import 'server-only';
import type { AiJob, AiKind } from '@/lib/ai-types';
import { approvedImageModel, heroCutoutModel } from './image-actions';
import { pollImage } from './image-provider';
import { finishAsset, failJob, getJob, getJobForExecution, markProviderTerminal, type AssetInput, type CostInformation } from './store';
import { photoResultRecoveryError } from './result-recovery-error';

type CapturedJob = Pick<Awaited<ReturnType<typeof getJobForExecution>>, 'id' | 'provider' | 'model' | 'kind' | 'targetId' | 'providerRequestId' | 'status' | 'result' | 'input'>;
export type AcceptedPhotoRecoveryResult = { handled: false } | { handled: true; job: AiJob };
type AcceptedPhotoPoll = { done: false } | { done: true; asset: AssetInput; cost: CostInformation; notes: string[] };
export type AcceptedPhotoRecoveryDependencies = {
  getJobForExecution: (id: string) => Promise<CapturedJob>;
  getJob: typeof getJob;
  pollImage: (model: string, requestId: string, jobId: string, kind: Exclude<AiKind, 'recipe'>, input: CapturedJob['input'], targetId: string | null, onTerminal?: () => Promise<void>) => Promise<AcceptedPhotoPoll>;
  markProviderTerminal: typeof markProviderTerminal;
  finishAsset: typeof finishAsset;
  failJob: typeof failJob;
  photoResultRecoveryError: typeof photoResultRecoveryError;
};

/** Call only after the controller's existing authenticated resumeJob checks. No admission or submission port exists. */
export function createAcceptedPhotoRecovery(overrides: Partial<AcceptedPhotoRecoveryDependencies> = {}) {
  const dependencies: AcceptedPhotoRecoveryDependencies = { getJobForExecution, getJob, pollImage, markProviderTerminal, finishAsset, failJob, photoResultRecoveryError, ...overrides };
  return async function recover(id: string): Promise<AcceptedPhotoRecoveryResult> {
    let source: CapturedJob;
    try { source = await dependencies.getJobForExecution(id); }
    // The controller already resumed an accepted request. A failed capture read
    // must preserve its existing workflow fallback rather than strand it as generating.
    catch { return { handled: false }; }
    if (source.id !== id) return { handled: false };
    if (source.result) return { handled: true, job: await dependencies.getJob(id) };
    if (source.provider !== 'fal' || ![approvedImageModel, heroCutoutModel].includes(source.model)
      || !['hero', 'ingredient', 'step'].includes(source.kind) || !source.providerRequestId
      || !/^[A-Za-z0-9_-]{1,100}$/.test(source.providerRequestId)
      || !['generating', 'submitting', 'uncertain', 'cancelled'].includes(source.status)) return { handled: false };
    const kind = source.kind as 'hero' | 'ingredient' | 'step';
    try {
      // pollImage reads this exact accepted request and stores only its private result; it cannot submit another image.
      const result = await dependencies.pollImage(source.model, source.providerRequestId, id, kind, source.input, source.targetId, async () => { await dependencies.markProviderTerminal(id); });
      if (!result.done) return { handled: false };
      const job = await dependencies.finishAsset(id, result.asset, result.cost, result.notes);
      return { handled: true, job };
    } catch (error) {
      const failure = dependencies.photoResultRecoveryError(error);
      // Accepted work never becomes an unpaid request just because retrieval or storage failed.
      const verifiedPositiveCharge = failure?.chargedUsd && /^\d+(?:\.\d{1,8})?$/.test(failure.chargedUsd) && Number(failure.chargedUsd) > 0 ? failure.chargedUsd : undefined;
      try {
        const job = await dependencies.failJob(id, failure ? {
          code: failure.code, message: failure.message, uncertain: failure.uncertain,
          ...(verifiedPositiveCharge ? { chargedUsd: verifiedPositiveCharge } : {}), providerFinished: !failure.uncertain,
        } : {
          code: 'AI_RESULT_UNCONFIRMED', uncertain: true,
          message: 'Nie potwierdzono odczytu istniejącego zdjęcia. Zachowano identyfikator zlecenia; kontynuacja odczyta to samo zlecenie bez nowej generacji.',
        });
        return { handled: true, job };
      } catch {
        // A DB outage can also prevent recording uncertainty. Keep the same
        // accepted receipt recoverable through the controller's workflow fallback.
        return { handled: false };
      }
    }
  };
}

export const recoverAcceptedPhoto = createAcceptedPhotoRecovery();
