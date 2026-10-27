import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { EditorialAction, EditorialActor, EditorialContent, EditorialRecord, PublicationIssue, RecipeSummary, ReviewChecks } from '../../lib/editorial-types';
import { reviewKeys } from '../../lib/editorial-types';
import type { Ingredient, Locale, Recipe } from '../../lib/recipes';
import { classifyRecipeDiet, type RecipeDietId } from '../../lib/recipe-diet';
import { toPublicRecipe } from '../../lib/recipe-presentation';
import { assertRecipeHasNoExternalReferences, findRecipeExternalReferences } from '../../lib/recipe-content-policy';
import { ingredientPhotoIdentity } from '../../lib/citrus-photo-policy';
import { ingredientPhotoPolicyIssues, type IngredientPhotoSources } from '../../lib/ingredient-photo-policy';
import type { IngredientPhotoSubject } from '../../lib/ingredient-photo-identity';
import { recipePhotoAssignmentIssues, recipePhotoCropKey, recipePhotoSource, type RecipePhotoSource } from '../../lib/recipe-photo-evidence';
import { isStepPhotoRequired } from '../../lib/step-photo-selection';
import { getDb } from '../db';
import { user } from '../db/auth-schema';
import { aiAssets, aiJobs } from '../ai/schema';
import { getRecipeVerifiedAliases } from '../ai/recipe-ingredient-dictionary';
import { requireTrendScope, trendWorker } from '../trends/actor';
import { trendPublicationDays, trendRuns, trendSettings } from '../trends/schema';
import { editorialAudit, editorialOutbox, editorialPublications, editorialRecipes, editorialSlugs, editorialVersions } from '../db/schema';
import { editorialContentSchema, publicationIssues } from './validation';

export { editorialContentSchema, publicationIssues } from './validation';

type Database = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type EditorialTransaction = Transaction;
type RecipeRow = typeof editorialRecipes.$inferSelect;
type ActionInput = { action: EditorialAction; expectedRevision: number; checks?: ReviewChecks; version?: number };

export class EditorialError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly latest?: EditorialRecord, public readonly issues?: PublicationIssue[]) {
    super(message);
    this.name = 'EditorialError';
  }
}

export const emptyChecks = (): ReviewChecks => ({ pl: false, en: false, quantities: false, method: false, photos: false, sources: false });

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function contentHash(content: EditorialContent) { return createHash('sha256').update(canonical(content)).digest('hex'); }

function rejectExternalReferences(content: unknown) {
  const references = findRecipeExternalReferences(content);
  if (references.length) throw new EditorialError(422, 'EXTERNAL_REFERENCE', 'Treść przepisu nie może odsyłać do zewnętrznych serwisów. Zachowaj źródła w prywatnej bibliografii.', undefined,
    references.map(issue => ({ field: issue.path, message: issue.reason })));
}

async function parseContent(input: unknown, db: Database | Transaction): Promise<EditorialContent> {
  const result = editorialContentSchema.safeParse(input);
  if (!result.success) throw new EditorialError(422, 'INVALID_CONTENT', 'Szkic zawiera nieprawidłowe dane.', undefined, result.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })));
  rejectExternalReferences(result.data);
  rejectIngredientPhotoIssues(ingredientPhotoIssues(result.data as EditorialContent));
  rejectRecipePhotoIssues(recipePhotoAssignmentIssues(result.data as EditorialContent));
  if (result.data.recipe.ingredients.length) result.data.recipe.diet = classifyRecipeDiet(result.data.recipe,
    await getRecipeVerifiedAliases(result.data.recipe.ingredients, db));
  return result.data as EditorialContent;
}

function ingredientPhotoIssues(content: EditorialContent, knownSources?: IngredientPhotoSources): PublicationIssue[] {
  return ingredientPhotoPolicyIssues(content.recipe.ingredients, content.photos.ingredients, knownSources)
    .map(issue => ({ field: `ingredients.${issue.ingredientId}.photo`, message: issue.message }));
}

function rejectIngredientPhotoIssues(issues: PublicationIssue[]) {
  if (issues.length) throw new EditorialError(422, 'INGREDIENT_PHOTO_MISMATCH', 'Zdjęcia muszą przedstawiać właściwy produkt i postać składnika.', undefined, issues);
}

/** Registered photographs keep their captured ingredient identity across recipes. */
async function ingredientPhotoSourceEvidence(content: EditorialContent, db: Database | Transaction) {
  const targets = content.recipe.ingredients.flatMap(ingredient => {
    const photo = content.photos.ingredients[ingredient.id];
    const match = photo && /^\/media\/([a-f0-9-]{36})$/i.exec(photo.src);
    return match ? [{ ingredient, photo, assetId: match[1] }] : [];
  });
  const knownSources = new Map<string, IngredientPhotoSubject>();
  const issues: PublicationIssue[] = [];
  if (!targets.length) return { knownSources, issues };
  const sources = await db.select({ id: aiAssets.id, kind: aiAssets.kind, assetTargetId: aiAssets.targetId, jobKind: aiJobs.kind, targetId: aiJobs.targetId,
    ingredients: sql<Ingredient[]>`${aiJobs.input}->'recipe'->'ingredients'` })
    .from(aiAssets).innerJoin(aiJobs, eq(aiAssets.jobId, aiJobs.id)).where(inArray(aiAssets.id, [...new Set(targets.map(item => item.assetId))]));
  for (const target of targets) {
    const source = sources.find(item => item.id === target.assetId);
    const sourceIngredient = Array.isArray(source?.ingredients) ? source.ingredients.find(item => item.id === source.targetId) : undefined;
    if (source?.kind === 'ingredient' && source.jobKind === 'ingredient' && source.assetTargetId === source.targetId
      && sourceIngredient && typeof sourceIngredient.name?.pl === 'string' && typeof sourceIngredient.name.en === 'string'
      && target.photo.columns === 1 && target.photo.rows === 1 && target.photo.index === 0) {
      knownSources.set(ingredientPhotoIdentity(target.photo), sourceIngredient);
    } else issues.push({
      field: `ingredients.${target.ingredient.id}.photo`,
      message: 'Wybierz zarejestrowane zdjęcie składnika z potwierdzonym pochodzeniem i właściwym kadrem.',
    });
  }
  return { knownSources, issues };
}

async function rejectIncompatibleIngredientPhotos(content: EditorialContent, db: Database | Transaction) {
  const evidence = await ingredientPhotoSourceEvidence(content, db);
  rejectIngredientPhotoIssues([...ingredientPhotoIssues(content, evidence.knownSources), ...evidence.issues]);
  rejectRecipePhotoIssues(await recipePhotoSourceIssues(content, db));
}

function rejectRecipePhotoIssues(issues: PublicationIssue[]) {
  if (issues.length) throw new EditorialError(422, 'RECIPE_PHOTO_MISMATCH', 'Zdjęcie musi przedstawiać właściwe danie i etap przygotowania.', undefined, issues);
}

/** Asset metadata and its immutable source job must agree before a hero or step
 * image can be assigned, restored, saved or published. */
async function recipePhotoSourceIssues(content: EditorialContent, db: Database | Transaction) {
  const photos = [
    ...(content.recipe.image ? [{ src: content.recipe.image, columns: 1, rows: 1, index: 0 }] : []),
    ...content.recipe.steps.flatMap(step => content.photos.steps[step.id] ? [content.photos.steps[step.id]] : []),
  ];
  const ids = [...new Set(photos.flatMap(photo => /^\/media\/([a-f0-9-]{36})$/iu.exec(photo.src)?.[1] ?? []))];
  const knownSources = new Map<string, RecipePhotoSource>();
  const rows = ids.length ? await db.select({ id: aiAssets.id, recipeId: aiAssets.recipeId, kind: aiAssets.kind, targetId: aiAssets.targetId,
    jobRecipeId: aiJobs.recipeId, jobKind: aiJobs.kind, jobTargetId: aiJobs.targetId, recipe: sql<Recipe>`${aiJobs.input}->'recipe'` })
    .from(aiAssets).innerJoin(aiJobs, eq(aiAssets.jobId, aiJobs.id)).where(inArray(aiAssets.id, ids)) : [];
  for (const photo of photos) {
    const id = /^\/media\/([a-f0-9-]{36})$/iu.exec(photo.src)?.[1];
    const row = id && rows.find(item => item.id === id);
    if (!row || !['hero', 'step'].includes(row.kind) || row.kind !== row.jobKind || row.recipeId !== row.jobRecipeId
      || row.targetId !== row.jobTargetId || row.recipe?.id !== row.recipeId
      || photo.columns !== 1 || photo.rows !== 1 || photo.index !== 0
      || !Array.isArray(row.recipe.ingredients) || !Array.isArray(row.recipe.steps)) continue;
    try {
      const source = recipePhotoSource(row.recipe, row.kind as 'hero' | 'step', row.targetId, photo.src);
      if (source) knownSources.set(recipePhotoCropKey(photo), source);
    } catch {
      // Malformed historical captures provide no evidence; the policy returns
      // a normal assignment issue instead of accepting the route or crashing.
    }
  }
  return recipePhotoAssignmentIssues(content, knownSources);
}

async function trustedActor(tx: Transaction, actor: EditorialActor) {
  const [account] = await tx.select().from(user).where(eq(user.id, actor.id)).for('share');
  if (!account || account.disabled || !['owner', 'admin'].includes(account.role)) throw new EditorialError(403, 'FORBIDDEN', 'To konto nie ma uprawnień do redakcji.');
  // Display names and role are loaded from storage, never trusted from a request.
  return { id: account.id, name: account.name, email: account.email, role: account.role as 'owner' | 'admin' };
}

async function record(row: RecipeRow, db: Database | Transaction): Promise<EditorialRecord> {
  const versions = await db.select({ revision: editorialVersions.revision, createdAt: editorialVersions.createdAt, createdBy: editorialVersions.createdByName, title: sql<string>`${editorialVersions.content}->'recipe'->'title'->>'pl'`, reason: editorialVersions.reason }).from(editorialVersions).where(eq(editorialVersions.recipeId, row.id)).orderBy(desc(editorialVersions.revision));
  return { id: row.id, revision: row.revision, content: row.content, editorialStatus: row.editorialStatus, publicationStatus: row.publicationStatus, deletedAt: row.deletedAt?.toISOString() ?? null, publishedRevision: row.publishedRevision, updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedByName, checks: row.checks, issues: await verifiedPublicationIssues(row.content, db), versions: versions.map(version => ({ revision: version.revision, createdAt: version.createdAt.toISOString(), createdBy: version.createdBy, title: version.title, reason: version.reason })) };
}

export async function verifiedPublicationIssues(content: EditorialContent, db: Database | Transaction) {
  const sources = [content.recipe.image, ...Object.values(content.photos.ingredients).map(photo => photo.src), ...Object.values(content.photos.steps).map(photo => photo.src)];
  const ids = [...new Set(sources.filter(src => /^\/media\/[0-9a-f-]{36}$/.test(src)).map(src => src.slice(7)))];
  // The route shape alone grants no trust: only immutable, registered assets pass.
  const assets = ids.length ? await db.select({ id: aiAssets.id, kind: aiAssets.kind }).from(aiAssets).where(inArray(aiAssets.id, ids)) : [];
  const evidence = await ingredientPhotoSourceEvidence(content, db);
  const verifiedAliases = await getRecipeVerifiedAliases(content.recipe.ingredients, db);
  const issues = [...publicationIssues(content, new Map(assets.map(asset => [`/media/${asset.id}`, asset.kind])), undefined, verifiedAliases), ...ingredientPhotoIssues(content, evidence.knownSources), ...evidence.issues, ...await recipePhotoSourceIssues(content, db)];
  return issues.filter((issue, index) => issues.findIndex(other => other.field === issue.field && other.message === issue.message) === index);
}

/** Used only by the AI store inside its job/apply transaction; creates a normal unapproved editorial revision. */
export async function applyAiProposalInTransaction(tx: Transaction, id: string, expectedRevision: number, input: unknown, actor: EditorialActor, reason: string, automationRunId?: string): Promise<EditorialRecord> {
  const account = automationRunId && actor.id === trendWorker.id && actor.role === 'trend_worker'
    ? (await requireTrendScope(tx, automationRunId, id), trendWorker) : await trustedActor(tx, actor);
  const original = await lockedRecipe(tx, id, expectedRevision);
  if (original.editorialStatus === 'archived') throw new EditorialError(409, 'ARCHIVED', 'Najpierw przywróć przepis z archiwum.');
  const content = await parseContent(input, tx);
  if (content.recipe.id !== id) throw new EditorialError(422, 'IDENTITY_MISMATCH', 'Identyfikator przepisu nie może się zmienić.');
  const row = await updateRecipe(tx, original, { content, editorialStatus: 'draft', checks: emptyChecks(), checksRevision: original.revision + 1, approvedRevision: null }, account, reason, 'apply_ai');
  return record(row, tx);
}

async function lockedRecipe(tx: Transaction, id: string, expectedRevision: number, allowDeleted = false) {
  const [row] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, id)).for('update');
  if (!row) throw new EditorialError(404, 'NOT_FOUND', 'Nie znaleziono przepisu.');
  if (!Number.isInteger(expectedRevision) || row.revision !== expectedRevision) throw new EditorialError(409, 'REVISION_CONFLICT', 'Przepis zmienił się w innym oknie. Porównaj wersje przed zapisem.', await record(row, tx));
  if (row.deletedAt && !allowDeleted) throw new EditorialError(409, 'RECIPE_DELETED', 'Przepis znajduje się w koszu. Najpierw przywróć go do szkiców.', await record(row, tx));
  return row;
}

async function appendHistory(tx: Transaction, row: RecipeRow, actor: EditorialActor, reason: string, action: string) {
  await tx.insert(editorialVersions).values({ recipeId: row.id, revision: row.revision, content: row.content, contentHash: row.contentHash, reason, createdAt: row.updatedAt, createdBy: actor.id, createdByName: actor.name });
  await tx.insert(editorialAudit).values({ id: randomUUID(), recipeId: row.id, revision: row.revision, action, actorId: actor.id, actorName: actor.name, createdAt: row.updatedAt });
}

async function updateRecipe(tx: Transaction, original: RecipeRow, values: Partial<typeof editorialRecipes.$inferInsert>, actor: EditorialActor, reason: string, action: string) {
  if (values.content) { rejectExternalReferences(values.content); await rejectIncompatibleIngredientPhotos(values.content, tx); }
  const [row] = await tx.update(editorialRecipes).set({ ...values, contentHash: contentHash(values.content ?? original.content), revision: original.revision + 1, updatedAt: new Date(), updatedBy: actor.id, updatedByName: actor.name }).where(and(eq(editorialRecipes.id, original.id), eq(editorialRecipes.revision, original.revision))).returning();
  if (!row) throw new EditorialError(409, 'REVISION_CONFLICT', 'Przepis zmienił się przed zapisem.');
  await appendHistory(tx, row, actor, reason, action);
  return row;
}

function defaultContent(id: string, title: string, originalText: string, author: string): EditorialContent {
  const blank = { pl: '', en: '' };
  return { originalText, author, sources: [], photos: { ingredients: {}, steps: {} }, recipe: {
    id, title: { pl: title, en: '' }, slug: blank, description: blank, image: '', imageAlt: blank,
    primaryCategory: 'main', categories: ['main'], dietaryTags: [], difficulty: 'easy', cuisine: blank,
    baseServings: 4, times: { active: 0, cooking: 0, rest: 0, total: 0 }, ingredients: [], steps: [],
    equipment: { pl: [], en: [] }, tips: { pl: [], en: [] }, storage: blank, featured: false,
    provenance: { type: 'original', label: { pl: 'Autorski przepis', en: 'Original recipe' }, note: { pl: 'Opracowanie redakcyjne. Przepis nie został jeszcze sprawdzony w kuchni.', en: 'Editorial draft. This recipe has not yet been kitchen-tested.' }, kitchenTested: false },
  } };
}

export async function listRecipes(): Promise<RecipeSummary[]> {
  const rows = await getDb().select({ recipe: editorialRecipes, hasUnpublishedChanges: sql<boolean>`${editorialPublications.snapshot} IS NOT NULL AND ${editorialPublications.snapshot} IS DISTINCT FROM ${editorialRecipes.content}` }).from(editorialRecipes).leftJoin(editorialPublications, eq(editorialRecipes.publishedId, editorialPublications.id)).orderBy(desc(editorialRecipes.updatedAt));
  return rows.map(({ recipe: row, hasUnpublishedChanges }) => {
    const completeLocale = (locale: Locale) => Boolean(row.content.recipe.title[locale].trim()) && Boolean(row.content.recipe.description[locale].trim()) && row.content.recipe.ingredients.length > 0 && row.content.recipe.steps.length > 0 && row.content.recipe.ingredients.every(ingredient => Boolean(ingredient.name[locale].trim())) && row.content.recipe.steps.every(step => Boolean(step.title[locale].trim()) && Boolean(step.text[locale].trim()));
    return { id: row.id, title: row.content.recipe.title, image: row.content.recipe.image, category: row.content.recipe.primaryCategory, totalMinutes: row.content.recipe.times.total, editorialStatus: row.editorialStatus, publicationStatus: row.publicationStatus, deletedAt: row.deletedAt?.toISOString() ?? null, revision: row.revision, publishedRevision: row.publishedRevision, updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedByName, languages: { pl: completeLocale('pl'), en: completeLocale('en') }, hasUnpublishedChanges };
  });
}

export async function getRecipeInTransaction(tx: Transaction, id: string): Promise<EditorialRecord> {
  const [row] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, id));
  if (!row) throw new EditorialError(404, 'NOT_FOUND', 'Nie znaleziono przepisu.');
  return record(row, tx);
}

export async function getRecipe(id: string): Promise<EditorialRecord> {
  const db = getDb();
  const [row] = await db.select().from(editorialRecipes).where(eq(editorialRecipes.id, id));
  if (!row) throw new EditorialError(404, 'NOT_FOUND', 'Nie znaleziono przepisu.');
  return record(row, db);
}

export async function createRecipe(input: { title: string; originalText: string }, actor: EditorialActor): Promise<EditorialRecord> {
  if (typeof input.title !== 'string' || input.title.length > 500 || !input.title.trim() || typeof input.originalText !== 'string' || input.originalText.length > 100_000) throw new EditorialError(422, 'INVALID_INPUT', 'Podaj tytuł przepisu i poprawną treść źródłową.');
  return getDb().transaction(async tx => {
    const account = await trustedActor(tx, actor);
    const id = randomUUID();
    const content = defaultContent(id, input.title.trim(), input.originalText, account.name);
    rejectExternalReferences(content);
    const [row] = await tx.insert(editorialRecipes).values({ id, content, contentHash: contentHash(content), checks: emptyChecks(), createdBy: account.id, updatedBy: account.id, updatedByName: account.name }).returning();
    await appendHistory(tx, row, account, 'Utworzenie szkicu', 'create');
    return record(row, tx);
  });
}

/** Worker-only draft creation. The run must own no draft yet; this identity can never publish. */
export async function createTrendDraftInTransaction(tx: Transaction, runId: string, title: string, originalText: string, sources: EditorialContent['sources'] = [], confirmed = true, dietTarget?: RecipeDietId): Promise<EditorialRecord> {
  const run = await requireTrendScope(tx, runId, undefined, true);
  if (run.recipeId) throw new EditorialError(409, 'TREND_DRAFT_EXISTS', 'Ten przebieg ma już szkic.');
  const id = randomUUID(); const content = defaultContent(id, title, originalText, 'jesie.pl');
  content.recipe.collection = 'trends'; if (confirmed) content.recipe.trendConfirmedAt = new Date().toISOString(); content.sources = structuredClone(sources);
  if (dietTarget) content.aiPhotography = { recipeDietTarget: dietTarget };
  rejectExternalReferences(content);
  const [row] = await tx.insert(editorialRecipes).values({ id, content, contentHash: contentHash(content), checks: emptyChecks(), createdBy: trendWorker.id, updatedBy: trendWorker.id, updatedByName: trendWorker.name }).returning();
  await appendHistory(tx, row, trendWorker, confirmed ? 'Przygotowanie szkicu z radaru' : 'Przygotowanie inspiracji z radaru', 'trend_draft');
  return record(row, tx);
}

export async function saveRecipe(id: string, input: { expectedRevision: number; content: unknown }, actor: EditorialActor): Promise<EditorialRecord> {
  return getDb().transaction(tx => saveRecipeInTransaction(tx, id, input, actor));
}

/** Ordinary manual save, reusable when reviewed edits and approval must commit together. */
export async function saveRecipeInTransaction(tx: EditorialTransaction, id: string, input: { expectedRevision: number; content: unknown }, actor: EditorialActor): Promise<EditorialRecord> {
  const content = await parseContent(input.content, tx);
  if (content.recipe.id !== id) throw new EditorialError(422, 'IDENTITY_MISMATCH', 'Identyfikator przepisu nie może się zmienić.');
  const account = await trustedActor(tx, actor);
  const original = await lockedRecipe(tx, id, input.expectedRevision);
  if (original.editorialStatus === 'archived') throw new EditorialError(409, 'ARCHIVED', 'Najpierw przywróć przepis z archiwum.');
  const hash = contentHash(content);
  if (hash === contentHash(original.content)) { await rejectIncompatibleIngredientPhotos(content, tx); return record(original, tx); }
  const row = await updateRecipe(tx, original, { content, contentHash: hash, editorialStatus: 'draft', checks: emptyChecks(), checksRevision: original.revision + 1, approvedRevision: null }, account, 'Zapis zmian', 'save');
  return record(row, tx);
}

/** Move any editorial stage to the recoverable trash; historical data and media stay intact. */
export async function deleteRecipe(id: string, input: { expectedRevision: number }, actor: EditorialActor): Promise<EditorialRecord> {
  return getDb().transaction(async tx => {
    // AI admissions, receipt settlement and apply use this same lock before their
    // job/recipe locks, so deletion cannot invert their lock order or lose a charge.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('jesie-ai-budget'))`);
    const account = await trustedActor(tx, actor);
    const original = await lockedRecipe(tx, id, input.expectedRevision, true);
    if (original.deletedAt) return record(original, tx);
    if (original.publishedId) await (await import('../public/read-model')).invalidatePublicReadModel(tx);
    const row = await updateRecipe(tx, original, { deletedAt: new Date(), editorialStatus: 'draft',
      publicationStatus: original.publishedId ? 'unpublished' : 'never_published',
      checks: emptyChecks(), checksRevision: original.revision + 1, approvedRevision: null }, account, 'Przeniesienie przepisu do kosza', 'delete');
    const { stopRecipeAutomationInTransaction } = await import('../ai/recipe-lifecycle');
    await stopRecipeAutomationInTransaction(tx, id);
    if (original.publishedId) await tx.insert(editorialOutbox).values({ id: randomUUID(), recipeId: id, revision: row.revision, event: 'delete' });
    return record(row, tx);
  });
}

async function reserveSlugs(tx: Transaction, id: string, recipe: Recipe) {
  for (const locale of ['pl', 'en'] as const) {
    await tx.insert(editorialSlugs).values({ locale, slug: recipe.slug[locale], recipeId: id }).onConflictDoNothing();
    const [owner] = await tx.select().from(editorialSlugs).where(and(eq(editorialSlugs.locale, locale), eq(editorialSlugs.slug, recipe.slug[locale])));
    if (owner?.recipeId !== id) throw new EditorialError(409, 'SLUG_TAKEN', `Adres ${locale.toUpperCase()} jest już przypisany do innego przepisu.`, undefined, [{ field: `slug.${locale}`, message: 'Wybierz inny adres przepisu.' }]);
  }
}

export async function performRecipeAction(id: string, input: ActionInput, actor: EditorialActor): Promise<EditorialRecord> {
  return getDb().transaction(tx => performRecipeActionInTransaction(tx, id, input, actor));
}

/** System publication is scoped to one new verified daily trend, never a human draft. */
export async function publishVerifiedTrendInTransaction(tx: Transaction, runId: string, id: string, expectedRevision: number,
  expectedHash: string, authorizedOwnerId: string, date: string, publishedAt: Date, freshClock: () => Promise<Date> = async () => publishedAt) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('jesie-ai-budget'))`);
  const { dailyAutomationGate, automaticRecipeForDay } = await import('../trends/automated-publication');
  const gate = await dailyAutomationGate(tx);
  const [day] = await tx.select().from(trendPublicationDays).where(eq(trendPublicationDays.date, date)).for('update');
  const [owner] = await tx.select().from(user).where(eq(user.id, authorizedOwnerId)).for('share');
  if (!gate.enabled || gate.authorizedOwnerId !== authorizedOwnerId || !owner || owner.disabled || owner.role !== 'owner'
    || !day || day.status !== 'pending') throw new EditorialError(403, 'AUTOMATION_AUTHORIZATION_REQUIRED', 'Automatyczna publikacja wymaga aktywnej zgody właściciela.');
  const ready = await automaticRecipeForDay(tx, date, publishedAt);
  if (!ready || ready.run.id !== runId || ready.recipe.id !== id || ready.recipe.revision !== expectedRevision || ready.recipe.contentHash !== expectedHash)
    throw new EditorialError(409, 'AUTOMATION_DRAFT_CHANGED', 'Ten przepis nie jest aktualnym potwierdzonym trendem przeznaczonym do automatycznej publikacji.');
  const original = ready.recipe;
  const accepted = structuredClone(original.content);
  // The system approves its own recipe; no human review/checks are fabricated.
  for (const substitution of accepted.recipe.substitutions ?? []) substitution.status = 'approved';
  const issues = await verifiedPublicationIssues(accepted, tx);
  if (issues.length) throw new EditorialError(422, 'PUBLICATION_BLOCKED', 'Przepis wymaga kompletnej treści i fotografii.', undefined, issues);
  await (await import('../public/read-model')).invalidatePublicReadModel(tx);
  await reserveSlugs(tx, id, accepted.recipe);
  const releasedAt = await freshClock();
  if (releasedAt.getTime() < day.dueAt.getTime()) throw new EditorialError(409, 'PUBLICATION_WINDOW_EARLY', 'Publikacja czeka na 06:00 w Warszawie.');
  if (releasedAt.getTime() >= day.dueAt.getTime() + 3_600_000) throw new EditorialError(409, 'PUBLICATION_WINDOW_EXPIRED', 'Minęło dzisiejsze okno publikacji.');
  const revision = original.revision + 1;
  const publicationId = randomUUID();
  const hash = contentHash(accepted);
  const { contentApprovalHash } = await import('./content-approval');
  const approvalHash = contentApprovalHash(original.content);
  const actor = { ...trendWorker, name: 'System: zweryfikowany trend dnia' };
  // An explicit migration-only field fences inserts emitted by older sleeping
  // workers. Keeping it out of the legacy projection also preserves old readers.
  await tx.execute(sql`INSERT INTO editorial_publication
    (id,recipe_id,revision,snapshot,content_hash,checks,approval_origin,published_at,published_by,published_by_name,content_approval_hash)
    VALUES (${publicationId},${id},${revision},${JSON.stringify(accepted)}::jsonb,${hash},${JSON.stringify(emptyChecks())}::jsonb,
      'automated',${releasedAt},${actor.id},${actor.name},${approvalHash})`);
  const row = await updateRecipe(tx, original, { content: accepted, contentHash: hash, editorialStatus: 'approved', approvedRevision: null,
    checks: emptyChecks(), checksRevision: revision, publicationStatus: 'published', publishedId: publicationId, publishedRevision: revision },
    actor, `Automatyczna publikacja potwierdzonego trendu ${date}; research ${runId}; zgoda właściciela ${owner.id}`, 'automated_publish');
  await tx.insert(editorialOutbox).values({ id: randomUUID(), recipeId: id, revision: row.revision, event: 'automated_publish' });
  return { recipeId: id, publicationId, revision: row.revision, publishedAt: releasedAt };
}

/** Scheduled release of an exact human-reviewed revision; workers never grant approval. */
export async function publishAutomatedTrendInTransaction(tx: Transaction, runId: string | null, id: string, expectedRevision: number,
  expectedHash: string, authorizedOwnerId: string, date: string, publishedAt: Date, freshClock?: () => Promise<Date>) {
  await (await import('../trends/publication-plan')).assertPublicationPlanSelection(tx, date, id, expectedHash);
  const [day] = await tx.select().from(trendPublicationDays).where(eq(trendPublicationDays.date, date)).for('update');
  const gate = await (await import('../trends/publication')).publicationAutomationGate(tx);
  const [settings] = await tx.select().from(trendSettings).where(eq(trendSettings.id, 'global')).for('share');
  const [owner] = await tx.select().from(user).where(eq(user.id, authorizedOwnerId)).for('share');
  if (!day || day.status !== 'pending' || publishedAt.getTime() < day.dueAt.getTime() || publishedAt.getTime() >= day.dueAt.getTime() + 3_600_000
    || !gate.enabled || !settings?.reviewedPublicationEnabled || settings.reviewedPublicationAuthorizedBy !== authorizedOwnerId || !owner || owner.disabled || owner.role !== 'owner')
    throw new EditorialError(403, 'AUTOMATION_AUTHORIZATION_REQUIRED', 'Właściciel musi ponownie zatwierdzić harmonogram.');
  const original = await lockedRecipe(tx, id, expectedRevision);
  const [review] = await tx.select({ audit: editorialAudit, account: user }).from(editorialAudit)
    .innerJoin(user, eq(user.id, editorialAudit.actorId))
    .where(and(eq(editorialAudit.recipeId, id), eq(editorialAudit.revision, expectedRevision), eq(editorialAudit.action, 'approve')))
    .for('share', { of: [user] }).limit(1);
  const [pending] = await tx.select({ id: aiJobs.id }).from(aiJobs).where(and(eq(aiJobs.recipeId, id),
    sql`(${aiJobs.status} in ('queued','submitting','generating','uncertain') OR (${aiJobs.status}='cancelled' AND ${aiJobs.providerFinishedAt} IS NULL) OR (${aiJobs.providerRequestId} IS NOT NULL AND ${aiJobs.providerFinishedAt} IS NULL))`)).limit(1);
  const [run] = runId ? await tx.select().from(trendRuns).where(eq(trendRuns.id, runId)).for('update') : [];
  if (!review || review.account.disabled || !['owner', 'admin'].includes(review.account.role)
    || original.editorialStatus !== 'approved' || original.approvedRevision !== original.revision
    || original.checksRevision !== original.revision || reviewKeys.some(key => !original.checks[key]))
    throw new EditorialError(422, 'AUTOMATION_MANUAL_REVIEW_REQUIRED', 'Publikacja o 06:00 wymaga ręcznego zatwierdzenia i sześciu akceptacji bieżącej wersji.');
  if (pending || (runId && (!run || run.recipeId !== id))
    || original.contentHash !== expectedHash || contentHash(original.content) !== expectedHash
    || original.publishedId || original.publicationStatus !== 'never_published')
    throw new EditorialError(409, 'AUTOMATION_DRAFT_CHANGED', 'Zatwierdzony przepis zmienił się lub został już opublikowany.');
  const accepted = original.content;
  // A scheduler must never accept substitutions or mutate the human-approved snapshot.
  const issues = await verifiedPublicationIssues(accepted, tx);
  if (issues.length || !accepted.recipe.image || accepted.recipe.ingredients.some(item => !accepted.photos.ingredients[item.id]) || accepted.recipe.steps.some(item => isStepPhotoRequired(accepted, item.id) && !accepted.photos.steps[item.id]))
    throw new EditorialError(422, 'PUBLICATION_BLOCKED', 'Publikacja wymaga kompletnej treści i wszystkich fotografii.', undefined, issues);
  await (await import('../public/read-model')).invalidatePublicReadModel(tx);
  await reserveSlugs(tx, id, accepted.recipe);
  // Editor/slug locks may have waited across the deadline. Runtime supplies a
  // fresh database clock at the final publication decision, not the initial check.
  const releasedAt = freshClock ? await freshClock() : publishedAt;
  if (releasedAt.getTime() >= day.dueAt.getTime() + 3_600_000)
    throw new EditorialError(409, 'PUBLICATION_WINDOW_EXPIRED', 'Minęło okno publikacji tego dnia.');
  if (releasedAt.getTime() < day.dueAt.getTime())
    throw new EditorialError(409, 'PUBLICATION_WINDOW_EARLY', 'Publikacja czeka na 06:00 w Warszawie.');
  const publicationId = randomUUID(); const revision = original.revision + 1;
  const scheduledActor = { ...trendWorker, name: 'Publikacja zatwierdzonego przepisu o 06:00' };
  await tx.insert(editorialPublications).values({ id: publicationId, recipeId: id, revision, snapshot: accepted,
    contentHash: expectedHash, checks: original.checks, approvalOrigin: 'manual_scheduled', publishedAt: releasedAt,
    reviewedBy: review.account.id, reviewedByName: review.account.name, reviewedRevision: expectedRevision,
    publishedBy: scheduledActor.id, publishedByName: scheduledActor.name });
  const row = await updateRecipe(tx, original, { editorialStatus: 'approved', approvedRevision: revision,
    checks: original.checks, checksRevision: revision, publicationStatus: 'published', publishedId: publicationId, publishedRevision: revision },
    scheduledActor, `Publikacja ${date} o 06:00 Europe/Warsaw; przegląd wersji ${expectedRevision} przez ${review.account.id}; harmonogram właściciela ${owner.id}`, 'scheduled_publish');
  await tx.insert(editorialOutbox).values({ id: randomUUID(), recipeId: id, revision: row.revision, event: 'scheduled_publish' });
  return { recipeId: id, publicationId, revision: row.revision, publishedAt: releasedAt };
}

/** Same manual publication transaction can also update its private radar record. */
export async function performRecipeActionInTransaction(tx: Transaction, id: string, input: ActionInput, actor: EditorialActor): Promise<EditorialRecord> {
    const account = await trustedActor(tx, actor);
    const original = await lockedRecipe(tx, id, input.expectedRevision, input.action === 'restore_deleted');
    if (original.editorialStatus === 'archived' && !['restore', 'restore_deleted', 'duplicate', 'unpublish'].includes(input.action)) throw new EditorialError(409, 'ARCHIVED', 'Najpierw przywróć przepis z archiwum.');
    const nextRevision = original.revision + 1;
    let values: Partial<typeof editorialRecipes.$inferInsert> = { checksRevision: nextRevision, approvedRevision: original.approvedRevision === original.revision ? nextRevision : null };
    let reason = '';
    let changedPublic = false;
    const issues = await verifiedPublicationIssues(original.content, tx);
    switch (input.action) {
      case 'checks': {
        if (!input.checks || reviewKeys.some(key => typeof input.checks?.[key] !== 'boolean')) throw new EditorialError(422, 'INVALID_CHECKS', 'Przekaż wszystkie sześć akceptacji redakcyjnych.');
        values = { ...values, checks: Object.fromEntries(reviewKeys.map(key => [key, input.checks![key]])) as ReviewChecks, approvedRevision: null, editorialStatus: 'in_review' };
        reason = 'Aktualizacja listy przeglądu';
        break;
      }
      case 'review': values = { ...values, editorialStatus: 'in_review', approvedRevision: null }; reason = 'Przekazanie do przeglądu'; break;
      case 'approve': {
        if (issues.length || original.checksRevision !== original.revision || reviewKeys.some(key => !original.checks[key])) throw new EditorialError(422, 'REVIEW_REQUIRED', 'Rozwiąż braki i zatwierdź wszystkie sześć obszarów bieżącej wersji.', undefined, issues);
        if (original.editorialStatus === 'archived') throw new EditorialError(409, 'ARCHIVED', 'Przywróć przepis z archiwum.');
        values = { ...values, editorialStatus: 'approved', approvedRevision: nextRevision }; reason = 'Ręczne zatwierdzenie przepisu'; break;
      }
      case 'approve_and_publish': {
        if (!input.checks || reviewKeys.some(key => input.checks?.[key] !== true)) throw new EditorialError(422, 'REVIEW_REQUIRED', 'Potwierdź wszystkie sześć obszarów, w tym oba języki, zdjęcia i zamienniki.');
        const accepted = structuredClone(original.content);
        for (const substitution of accepted.recipe.substitutions ?? []) if (substitution.status === 'to_review') substitution.status = 'approved';
        const acceptedIssues = await verifiedPublicationIssues(accepted, tx);
        if (acceptedIssues.length) throw new EditorialError(422, 'PUBLICATION_BLOCKED', 'Przepis wymaga uzupełnienia przed publikacją.', undefined, acceptedIssues);
        await reserveSlugs(tx, id, accepted.recipe);
        const publicationId = randomUUID();
        await tx.insert(editorialPublications).values({ id: publicationId, recipeId: id, revision: nextRevision, snapshot: accepted, contentHash: contentHash(accepted), checks: input.checks, approvalOrigin: 'manual', publishedBy: account.id, publishedByName: account.name });
        values = { ...values, content: accepted, editorialStatus: 'approved', approvedRevision: nextRevision, checks: input.checks, publicationStatus: 'published', publishedId: publicationId, publishedRevision: nextRevision };
        reason = 'Ręczne zatwierdzenie i publikacja'; changedPublic = true; break;
      }
      case 'publish': {
        if (original.editorialStatus !== 'approved' || original.approvedRevision !== original.revision || original.checksRevision !== original.revision || reviewKeys.some(key => !original.checks[key]) || issues.length) throw new EditorialError(422, 'PUBLICATION_BLOCKED', 'Publikacja wymaga zatwierdzenia kompletnej, bieżącej wersji.', undefined, issues);
        await reserveSlugs(tx, id, original.content.recipe);
        const publicationId = randomUUID();
        await tx.insert(editorialPublications).values({ id: publicationId, recipeId: id, revision: nextRevision, snapshot: original.content, contentHash: contentHash(original.content), checks: original.checks, approvalOrigin: 'manual', publishedBy: account.id, publishedByName: account.name });
        values = { ...values, publicationStatus: 'published', publishedId: publicationId, publishedRevision: nextRevision };
        reason = 'Publikacja zatwierdzonej wersji'; changedPublic = true; break;
      }
      case 'unpublish': values = { ...values, publicationStatus: original.publishedId ? 'unpublished' : 'never_published' }; reason = 'Wycofanie publikacji'; changedPublic = true; break;
      case 'archive': values = { ...values, editorialStatus: 'archived', publicationStatus: original.publishedId ? 'unpublished' : 'never_published', approvedRevision: null }; reason = 'Archiwizacja przepisu'; changedPublic = true; break;
      case 'restore_deleted': {
        if (!original.deletedAt) throw new EditorialError(409, 'RECIPE_NOT_DELETED', 'Przepis nie znajduje się w koszu.');
        await rejectIncompatibleIngredientPhotos(original.content, tx);
        values = { ...values, deletedAt: null, editorialStatus: 'draft',
          publicationStatus: original.publishedId ? 'unpublished' : 'never_published',
          checks: emptyChecks(), approvedRevision: null };
        reason = 'Przywrócenie przepisu z kosza do szkiców'; break;
      }
      case 'restore': {
        const version = input.version ?? original.revision;
        const [historical] = await tx.select().from(editorialVersions).where(and(eq(editorialVersions.recipeId, id), eq(editorialVersions.revision, version)));
        if (!historical) throw new EditorialError(404, 'VERSION_NOT_FOUND', 'Nie znaleziono tej wersji przepisu.');
        values = { ...values, content: historical.content, contentHash: historical.contentHash, editorialStatus: 'draft', checks: emptyChecks(), approvedRevision: null };
        reason = `Przywrócenie wersji ${version} do szkicu`; break;
      }
      case 'duplicate': {
        const duplicateId = randomUUID();
        const content = structuredClone(original.content);
        content.recipe.id = duplicateId; content.recipe.slug = { pl: '', en: '' }; content.recipe.title.pl += ' — kopia'; content.recipe.title.en += ' — copy'; content.recipe.featured = false;
        rejectExternalReferences(content);
        await rejectIncompatibleIngredientPhotos(content, tx);
        const [duplicate] = await tx.insert(editorialRecipes).values({ id: duplicateId, content, contentHash: contentHash(content), checks: emptyChecks(), createdBy: account.id, updatedBy: account.id, updatedByName: account.name }).returning();
        await appendHistory(tx, duplicate, account, `Duplikacja przepisu ${id}`, 'duplicate');
        return record(duplicate, tx);
      }
      default: throw new EditorialError(422, 'INVALID_ACTION', 'Nieznana operacja redakcyjna.');
    }
    if (changedPublic) await (await import('../public/read-model')).invalidatePublicReadModel(tx);
    const row = await updateRecipe(tx, original, values, account, reason, input.action);
    if (changedPublic) await tx.insert(editorialOutbox).values({ id: randomUUID(), recipeId: id, revision: row.revision, event: input.action });
    return record(row, tx);
}

/** Public identity is the brand; private editor/source fields never become an author. */
function publicRecipe(content: EditorialContent, publication?: Recipe['publication'], revision?: number): Recipe & { version: string; kitchenVerified: boolean } {
  const { heroPresentation, ...recipe } = content.recipe;
  void heroPresentation;
  const test = content.kitchenTest;
  const kitchenVerified = Boolean(recipe.provenance.kitchenTested && test && /^\d{4}-\d{2}-\d{2}$/.test(test.date) && Number.isFinite(Date.parse(test.date)) && test.tester.trim() && test.notes.trim());
  return { ...recipe, photos: content.photos, ...(publication ? { publication } : {}), version: revision ? String(revision) : publication?.dateModified ?? 'legacy', kitchenVerified };
}

/** Hash only substantive public content, ignoring editorial notes and AI layout instructions. */
export function publicContentHash(content: EditorialContent) {
  const { publication, ...recipe } = toPublicRecipe(publicRecipe(content));
  void publication;
  return createHash('sha256').update(canonical(recipe)).digest('hex');
}

type PublicationHistory = { recipeId: string; snapshot: EditorialContent; publishedAt: Date; revision: number };
export function publicationMetadata(history: PublicationHistory[]): Recipe['publication'] {
  if (!history.length) return undefined;
  const ordered = [...history].sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime() || a.revision - b.revision);
  let previousHash = ''; let modified = ordered[0].publishedAt;
  for (const publication of ordered) {
    const hash = publicContentHash(publication.snapshot);
    if (hash !== previousHash) modified = publication.publishedAt;
    previousHash = hash;
  }
  return { datePublished: new Date(ordered[0].publishedAt).toISOString(), dateModified: new Date(modified).toISOString(), author: 'jesie.pl' };
}

async function publicSnapshots(rows: { recipeId: string; snapshot: EditorialContent; revision: number }[], db: Database | Transaction = getDb()) {
  if (!rows.length) return [];
  for (const row of rows) assertRecipeHasNoExternalReferences(row.snapshot);
  const histories = await db.select({ recipeId: editorialPublications.recipeId, snapshot: editorialPublications.snapshot,
    publishedAt: editorialPublications.publishedAt, revision: editorialPublications.revision })
    .from(editorialPublications).where(inArray(editorialPublications.recipeId, rows.map(row => row.recipeId))).orderBy(asc(editorialPublications.publishedAt));
  const groups = new Map<string, PublicationHistory[]>();
  for (const item of histories) groups.set(item.recipeId, [...(groups.get(item.recipeId) ?? []), item]);
  return rows.map(row => publicRecipe(row.snapshot, publicationMetadata((groups.get(row.recipeId) ?? []).filter(item => item.revision <= row.revision)), row.revision));
}

/** Read only active immutable snapshots; drafts and withdrawn dishes never enter discovery. */
export async function getPublishedRecipes(db: Database | Transaction = getDb()): Promise<Recipe[]> {
  const firstPublication = db.select({ recipeId: editorialPublications.recipeId,
    publishedAt: sql<Date>`min(${editorialPublications.publishedAt})`.as('first_published_at'),
  }).from(editorialPublications).groupBy(editorialPublications.recipeId).as('first_publication');
  const rows = await db.select({ recipeId: editorialRecipes.id, snapshot: editorialPublications.snapshot, revision: editorialPublications.revision }).from(editorialRecipes)
    .innerJoin(editorialPublications, eq(editorialRecipes.publishedId, editorialPublications.id))
    .innerJoin(firstPublication, eq(editorialRecipes.id, firstPublication.recipeId))
    .where(and(eq(editorialRecipes.publicationStatus, 'published'), isNull(editorialRecipes.deletedAt)))
    .orderBy(desc(firstPublication.publishedAt), desc(editorialRecipes.createdAt), desc(editorialRecipes.id));
  return publicSnapshots(rows, db);
}

export async function getPublishedRecipe(slug: string, locale: Locale): Promise<Recipe | null> {
  const db = getDb();
  const rows = await db.select({ recipeId: editorialRecipes.id, snapshot: editorialPublications.snapshot, revision: editorialPublications.revision }).from(editorialSlugs)
    .innerJoin(editorialRecipes, eq(editorialSlugs.recipeId, editorialRecipes.id)).innerJoin(editorialPublications, eq(editorialRecipes.publishedId, editorialPublications.id))
    .where(and(eq(editorialSlugs.locale, locale), eq(editorialSlugs.slug, slug), eq(editorialRecipes.publicationStatus, 'published'), isNull(editorialRecipes.deletedAt))).limit(1);
  return (await publicSnapshots(rows, db))[0] ?? null;
}

export async function getPublishedRecipeById(id: string): Promise<Recipe | null> {
  const db = getDb();
  const rows = await db.select({ recipeId: editorialRecipes.id, snapshot: editorialPublications.snapshot, revision: editorialPublications.revision }).from(editorialRecipes)
    .innerJoin(editorialPublications, eq(editorialRecipes.publishedId, editorialPublications.id))
    .where(and(eq(editorialRecipes.id, id), eq(editorialRecipes.publicationStatus, 'published'), isNull(editorialRecipes.deletedAt))).limit(1);
  return (await publicSnapshots(rows, db))[0] ?? null;
}
