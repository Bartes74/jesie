import { z } from 'zod';
import { applyPhotoBatch } from '@/server/ai/photo-batch';
import { recoverPhotoBatch } from '@/server/ai/photo-batch-recovery';
import { recoverAcceptedPhotoBatchChildren } from '@/server/ai/accepted-photo-batch-recovery';
import { dispatchPhotoBatch } from '@/server/ai/photo-batch-dispatch';
import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { aiFailure } from '@/server/http/ai';

export const runtime = 'nodejs';
export const maxDuration = 180;
const actionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('resume') }).strict(),
  z.object({ action: z.literal('apply'), expectedRevision: z.number().int().positive() }).strict(),
]);
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await adminActor(request, true);
    const { id } = await context.params;
    const input = actionInput.parse(await readJson(request));
    if (input.action === 'apply') return adminResponse(await applyPhotoBatch(id, input.expectedRevision, actor));
    await recoverAcceptedPhotoBatchChildren(id, actor);
    const resumed = await recoverPhotoBatch(id, actor);
    if (resumed.dispatch) return adminResponse({ batch: await dispatchPhotoBatch(id, resumed.generation) }, 202);
    return adminResponse({ batch: resumed.batch }, 202);
  } catch (error) { return aiFailure(error); }
}
