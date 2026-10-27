import type { AiJob } from './ai-types';
import type { AiPhotoBatch } from './ai-photo-batch-types';

export type PendingPreparationRequest = { version: 1; action: 'generate_text' | 'generate_photos'; expectedRevision: number; requestKey: string };

export function readPendingPreparation(raw: string | null): PendingPreparationRequest | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    if (!('version' in value) || value.version !== 1 || !('action' in value) || value.action !== 'generate_text' && value.action !== 'generate_photos') return null;
    if (!('expectedRevision' in value) || typeof value.expectedRevision !== 'number' || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1) return null;
    if (!('requestKey' in value) || typeof value.requestKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.requestKey)) return null;
    return { version: 1, action: value.action, expectedRevision: value.expectedRevision, requestKey: value.requestKey };
  } catch { return null; }
}

/** Retry keeps both the request identity and the revision captured before submission. */
export function generationRequest(pending: PendingPreparationRequest) {
  return { action: pending.action, expectedRevision: pending.expectedRevision, requestKey: pending.requestKey };
}

export function readyPreparationAction(revision: number, text: AiJob | null, photos: AiPhotoBatch | null, photoBatchCompatible = false): { action: 'apply_text'; jobId: string } | { action: 'apply_photos'; batchId: string } | null {
  if (text?.status === 'ready' && text.baseRevision === revision) return { action: 'apply_text', jobId: text.id };
  if (photos?.status === 'ready' && (photos.baseRevision === revision || photoBatchCompatible)) return { action: 'apply_photos', batchId: photos.id };
  return null;
}
