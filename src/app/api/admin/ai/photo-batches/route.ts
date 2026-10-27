import { z } from 'zod';
import { createPhotoBatch, listPhotoBatches } from '@/server/ai/photo-batch';
import { dispatchPhotoBatch } from '@/server/ai/photo-batch-dispatch';
import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { aiFailure } from '@/server/http/ai';

export const runtime = 'nodejs';
const createInput = z.object({ recipeId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), expectedRevision: z.number().int().positive(), requestKey: z.string().uuid(), sourceJobId: z.string().uuid().optional(), mode:z.enum(['missing','ingredients-white','ingredients-paper']).optional(), ingredientIds:z.array(z.string().min(1).max(100)).min(1).max(100).optional() }).strict();
const queryInput = z.object({ recipeId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), sourceJobId: z.string().uuid().optional() });

export async function GET(request: Request) {
  try {
    await adminActor(request);
    const query = queryInput.parse(Object.fromEntries(new URL(request.url).searchParams));
    return adminResponse({ batches: await listPhotoBatches(query.recipeId, query.sourceJobId) });
  } catch (error) { return aiFailure(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await adminActor(request, true);
    const { batch, generation, created } = await createPhotoBatch(createInput.parse(await readJson(request)), actor);
    // Durable replays return the same packet. Explicit recovery checks its
    // worker and grace period before replacing an interrupted dispatch.
    if (created && batch.status === 'queued') return adminResponse({ batch: await dispatchPhotoBatch(batch.id, generation) }, 202);
    return adminResponse({ batch }, 202);
  } catch (error) { return aiFailure(error); }
}
