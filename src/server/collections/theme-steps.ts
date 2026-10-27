import { RetryableError } from 'workflow';
import { advanceThemeGeneration, attachThemeWorkflow, stopThemeGeneration } from './theme-store';

export async function attachThemeRun(id: string, token: string, runId: string) {
  'use step';
  console.info('Collection artwork workflow attached', { generationId: id });
  await attachThemeWorkflow(id, token, runId);
}
export async function advanceCollectionTheme(id: string, token: string) {
  'use step';
  console.info('Collection artwork workflow advanced', { generationId: id });
  return advanceThemeGeneration(id, token);
}
// A paid submission must never be automatically replayed by the workflow engine.
advanceCollectionTheme.maxRetries = 0;
export async function pauseCollectionTheme(id: string, token: string) {
  'use step';
  try { await stopThemeGeneration(id, 'Nie potwierdzono zakończenia oprawy. Wznów odczyt istniejącego zlecenia w panelu.', token); }
  catch { throw new RetryableError('COLLECTION_STATE_UNAVAILABLE', { retryAfter: '30s' }); }
}
