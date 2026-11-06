import 'server-only';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { EditorialActor } from '@/lib/editorial-types';
import { recipeDietIds } from '@/lib/recipe-diet';
import { getDb } from '@/server/db';
import { editorialRecipes } from '@/server/db/schema';
import { editorialContentSchema } from '@/server/editorial/validation';
import { EditorialError } from '@/server/editorial/store';
import { contentApprovalHash } from '@/server/editorial/content-approval';
import { aiJobs } from './schema';
import { budgetLock, getJobForExecution, trustedActor } from './store';
import { recipeResponses, recipeManualRepairs, type ReviewedRecipeIngredient } from './recipe-checkpoint-schema';
import { checkpointConflict, getRecipeResponse, latestManualRecipeRepair, retainRecipeResponse, reviewedIngredientDictionary } from './recipe-checkpoint';
import { buildRecipeProposal, capturedRecipeProposalSchema, normalizeRecipeProposal, recipeResearchVersion } from './recipe-proposal';
import { recipeRecoveryReadableState, recipeRecoverySubmission } from './recipe-recovery-state';
import { recipeResearchSources } from './recipe-research';
import { getRecipeVerifiedAliases } from './recipe-ingredient-dictionary';
import { retrieveRetainedRecipeResponse } from './text-provider';
import { AiError } from './errors';
import { ProviderError } from './provider-error';

export const manualRecipeRepairInput = z.object({
  expectedRevision: z.number().int().positive(), expectedVersion: z.number().int().nonnegative(),
  proposal: z.record(z.string(), z.unknown()), reason: z.string().trim().min(10).max(2000),
  reviewedIngredients: z.array(z.object({ ingredientId: z.string().min(1).max(100), diet: z.enum(recipeDietIds) }).strict()).max(100),
}).strict();
export type ManualRecipeRepairInput = z.infer<typeof manualRecipeRepairInput>;

async function responseFor(jobId: string) {
  const job = await getJobForExecution(jobId);
  if (job.kind !== 'recipe' || !job.providerRequestId) throw new AiError(409, 'RECIPE_RECOVERY_RECEIPT_REQUIRED', 'Ten etap nie ma jeszcze zapisanego wyniku przepisu.');
  const cached = await getRecipeResponse(job.providerRequestId);
  if (cached) return cached;
  const response = await retrieveRetainedRecipeResponse(job.providerRequestId);
  if (response.status !== 'completed') throw new AiError(409, 'RECIPE_RESULT_PENDING', 'Generator jeszcze nie zakończył odpowiedzi. Sprawdź ponownie za chwilę.');
  await retainRecipeResponse(job.id, response);
  return response;
}

export async function recipeManualRepairView(id: string) {
  const job = await getJobForExecution(id);
  const [response, repair, state] = await Promise.all([responseFor(id), latestManualRecipeRepair(id), recipeRecoveryReadableState(id)]);
  let proposal: unknown;
  try { proposal = normalizeRecipeProposal(JSON.parse(response.output_text)); }
  catch { proposal = {}; }
  const { ancestorRequestIds } = await recipeRecoverySubmission(id);
  const ancestors = await Promise.all(ancestorRequestIds.map(async requestId => {
    const cached = await getRecipeResponse(requestId);
    if (cached) return cached;
    const [ancestor] = await getDb().select({ id: aiJobs.id }).from(aiJobs).where(eq(aiJobs.providerRequestId, requestId)).limit(1);
    if (!ancestor) throw new AiError(409, 'AI_REPAIR_LINEAGE_INVALID', 'Brakuje wcześniejszego etapu tego przepisu.');
    return responseFor(ancestor.id);
  }));
  const output = [...ancestors.flatMap(item => item.output), ...response.output];
  const evidenceUrls = new Set<string>();
  for (const item of output) {
    if (item.type === 'web_search_call' && item.status === 'completed') {
      if (item.action.type === 'search') for (const source of item.action.sources ?? []) evidenceUrls.add(source.url);
      if (item.action.type === 'open_page' && item.action.url) evidenceUrls.add(item.action.url);
    }
    if (item.type === 'message') for (const part of item.content) if (part.type === 'output_text')
      for (const annotation of part.annotations) if (annotation.type === 'url_citation') evidenceUrls.add(annotation.url);
  }
  return { jobId: job.id, recipeId: job.recipeId, expectedRevision: job.baseRevision, version: repair?.version ?? 0,
    proposal: repair?.proposal ?? proposal, reviewedIngredients: repair?.reviewedIngredients ?? [], reason: repair?.reason ?? '',
    evidenceUrls: [...evidenceUrls].filter(url => /^https:\/\//.test(url)),
    canEdit: !job.result && ['failed', 'uncertain'].includes(job.status) && (!state.entry || state.entry.jobId === id),
    issues: state.entry?.failureIssues ?? [], output };
}

/** Local correction, with an immutable audit. It buys no request and never approves or publishes a recipe. */
export async function saveManualRecipeRepair(id: string, input: ManualRecipeRepairInput, actor: EditorialActor) {
  const view = await recipeManualRepairView(id);
  return getDb().transaction(async tx => {
    await budgetLock(tx);
    const account = await trustedActor(tx, actor.id);
    const [job] = await tx.select().from(aiJobs).where(eq(aiJobs.id, id)).for('update');
    if (!job || job.kind !== 'recipe' || job.result || !['failed', 'uncertain'].includes(job.status))
      throw new AiError(409, 'RECIPE_REPAIR_STATE_CHANGED', 'Ten etap już trwa albo ma gotowy wynik. Odśwież jego stan.');
    const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, job.recipeId)).for('share');
    if (!recipe || recipe.deletedAt || recipe.editorialStatus === 'archived') throw new AiError(409, 'RECIPE_UNAVAILABLE', 'Najpierw przywróć przepis do edycji.');
    if (recipe.revision !== input.expectedRevision || recipe.revision !== job.baseRevision
      || contentApprovalHash(recipe.content) !== contentApprovalHash(job.input)) throw new AiError(409, 'STALE_RESULT', 'Szkic zmienił się od rozpoczęcia generowania. Zachowano treść; porównaj bieżącą wersję.');
    const previous = await latestManualRecipeRepair(id, tx);
    if ((previous?.version ?? 0) !== input.expectedVersion) checkpointConflict();
    const readable = await recipeRecoveryReadableState(id, tx);
    if (readable.entry && readable.entry.jobId !== id) throw new AiError(409, 'RECIPE_REPAIR_SUPERSEDED', 'Ten wynik ma nowszy etap poprawki. Otwórz bieżące zadanie, aby je wznowić.');
    const parsed = capturedRecipeProposalSchema(job.input).safeParse(normalizeRecipeProposal(input.proposal));
    if (!parsed.success) throw new EditorialError(422, 'INVALID_RECIPE_REPAIR', 'Uzupełnij wskazane pola zachowanego przepisu.', undefined,
      parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })));
    const reviews: ReviewedRecipeIngredient[] = input.reviewedIngredients.map(review => {
      const ingredient = parsed.data.ingredients.find(item => item.id === review.ingredientId);
      if (!ingredient) throw new AiError(422, 'INGREDIENT_NOT_FOUND', 'Sprawdzany składnik nie występuje w tej wersji przepisu.');
      return { ...review, name: ingredient.name };
    });
    const ingredients = parsed.data.ingredients.map(({ note, ...item }) => ({ ...item, ...(note ? { note } : {}) }));
    const aliases = reviewedIngredientDictionary(ingredients, reviews,
      await getRecipeVerifiedAliases(ingredients, tx, job.recipeId));
    try {
      const { researchSources, ...fields } = parsed.data as Record<string, unknown>;
      const research = job.input.aiPhotography?.recipeResearchVersion === recipeResearchVersion;
      const candidate = buildRecipeProposal(research ? fields : parsed.data, job.input, aliases);
      // Human review may resolve composition, never override contradictory animal evidence.
      editorialContentSchema.parse(candidate.content);
      if (research) recipeResearchSources(view.output, researchSources, job.input.sources);
    } catch (error) {
      if (error instanceof ProviderError) throw new EditorialError(422, 'INVALID_RECIPE_REPAIR', error.message, undefined, error.issues);
      throw error;
    }
    const [saved] = await tx.insert(recipeManualRepairs).values({ id: randomUUID(), jobId: id, recipeId: job.recipeId,
      version: input.expectedVersion + 1, proposal: parsed.data, reviewedIngredients: reviews, reason: input.reason,
      actorId: account.id, actorName: account.name }).returning();
    const [checkpoint] = await tx.select({ jobId: recipeResponses.jobId }).from(recipeResponses).where(eq(recipeResponses.jobId, id));
    if (!checkpoint) throw new AiError(409, 'AI_CHECKPOINT_MISSING', 'Brakuje zapisanego punktu wznowienia. Odśwież wynik przed korektą.');
    return { version: saved.version, jobId: id };
  });
}
