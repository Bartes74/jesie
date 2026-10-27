import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import { findRecipeExternalReferences } from '@/lib/recipe-content-policy';
import { editorialContentSchema } from '@/server/editorial/validation';

const quotaMessage = 'Your account or project has exceeded the quota. Upgrade your plan to increase limits.';
const capturedAt = '2026-10-13T15:50:52Z';
const expiresAt = '2026-10-14T15:50:52Z';
const sourceSha256 = 'ec024ae426c2d1ea8a14495e9df375895648186494082898e5e61ef95319604b';
const recipesSha256 = '09b0c55722e96dc2cb46103bdc0568893a5a021e35e239279ace3865611a1220';

// The emergency bundle contains only DTOs captured from anonymous production
// HTML. These exact IDs were also verified anonymously after the capture.
const publishedIds = new Set([
  '00541e2a-ae68-4917-b88d-e7f7c07e7e82', '32e9c1d9-d345-4889-a626-43c0ebfb3d5b',
  '4aa1a876-937f-4ea7-8efc-3fec9b1abbaf', '56f00197-7ca6-4bc5-9f89-8912ae7a380c',
  '6b2523db-1489-499f-a81a-6ecdfd61597e', '723141c6-262f-4a3e-9a5f-3550c5526a02',
  '77d32f06-483b-41e5-8054-048e575f1b81', 'apple-cake',
  'b549efa4-8514-4a64-a963-f4f39d4f073c', 'b9229252-6f52-405b-8966-5a6f232b4f0c',
  'b974f7dd-6226-463e-aa20-33194d6cd8c4', 'beetroot-salad',
  'c8e6ff07-38de-4949-b28c-7e5f0655c2fe', 'fc71fcf7-0428-4ac9-a13a-564a9d7a3439',
  'lemon-pasta', 'pumpkin-soup', 'ricotta-pancakes', 'spinach-pierogi',
]);

const publicRecipeSchema = editorialContentSchema.shape.recipe
  .omit({ provenance: true, heroPresentation: true })
  .extend({
    photos: editorialContentSchema.shape.photos.optional(),
    publication: z.object({
      datePublished: z.string().datetime({ offset: true }),
      dateModified: z.string().datetime({ offset: true }),
      author: z.literal('jesie.pl'),
    }).strict(),
  }).strict();

const snapshotSchema = z.object({
  version: z.literal(1),
  capturedAt: z.literal(capturedAt),
  expiresAt: z.literal(expiresAt),
  sourceSha256: z.literal(sourceSha256),
  recipes: z.array(publicRecipeSchema).length(publishedIds.size),
}).strict();

/** Match only the observed Neon limit, including a Drizzle-wrapped Pg cause. */
export function isNeonQuotaError(error: unknown): boolean {
  const visited = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 16 && current && typeof current === 'object'; depth++) {
    if (visited.has(current)) return false;
    visited.add(current);
    const entry = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (entry.code === '53000' && entry.message === quotaMessage) return true;
    current = entry.cause;
  }
  return false;
}

/** A historical snapshot expires at its original capture time plus 24 hours. */
export function parsePublishedSnapshot(input: unknown, now = Date.now()): PublicRecipe[] | null {
  if (!Number.isFinite(now) || now < Date.parse(capturedAt) || now >= Date.parse(expiresAt)) return null;
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success) return null;
  const recipes = parsed.data.recipes;
  const ids = new Set(recipes.map(recipe => recipe.id));
  if (ids.size !== publishedIds.size || [...ids].some(id => !publishedIds.has(id))) return null;
  // Bind all nested content, dates and media references to the verified capture.
  // Validate the input bytes' structure, rather than a projection that strips keys.
  const rawRecipes = (input as { recipes: unknown }).recipes;
  if (createHash('sha256').update(JSON.stringify(rawRecipes)).digest('hex') !== recipesSha256) return null;
  if (findRecipeExternalReferences(recipes).length) return null;
  for (const recipe of recipes) {
    const first = Date.parse(recipe.publication.datePublished);
    const modified = Date.parse(recipe.publication.dateModified);
    if (modified < first || modified > Date.parse(capturedAt)) return null;
  }
  return recipes;
}

// A literal dynamic import is traced into server functions by Next. The file is
// deliberately outside public/ and is never exposed as a downloadable endpoint.
let bundledSnapshot: Promise<unknown> | undefined;
export async function loadPublishedSnapshot(): Promise<PublicRecipe[] | null> {
  try {
    const input = await (bundledSnapshot ??= import('../../../private-data/public-recovery/recipes.json').then(module => module.default));
    return parsePublishedSnapshot(input);
  } catch {
    return null;
  }
}

/** Keep successful SQL reads authoritative, even when a recipe was withdrawn. */
export async function withPublishedSnapshot<T>(
  primary: () => Promise<T>,
  select: (recipes: PublicRecipe[]) => T,
  loadSnapshot: () => Promise<PublicRecipe[] | null> = loadPublishedSnapshot,
): Promise<T> {
  try {
    return await primary();
  } catch (error) {
    if (!isNeonQuotaError(error)) throw error;
    const snapshot = await loadSnapshot();
    if (!snapshot?.length) throw error;
    return select(snapshot);
  }
}
