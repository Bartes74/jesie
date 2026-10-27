import 'server-only';
import { eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import type { EditorialActor } from '@/lib/editorial-types';
import type { PhotoBatchBilling } from '@/lib/photo-batch-billing-types';
import { getDb } from '@/server/db';
import { AiError } from './errors';
import { aiJobs, aiPhotoBatches } from './schema';
import { budgetLock, settleCostInTransaction, trustedActor } from './store';
import { readPhotoBills, type PhotoBillingRead } from './photo-billing-reader';

type Job = typeof aiJobs.$inferSelect;
type Packet = typeof aiPhotoBatches.$inferSelect;
function billable(job: Job) {
  return job.provider === 'fal' && Boolean(job.providerRequestId) && job.costBasis !== 'usage'
    && (['ready', 'applied'].includes(job.status) && Boolean(job.result)
      || job.status === 'failed' && Boolean(job.providerFinishedAt));
}
function summary(packet: Packet, jobs: Job[], read: PhotoBillingRead, reconciledJobs = 0): PhotoBatchBilling {
  const verified = jobs.reduce((sum, job) => job.costBasis === 'usage' && job.chargedUsd !== null ? sum.plus(job.chargedUsd) : sum, new Decimal(0));
  return { batchId: packet.id, checkedAt: new Date().toISOString(), originalReservationUsd: '0.00000000',
    verifiedCostUsd: verified.toFixed(8), conservativeCostUsd: '0.00000000', remainingReservationUsd: '0.00000000',
    totalCommitmentUsd: verified.toFixed(8), availableWithinOriginalUsd: '0.00000000',
    pendingJobs: jobs.filter(job => (job.costBasis !== 'usage' || job.chargedUsd === null)
      && Boolean(job.providerRequestId || ['submitting', 'uncertain'].includes(job.status))).length,
    reconciledJobs, read: { status: read.status, httpStatus: read.httpStatus } };

}

/** Provider GETs happen outside locks. A second actor/receipt check protects atomic accounting. */
export async function photoBatchBilling(id: string, actor: EditorialActor, reconcile = false, reader: typeof readPhotoBills = readPhotoBills): Promise<PhotoBatchBilling> {
  if (!['owner', 'admin'].includes(actor.role)) throw new AiError(403, 'FORBIDDEN', 'To konto nie ma dostępu do rozliczeń.');
  const captured = await getDb().transaction(async tx => {
    await trustedActor(tx, actor.id);
    const [packet] = await tx.select().from(aiPhotoBatches).where(eq(aiPhotoBatches.id, id));
    if (!packet) throw new AiError(404, 'PHOTO_BATCH_NOT_FOUND', 'Nie znaleziono pakietu zdjęć.');
    const jobs = await tx.select().from(aiJobs).where(eq(aiJobs.photoBatchId, id));
    if (jobs.some(job => job.recipeId !== packet.recipeId)) throw new AiError(409, 'PHOTO_BATCH_SCOPE', 'Historia rozliczeń nie odpowiada temu przepisowi. Zachowano rozliczenia.');
    return { packet, jobs };
  });
  const candidates = captured.jobs.filter(billable);
  const read = await reader(candidates.map(job => ({ requestId: job.providerRequestId!, createdAt: job.createdAt })));
  if (!reconcile || !['verified', 'pending'].includes(read.status) || !Object.keys(read.costs).length) return summary(captured.packet, captured.jobs, read);
  return getDb().transaction(async tx => {
    await budgetLock(tx); await trustedActor(tx, actor.id);
    const [packet] = await tx.select().from(aiPhotoBatches).where(eq(aiPhotoBatches.id, id)).for('update');
    if (!packet || packet.recipeId !== captured.packet.recipeId || packet.generation !== captured.packet.generation) throw new AiError(409, 'PHOTO_BATCH_CHANGED', 'Pakiet zmienił się podczas odczytu rozliczenia. Sprawdź jego aktualny stan.');
    const jobs = await tx.select().from(aiJobs).where(eq(aiJobs.photoBatchId, id)).for('update');
    let reconciled = 0;
    for (const source of candidates) {
      const cost = read.costs[source.providerRequestId!];
      if (cost === undefined) continue;
      const current = jobs.find(job => job.id === source.id);
      if (!current || current.recipeId !== packet.recipeId || current.providerRequestId !== source.providerRequestId) throw new AiError(409, 'PHOTO_BILLING_RECEIPT_CHANGED', 'Identyfikator rozliczenia zmienił się. Zachowano dotychczasowe rozliczenia.');
      if (!billable(current)) continue;
      await settleCostInTransaction(tx, current.id, { chargedUsd: cost, costBasis: 'usage' });
      reconciled++;
    }
    const updatedJobs = await tx.select().from(aiJobs).where(eq(aiJobs.photoBatchId, id));
    return summary(packet, updatedJobs, read, reconciled);
  });
}
