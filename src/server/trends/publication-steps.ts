import { RetryableError } from 'workflow';
import { dispatchDiscoveryWorkflows } from '@/server/seo/dispatch';
import { attachPublicationWorkflow } from './publication';
import { automatedPublicationState, publishVerifiedDailyRecipe } from './automated-publication';

export async function claimDailyPublisher(date: string, generation: number, workflowId: string) {
  'use step';
  return attachPublicationWorkflow(date, workflowId, generation);
}

export async function dailyPublicationState(date: string) {
  'use step';
  try { return await automatedPublicationState(date); }
  catch { throw new RetryableError('DAILY_PUBLICATION_STATE_UNAVAILABLE', { retryAfter: '30s' }); }
}

export async function releaseDailyRecipe(date: string, generation: number) {
  'use step';
  try {
    const result=await publishVerifiedDailyRecipe(date,generation);
    if (result.status==='published' && result.recipeId) {
      const discovery=await dispatchDiscoveryWorkflows({recipeId:result.recipeId});
      if (discovery.failed || discovery.locked) throw new Error('DISCOVERY_DISPATCH_UNAVAILABLE');
    }
    return result;
  }
  catch { throw new RetryableError('DAILY_PUBLICATION_UNAVAILABLE', { retryAfter: '30s' }); }
}
releaseDailyRecipe.maxRetries = 30;
