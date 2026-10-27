import 'server-only';
import { start } from 'workflow/api';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { EditorialActor } from '@/lib/editorial-types';
import { reviewKeys } from '@/lib/editorial-types';
import { heroPresentationReviewSchema } from '@/lib/hero-presentation-review';
import { getDb } from '@/server/db';
import { aiJobs, aiPhotoBatches } from '@/server/ai/schema';
import { applyJob, budgetLock, createJobAdmission, failJob, getJob, listJobs } from '@/server/ai/store';
import { samePhotoSubject } from '@/server/ai/photo-subject';
import { applyPhotoBatch, createPhotoBatch, getPhotoBatch, listPhotoBatches } from '@/server/ai/photo-batch';
import { recoverPhotoBatch } from '@/server/ai/photo-batch-recovery';
import { recoverAcceptedPhotoBatchChildren } from '@/server/ai/accepted-photo-batch-recovery';
import { dispatchPhotoBatch } from '@/server/ai/photo-batch-dispatch';
import { aiGeneration } from '@/workflows/ai-generation';
import { approveRecipeContent, isRecipeContentApproved } from './content-approval';
import { EditorialError, getRecipe, getRecipeInTransaction, performRecipeActionInTransaction, verifiedPublicationIssues, type EditorialTransaction } from './store';

const base = { expectedRevision: z.number().int().positive() };
export const preparationInput = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('generate_text'), requestKey: z.string().uuid() }).strict(),
  z.object({ ...base, action: z.literal('apply_text'), jobId: z.string().uuid() }).strict(),
  z.object({ ...base, action: z.literal('approve_content'), heroPresentation: heroPresentationReviewSchema.optional() }).strict(),
  z.object({ ...base, action: z.literal('generate_photos'), requestKey: z.string().uuid() }).strict(),
  z.object({ ...base, action: z.literal('apply_photos'), batchId: z.string().uuid() }).strict(),
  z.object({ ...base, action: z.literal('publish'), checks: z.object({ pl: z.literal(true), en: z.literal(true), quantities: z.literal(true), method: z.literal(true), photos: z.literal(true), sources: z.literal(true) }).strict() }).strict(),
]);
export type PreparationInput = z.infer<typeof preparationInput>;

export async function recipePreparation(id: string) {
  const [recipe, jobs, batches, blockingGeneration] = await Promise.all([getRecipe(id), listJobs(id), listPhotoBatches(id), hasPendingGeneration(id)]);
  const missingBatches = batches.filter(batch => batch.mode === 'missing');
  const captures = missingBatches.length ? await getDb().select({ id: aiPhotoBatches.id, input: aiPhotoBatches.input }).from(aiPhotoBatches).where(and(inArray(aiPhotoBatches.id, missingBatches.map(batch => batch.id)), eq(aiPhotoBatches.recipeId, id))).limit(20) : [];
  const compatible = (batchId: string) => { const capture = captures.find(item => item.id === batchId); return Boolean(capture && samePhotoSubject(capture.input, recipe.content, 'hero', null)); };
  const photoBatch = missingBatches.find(batch => compatible(batch.id)) ?? missingBatches[0] ?? null;
  let textJob = jobs.find(job => job.kind === 'recipe') ?? null;
  const recoveryJobId = textJob?.recovery?.jobId;
  if (textJob && recoveryJobId && recoveryJobId !== textJob.id) {
    // A stopped, never-submitted repair may point back to an accepted parent.
    // Expose that actual result so the normal ready-result action can apply it.
    const recovered = jobs.find(job => job.id === recoveryJobId) ?? await getJob(recoveryJobId);
    if (recovered?.kind === 'recipe' && recovered.recipeId === id && recovered.baseRevision === textJob.baseRevision) textJob = recovered;
  }
  const contentApproved = await isRecipeContentApproved(recipe);
  let issues = recipe.issues;
  if (contentApproved && recipe.content.recipe.substitutions?.some(item => item.status === 'to_review')) {
    const accepted = structuredClone(recipe.content);
    for (const item of accepted.recipe.substitutions ?? []) item.status = 'approved';
    issues = await verifiedPublicationIssues(accepted, getDb());
  }
  return {
    recipe: { ...recipe, issues },
    textJob,
    photoBatch,
    photoBatchCompatible: Boolean(photoBatch && compatible(photoBatch.id)),
    blockingGeneration,
    contentApproved,
  };
}

async function hasPendingGeneration(id: string, db: ReturnType<typeof getDb> | EditorialTransaction = getDb()) {
  const [pending] = await db.select({ id: aiJobs.id }).from(aiJobs).where(and(eq(aiJobs.recipeId, id),
    sql`(${aiJobs.status} in ('queued','submitting','generating','uncertain') OR (${aiJobs.status}='cancelled' AND ${aiJobs.providerFinishedAt} IS NULL) OR (${aiJobs.providerRequestId} IS NOT NULL AND ${aiJobs.providerFinishedAt} IS NULL))`)).limit(1);
  return Boolean(pending);
}

/** One explicit action at a time; generating or applying results never publishes a manual recipe. */
export async function prepareRecipe(id: string, input: PreparationInput, actor: EditorialActor) {
  const current = await recipePreparation(id);
  if (current.recipe.deletedAt) throw new EditorialError(409, 'RECIPE_DELETED', 'Najpierw przywróć przepis z kosza.');
  if (current.recipe.editorialStatus === 'archived') throw new EditorialError(409, 'ARCHIVED', 'Najpierw przywróć przepis z archiwum.');

  // A lost apply response may be retried after that action already advanced the revision.
  if (input.action === 'apply_text') {
    const job = await getJob(input.jobId);
    if (job.recipeId !== id || job.kind !== 'recipe') throw new EditorialError(404, 'RESULT_NOT_FOUND', 'Nie znaleziono propozycji treści dla tego przepisu.');
    if (job.status === 'applied') return current;
  }
  if (input.action === 'apply_photos') {
    const batch = await getPhotoBatch(input.batchId);
    if (batch.recipeId !== id) throw new EditorialError(404, 'RESULT_NOT_FOUND', 'Nie znaleziono grafik dla tego przepisu.');
    if (batch.status === 'applied') return current;
  }
  if (current.recipe.revision !== input.expectedRevision) throw new EditorialError(409, 'REVISION_CONFLICT', 'Przepis zmienił się w innym oknie. Wczytaj aktualną wersję przed następnym krokiem.', current.recipe);

  switch (input.action) {
    case 'generate_text': {
      const existing = current.textJob;
      if (existing?.baseRevision === current.recipe.revision && ['queued', 'submitting', 'generating', 'uncertain', 'ready'].includes(existing.status)) return current;
      const { job, created } = await createJobAdmission({ recipeId: id, expectedRevision: input.expectedRevision, kind: 'recipe',
        brief: 'Zrób research dania wskazanego w tytule i notatkach. Porównaj wiarygodne źródła kulinarne, uzupełnij wszystkie brakujące pola szablonu oraz przygotuj spójny przepis PL i en-GB. Uszanuj zamysł autora. Wyjaśnij w uwagach istotne korekty proporcji, techniki i przyjęte założenia. Nie generuj zdjęć i nie publikuj przepisu.', requestKey: input.requestKey }, actor);
      if (created && job.status === 'queued') {
        try { await start(aiGeneration, [job.id], { region: 'fra1' }); }
        catch { await failJob(job.id, { code: 'AI_DISPATCH_UNCONFIRMED', message: 'Nie potwierdzono uruchomienia zadania. Zachowano zlecenie; nie wysyłaj drugiego generowania.', uncertain: true }); }
      }
      break;
    }
    case 'apply_text':
      await applyJob(input.jobId, { expectedRevision: input.expectedRevision, acknowledgeStale: false }, actor);
      break;
    case 'approve_content':
      await approveRecipeContent(id, input.expectedRevision, actor, input.heroPresentation);
      break;
    case 'generate_photos': {
      if (!current.contentApproved) throw new EditorialError(422, 'CONTENT_REVIEW_REQUIRED', 'Najpierw przeczytaj i zaakceptuj treść przepisu.');
      const existing = current.photoBatch;
      if (existing?.canResume && current.photoBatchCompatible && ['blocked', 'failed'].includes(existing.status)) {
        await recoverAcceptedPhotoBatchChildren(existing.id, actor);
        const resumed = await recoverPhotoBatch(existing.id, actor);
        if (resumed.dispatch) await dispatchPhotoBatch(existing.id, resumed.generation);
      } else {
        const { batch, created, generation } = await createPhotoBatch({ recipeId: id, expectedRevision: input.expectedRevision, requestKey: input.requestKey, mode: 'missing' }, actor);
        if (created && batch.status === 'queued') await dispatchPhotoBatch(batch.id, generation);
      }
      break;
    }
    case 'apply_photos':
      await applyPhotoBatch(input.batchId, input.expectedRevision, actor);
      break;
    case 'publish': {
      if (!input.checks || reviewKeys.some(key => input.checks[key] !== true)) throw new EditorialError(422, 'REVIEW_REQUIRED', 'Potwierdź przegląd obu języków, ilości, kroków, zdjęć i źródeł bieżącej wersji.');
      await getDb().transaction(async tx => {
        // Serialize with generation admission. No new job can appear between
        // the final receipt check and publication of the previewed revision.
        await budgetLock(tx);
        if (await hasPendingGeneration(id, tx)) throw new EditorialError(409, 'GENERATION_PENDING', 'Poczekaj na zakończenie generowania przed publikacją.');
        const recipe = await getRecipeInTransaction(tx, id);
        if (!await isRecipeContentApproved(recipe, tx)) throw new EditorialError(422, 'CONTENT_REVIEW_REQUIRED', 'Najpierw zaakceptuj bieżącą treść przepisu.');
        await performRecipeActionInTransaction(tx, id, { action: 'approve_and_publish', expectedRevision: input.expectedRevision,
          checks: input.checks }, actor);
      });
      break;
    }
  }
  return recipePreparation(id);
}
