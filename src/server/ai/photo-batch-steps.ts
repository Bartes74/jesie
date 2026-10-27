import { RetryableError } from 'workflow';
import { AiError } from './errors';
import { EditorialError } from '@/server/editorial/store';
import { claimPhotoBatchWorkflow, nextPhotoBatchOperation, nextPhotoBatchWave, stopPhotoBatch } from './photo-batch';
import { getJobForExecution, resumeJob } from './store';

export async function claimPhotoBatchStep(id: string, generation: number, runId: string) {
  'use step';
  console.info('Studio photo package worker claim', { batchId: id, generation });
  try { return await claimPhotoBatchWorkflow(id, generation, runId); }
  catch { throw new RetryableError('PHOTO_BATCH_STATE_UNAVAILABLE', { retryAfter: '30s' }); }
}

export async function nextPhotoBatchStep(id: string, generation: number) {
  'use step';
  console.info('Studio photo package advance', { batchId: id, generation });
  try { return await nextPhotoBatchOperation(id, generation); }
  catch (error) {
    if (error instanceof AiError || error instanceof EditorialError) {
      await stopPhotoBatch(id, generation, error.code, error.message);
      return { state: 'done' as const };
    }
    throw new RetryableError('PHOTO_BATCH_STATE_UNAVAILABLE', { retryAfter: '30s' });
  }
}

export async function nextPhotoBatchWaveStep(id: string, generation: number) {
  'use step';
  console.info('Studio photo package wave', { batchId: id, generation });
  try { return await nextPhotoBatchWave(id, generation); }
  catch (error) {
    if (error instanceof AiError || error instanceof EditorialError) {
      await stopPhotoBatch(id, generation, error.code, error.message);
      return { state: 'done' as const };
    }
    throw new RetryableError('PHOTO_BATCH_STATE_UNAVAILABLE', { retryAfter: '30s' });
  }
}

export async function photoBatchChildState(id: string) {
  'use step';
  try {
    const job = await getJobForExecution(id);
    return { status: job.status, hasResult: Boolean(job.result?.asset || job.result?.reusedPhoto), receipt: Boolean(job.providerRequestId || job.reuseSourceJobId), providerFinished: Boolean(job.providerFinishedAt), errorCode: job.errorCode, errorMessage: job.errorMessage };
  } catch { throw new RetryableError('PHOTO_BATCH_CHILD_STATE_UNAVAILABLE', { retryAfter: '30s' }); }
}

/** Recover only a captured request or ingredient follower. This never submits. */
export async function resumePhotoBatchChildReadStep(id: string) {
  'use step';
  console.info('Studio photo package existing request recovery', { jobId: id });
  try {
    const job = await getJobForExecution(id);
    if (!job.providerRequestId && !job.reuseSourceJobId) return false;
    if (job.status === 'uncertain' && !job.result) {
      await resumeJob(id, { id: job.createdBy, name: job.createdByName, email: '', role: 'admin' });
    }
    return true;
  } catch {
    throw new RetryableError('PHOTO_BATCH_EXISTING_REQUEST_UNAVAILABLE', { retryAfter: '30s' });
  }
}

export async function stopPhotoBatchStep(id: string, generation: number, code: string, message: string, failed = false) {
  'use step';
  console.info('Studio photo package stopped', { batchId: id, generation, code });
  await stopPhotoBatch(id, generation, code, message, failed);
}
