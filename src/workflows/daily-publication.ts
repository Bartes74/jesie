import { getWorkflowMetadata, sleep } from 'workflow';
import { claimDailyPublisher, dailyPublicationState, releaseDailyRecipe } from '@/server/trends/publication-steps';

/** A small independent timer releases one complete recipe; it never calls an AI provider. */
export async function publishDailyRecipe(date: string, generation = 1) {
  'use workflow';
  if (!await claimDailyPublisher(date, generation, getWorkflowMetadata().workflowRunId)) return;
  const state = await dailyPublicationState(date);
  if (state.generation !== generation || state.status === 'published') return;
  if (new Date(state.serverNow).getTime() < new Date(state.dueAt).getTime()) await sleep(new Date(state.dueAt));
  // Brief recovery covers a last-minute completed photo or a transient database
  // outage. The database rejects previous dates and atomically limits the day.
  for (let attempt = 0; attempt < 13; attempt++) {
    const current = await dailyPublicationState(date);
    if (current.generation !== generation) return;
    const result = await releaseDailyRecipe(date, generation);
    if (result.status !== 'waiting' && result.status !== 'early') return result;
    if (result.status === 'early') await sleep(new Date(result.state.dueAt));
    else if (attempt < 12) await sleep('5m');
  }
}
