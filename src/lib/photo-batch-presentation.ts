import type { AiPhotoBatch } from './ai-photo-batch-types';

type StartOptions = {
  saveDraftFirst: boolean;
  unconfirmed: boolean;
  missingTotal: number;
  canResume: boolean;
  canApply: boolean;
};

/** An existing unfinished packet must never be hidden behind a new admission. */
export function shouldShowPhotoBatchStart(batch: AiPhotoBatch | null, options: StartOptions): boolean {
  if (batch && (batch.status === 'queued' || batch.status === 'generating' || options.canResume || options.canApply)) return false;
  return options.unconfirmed || options.saveDraftFirst || !batch || batch.status === 'failed' || batch.status === 'applied' && options.missingTotal > 0;
}

/** This controls read-only UI refreshes; it never dispatches a provider request. */
export function photoBatchPollInterval(batch: AiPhotoBatch | null): number | null {
  if (!batch) return null;
  if (batch.status === 'queued' || batch.status === 'generating') return 4000;
  if (batch.status !== 'blocked' && batch.status !== 'failed') return null;
  const unresolvedReceipt = batch.slots.some(slot => slot.job
    && (slot.job.providerRequestId || slot.job.reuseSourceJobId)
    && !slot.job.result?.asset && !slot.job.result?.reusedPhoto
    && ['queued', 'submitting', 'generating', 'uncertain'].includes(slot.status));
  return unresolvedReceipt ? 15000 : null;
}
