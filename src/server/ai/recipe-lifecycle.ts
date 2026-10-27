import 'server-only';
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AiTransaction } from './store';
import { aiJobs, aiLedger, aiPhotoBatches } from './schema';
import { trendRuns } from '../trends/schema';

/** Caller holds the AI budget advisory lock before locking the recipe.
 * Only queued requests with no receipt prove that no provider submission began.
 * Accepted and uncertain requests retain their receipts, slots and conservative
 * costs, so existing workers can retrieve results and reconcile their bills.
 */
export async function stopRecipeAutomationInTransaction(tx: AiTransaction, recipeId: string): Promise<void> {
  const now = new Date();
  const queued = await tx.select().from(aiJobs).where(and(eq(aiJobs.recipeId, recipeId),
    eq(aiJobs.status, 'queued'), isNull(aiJobs.providerRequestId))).orderBy(aiJobs.id).for('update');
  for (const job of queued) {
    const [settlement] = await tx.select().from(aiLedger).where(and(eq(aiLedger.jobId, job.id), eq(aiLedger.entry, 'settle')));
    if (!settlement) {
      await tx.insert(aiLedger).values({ id: randomUUID(), jobId: job.id, entry: 'settle',
        amountUsd: new Decimal(job.reservedUsd).negated().toFixed(8), basis: 'cancelled' });
    } else if (job.costBasis === 'reservation') {
      await tx.insert(aiLedger).values({ id: randomUUID(), jobId: job.id, entry: 'reconcile',
        amountUsd: new Decimal(job.chargedUsd ?? job.reservedUsd).negated().toFixed(8), basis: 'cancelled' }).onConflictDoNothing();
    }
    await tx.update(aiJobs).set({ status: 'cancelled', chargedUsd: '0', costBasis: 'usage',
      providerFinishedAt: now, ingredientResolvedAt: now, errorCode: 'RECIPE_DELETED',
      errorMessage: 'Przepis przeniesiono do kosza przed wysłaniem generowania.', updatedAt: now }).where(eq(aiJobs.id, job.id));
  }
  // This remainder covers children that were never admitted. Each admitted
  // child already owns a separate reservation and is settled independently.
  await tx.update(aiPhotoBatches).set({ status: 'failed', remainingReservedUsd: '0',
    generation: sql`${aiPhotoBatches.generation} + 1`, workflowRunId: null,
    errorCode: 'RECIPE_DELETED', errorMessage: 'Przepis przeniesiono do kosza. Zachowano istniejące wyniki zdjęć.', updatedAt: now })
    .where(and(eq(aiPhotoBatches.recipeId, recipeId), inArray(aiPhotoBatches.status, ['queued', 'generating', 'blocked', 'failed'])));
  await tx.update(trendRuns).set({ status: 'paused', packetRemainingUsd: '0',
    error: 'Przepis przeniesiono do kosza. Przygotowanie zostało zatrzymane.', updatedAt: now })
    .where(and(eq(trendRuns.recipeId, recipeId), inArray(trendRuns.status, ['queued', 'searching', 'generating', 'uncertain', 'failed', 'paused', 'awaiting_review'])));
}
