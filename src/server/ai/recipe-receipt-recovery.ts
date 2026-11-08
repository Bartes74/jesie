import 'server-only';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { EditorialActor } from '@/lib/editorial-types';
import { getDb } from '@/server/db';
import { editorialAudit, editorialRecipes } from '@/server/db/schema';
import { contentApprovalHash } from '@/server/editorial/content-approval';
import { aiJobs } from './schema';
import { budgetLock, getJobForExecution, trustedActor } from './store';
import { retrieveRetainedRecipeResponse } from './text-provider';
import { retainRecipeResponse } from './recipe-checkpoint';
import { AiError } from './errors';

export const recipeReceiptInput = z.object({
  requestId: z.string().regex(/^resp_[A-Za-z0-9_-]{1,490}$/),
  reason: z.string().trim().min(10).max(2000),
}).strict();

/** Correlate with provider-owned metadata, never a client assertion or a similar dish title. */
export async function attachRecipeReceipt(id: string, input: z.infer<typeof recipeReceiptInput>, actor: EditorialActor,
  retrieve = retrieveRetainedRecipeResponse) {
  const captured = await getJobForExecution(id);
  if (captured.kind !== 'recipe' || captured.provider !== 'openai') throw new AiError(409, 'RECIPE_RECOVERY_SCOPE', 'To zadanie nie dotyczy treści przepisu.');
  const response = await retrieve(input.requestId);
  if (response.id !== input.requestId || response.metadata?.jesie_job_id !== id
    || !(response.model === captured.model || response.model.startsWith(`${captured.model}-`)))
    throw new AiError(422, 'RECIPE_RECEIPT_MISMATCH', 'Generator nie potwierdził powiązania tego identyfikatora z zadaniem. Nie zmieniono zgłoszenia.');
  await getDb().transaction(async tx => {
    await budgetLock(tx);
    const account = await trustedActor(tx, actor.id);
    const [job] = await tx.select().from(aiJobs).where(eq(aiJobs.id, id)).for('update');
    if (!job || job.result || !['submitting', 'uncertain', 'generating'].includes(job.status))
      throw new AiError(409, 'RECIPE_RECEIPT_STATE_CHANGED', 'Stan zadania zmienił się. Odśwież zapisany wynik.');
    if (job.providerRequestId && job.providerRequestId !== input.requestId) throw new AiError(409, 'RECIPE_RECEIPT_IMMUTABLE', 'Zadanie ma już inne niezmienne potwierdzenie.');
    const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, job.recipeId)).for('share');
    if (!recipe || recipe.deletedAt || recipe.editorialStatus === 'archived'
      || recipe.revision !== job.baseRevision || contentApprovalHash(recipe.content) !== contentApprovalHash(job.input))
      throw new AiError(409, 'STALE_RESULT', 'Szkic zmienił się od rozpoczęcia zadania. Zachowano dotychczasowe zgłoszenie.');
    if (!job.providerRequestId) {
      await tx.update(aiJobs).set({ providerRequestId: input.requestId, status: 'generating', errorCode: null, errorMessage: null, updatedAt: new Date() }).where(eq(aiJobs.id, id));
      await tx.insert(editorialAudit).values({ id: randomUUID(), recipeId: recipe.id, revision: recipe.revision,
        action: `recover_ai_receipt: ${input.reason}`, actorId: account.id, actorName: account.name });
    }
  });
  if (response.status === 'completed') await retainRecipeResponse(id, response);
}
