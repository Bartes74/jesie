import { getWorkflowMetadata, sleep } from 'workflow';
import { advanceCollectionTheme, attachThemeRun, pauseCollectionTheme } from '@/server/collections/theme-steps';

export async function collectionThemeWorkflow(id: string, token: string) {
  'use workflow';
  console.info('Collection artwork workflow started', { generationId: id });
  await attachThemeRun(id, token, getWorkflowMetadata().workflowRunId);
  for (let poll = 0; poll < 150; poll++) {
    try { if (await advanceCollectionTheme(id, token)) return; }
    catch { await pauseCollectionTheme(id, token); return; }
    await sleep('10s');
  }
  await pauseCollectionTheme(id, token);
}
