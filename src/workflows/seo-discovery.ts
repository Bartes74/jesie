import { getWorkflowMetadata, sleep } from 'workflow';
import { claimDiscoveryDelivery, continueDiscoveryDelivery, deliverDiscoveryEvent } from '@/server/seo/discovery-steps';

/** One public change, no polling when idle, no AI/provider calls, durable backoff. */
export async function notifyDiscoveryEvent(eventId:string,generation:number,token:string) {
  'use workflow';
  const workflowId=getWorkflowMetadata().workflowRunId;
  if (!await claimDiscoveryDelivery(eventId,generation,token,workflowId)) return;
  for (let attempt=0;attempt<32;attempt++) {
    const state=await deliverDiscoveryEvent(eventId,generation,workflowId);
    if (state.status!=='pending') return state;
    const next=new Date(Math.max(Date.parse(state.serverNow)+1_000,Date.parse(state.nextAttemptAt)));
    await sleep(next);
  }
  // Rotate well before the World's event ceiling while retaining the same
  // outbox event and its persisted delivery attempts/backoff.
  return continueDiscoveryDelivery(eventId,generation,workflowId);
}
