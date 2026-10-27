import { start } from 'workflow/api';
import { aiGeneration } from '@/workflows/ai-generation';
import { applyJob, cancelJob, getJobForExecution, resumeJob, failJob } from '@/server/ai/store';
import { cancelText } from '@/server/ai/text-provider';
import { cancelImage } from '@/server/ai/image-provider';
import { recoverAcceptedPhoto } from '@/server/ai/accepted-photo-recovery';
import { recoverRecipeResult, recheckRecipeResult } from '@/server/ai/recipe-recovery-dispatch';
import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { aiActionInput, aiFailure } from '@/server/http/ai';

export const runtime = 'nodejs';
export const maxDuration = 180;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await adminActor(request, true);
    const { id } = await context.params;
    const input = aiActionInput.parse(await readJson(request));
    if (input.action === 'apply') return adminResponse(await applyJob(id, input, actor));
    if (input.action === 'recover') return adminResponse({ job: await recoverRecipeResult(id, actor) }, 202);
    if (input.action === 'recheck') return adminResponse({ job: await recheckRecipeResult(id, actor) }, 202);
    if (input.action === 'cancel') {
      const job = await cancelJob(id, actor);
      if (job.providerRequestId) {
        const captured = await getJobForExecution(id);
        try {
          if (captured.provider === 'openai') await cancelText(job.providerRequestId);
          else await cancelImage(captured.model, job.providerRequestId);
        } catch { /* Cancellation is a request, not proof of no charge or no result. */ }
      }
      return adminResponse({ job });
    }
    const captured = await getJobForExecution(id);
    if (captured.kind === 'recipe') return adminResponse({ job: await recoverRecipeResult(id, actor) }, 202);
    const job = await resumeJob(id, actor);
    const recovered = await recoverAcceptedPhoto(id);
    if (recovered.handled) return adminResponse({ job: recovered.job });
    try { await start(aiGeneration, [id], { region: 'fra1' }); }
    catch { return adminResponse({ job: await failJob(id, { code: 'AI_DISPATCH_UNCONFIRMED', message: 'Nie potwierdzono uruchomienia odczytu zlecenia. Spróbuj wznowić odczyt ponownie.', uncertain: true }) }, 202); }
    return adminResponse({ job }, 202);
  } catch (error) { return aiFailure(error); }
}
