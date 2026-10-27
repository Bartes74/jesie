import { z } from 'zod';
import { photoBatchBilling } from '@/server/ai/photo-batch-billing';
import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { aiFailure } from '@/server/http/ai';

export const runtime = 'nodejs';
const input = z.object({ action: z.literal('reconcile') }).strict();
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await adminActor(request);
    const { id } = await context.params;
    return adminResponse({ billing: await photoBatchBilling(z.string().uuid().parse(id), actor) });
  } catch (error) { return aiFailure(error); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await adminActor(request, true);
    const { id } = await context.params;
    input.parse(await readJson(request));
    return adminResponse({ billing: await photoBatchBilling(z.string().uuid().parse(id), actor, true) });
  } catch (error) { return aiFailure(error); }
}
