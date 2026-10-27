import { getJobForExecution } from '@/server/ai/store';
import { inspectAcceptedPhotoReceipt } from '@/server/ai/image-provider';
import { AiError } from '@/server/ai/errors';
import { adminActor, adminResponse } from '@/server/http/admin';
import { aiFailure } from '@/server/http/ai';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Inspect an existing receipt. No generation, reservation, file or job is written. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await adminActor(request);
    const { id } = await context.params;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new AiError(404, 'AI_JOB_NOT_FOUND', 'Nie znaleziono zlecenia.');
    const job = await getJobForExecution(id);
    return adminResponse({ diagnostic: await inspectAcceptedPhotoReceipt(job) });
  } catch (error) { return aiFailure(error); }
}
