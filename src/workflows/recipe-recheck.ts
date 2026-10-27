import { getWorkflowMetadata, sleep } from 'workflow';
import { claimGenerationRecovery, pollGeneration, expireGeneration } from '@/server/ai/steps';

/** Existing provider GETs and saved ingredient evidence only: no submission or repair admission. */
export async function recipeRecheck(jobId: string, generation: number) {
  'use workflow';
  if (!await claimGenerationRecovery(jobId, generation, getWorkflowMetadata().workflowRunId)) return;
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await pollGeneration(jobId, true)) return;
      await sleep('10s');
    }
  } catch { /* Preserve the receipt after exhausted safe GET retries. */ }
  await expireGeneration(jobId);
}
