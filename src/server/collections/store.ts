import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { EditorialActor } from '@/lib/editorial-types';
import { collectionPromotionsOverlap, collectionPublicDefinition, isLegacyCollection, newCollectionContent, resolveCollection,
  type CollectionDefinition, type CollectionRecord } from '@/lib/collections';
import { toPublicRecipe } from '@/lib/recipe-presentation';
import { getDb } from '@/server/db';
import { user } from '@/server/db/auth-schema';
import { editorialRecipes } from '@/server/db/schema';
import { getPublishedRecipes } from '@/server/editorial/store';
import { collections, collectionPublications } from './schema';
import { CollectionError } from './errors';
import { collectionContentSchema, collectionDefinitionSchema, collectionPublicationIssues } from './validation';

type Database = ReturnType<typeof getDb>;
export type CollectionTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type CollectionReader = Database | CollectionTransaction;
type CollectionRow = typeof collections.$inferSelect;
const promotionLock = sql`SELECT pg_advisory_xact_lock(hashtext('jesie-collection-promotions'))`;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([first], [second]) => first.localeCompare(second)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function collectionContentHash(value: unknown) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function publicHash(value: CollectionDefinition) { const { dateModified, ...content } = value; void dateModified; return collectionContentHash(content); }
async function dto(row: CollectionRow, db: CollectionReader): Promise<CollectionRecord> {
  const content = collectionContentSchema.parse(row.content);
  const [published] = row.publishedId ? await db.select({ snapshot: collectionPublications.snapshot }).from(collectionPublications).where(eq(collectionPublications.id, row.publishedId)).limit(1) : [];
  return { id: row.id, revision: row.revision, content, publicationStatus: row.publicationStatus, publishedRevision: row.publishedRevision,
    hasUnpublishedChanges: Boolean(published && publicHash(collectionPublicDefinition(row.id, content)) !== publicHash(published.snapshot)),
    firstPublishedAt: row.firstPublishedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedByName };
}
/** Re-read live role and identity; caller-supplied names never enter the audit metadata. */
export async function assertCollectionActor(tx: CollectionTransaction, actor: EditorialActor) {
  const [account] = await tx.select({ id: user.id, name: user.name, email: user.email, role: user.role, disabled: user.disabled }).from(user).where(eq(user.id, actor.id)).for('share').limit(1);
  if (!account || account.disabled || (account.role !== 'owner' && account.role !== 'admin')) throw new CollectionError(403, 'FORBIDDEN', 'Brak dostępu do kolekcji.');
  return { id: account.id, name: account.name, email: account.email, role: account.role as 'owner' | 'admin' };
}
export async function lockedCollection(tx: CollectionTransaction, id: string, expectedRevision?: number) {
  const [row] = await tx.select().from(collections).where(eq(collections.id, id)).for('update').limit(1);
  if (!row) throw new CollectionError(404, 'NOT_FOUND', 'Nie znaleziono kolekcji.');
  if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new CollectionError(409, 'REVISION_CONFLICT', 'Kolekcja zmieniła się. Wczytaj bieżącą wersję.', await dto(row, tx));
  return row;
}
export async function getCollection(id: string, db: CollectionReader = getDb()): Promise<CollectionRecord> {
  const [row] = await db.select().from(collections).where(eq(collections.id, id)).limit(1);
  if (!row) throw new CollectionError(404, 'NOT_FOUND', 'Nie znaleziono kolekcji.');
  return dto(row, db);
}
export async function listCollections(): Promise<CollectionRecord[]> {
  const db = getDb();
  const rows = await db.select().from(collections).orderBy(desc(collections.updatedAt), asc(collections.id));
  return Promise.all(rows.map(row => dto(row, db)));
}
async function slugErrors<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    let current = error;
    for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
      if ('code' in current && current.code === '23505') throw new CollectionError(409, 'SLUG_TAKEN', 'Ten adres kolekcji jest już zajęty. Wybierz inny adres PL lub EN.');
      current = 'cause' in current ? current.cause : null;
    }
    throw error;
  }
}
export async function createCollection(input: { title: string }, actor: EditorialActor): Promise<CollectionRecord> {
  return slugErrors(() => getDb().transaction(async tx => {
    const account = await assertCollectionActor(tx, actor);
    const content = collectionContentSchema.parse(newCollectionContent(input.title.trim()));
    const [row] = await tx.insert(collections).values({ id: randomUUID(), content, contentHash: collectionContentHash(content), createdBy: account.id, updatedBy: account.id, updatedByName: account.name }).returning();
    return dto(row, tx);
  }));
}
export async function saveCollection(id: string, input: { expectedRevision: number; content: unknown }, actor: EditorialActor) {
  return slugErrors(() => getDb().transaction(tx => saveCollectionInTransaction(tx, id, input, actor)));
}
export async function saveCollectionInTransaction(tx: CollectionTransaction, id: string, input: { expectedRevision: number; content: unknown }, actor: EditorialActor, options: { allowThemeChange?: boolean } = {}): Promise<CollectionRecord> {
  const content = collectionContentSchema.parse(input.content);
  const account = await assertCollectionActor(tx, actor);
  const original = await lockedCollection(tx, id, input.expectedRevision);
  if (content.minimumRecipes !== (isLegacyCollection(id) ? 5 : 1) || content.selectionMode !== (id === 'quick-dinners' ? 'quick-dinners' : 'manual')) throw new CollectionError(422, 'SELECTION_MODE_LOCKED', 'Reguła wyboru przepisów tej kolekcji nie może się zmienić.');
  if (original.firstPublishedAt && (content.slug.pl !== original.content.slug.pl || content.slug.en !== original.content.slug.en)) throw new CollectionError(422, 'SLUG_LOCKED', 'Adresy kolekcji są stałe od pierwszej publikacji.');
  if (!options.allowThemeChange && (collectionContentHash(content.theme) !== collectionContentHash(original.content.theme) || content.themeGenerationId !== original.content.themeGenerationId)) throw new CollectionError(422, 'THEME_REVIEW_REQUIRED', 'Wygląd można zmienić przez zaakceptowanie wygenerowanej propozycji.');
  const hash = collectionContentHash(content);
  if (hash === original.contentHash) return dto(original, tx);
  const [row] = await tx.update(collections).set({ content, contentHash: hash, revision: original.revision + 1, updatedAt: new Date(), updatedBy: account.id, updatedByName: account.name }).where(eq(collections.id, id)).returning();
  return dto(row, tx);
}
/** Public definitions deliberately contain no appearance brief, inspiration or provider metadata. */
export async function getPublishedCollectionDefinitions(db: CollectionReader = getDb()): Promise<CollectionDefinition[]> {
  const rows = await db.select({ id: collections.id, snapshot: collectionPublications.snapshot, publishedAt: collectionPublications.publishedAt }).from(collections)
    .innerJoin(collectionPublications, and(eq(collections.publishedId, collectionPublications.id), eq(collections.id, collectionPublications.collectionId)))
    .where(eq(collections.publicationStatus, 'published')).orderBy(desc(collections.firstPublishedAt), asc(collections.id));
  return rows.map(row => {
    const snapshot = collectionDefinitionSchema.parse(row.snapshot);
    if (snapshot.id !== row.id) throw new Error('COLLECTION_PUBLICATION_IDENTITY_MISMATCH');
    return { ...snapshot, dateModified: row.publishedAt.toISOString() };
  });
}
export async function performCollectionAction(id: string, input: { expectedRevision: number; action: 'publish' | 'unpublish' }, actor: EditorialActor): Promise<CollectionRecord> {
  return getDb().transaction(async tx => {
    // All publications use the same lock, including different collection IDs.
    await tx.execute(promotionLock);
    const account = await assertCollectionActor(tx, actor);
    const original = await lockedCollection(tx, id, input.expectedRevision);
    if (input.action === 'unpublish' && original.publicationStatus !== 'published') return dto(original, tx);
    const content = collectionContentSchema.parse(original.content);
    const now = new Date(), revision = original.revision + 1;
    if (input.action === 'publish') {
      const issues = collectionPublicationIssues(id, content);
      const recipes = (await getPublishedRecipes(tx)).map(toPublicRecipe);
      const available = new Set(recipes.map(recipe => recipe.id));
      if (content.selectionMode === 'manual') for (const recipeId of content.recipeIds) if (!available.has(recipeId)) issues.push({ field: 'recipeIds', message: 'Usuń wycofane lub niedostępne przepisy przed publikacją.' });
      const definition = collectionPublicDefinition(id, content, now.toISOString());
      if (resolveCollection(definition, recipes, 'pl').recipes.length < content.minimumRecipes) issues.push({ field: 'recipeIds', message: `Wybierz co najmniej ${content.minimumRecipes} opublikowany${content.minimumRecipes === 1 ? ' przepis' : 'ch przepisów'}.` });
      if (issues.length) throw new CollectionError(422, 'PUBLICATION_BLOCKED', 'Uzupełnij kolekcję przed publikacją.', undefined, issues);
      if (content.theme) await (await import('./theme-approval')).assertThemeAssets(id, content.theme, content.themeGenerationId);
      const published = await getPublishedCollectionDefinitions(tx);
      const collision = published.find(collection => collection.id !== id && collectionPromotionsOverlap(content.promotion, collection.promotion));
      if (collision) throw new CollectionError(409, 'PROMOTION_OVERLAP', `Ten okres promocji jest już przypisany do kolekcji „${collision.title.pl}”.`, undefined, [{ field: 'promotion', message: 'Wybierz okres bez nakładania się promocji.' }]);
      await (await import('../public/read-model')).invalidatePublicReadModel(tx);
      const publicationId = randomUUID();
      await tx.insert(collectionPublications).values({ id: publicationId, collectionId: id, revision, snapshot: definition, publishedAt: now, publishedBy: account.id, publishedByName: account.name });
      const [row] = await tx.update(collections).set({ publicationStatus: 'published', publishedId: publicationId, publishedRevision: revision, firstPublishedAt: original.firstPublishedAt ?? now, revision, updatedAt: now, updatedBy: account.id, updatedByName: account.name }).where(eq(collections.id, id)).returning();
      await (await import('./discovery')).queueCollectionDiscovery(tx, id, ['pl', 'en'].map(locale => `/${locale}/kolekcje/${content.slug[locale as 'pl' | 'en']}`));
      return dto(row, tx);
    }
    await (await import('../public/read-model')).invalidatePublicReadModel(tx);
    const [row] = await tx.update(collections).set({ publicationStatus: 'unpublished', revision, updatedAt: now, updatedBy: account.id, updatedByName: account.name }).where(eq(collections.id, id)).returning();
    await (await import('./discovery')).queueCollectionDiscovery(tx, id, ['pl', 'en'].map(locale => `/${locale}/kolekcje/${content.slug[locale as 'pl' | 'en']}`));
    return dto(row, tx);
  });
}

/** Published rows only; suitable for the administrator's recipe picker. */
export async function collectionRecipePicker() {
  return (await getPublishedRecipes()).map(toPublicRecipe);
}

/** Lightweight identity checks are reusable by collection generation admission. */
export async function publishedCollectionRecipeIds(db: CollectionReader = getDb()) {
  return (await db.select({ id: editorialRecipes.id }).from(editorialRecipes).where(and(eq(editorialRecipes.publicationStatus, 'published'), isNull(editorialRecipes.deletedAt)))).map(row => row.id);
}
