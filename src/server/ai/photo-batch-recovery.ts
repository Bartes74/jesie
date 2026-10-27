import 'server-only';
import { getRun } from 'workflow/api';
import type { EditorialActor } from '@/lib/editorial-types';
import { AiError } from './errors';
import { getPhotoBatchRecoveryState, resumePhotoBatch, stopPhotoBatch, type PhotoBatchWorkflowEvidence } from './photo-batch';
import { ensurePhotoStorageAvailable } from '@/server/media/capacity';
import { ProviderError } from './provider-error';

type RecoveryState = Awaited<ReturnType<typeof getPhotoBatchRecoveryState>>;
type ResumeResult = Awaited<ReturnType<typeof resumePhotoBatch>>;
type EngineRun = {
  exists: () => Promise<boolean>;
  status: () => Promise<string>;
  wakeUp: () => Promise<unknown>;
};
type Dependencies = {
  state: (id: string) => Promise<RecoveryState>;
  resume: (id: string, actor: EditorialActor, evidence?: PhotoBatchWorkflowEvidence) => Promise<ResumeResult>;
  run: (runId: string) => EngineRun;
  storageReady?: () => Promise<void>;
  pause?: (id: string, generation: number, code: string, message: string, failed?: boolean) => Promise<ResumeResult['batch']>;
};

/** Engine evidence and the database generation fence jointly prevent duplicate workers. */
export function createPhotoBatchRecoveryService(dependencies: Dependencies) {
  return async (id: string, actor: EditorialActor) => {
    const captured = await dependencies.state(id);
    const pauseForStorage = async (): Promise<ResumeResult | null> => {
      try { await dependencies.storageReady?.(); return null; }
      catch (error) {
        if (!(error instanceof ProviderError) || !dependencies.pause) {
          throw new AiError(503, 'PHOTO_BATCH_STORAGE_CHECK_UNAVAILABLE', 'Nie udało się sprawdzić magazynu zdjęć. Zachowano pakiet; spróbuj ponownie sprawdzić jego stan.');
        }
        // Failed packages have released their remaining reservation. Keep that
        // state so a later continuation rebuilds it after storage is restored.
        const batch = await dependencies.pause(id, captured.generation, error.code, error.message, captured.status === 'failed');
        return { batch, generation: captured.generation, dispatch: false };
      }
    };
    if (!['queued', 'generating'].includes(captured.status)) {
      if (captured.status === 'blocked' || captured.status === 'failed') {
        const paused = await pauseForStorage(); if (paused) return paused;
      }
      return dependencies.resume(id, actor);
    }
    let evidence: PhotoBatchWorkflowEvidence;
    if (!captured.workflowRunId) {
      // The transaction applies a grace period for a dispatched run awaiting its first claim.
      evidence = { generation: captured.generation, runId: null, status: 'missing' };
    } else {
      const run = dependencies.run(captured.workflowRunId);
      let exists: boolean, status: string;
      try {
        exists = await run.exists();
        status = exists ? await run.status() : 'missing';
      } catch {
        throw new AiError(503, 'PHOTO_BATCH_WORKFLOW_STATE_UNAVAILABLE', 'Nie udało się sprawdzić procesu zdjęć. Spróbuj ponownie sprawdzić i wznowić pakiet. Zachowano istniejące zlecenia.');
      }
      if (status === 'pending' || status === 'running') {
        const current = await dependencies.resume(id, actor);
        if (!current.dispatch && ['queued', 'generating'].includes(current.batch.status)) {
          const latest = await dependencies.state(id);
          if (latest.generation === captured.generation && latest.workflowRunId === captured.workflowRunId) {
            try { await run.wakeUp(); }
            catch { throw new AiError(503, 'PHOTO_BATCH_WAKE_UNCONFIRMED', 'Proces zdjęć nadal istnieje, ale nie potwierdzono przyspieszenia odczytu. Zachowano ten sam proces; sprawdź stan ponownie.'); }
          }
        }
        return current;
      }
      if (!['completed', 'failed', 'cancelled', 'missing'].includes(status)) {
        throw new AiError(503, 'PHOTO_BATCH_WORKFLOW_STATE_UNAVAILABLE', 'Proces zdjęć zwrócił nierozpoznany stan. Zachowano istniejące zlecenia; sprawdź stan ponownie.');
      }
      evidence = { generation: captured.generation, runId: captured.workflowRunId, status: status as PhotoBatchWorkflowEvidence['status'] };
    }
    const paused = await pauseForStorage(); if (paused) return paused;
    return dependencies.resume(id, actor, evidence);
  };
}

export const recoverPhotoBatch = createPhotoBatchRecoveryService({
  state: getPhotoBatchRecoveryState,
  resume: resumePhotoBatch,
  storageReady: ensurePhotoStorageAvailable,
  pause: stopPhotoBatch,
  run: id => {
    const run = getRun(id);
    return { exists: () => run.exists, status: () => run.status, wakeUp: () => run.wakeUp() };
  },
});
