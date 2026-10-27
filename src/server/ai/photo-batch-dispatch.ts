import 'server-only';
import { start } from 'workflow/api';
import { aiPhotoBatch } from '@/workflows/ai-photo-batch';
import { getPhotoBatch, recordPhotoBatchWorkflowDispatch, stopPhotoBatchDispatchUnconfirmed } from './photo-batch';

type Dependencies = {
  start: (id: string, generation: number) => Promise<{ runId: string }>;
  record: typeof recordPhotoBatchWorkflowDispatch;
  state: typeof getPhotoBatch;
  unconfirmed: typeof stopPhotoBatchDispatchUnconfirmed;
};

/** A dispatch failure cannot pause a different worker that already claimed the packet. */
export function createPhotoBatchDispatcher(dependencies: Dependencies) {
  return async (id: string, generation: number) => {
    let runId: string;
    try { runId = (await dependencies.start(id, generation)).runId; }
    catch {
      return dependencies.unconfirmed(id, generation, 'Nie potwierdzono uruchomienia pakietu. Zachowano istniejące zlecenia; sprawdź i wznów ten sam pakiet.');
    }
    try { await dependencies.record(id, generation, runId); }
    catch {
      // The engine accepted this run. Its first claim also persists the ID;
      // a failed receipt write is not evidence that dispatch failed.
      console.info('Studio photo workflow receipt persistence deferred', { batchId: id, generation });
    }
    return dependencies.state(id);
  };
}

export const dispatchPhotoBatch = createPhotoBatchDispatcher({
  start: (id, generation) => start(aiPhotoBatch, [id, generation], { region: 'fra1' }),
  record: recordPhotoBatchWorkflowDispatch,
  state: getPhotoBatch,
  unconfirmed: stopPhotoBatchDispatchUnconfirmed,
});
