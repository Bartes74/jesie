import { RetryableError } from 'workflow';
import { PUBLIC_SITE_URL } from '@/lib/seo';
import { attachDiscoveryWorkflow, type DiscoveryDeliveryState } from './discovery';
import { dispatchDiscoveryWorkflows } from './dispatch';

export async function claimDiscoveryDelivery(eventId:string,generation:number,token:string,workflowId:string) {
  'use step';
  try { return await attachDiscoveryWorkflow(eventId,generation,token,workflowId); }
  catch { throw new RetryableError('DISCOVERY_STARTUP_UNAVAILABLE',{retryAfter:'30s'}); }
}
claimDiscoveryDelivery.maxRetries=20;

export async function deliverDiscoveryEvent(eventId:string,generation:number,workflowId:string):Promise<DiscoveryDeliveryState> {
  'use step';
  const secret=process.env.CRON_SECRET;
  if (!secret) throw new RetryableError('DISCOVERY_CRON_NOT_CONFIGURED',{retryAfter:'5m'});
  const url=new URL('/api/cron/seo',PUBLIC_SITE_URL);
  url.searchParams.set('event',eventId);url.searchParams.set('generation',String(generation));url.searchParams.set('workflow',workflowId);
  try {
    // Revalidation is performed inside a genuine Next Route Handler. No secret
    // is returned or logged; the durable step stores only this small state.
    const response=await fetch(url,{headers:{authorization:`Bearer ${secret}`},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(290_000)});
    if (!response.ok) throw new Error('DISCOVERY_HANDLER_UNAVAILABLE');
    const body=await response.json() as {delivery?:DiscoveryDeliveryState};
    if (!body.delivery || !['pending','completed','superseded'].includes(body.delivery.status)
      || !Number.isFinite(Date.parse(body.delivery.serverNow)) || !Number.isFinite(Date.parse(body.delivery.nextAttemptAt))) throw new Error('DISCOVERY_HANDLER_INVALID_STATE');
    return body.delivery;
  } catch { throw new RetryableError('DISCOVERY_DELIVERY_UNAVAILABLE',{retryAfter:'1m'}); }
}
deliverDiscoveryEvent.maxRetries=20;

export async function continueDiscoveryDelivery(eventId:string,generation:number,workflowId:string) {
  'use step';
  const result=await dispatchDiscoveryWorkflows({eventId,limit:1,continueFrom:{id:workflowId,generation}});
  if (result.failed || result.locked) throw new RetryableError('DISCOVERY_CONTINUATION_UNAVAILABLE',{retryAfter:'1m'});
  return result;
}
continueDiscoveryDelivery.maxRetries=20;
