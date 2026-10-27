import 'server-only';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { getDb } from '@/server/db';
import type { EditorialActor } from '@/lib/editorial-types';
import { aiJobs } from './schema';
import { approvedImageModel, canRestoreHeroContents, heroCutoutModel } from './image-actions';
import { recoverAcceptedPhoto, type AcceptedPhotoRecoveryResult } from './accepted-photo-recovery';
import { resumeJob } from './store';
import { AiError } from './errors';

export type AcceptedPhotoBatchChild = Pick<typeof aiJobs.$inferSelect,
  'id' | 'photoBatchId' | 'recipeId' | 'provider' | 'model' | 'kind' | 'status' | 'providerRequestId' | 'providerFinishedAt' | 'result'
  | 'input' | 'errorCode' | 'errorMessage' | 'chargedUsd' | 'costBasis' | 'appliedRevision'>;
export type AcceptedPhotoBatchRecoveryDependencies = {
  list: (batchId: string) => Promise<readonly AcceptedPhotoBatchChild[]>;
  recover: (id: string) => Promise<AcceptedPhotoRecoveryResult>;
  resume?: typeof resumeJob;
};
export type AcceptedPhotoBatchRecoveryResult = { attempted: string[]; handled: string[] };

const maximumChildren = 2;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Authenticated manual recovery only reads accepted receipts; no submission or admission dependency exists. */
export function createAcceptedPhotoBatchRecovery(dependencies: AcceptedPhotoBatchRecoveryDependencies) {
  return async (batchId: string, actor?: EditorialActor): Promise<AcceptedPhotoBatchRecoveryResult> => {
    const result: AcceptedPhotoBatchRecoveryResult = { attempted: [], handled: [] };
    if (!uuid.test(batchId)) return result;
    let children: readonly AcceptedPhotoBatchChild[];
    try { children = await dependencies.list(batchId); }
    catch { return result; }
    const seen = new Set<string>();
    for (const child of children) {
      if (result.attempted.length >= maximumChildren) break;
      const restoreContents = Boolean(actor && canRestoreHeroContents(child));
      if (seen.has(child.id) || !uuid.test(child.id) || child.photoBatchId !== batchId
        || child.provider !== 'fal' || ![approvedImageModel, heroCutoutModel].includes(child.model)
        || !['hero', 'ingredient', 'step'].includes(child.kind)
        || (!['generating', 'uncertain'].includes(child.status) && !restoreContents) || child.result !== null
        || !child.providerFinishedAt || !child.providerRequestId
        || !/^[A-Za-z0-9_-]{1,100}$/.test(child.providerRequestId)) continue;
      seen.add(child.id);
      result.attempted.push(child.id);
      if (restoreContents) {
        try {
          // Recheck the actor, approval, original and vessel under the shared
          // lock. This resumes the same immutable receipt, never submission.
          await (dependencies.resume ?? resumeJob)(child.id, actor!);
        } catch (error) {
          // Another continuation may have resumed or completed this child.
          // The GET-only reader below independently checks its current state.
          if (!(error instanceof AiError) || error.code !== 'CANNOT_RESUME') throw error;
        }
      }
      try {
        // The child service rereads the current capture and preserves this same accepted request.
        const recovered = await dependencies.recover(child.id);
        if (recovered.handled) result.handled.push(child.id);
      } catch {
        // Existing batch recovery must remain available if a child read or registration fails.
      }
    }
    return result;
  };
}

export const recoverAcceptedPhotoBatchChildren = createAcceptedPhotoBatchRecovery({
  list: async batchId => {
    const children = await getDb().select({
      id: aiJobs.id, photoBatchId: aiJobs.photoBatchId, recipeId: aiJobs.recipeId, provider: aiJobs.provider, model: aiJobs.model,
      kind: aiJobs.kind, status: aiJobs.status, providerRequestId: aiJobs.providerRequestId,
      providerFinishedAt: aiJobs.providerFinishedAt, result: aiJobs.result,
      input: aiJobs.input, errorCode: aiJobs.errorCode, errorMessage: aiJobs.errorMessage,
      chargedUsd: aiJobs.chargedUsd, costBasis: aiJobs.costBasis, appliedRevision: aiJobs.appliedRevision,
    }).from(aiJobs).where(and(
      eq(aiJobs.photoBatchId, batchId), eq(aiJobs.provider, 'fal'),
      inArray(aiJobs.model, [approvedImageModel, heroCutoutModel]), inArray(aiJobs.kind, ['hero', 'ingredient', 'step']),
      inArray(aiJobs.status, ['generating', 'uncertain', 'failed']), isNotNull(aiJobs.providerRequestId),
      isNotNull(aiJobs.providerFinishedAt), isNull(aiJobs.result),
    )).orderBy(asc(aiJobs.providerFinishedAt), asc(aiJobs.id));
    // Failed rows must pass the same narrow restoration contract before taking
    // one of the two read slots from an ordinary accepted child.
    return children.filter(child => child.status !== 'failed' || canRestoreHeroContents(child));
  },
  recover: recoverAcceptedPhoto,
  resume: resumeJob,
});
