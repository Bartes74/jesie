import { start } from 'workflow/api';
import { aiGeneration } from '@/workflows/ai-generation';
import { createJobAdmission, listJobs, getConfiguration, failJob } from '@/server/ai/store';
import { adminActor, adminResponse, readJson } from '@/server/http/admin';
import { createAiInput, aiFailure } from '@/server/http/ai';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const actor = await adminActor(request);
    const [jobs, configuration] = await Promise.all([listJobs(undefined, { allowMaskRetry: actor.role === 'owner' }), getConfiguration()]);
    return adminResponse({ jobs, configuration });
  } catch (error) { return aiFailure(error); }
}
export async function POST(request: Request) {
  try {
    const actor = await adminActor(request, true);
    const input = createAiInput.parse(await readJson(request));
    const {job,created} = await createJobAdmission(input, actor);
    if (created && job.status === 'queued') {
      try { await start(aiGeneration, [job.id], { region: 'fra1' }); }
      catch {
        const recorded = await failJob(job.id, { code: 'AI_DISPATCH_UNCONFIRMED', message: 'Nie potwierdzono uruchomienia zadania. Zachowano zlecenie i rezerwację; sprawdź jego stan przed kolejną generacją.', uncertain: true });
        return adminResponse({ job: recorded }, 202);
      }
    }
    return adminResponse({ job }, 202);
  } catch (error) { return aiFailure(error); }
}
