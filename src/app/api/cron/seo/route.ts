import { adminFailure, adminResponse } from '@/server/http/admin';
import { cronAuthorized } from '@/server/http/cron';
import { getDiscoveryDeliveryState, processDiscoveryOutbox } from '@/server/seo/discovery';
import { dispatchDiscoveryWorkflows } from '@/server/seo/dispatch';
import { dispatchPublicationTimer } from '@/server/trends/daily-dispatch';
import { processCollectionDiscovery } from '@/server/collections/discovery';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return adminResponse({ error: 'Unauthorized' }, 401);
  try {
    const query=new URL(request.url).searchParams;
    if (query.has('event')) {
      const eventId=query.get('event') ?? '';const workflowId=query.get('workflow') ?? '';const generation=Number(query.get('generation'));
      if (!/^[a-f0-9-]{36}$/.test(eventId) || !/^[a-zA-Z0-9_-]{1,200}$/.test(workflowId) || !Number.isInteger(generation) || generation<1) return adminResponse({error:'Invalid delivery identity'},400);
      const state=await getDiscoveryDeliveryState(eventId,generation,workflowId);
      if (state.status==='pending') await processDiscoveryOutbox({eventId,limit:1,workflow:{id:workflowId,generation}});
      return adminResponse({delivery:await getDiscoveryDeliveryState(eventId,generation,workflowId)});
    }
    // Recovery of reviewed publishing needs no paid radar preparation.
    let timer: unknown;
    try { timer = await dispatchPublicationTimer(); }
    catch { timer = { retry: true }; }
    await processCollectionDiscovery();
    return adminResponse({ timer, discovery: await processDiscoveryOutbox(), workers: await dispatchDiscoveryWorkflows() });
  } catch (error) { return adminFailure(error); }
}
