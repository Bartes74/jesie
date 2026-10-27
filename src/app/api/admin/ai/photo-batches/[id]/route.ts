import { getPhotoBatch } from '@/server/ai/photo-batch';
import { adminActor, adminResponse } from '@/server/http/admin';
import { aiFailure } from '@/server/http/ai';

export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await adminActor(request);
    const { id } = await context.params;
    return adminResponse({ batch: await getPhotoBatch(id) });
  } catch (error) { return aiFailure(error); }
}
