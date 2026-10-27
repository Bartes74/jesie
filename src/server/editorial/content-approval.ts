import 'server-only';
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { EditorialActor, EditorialContent, EditorialRecord } from '@/lib/editorial-types';
import { reviewKeys } from '@/lib/editorial-types';
import { heroPresentationProfile, resolveHeroPresentation, type HeroPresentation } from '@/lib/hero-presentation';
import { heroPresentationReviewSchema, type HeroPresentationReview } from '@/lib/hero-presentation-review';
import { getDb } from '@/server/db';
import { user } from '@/server/db/auth-schema';
import { editorialAudit, editorialRecipes, editorialVersions } from '@/server/db/schema';
import { editorialContentApprovals } from './content-approval-schema';
import { EditorialError, saveRecipeInTransaction, type EditorialTransaction } from './store';
import { aiJobs, aiPhotoBatches } from '../ai/schema';
import type { VerifiedIngredientDictionary } from '@/lib/recipe-diet';
import { getRecipeVerifiedAliases } from '../ai/recipe-ingredient-dictionary';
import { editorialContentSchema, publicationIssues } from './validation';

type RecipeRow = typeof editorialRecipes.$inferSelect;
type ApprovalRecipe = Pick<EditorialRecord, 'id' | 'revision' | 'content' | 'editorialStatus'> & { deletedAt?: string | Date | null };
type Database = ReturnType<typeof getDb> | EditorialTransaction;
type ApprovalRow = typeof editorialContentApprovals.$inferSelect;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Culinary content and its evidence, independent of photos and delivery metadata. */
export function contentApprovalHash(content: EditorialContent): string {
  const { image, imageAlt, featured, collection, trendConfirmedAt, seo, heroPresentation, substitutions, dietaryTags, diet, ...recipe } = content.recipe;
  void image; void imageAlt; void featured; void collection; void trendConfirmedAt;
  void heroPresentation;
  // Diet is an ingredient-derived index; the actual ingredients remain hashed.
  void diet;
  const presentation = resolveHeroPresentation(content.recipe);
  const concept = presentation ? { container: presentation.container, finalAppearance: presentation.finalAppearance, evidenceStepIds: presentation.evidenceStepIds } : presentation;
  return createHash('sha256').update(canonical({
    recipe: { ...recipe, heroPresentation: concept,
      substitutions: substitutions?.map(({ status, ...substitution }) => { void status; return substitution; }),
      dietaryTags: dietaryTags.map(({ status, ...tag }) => { void status; return tag; }),
      questions: seo?.questions,
    },
    originalText: content.originalText, author: content.author, sources: content.sources, kitchenTest: content.kitchenTest,
  })).digest('hex');
}

/** Validate all supplied cooking text, including substitutions, before any photos. */
export function recipeContentIssues(content: EditorialContent, verifiedAliases?: VerifiedIngredientDictionary) {
  const parsed = editorialContentSchema.safeParse(content);
  if (!parsed.success) return parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message }));
  const tested = structuredClone(content);
  for (const substitution of tested.recipe.substitutions ?? []) substitution.status = 'approved';
  return publicationIssues(tested, undefined, undefined, verifiedAliases).filter(issue => issue.field !== 'image' && !issue.field.startsWith('imageAlt.')
    && !/^(?:ingredients|steps)\.[^.]+\.photo(?:\.|$)/.test(issue.field));
}

function assertActive(recipe: ApprovalRecipe) {
  if (recipe.deletedAt) throw new EditorialError(409, 'RECIPE_DELETED', 'Najpierw przywróć przepis z kosza.');
  if (recipe.editorialStatus === 'archived') throw new EditorialError(409, 'ARCHIVED', 'Najpierw przywróć przepis z archiwum.');
}

async function assertComplete(recipe: ApprovalRecipe, db: Database) {
  assertActive(recipe);
  const verifiedAliases = await getRecipeVerifiedAliases(recipe.content.recipe.ingredients, db);
  const issues = recipeContentIssues(recipe.content, verifiedAliases);
  if (issues.length) throw new EditorialError(422, 'CONTENT_REVIEW_REQUIRED', 'Uzupełnij i sprawdź treść przepisu przed generowaniem zdjęć.', undefined, issues);
}

function dto(row: ApprovalRow) {
  return { recipeId: row.recipeId, contentHash: row.contentHash, origin: row.origin, approvedAt: row.approvedAt.toISOString(), approvedBy: row.actorId };
}

/** Preserve provider-generated evidence privately; missing legacy evidence uses the current method. */
export function reviewedHeroPresentation(content: EditorialContent, review: HeroPresentationReview): HeroPresentation {
  const parsed = heroPresentationReviewSchema.safeParse(review);
  if (!parsed.success) throw new EditorialError(422, 'INVALID_HERO_PRESENTATION', 'Sprawdź naczynie i opis gotowej potrawy w obu językach.', undefined,
    parsed.error.issues.map(issue => ({ field: `heroPresentation.${issue.path.join('.')}`, message: issue.message })));
  const stepIds = content.recipe.steps.map(step => step.id);
  const currentIds = new Set(stepIds);
  const captured = resolveHeroPresentation(content.recipe)?.evidenceStepIds ?? content.recipe.heroPresentation?.evidenceStepIds;
  const evidenceStepIds = Array.isArray(captured) && captured.length > 0 && new Set(captured).size === captured.length && captured.every(id => currentIds.has(id))
    ? [...captured] : [...new Set(stepIds)];
  return { ...parsed.data, evidenceStepIds, profileVersion: heroPresentationProfile };
}

export async function approveRecipeContent(id: string, expectedRevision: number, actor: EditorialActor, presentation?: HeroPresentationReview) {
  return getDb().transaction(async tx => {
    // Generation admission and publication take this lock before recipe rows.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('jesie-ai-budget'))`);
    const [account] = await tx.select().from(user).where(eq(user.id, actor.id)).for('share');
    if (!account || account.disabled || !['owner', 'admin'].includes(account.role)) throw new EditorialError(403, 'FORBIDDEN', 'To konto nie ma uprawnień do redakcji.');
    const [stored] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, id)).for('update');
    let recipe: ApprovalRecipe | undefined = stored;
    if (!recipe) throw new EditorialError(404, 'NOT_FOUND', 'Nie znaleziono przepisu.');
    if (!Number.isSafeInteger(expectedRevision) || recipe.revision !== expectedRevision) throw new EditorialError(409, 'REVISION_CONFLICT', 'Przepis zmienił się. Odśwież treść przed akceptacją.');
    assertActive(recipe);
    if (presentation !== undefined) {
      const content = structuredClone(recipe.content);
      content.recipe.heroPresentation = reviewedHeroPresentation(content, presentation);
      // Validate before saving, and roll back both operations if any later gate fails.
      await assertComplete({ ...recipe, content }, tx);
      if (canonical(content.recipe.heroPresentation) !== canonical(recipe.content.recipe.heroPresentation)) {
        const [pending] = await tx.select({ id: aiJobs.id }).from(aiJobs).where(and(eq(aiJobs.recipeId, id),
          sql`(${aiJobs.status} in ('queued','submitting','generating','uncertain') OR (${aiJobs.status}='cancelled' AND ${aiJobs.providerFinishedAt} IS NULL) OR (${aiJobs.providerRequestId} IS NOT NULL AND ${aiJobs.providerFinishedAt} IS NULL))`)).limit(1);
        const [pendingBatch] = pending ? [] : await tx.select({ id: aiPhotoBatches.id }).from(aiPhotoBatches).where(and(eq(aiPhotoBatches.recipeId, id), inArray(aiPhotoBatches.status, ['queued', 'generating']))).limit(1);
        if (pending || pendingBatch) throw new EditorialError(409, 'GENERATION_PENDING', 'Poczekaj na zakończenie generowania przed zmianą opisu gotowej potrawy.');
        recipe = await saveRecipeInTransaction(tx, id, { expectedRevision, content }, actor);
      }
    }
    await assertComplete(recipe, tx);
    const contentHash = contentApprovalHash(recipe.content);
    await tx.insert(editorialContentApprovals).values({ recipeId: id, contentHash, origin: 'manual', revision: recipe.revision, actorId: account.id, actorName: account.name }).onConflictDoNothing();
    const [approval] = await tx.select().from(editorialContentApprovals).where(and(eq(editorialContentApprovals.recipeId, id), eq(editorialContentApprovals.contentHash, contentHash), eq(editorialContentApprovals.origin, 'manual')));
    return dto(approval);
  });
}

/** Compatibility entry point for old callers; every new approval is a human action. */
export async function approveAutomatedRecipeContentInTransaction(tx: EditorialTransaction, recipe: ApprovalRecipe | RecipeRow, actorId: string): Promise<never> {
  void tx; void recipe; void actorId;
  throw new EditorialError(410, 'MANUAL_CONTENT_REVIEW_REQUIRED', 'Akceptacja automatyczna jest wyłączona. Treść wymaga ręcznego sprawdzenia i akceptacji.');
}

/** Legacy approval is trusted only with an actual human audit/publication receipt. */
async function hasLegacyManualApproval(recipe: ApprovalRecipe, db: Database) {
  const [current] = await db.select().from(editorialRecipes).where(eq(editorialRecipes.id, recipe.id));
  if (!current || current.revision !== recipe.revision || current.deletedAt || current.editorialStatus !== 'approved'
    || current.approvedRevision !== current.revision || current.checksRevision !== current.revision || reviewKeys.some(key => !current.checks[key])
    || contentApprovalHash(current.content) !== contentApprovalHash(recipe.content)) return false;
  const reviews = await db.select({ audit: editorialAudit, account: user }).from(editorialAudit).innerJoin(user, eq(user.id, editorialAudit.actorId))
    .where(and(eq(editorialAudit.recipeId, recipe.id), inArray(editorialAudit.action, ['approve', 'approve_and_publish']), eq(user.disabled, false), inArray(user.role, ['owner', 'admin']))).orderBy(desc(editorialAudit.revision));
  for (const { audit } of reviews) {
    if (audit.revision === recipe.revision) return true;
    // publish/unpublish may advance the revision without changing approved food.
    const [version] = await db.select().from(editorialVersions).where(and(eq(editorialVersions.recipeId, recipe.id), eq(editorialVersions.revision, audit.revision))).limit(1);
    if (version && contentApprovalHash(version.content) === contentApprovalHash(recipe.content)) return true;
  }
  return false;
}

/** New preparation accepts human review only; historical system receipts remain history. */
export async function isRecipeContentApproved(recipe: ApprovalRecipe | RecipeRow, db: Database = getDb()): Promise<boolean> {
  if (recipe.deletedAt || recipe.editorialStatus === 'archived') return false;
  const [approval] = await db.select().from(editorialContentApprovals).where(and(eq(editorialContentApprovals.recipeId, recipe.id), eq(editorialContentApprovals.contentHash, contentApprovalHash(recipe.content)), eq(editorialContentApprovals.origin, 'manual'))).limit(1);
  return Boolean(approval) || hasLegacyManualApproval(recipe, db);
}

/** Exact origin-specific evidence, without inferring an origin from legacy audits. */
export async function hasRecipeContentApproval(tx: EditorialTransaction, recipe: ApprovalRecipe | RecipeRow, origin?: 'manual' | 'automated'): Promise<boolean> {
  if (recipe.deletedAt || recipe.editorialStatus === 'archived') return false;
  const [approval] = await tx.select().from(editorialContentApprovals).where(and(eq(editorialContentApprovals.recipeId, recipe.id),
    eq(editorialContentApprovals.contentHash, contentApprovalHash(recipe.content)), origin ? eq(editorialContentApprovals.origin, origin) : undefined)).limit(1);
  return Boolean(approval);
}

export async function requireRecipeContentApproval(tx: EditorialTransaction, recipe: ApprovalRecipe | RecipeRow): Promise<void> {
  assertActive(recipe);
  if (!await isRecipeContentApproved(recipe, tx)) throw new EditorialError(409, 'CONTENT_APPROVAL_REQUIRED', 'Najpierw sprawdź i zaakceptuj treść przepisu, a następnie wygeneruj brakujące grafiki.');
}
