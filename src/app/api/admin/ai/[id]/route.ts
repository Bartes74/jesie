import { getJob } from '@/server/ai/store';
import { adminActor, adminResponse } from '@/server/http/admin';
import { aiFailure } from '@/server/http/ai';

export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const actor = await adminActor(request); const { id } = await context.params; return adminResponse({ job: await getJob(id, { allowMaskRetry: actor.role === 'owner' }) }); }
  catch (error) { return aiFailure(error); }
}
