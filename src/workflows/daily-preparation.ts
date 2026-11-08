import { getWorkflowMetadata, sleep } from 'workflow';
import { pollWithBackoff, trendSearchPollDelays, trendRunLimits } from '@/lib/trend-polling';
import { reconcileGeneration } from '@/server/ai/steps';
import { submitRadar, pollRadar, continueDailySearchWithFallback, radarState, stopRadar, pendingRadarBills, reserveRadarPhotos } from '@/server/trends/steps';
import { approveRadarContent, finishRadarPreparation, planRadarPreparation } from '@/server/trends/preparation-steps';
import { claimDailyPreparation } from '@/server/trends/daily-preparation-steps';
import { preparePhoto, prepareText } from './trends';

/** One daily research request, then approved text, ingredients, steps and final dish. */
export async function prepareDailyRecipe(runId: string, generation = 1) {
  'use workflow';
  if (!await claimDailyPreparation(runId, generation, getWorkflowMetadata().workflowRunId)) return;
  try {
    let state = await radarState(runId, generation);
    if (!state.searchFinishedAt && !(state.status === 'generating' && state.candidateId && state.searchRequestId)) {
      if (!await submitRadar(runId, generation)) return;
      let done = false;
      try { done = await pollRadar(runId, generation) || await pollWithBackoff(trendSearchPollDelays, sleep, () => pollRadar(runId, generation)); }
      catch { /* The stored receipt remains available to the separate reconciliation job. */ }
      if (!done && !await continueDailySearchWithFallback(runId, generation)) return;
    }
    state = await radarState(runId, generation);
    if (state.status !== 'generating' || !state.recipeId) return;
    const text = await prepareText(runId, generation);
    if (text.state !== 'complete') { await stopRadar(runId, text.reason ?? 'Nie ukończono opracowania treści.', text.state === 'blocked', generation); return; }
    if (!await approveRadarContent(runId, generation)) return;
    if ((await reserveRadarPhotos(runId, generation))?.blocked) return;
    const plan = await planRadarPreparation(runId, generation);
    // Slots are ingredients, steps, then hero. Save each result before the next
    // stage; an unresolved request stops later spending.
    for (const slot of plan.slots) {
      const result = await preparePhoto(runId, generation, slot);
      if (result.state !== 'complete') {
        await stopRadar(runId, result.reason ?? 'Jedno zdjęcie wymaga uzupełnienia. Gotowe materiały zapisano.', result.state === 'blocked', generation);
        return;
      }
    }
    await finishRadarPreparation(runId, generation);
  } catch {
    await stopRadar(runId, 'Przygotowanie wstrzymano. Zachowano treść, zdjęcia i istniejące zlecenia do wyjaśnienia.', false, generation);
  } finally {
    for (let attempt = 0; attempt < trendRunLimits.billingAttempts; attempt++) {
      const ids = await pendingRadarBills(runId);
      if (!ids.length) break;
      for (const id of ids) await reconcileGeneration(id);
      if (attempt < trendRunLimits.billingAttempts - 1) await sleep('5m');
    }
  }
}
