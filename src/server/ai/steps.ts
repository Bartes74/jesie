import { RetryableError } from 'workflow';
import { trendRunLimits } from '@/lib/trend-polling';
import { claimSubmission, attachProviderRequest, getJobForExecution, finishRecipe, finishAsset, failJob, settleCost, ensureSubmissionAllowed, confirmNotSubmitted, markProviderTerminal, resolveIngredientReuse } from './store';
import { submitText, submitTextRepair, pollText } from './text-provider';
import { submitImage, pollImage, imageBill, formatExistingStep, formatExistingHero } from './image-provider';
import { stepFormatModel, filledHeroModel } from './image-actions';
import { ProviderError } from './provider-error';
import { ensurePhotoStorageAvailable } from '@/server/media/capacity';
import { isTransientPhotoResultRead, photoResultRecoveryError } from './result-recovery-error';
import { claimRecipeRecoveryWorker, pauseRecipeRecovery, recipeRecoverySubmission } from './recipe-recovery-state';
import { admitRecipeRepair } from './recipe-recovery';
import { recipeGetRetryable } from './recipe-recovery-policy';
import { AiError } from './errors';
import { TrendError } from '@/server/trends/store';
import { admitManualHeroCutout } from './manual-hero-recovery';
import { resolveRecipeIngredients } from './recipe-ingredient-resolution';

export async function prepareManualHeroCutout(id: string, workflowRunId: string) {
  'use step';
  console.info('Studio manual photograph existing-source cutout', { jobId: id });
  try { return await admitManualHeroCutout(id, workflowRunId); }
  catch (error) {
    if (error instanceof AiError && error.code !== 'CONCURRENCY_LIMIT') return null;
    throw new RetryableError('AI_PHOTO_RECOVERY_STATE_UNAVAILABLE', { retryAfter: '30s' });
  }
}
prepareManualHeroCutout.maxRetries = 6;

export async function claimGenerationRecovery(id: string, generation: number, workflowRunId: string) {
  'use step';
  try { return await claimRecipeRecoveryWorker(id, generation, workflowRunId); }
  catch { throw new RetryableError('AI_RECOVERY_STATE_UNAVAILABLE', { retryAfter: '30s' }); }
}

export async function advanceGenerationRecovery(id: string, generation: number, workflowRunId: string, trendGeneration?: number) {
  'use step';
  try { return await admitRecipeRepair(id, generation, workflowRunId, trendGeneration); }
  catch (error) {
    if (error instanceof AiError || error instanceof TrendError) {
      await pauseRecipeRecovery(id, generation, error.code, error.message);
      return { jobId: id, generation, attempt: 0, created: false, continue: false, reason: error.message };
    }
    throw new RetryableError('AI_RECOVERY_STATE_UNAVAILABLE', { retryAfter: '30s' });
  }
}

export async function submitGeneration(id: string) {
  'use step';
  let claimed;
  try { claimed = await claimSubmission(id); }
  catch { throw new RetryableError('AI_JOB_STATE_UNAVAILABLE'); }
  const job = claimed.job;
  if(job.reuseSourceJobId)return !await resolveIngredientReuse(id);
  if (job.providerRequestId) return ['generating', 'submitting', 'cancelled'].includes(job.status);
  if (!claimed.shouldSubmit) return false;
  try {
    const beforeSubmit = async () => {
      if (job.kind !== 'recipe') await ensurePhotoStorageAvailable();
      try { await ensureSubmissionAllowed(id); }
      catch { throw new ProviderError('AI_SUBMISSION_BLOCKED', 'Generowanie zatrzymano przed wysłaniem. Sprawdź uprawnienia i stan zlecenia.'); }
    };
    if(job.model===stepFormatModel||job.model===filledHeroModel){
      await beforeSubmit();
      const result=job.model===filledHeroModel?await formatExistingHero(job.input,id):await formatExistingStep(job.input,job.targetId,id);
      await finishAsset(id,result.asset,{chargedUsd:'0',costBasis:'usage'},result.notes);
      return false;
    }
    const recovery = job.kind === 'recipe' ? await recipeRecoverySubmission(id, { forSubmission: true }) : null;
    const requestId = job.kind === 'recipe'
      ? recovery?.repair
        ? await submitTextRepair(job.model, job.input, job.brief, recovery.repair.previousResponseId, recovery.repair.issues, beforeSubmit, `recipe-job-${job.id}`)
        : await submitText(job.model, job.input, job.brief, beforeSubmit)
      : await submitImage(job.model, job.kind, job.input, job.targetId, job.brief, beforeSubmit);
    await attachProviderRequest(id, requestId);
    return true;
  } catch (error) {
    const failure = error instanceof ProviderError ? error : new ProviderError('AI_SUBMISSION_UNCERTAIN', 'Nie potwierdzono przyjęcia generowania. Zgłoszenie pozostaje w historii.', true);
    try {
      const latest = await getJobForExecution(id);
      if (!failure.uncertain && latest.status === 'cancelled' && !latest.providerRequestId) await confirmNotSubmitted(id);
      else await failJob(id, { code: failure.code, message: failure.message, uncertain: failure.uncertain, chargedUsd: failure.uncertain ? undefined : '0', providerFinished: !failure.uncertain });
    } catch { throw new RetryableError('AI_JOB_RECORD_UNAVAILABLE'); }
    return false;
  }
}
// Never automatically repeat a paid POST after a transport/process failure.
submitGeneration.maxRetries = 0;

export async function pollGeneration(id: string, existingRecipeOnly = false) {
  'use step';
  let job;
  try { job = await getJobForExecution(id); }
  catch { throw new RetryableError('AI_JOB_STATE_UNAVAILABLE', { retryAfter: '30s' }); }
  if (existingRecipeOnly && (job.kind !== 'recipe' || !job.providerRequestId)) return true;
  if(job.reuseSourceJobId)return resolveIngredientReuse(id);
  if (job.result || ['ready', 'applied', 'failed', 'uncertain'].includes(job.status)) return true;
  if (!job.providerRequestId) return true;
  try {
    if (job.kind === 'recipe') {
      const recovery = await recipeRecoverySubmission(id);
      const result = await pollText(job.model, job.providerRequestId, job.input, recovery.ancestorRequestIds,
        raw => resolveRecipeIngredients(job, raw, { existingOnly: existingRecipeOnly }));
      if (!result.done) return false;
      await finishRecipe(id, result.content, result.cost, result.notes, { verifiedResearchSources: true });
    } else {
      const result = await pollImage(job.model, job.providerRequestId, id, job.kind, job.input, job.targetId, () => markProviderTerminal(id).then(() => undefined));
      if (!result.done) return false;
      await finishAsset(id, result.asset, result.cost, result.notes);
    }
    return true;
  } catch (error) {
    if (job.providerRequestId && (job.kind === 'recipe'
      ? error instanceof ProviderError && recipeGetRetryable(error.code) : isTransientPhotoResultRead(error)))
      throw new RetryableError('AI_PROVIDER_STATUS_TEMPORARILY_UNAVAILABLE', { retryAfter: '30s' });
    const failure = photoResultRecoveryError(error);
    if (failure) {
      const bill = job.provider === 'fal' ? await imageBill(job.providerRequestId) : null;
      try { await failJob(id, { code: failure.code, message: failure.message, uncertain: failure.uncertain, chargedUsd: bill?.chargedUsd ?? failure.chargedUsd, providerFinished: !failure.uncertain,
        ...(job.kind === 'recipe' && failure.code === 'AI_RESULT_INVALID' ? { validation: { issues: failure.issues, repairable: failure.repairable } } : {}) }); }
      catch { throw new RetryableError('AI_JOB_RECORD_UNAVAILABLE', { retryAfter: '30s' }); }
      return true;
    }
    // GET retries are safe. Keep errors generic: provider/DB errors may contain
    // raw prompts, credentials or SQL. A final workflow catch records uncertainty.
    throw new RetryableError('AI_PROVIDER_STATUS_TEMPORARILY_UNAVAILABLE', { retryAfter: '30s' });
  }
}
pollGeneration.maxRetries = trendRunLimits.statusRetries;

export async function expireGeneration(id: string) {
  'use step';
  try { await failJob(id, { code: 'AI_RESULT_UNCONFIRMED', message: 'Nie potwierdzono ukończenia wyniku. Możesz ponownie odczytać stan istniejącego zlecenia; nie wyślemy nowej generacji.', uncertain: true }); }
  catch { throw new RetryableError('AI_JOB_RECORD_UNAVAILABLE', { retryAfter: '1m' }); }
}

export async function reconcileGeneration(id: string) {
  'use step';
  try {
    const job = await getJobForExecution(id);
    if (job.costBasis === 'usage' || job.provider !== 'fal' || !job.providerRequestId) return true;
    const bill = await imageBill(job.providerRequestId);
    if (!bill) return false;
    await settleCost(id, bill);
    return true;
  } catch { throw new RetryableError('AI_BILLING_RECORD_UNAVAILABLE', { retryAfter: '1m' }); }
}
