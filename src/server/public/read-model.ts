import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { get, put } from '@vercel/blob';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import { toPublicRecipe } from '@/lib/recipe-presentation';
import { assertRecipeHasNoExternalReferences, findRecipeExternalReferences } from '@/lib/recipe-content-policy';
import { getDb } from '@/server/db';
import { editorialContentSchema } from '@/server/editorial/validation';
import { getPublishedRecipes, type EditorialTransaction } from '@/server/editorial/store';
import { isDatabaseUnavailable } from '@/server/http/database-failure';
import { isNeonQuotaError } from './published-snapshot';
import { collectionDefinitionSchema } from '@/server/collections/validation';
import type { CollectionDefinition } from '@/lib/collections';

const maximumBytes = 16 * 1024 * 1024;
const lifetime = 24 * 60 * 60 * 1000;
const lock = sql`SELECT pg_advisory_xact_lock(hashtext('jesie-public-read-model'))`;
const recipeSchema = editorialContentSchema.shape.recipe.omit({ provenance: true, heroPresentation: true }).extend({
  photos: editorialContentSchema.shape.photos.optional(), version: z.string().min(1).max(100).optional(), kitchenVerified: z.boolean().optional(),
  publication: z.object({ datePublished: z.string().datetime({ offset: true }), dateModified: z.string().datetime({ offset: true }), author: z.literal('jesie.pl') }).strict(),
}).strict();
const payloadSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), recipes: z.array(recipeSchema).max(5000) }).strict(),
  z.object({ version: z.literal(2), recipes: z.array(recipeSchema).max(5000), collections: z.array(collectionDefinitionSchema).max(1000) }).strict(),
]);
export type PublicContentSnapshot = { recipes: PublicRecipe[]; collections: CollectionDefinition[] | null };
const headSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('revoked'), token: z.string().uuid() }).strict(),
  z.object({ state: z.literal('ready'), token: z.string().uuid(), slot: z.enum(['a', 'b']), sha256: z.string().regex(/^[a-f0-9]{64}$/), capturedAt: z.number().finite(), expiresAt: z.number().finite() }).strict(),
]);
type Head = z.infer<typeof headSchema>;
type ReadModelIO = { read(path: string, maximum: number): Promise<{ bytes: Buffer; etag: string } | null>; write(path: string, bytes: Buffer, condition?: { ifMatch?: string; createOnly?: boolean }): Promise<void>; now(): number };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** The two bounded slots live outside the database; a fresh head fences withdrawals. */
export function createPublicReadModel(io: ReadModelIO) {
  async function versionedHead(): Promise<{ value: Head | null; etag?: string }> {
    const stored = await io.read('head.json', 2048); if (!stored) return { value: null };
    try { const parsed = headSchema.safeParse(JSON.parse(stored.bytes.toString('utf8'))); return { value: parsed.success ? parsed.data : null, etag: stored.etag }; } catch { return { value: null, etag: stored.etag }; }
  }
  async function head(): Promise<Head | null> { return (await versionedHead()).value; }
  async function invalidate() {
    const prior = await versionedHead();
    await io.write('head.json', Buffer.from(JSON.stringify({ state: 'revoked', token: randomUUID() })), prior.etag ? { ifMatch: prior.etag } : { createOnly: true });
  }
  async function refresh(recipes: PublicRecipe[], collections?: CollectionDefinition[]) {
    assertRecipeHasNoExternalReferences(recipes);
    const valid = payloadSchema.parse(collections === undefined ? { version: 1, recipes } : { version: 2, recipes, collections });
    const previous = await versionedHead();
    const prior = previous.value;
    const slot = prior?.state === 'ready' && prior.slot === 'a' ? 'b' : 'a';
    const bytes = Buffer.from(JSON.stringify(valid)); if (bytes.length > maximumBytes) throw new Error('PUBLIC_SNAPSHOT_TOO_LARGE');
    const capturedAt = io.now();
    await io.write(`snapshot-${slot}.json`, bytes);
    const next: Head = { state: 'ready', token: randomUUID(), slot, sha256: hash(bytes), capturedAt, expiresAt: capturedAt + lifetime };
    await io.write('head.json', Buffer.from(JSON.stringify(next)), previous.etag ? { ifMatch: previous.etag } : { createOnly: true });
    return next;
  }
  async function readContent(): Promise<PublicContentSnapshot | null> {
    const before = await head(); const now = io.now();
    if (before?.state !== 'ready' || now < before.capturedAt || now >= before.expiresAt || before.expiresAt - before.capturedAt !== lifetime) return null;
    const stored = await io.read(`snapshot-${before.slot}.json`, maximumBytes);
    if (!stored || hash(stored.bytes) !== before.sha256) return null;
    const bytes = stored.bytes;
    let parsed: ReturnType<typeof payloadSchema.safeParse>;
    try { parsed = payloadSchema.safeParse(JSON.parse(bytes.toString('utf8'))); } catch { return null; }
    if (!parsed.success || new Set(parsed.data.recipes.map(recipe => recipe.id)).size !== parsed.data.recipes.length) return null;
    if (findRecipeExternalReferences(parsed.data.recipes).length) return null;
    if (parsed.data.version === 2 && new Set(parsed.data.collections.map(collection => collection.id)).size !== parsed.data.collections.length) return null;
    // A withdrawal committed while the body was downloading must win.
    const after = await head();
    if (after?.state !== 'ready' || after.token !== before.token || io.now() >= after.expiresAt) return null;
    return { recipes: parsed.data.recipes as PublicRecipe[], collections: parsed.data.version === 2 ? parsed.data.collections : null };
  }
  async function read(): Promise<PublicRecipe[] | null> { return (await readContent())?.recipes ?? null; }
  return { head, invalidate, refresh, read, readContent };
}

export function publicReadModelEnabled() {
  return process.env.PUBLIC_RECIPE_SNAPSHOT_ENABLED === 'true' && Boolean(process.env.BLOB_READ_WRITE_TOKEN && process.env.DATABASE_URL);
}
function prefix() {
  const url = new URL(process.env.DATABASE_URL!);
  const scope = createHash('sha256').update(`${url.host}${url.pathname}:${url.username}`).digest('hex').slice(0, 20);
  return `public-read-model/v1/${scope}`;
}
const durable = createPublicReadModel({
  now: () => Date.now(),
  async read(path, maximum) {
    const result = await get(`${prefix()}/${path}`, { access: 'private', useCache: false, abortSignal: AbortSignal.timeout(8000) });
    if (!result || result.statusCode !== 200) return null;
    if (result.blob.size > maximum) { await result.stream.cancel(); return null; }
    const reader = result.stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maximum) { await reader.cancel(); return null; } chunks.push(next.value); } } finally { reader.releaseLock(); }
    return { bytes: Buffer.concat(chunks, size), etag: result.blob.etag };
  },
  async write(path, bytes, condition) {
    await put(`${prefix()}/${path}`, bytes, { access: 'private', addRandomSuffix: false, allowOverwrite: !condition?.createOnly, ...(condition?.ifMatch ? { ifMatch: condition.ifMatch } : {}), contentType: 'application/json', cacheControlMaxAge: 60, abortSignal: AbortSignal.timeout(8000) });
  },
});

/** Called inside every public mutation before changing its SQL publication. */
export async function invalidatePublicReadModel(tx: EditorialTransaction) {
  if (!publicReadModelEnabled()) return;
  await tx.execute(lock);
  await durable.invalidate(); // Fail closed: never commit a withdrawal after an unconfirmed fence.
}
export async function refreshPublicReadModel() {
  if (!publicReadModelEnabled()) return { enabled: false };
  return getDb().transaction(async tx => {
    await tx.execute(lock);
    const recipes = (await getPublishedRecipes(tx)).map(toPublicRecipe);
    const { getPublishedCollectionDefinitions } = await import('../collections/store');
    const collections = await getPublishedCollectionDefinitions(tx);
    return { enabled: true, recipes: recipes.length, collections: collections.length, ...await durable.refresh(recipes, collections) };
  });
}
export async function getPublicReadModelStatus() {
  if (!publicReadModelEnabled()) return { enabled: false, ready: false, capturedAt: null };
  try { const head = await durable.head(); return { enabled: true, ready: head?.state === 'ready' && head.expiresAt > Date.now(), capturedAt: head?.state === 'ready' ? head.capturedAt : null }; }
  catch { return { enabled: true, ready: false, capturedAt: null }; }
}
export async function withPublicReadModel<T>(primary: () => Promise<T>, select: (recipes: PublicRecipe[]) => T): Promise<T> {
  try { return await primary(); }
  catch (error) {
    if (!publicReadModelEnabled() || !isDatabaseUnavailable(error) && !isNeonQuotaError(error)) throw error;
    try { const recipes = await durable.read(); if (recipes !== null) return select(recipes); } catch { /* A missing, revoked or unverifiable copy never grants access. */ }
    throw error;
  }
}

/** Old recipe-only snapshots cannot authoritatively claim that a collection is absent. */
export async function withPublicCollectionReadModel<T>(primary: () => Promise<T>, select: (collections: CollectionDefinition[]) => T): Promise<T> {
  try { return await primary(); }
  catch (error) {
    if (!publicReadModelEnabled() || !isDatabaseUnavailable(error) && !isNeonQuotaError(error)) throw error;
    try { const content = await durable.readContent(); if (content?.collections !== null && content?.collections !== undefined) return select(content.collections); } catch { /* The original availability error wins over an unverified fallback. */ }
    throw error;
  }
}
