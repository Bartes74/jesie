import { getWorkflowMetadata, sleep } from 'workflow';
import { submitGeneration, pollGeneration, expireGeneration, reconcileGeneration, claimGenerationRecovery, advanceGenerationRecovery, prepareManualHeroCutout } from '@/server/ai/steps';
import { recipeRepairBackoff, recipeRepairLimit } from '@/server/ai/recipe-recovery-policy';

export async function aiGeneration(jobId: string, generation = 1) {
  'use workflow';
  const workflowRunId = getWorkflowMetadata().workflowRunId;
  const runGeneration = async (id: string) => {
    try {
      if (await submitGeneration(id)) {
        let confirmed = false;
        for (let attempt = 0; attempt < 360; attempt++) {
          await sleep('10s');
          if (await pollGeneration(id)) { confirmed = true; break; }
        }
        if (!confirmed) await expireGeneration(id);
      }
    } catch { await expireGeneration(id); }
  };
  const reconcile = async (id: string) => {
    for (let reconciliation = 0; reconciliation < 6; reconciliation++) {
      if (await reconcileGeneration(id)) break;
      await sleep('5m');
    }
  };
  let currentId = jobId;
  let currentGeneration = generation;
  for (let repair = 0; repair <= recipeRepairLimit; repair++) {
    if (!await claimGenerationRecovery(currentId, currentGeneration, workflowRunId)) return;
    await runGeneration(currentId);
    // A manual retake may need one mask of its already completed photograph.
    // This never re-renders the food, auto-applies it, or retries an empty SAM.
    let cutout: Awaited<ReturnType<typeof prepareManualHeroCutout>> = null;
    try { cutout = await prepareManualHeroCutout(currentId, workflowRunId); }
    catch { /* The original receipt and manual correction action remain available. */ }
    if (cutout?.run) {
      try { await runGeneration(cutout.jobId); await reconcile(cutout.jobId); }
      catch { console.info('Studio photo cutout billing reconciliation deferred', { jobId: cutout.jobId }); }
    }
    // These reads never submit another paid request or release an unknown bill.
    await reconcile(currentId);
    const next = await advanceGenerationRecovery(currentId, currentGeneration, workflowRunId);
    if (!next.continue || next.jobId === currentId) return;
    await sleep(recipeRepairBackoff[Math.min(next.attempt - 1, recipeRepairBackoff.length - 1)]);
    currentId = next.jobId;
    currentGeneration = next.generation;
  }
}
