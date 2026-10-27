import { z } from 'zod';
import { requireOwner } from '@/server/auth';
import { adminActor, adminFailure, adminResponse, readJson } from '@/server/http/admin';
import { getDiscoveryStatus, processDiscoveryOutbox, queuePublishedDiscoveryBackfill } from '@/server/seo/discovery';
import { dispatchDiscoveryWorkflows } from '@/server/seo/dispatch';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request: Request) {
  try { await adminActor(request); return adminResponse(await getDiscoveryStatus()); }
  catch (error) { return adminFailure(error); }
}

export async function POST(request: Request) {
  try {
    await adminActor(request, true);
    await requireOwner(request.headers);
    const { action } = z.object({ action: z.enum(['recover', 'backfill']) }).strict().parse(await readJson(request));
    const timerArmed = false;
    if (action === 'backfill') {
      const backfill = await queuePublishedDiscoveryBackfill();
      return adminResponse({ timerArmed, backfill, workers: await dispatchDiscoveryWorkflows({ limit: 50 }) });
    }
    const discovery = await processDiscoveryOutbox();
    const workers = await dispatchDiscoveryWorkflows();
    return adminResponse({ timerArmed, discovery, workers });
  } catch (error) { return adminFailure(error); }
}
