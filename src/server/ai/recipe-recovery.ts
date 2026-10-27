import 'server-only';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { EditorialActor } from '@/lib/editorial-types';
import { getDb } from '@/server/db';
import { editorialRecipes } from '@/server/db/schema';
import { contentApprovalHash } from '@/server/editorial/content-approval';
import { requireTrendScope } from '@/server/trends/actor';
import { trendRuns } from '@/server/trends/schema';
import { reserveTrendPreparationAmountInTransaction } from '@/server/trends/store';
import { aiSettings, recipeGenerationReservationUsd } from './config';
import { AiError } from './errors';
import { aiJobs, aiRecipeRecoveries } from './schema';
import { budgetLock, createJobAdmission, jobDto, trustedActor, type AiTransaction } from './store';
import { confirmedInvalidRecipe, hasUnrecognisedDietaryIngredient, recipeReceiptCanBeRead, recipeRepairLimit } from './recipe-recovery-policy';
import { recipeRecoveryLineage, recipeRecoveryReadableState } from './recipe-recovery-state';

export type RecipeRecoveryOperation = { jobId: string; generation: number; attempt: number; created: boolean; continue: boolean; reason?: string };
export type RecipeRecoveryEvidence = { generation: number; workflowRunId: string | null; status: 'terminated' | 'missing' };

async function noOtherPending(tx: AiTransaction, recipeId: string, jobId: string) {
  const [pending] = await tx.select({ id: aiJobs.id }).from(aiJobs).where(and(eq(aiJobs.recipeId, recipeId), ne(aiJobs.id, jobId), isNull(aiJobs.result),
    sql`(${aiJobs.status} IN ('queued','submitting','generating','uncertain') OR (${aiJobs.providerRequestId} IS NOT NULL AND ${aiJobs.providerFinishedAt} IS NULL) OR (${aiJobs.status}='cancelled' AND ${aiJobs.providerFinishedAt} IS NULL))`)).limit(1);
  if (pending) throw new AiError(409, 'GENERATION_PENDING', 'Inne zlecenie tego przepisu nadal wymaga zakończenia lub odczytu. Zachowano istniejące wyniki; nie rozpoczęto kolejnej generacji.');
}

/** No provider call occurs here. Its separately billed child and lineage commit together. */
export async function admitRecipeRepair(parentId: string, generation: number, workflowRunId: string, expectedTrendGeneration?: number): Promise<RecipeRecoveryOperation> {
  return getDb().transaction(async tx => {
    await budgetLock(tx);
    const [parent] = await tx.select().from(aiJobs).where(eq(aiJobs.id, parentId)).for('update');
    if (!parent) throw new AiError(404, 'JOB_NOT_FOUND', 'Nie znaleziono generowania.');
    const lineage = await recipeRecoveryLineage(parentId, tx);
    const stop = async (reason?: string, code = 'RECIPE_RECOVERY_BLOCKED'): Promise<RecipeRecoveryOperation> => {
      if (lineage && reason) await tx.update(aiRecipeRecoveries).set({ blockedCode: code, blockedMessage: reason, updatedAt: new Date() }).where(eq(aiRecipeRecoveries.jobId, parentId));
      return { jobId: parentId, generation, attempt: lineage?.entry.attempt ?? 0, created: false, continue: false, reason };
    };
    if (!lineage || lineage.entry.generation !== generation || lineage.entry.workflowRunId && lineage.entry.workflowRunId !== workflowRunId) return stop();
    if (lineage.latest.attempt > lineage.entry.attempt) {
      const readable = await recipeRecoveryReadableState(parentId, tx);
      if (readable.entry?.jobId !== lineage.latest.jobId) return stop();
      return { jobId: lineage.latest.jobId, generation: lineage.latest.generation,
        attempt: lineage.latest.attempt, created: false, continue: !lineage.latest.workflowRunId || lineage.latest.workflowRunId === workflowRunId };
    }
    if (!confirmedInvalidRecipe(parent)) return stop();
    // Old rows may still be marked repairable by a previous application version.
    if (hasUnrecognisedDietaryIngredient(lineage.entry.failureIssues)) return stop(
      'Aplikacja nie rozpoznaje składnika potrzebnego do klasyfikacji dania. Zachowano wynik; automatyczne płatne poprawki są wstrzymane.',
      'RECIPE_DIET_VOCABULARY_UNSUPPORTED');
    if (!lineage.entry.repairable || !lineage.entry.failureIssues.length) return stop();
    if (lineage.entry.attempt >= recipeRepairLimit) return stop('Wykorzystano dwie próby poprawy przepisu.', 'RECIPE_REPAIR_EXHAUSTED');
    const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, parent.recipeId)).for('share');
    if (!recipe || recipe.deletedAt || recipe.editorialStatus === 'archived') return stop('Przepis jest usunięty lub zarchiwizowany. Zachowano wynik.');
    if (recipe.revision !== parent.baseRevision || contentApprovalHash(recipe.content) !== contentApprovalHash(parent.input))
      return stop('Przepis zmienił się od rozpoczęcia opracowania. Poprawka nie nadpisze bieżącej treści.', 'STALE_RESULT');
    if (parent.trendRunId) {
      const [scope] = await tx.select().from(trendRuns).where(eq(trendRuns.id, parent.trendRunId)).for('update');
      if (!scope || scope.status !== 'generating' || scope.recipeId !== parent.recipeId || scope.generation !== expectedTrendGeneration)
        return stop('Przygotowanie trendu jest wstrzymane lub zostało zastąpione. Zachowano wynik; kontynuuj bieżący przebieg.', 'TREND_SUPERSEDED');
    }
    const account = await trustedActor(tx, parent.createdBy, parent.trendRunId, parent.recipeId);
    if (aiSettings().recipeModel !== parent.model) return stop('Konfiguracja modelu zmieniła się. Rozpocznij opracowanie bieżącej wersji przepisu.', 'RECIPE_MODEL_CHANGED');
    await noOtherPending(tx, parent.recipeId, parent.id);
    let trendGeneration: number | undefined;
    if (parent.trendRunId) {
      const run = await requireTrendScope(tx, parent.trendRunId, parent.recipeId);
      trendGeneration = run.generation;
      await reserveTrendPreparationAmountInTransaction(tx, run.id, recipeGenerationReservationUsd(), run.generation);
    }
    const attempt = lineage.entry.attempt + 1;
    const admission = await createJobAdmission({ recipeId: parent.recipeId, expectedRevision: parent.baseRevision, kind: 'recipe',
      brief: parent.brief, requestKey: `recipe_repair_${parent.id}` }, account, parent.trendRunId ?? undefined,
    { transaction: tx, recipeRepairParentId: parent.id, ...(trendGeneration !== undefined ? { generation: trendGeneration } : {}) });
    await tx.insert(aiRecipeRecoveries).values({ jobId: admission.job.id, rootJobId: lineage.entry.rootJobId, parentJobId: parent.id, attempt, trendGeneration,
      repairIssues: lineage.entry.failureIssues, workflowRunId, dispatchClaimedAt: new Date() });
    await tx.update(aiRecipeRecoveries).set({ blockedCode: null, blockedMessage: null, updatedAt: new Date() }).where(eq(aiRecipeRecoveries.jobId, parent.id));
    // The original workflow now owns this child, even if the step response is lost.
    return { jobId: admission.job.id, generation: 1, attempt, created: admission.created, continue: true };
  });
}

/** Explicit recovery first revalidates the old receipt. A failed job can never POST again. */
export async function beginRecipeResultRecovery(id: string, actor: EditorialActor, evidence?: RecipeRecoveryEvidence, options: { existingOnly?: boolean } = {}) {
  return getDb().transaction(async tx => {
    await budgetLock(tx);
    await trustedActor(tx, actor.id);
    const readable = await recipeRecoveryReadableState(id, tx);
    const latestId = readable.entry?.jobId ?? id;
    const [job] = await tx.select().from(aiJobs).where(eq(aiJobs.id, latestId)).for('update');
    if (!job) throw new AiError(404, 'JOB_NOT_FOUND', 'Nie znaleziono generowania.');
    if (job.kind !== 'recipe' || job.provider !== 'openai') throw new AiError(409, 'RECIPE_RECOVERY_SCOPE', 'To zlecenie nie dotyczy treści przepisu.');
    const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, job.recipeId)).for('share');
    if (!recipe || recipe.deletedAt || recipe.editorialStatus === 'archived') throw new AiError(409, 'RECIPE_UNAVAILABLE', 'Najpierw przywróć przepis do edycji.');
    if (recipe.revision !== job.baseRevision || contentApprovalHash(recipe.content) !== contentApprovalHash(job.input))
      throw new AiError(409, 'STALE_RESULT', 'Przepis zmienił się od rozpoczęcia generowania. Zachowano wynik; opracuj bieżącą wersję.');
    const entry = readable.entry;
    if (job.result && ['ready', 'applied'].includes(job.status)) return { job: jobDto(job), generation: entry?.generation ?? 1, dispatch: false };
    if (options.existingOnly && !job.providerRequestId)
      throw new AiError(409, 'RECIPE_RECOVERY_RECEIPT_REQUIRED', 'Brak zapisanego wyniku do sprawdzenia. Nie uruchomiono nowej generacji.');
    // The cap limits separately billed repair children, not reading an accepted
    // receipt again. Local validation may have been corrected since this result
    // failed; admitRecipeRepair still prevents a third repair after this read.
    const currentlyReading = job.kind === 'recipe' && job.provider === 'openai' && job.status === 'generating' && job.providerRequestId && !job.result;
    const unsentChild = Boolean(entry && entry.attempt > 0 && job.status === 'queued' && !job.providerRequestId && !job.result);
    if (!recipeReceiptCanBeRead(job) && !currentlyReading && !unsentChild || job.status === 'failed' && !job.providerFinishedAt)
      throw new AiError(409, 'RECIPE_RECOVERY_RECEIPT_REQUIRED', 'Naprawa wymaga zapisanego identyfikatora istniejącego wyniku. Nie wysłano nowej generacji.');
    await noOtherPending(tx, job.recipeId, job.id);
    if (entry?.workflowRunId) {
      if (!evidence || evidence.status !== 'terminated' || evidence.generation !== entry.generation || evidence.workflowRunId !== entry.workflowRunId)
        return { job: jobDto(job), generation: entry.generation, dispatch: false };
    } else if (entry?.dispatchClaimedAt && new Date().getTime() - entry.dispatchClaimedAt.getTime() < 120_000) {
      return { job: jobDto(job), generation: entry.generation, dispatch: false };
    }
    const generation = entry ? entry.generation + 1 : 1;
    if (entry) await tx.update(aiRecipeRecoveries).set({ generation, workflowRunId: null, dispatchClaimedAt: new Date(), blockedCode: null, blockedMessage: null, updatedAt: new Date() }).where(eq(aiRecipeRecoveries.jobId, job.id));
    else await tx.insert(aiRecipeRecoveries).values({ jobId: job.id, rootJobId: job.id, attempt: 0, dispatchClaimedAt: new Date() });
    const [updated] = await tx.update(aiJobs).set({ status: unsentChild ? 'queued' : 'generating', errorCode: null, errorMessage: null, updatedAt: new Date() }).where(eq(aiJobs.id, job.id)).returning();
    return { job: jobDto(updated), generation, dispatch: true };
  });
}

export async function recordRecipeRecoveryDispatch(id: string, generation: number, runId: string) {
  return getDb().transaction(async tx => {
    await budgetLock(tx);
    await tx.update(aiRecipeRecoveries).set({ workflowRunId: runId, updatedAt: new Date() }).where(and(eq(aiRecipeRecoveries.jobId, id),
      eq(aiRecipeRecoveries.generation, generation), sql`(${aiRecipeRecoveries.workflowRunId} IS NULL OR ${aiRecipeRecoveries.workflowRunId}=${runId})`));
  });
}

/** A lost response cannot stop a worker that has already persisted its claim. */
export async function markRecipeRecoveryDispatchUnconfirmed(id: string, generation: number) {
  return getDb().transaction(async tx => {
    await budgetLock(tx);
    const [entry] = await tx.select().from(aiRecipeRecoveries).where(eq(aiRecipeRecoveries.jobId, id)).for('update');
    if (!entry || entry.generation !== generation || entry.workflowRunId) return;
    const message = 'Nie potwierdzono uruchomienia odczytu. Zachowano to samo zlecenie; ponów sprawdzenie za dwie minuty.';
    await tx.update(aiRecipeRecoveries).set({ blockedCode: 'AI_RECOVERY_DISPATCH_UNCONFIRMED', blockedMessage: message, updatedAt: new Date() }).where(eq(aiRecipeRecoveries.jobId, id));
    await tx.update(aiJobs).set({ status: 'uncertain', errorCode: 'AI_RECOVERY_DISPATCH_UNCONFIRMED', errorMessage: message, updatedAt: new Date() })
      .where(and(eq(aiJobs.id, id), isNull(aiJobs.result), eq(aiJobs.status, 'generating')));
  });
}
