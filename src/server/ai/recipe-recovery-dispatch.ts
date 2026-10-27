import 'server-only';
import { getRun, start } from 'workflow/api';
import type { EditorialActor } from '@/lib/editorial-types';
import { aiGeneration } from '@/workflows/ai-generation';
import { AiError } from './errors';
import { getJob, getJobForExecution } from './store';
import { beginRecipeResultRecovery, markRecipeRecoveryDispatchUnconfirmed, recordRecipeRecoveryDispatch, type RecipeRecoveryEvidence } from './recipe-recovery';
import { recipeRecoveryReadableState } from './recipe-recovery-state';

async function recoveryState(id: string) {
  const readable = await recipeRecoveryReadableState(id);
  const job = readable.job ?? await getJobForExecution(id);
  return { job, entry: readable.entry };
}

type Dependencies = {
  state: typeof recoveryState;
  begin: typeof beginRecipeResultRecovery;
  read: typeof getJob;
  record: typeof recordRecipeRecoveryDispatch;
  start: (id: string, generation: number) => Promise<{ runId: string }>;
  run: (id: string) => { status: () => Promise<string>; wake: () => Promise<unknown> };
  unconfirmed: (id: string, generation: number) => Promise<void>;
};

/** An uncertain start retains its lease; a late worker claims it before any POST. */
export function createRecipeRecoveryDispatcher(dependencies: Dependencies) {
  return async (id: string, actor: EditorialActor) => {
    const state = await dependencies.state(id);
    let evidence: RecipeRecoveryEvidence | undefined;
    if (state.entry?.workflowRunId) {
      let status: string;
      const run = dependencies.run(state.entry.workflowRunId);
      try { status = await run.status(); }
      catch { throw new AiError(503, 'AI_RECOVERY_WORKFLOW_UNAVAILABLE', 'Nie udało się sprawdzić istniejącego procesu. Zachowano to samo zlecenie; spróbuj ponownie odczytać jego stan.'); }
      if (status === 'pending' || status === 'running') {
        try { await run.wake(); }
        catch { throw new AiError(503, 'AI_RECOVERY_WAKE_UNCONFIRMED', 'Proces nadal istnieje. Nie potwierdzono przyspieszenia odczytu; zachowano jego zlecenie.'); }
        return dependencies.read(state.job.id);
      }
      if (!['completed', 'failed', 'cancelled'].includes(status)) throw new AiError(503, 'AI_RECOVERY_WORKFLOW_UNAVAILABLE', 'Nie rozpoznano stanu istniejącego procesu. Nie rozpoczęto kolejnej generacji.');
      evidence = { generation: state.entry.generation, workflowRunId: state.entry.workflowRunId, status: 'terminated' };
    }
    const admitted = await dependencies.begin(state.job.id, actor, evidence);
    if (!admitted.dispatch) return dependencies.read(admitted.job.id);
    let runId: string;
    try { runId = (await dependencies.start(admitted.job.id, admitted.generation)).runId; }
    catch { await dependencies.unconfirmed(admitted.job.id, admitted.generation); return dependencies.read(admitted.job.id); }
    try { await dependencies.record(admitted.job.id, admitted.generation, runId); }
    catch { console.info('Recipe recovery workflow receipt persistence deferred', { jobId: admitted.job.id, generation: admitted.generation }); }
    return dependencies.read(admitted.job.id);
  };
}

export const recoverRecipeResult = createRecipeRecoveryDispatcher({
  state: recoveryState, begin: beginRecipeResultRecovery, read: getJob, record: recordRecipeRecoveryDispatch,
  start: (id, generation) => start(aiGeneration, [id, generation], { region: 'fra1' }),
  run: id => { const run = getRun(id); return { status: () => run.status, wake: () => run.wakeUp() }; },
  unconfirmed: markRecipeRecoveryDispatchUnconfirmed,
});
