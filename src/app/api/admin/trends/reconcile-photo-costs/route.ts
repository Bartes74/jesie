import { z } from 'zod';
import { reconcileTrendPhotoCosts } from '@/server/ai/photo-cost-reconciliation';
import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { aiFailure } from '@/server/http/ai';

export const runtime = 'nodejs';
export const maxDuration = 300;
const input = z.object({ action: z.literal('reconcile') }).strict();

export async function POST(request: Request) {
  try {
    const actor = await adminActor(request, true);
    input.parse(await readJson(request));
    return adminResponse({ report: await reconcileTrendPhotoCosts(actor) });
  } catch (error) { return aiFailure(error); }
}
