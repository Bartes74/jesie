import { z } from 'zod';
import { replaceReviewedBatchIngredient } from '@/server/ai/photo-batch';
import { dispatchPhotoBatch } from '@/server/ai/photo-batch-dispatch';
import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { aiFailure } from '@/server/http/ai';

export const runtime = 'nodejs';
const input = z.object({ generation: z.number().int().positive(), expectedRevision: z.number().int().positive(),
  targetId: z.literal('white_wine'), replacedJobId: z.string().uuid(), reviewNote: z.string().trim().min(1).max(1000),
  requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/) }).strict();
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await adminActor(request, true); const { id } = await context.params;
    const replacement = await replaceReviewedBatchIngredient(id, input.parse(await readJson(request)), actor);
    return adminResponse({ batch: replacement.dispatch ? await dispatchPhotoBatch(id, replacement.generation) : replacement.batch }, 202);
  } catch (error) { return aiFailure(error); }
}
