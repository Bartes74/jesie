import 'server-only';
import { start } from 'workflow/api';
import { prepareDailyRecipe } from '@/workflows/daily-preparation';
import { dailyAutomationGate } from './automated-publication';
import { admitTrendRun, attachTrendWorkflow, failTrendRun, getTrendRun } from './store';
import { reconcileAutomatedTrendPhotoCosts } from '@/server/ai/photo-cost-reconciliation';

function reportedDispatch<T extends { publication: unknown; billing: { status: string; reconciledJobs?: number }; preparation: { skipped?: boolean; code?: string; run?: { id: string; status?: string }; created?: boolean } }>(result: T): T {
  const entry = { event: 'daily_preparation_dispatch', billingStatus: result.billing.status, reconciledJobs: result.billing.reconciledJobs ?? 0,
    preparation: result.preparation.skipped ? 'skipped' : result.preparation.created ? 'created' : 'existing',
    code: result.preparation.code && /^[A-Z_]{1,80}$/.test(result.preparation.code) ? result.preparation.code : null,
    runId: result.preparation.run?.id ?? null, runStatus: result.preparation.run?.status ?? null };
  if (result.preparation.skipped) console.warn(JSON.stringify(entry)); else console.info(JSON.stringify(entry));
  return result;
}

export async function dispatchPublicationTimer() {
  const gate = await dailyAutomationGate();
  return { skipped: true as const, reason: gate.reason };
}

/** Exact-date automatic timers are obsolete; research dispatch remains separate. */
export async function rearmPublicationTimerForPlan() {
  return dispatchPublicationTimer();
}

export async function dispatchAdmittedPreparation(admitted: Exclude<Awaited<ReturnType<typeof admitTrendRun>>, { skipped: true }>) {
  if (admitted.created || admitted.restarted || admitted.run.status === 'queued' && !admitted.run.workflowId) {
    try {
      const workflow = await start(prepareDailyRecipe, [admitted.run.id, admitted.generation], { region: 'fra1' });
      await attachTrendWorkflow(admitted.run.id, workflow.runId, admitted.generation);
    } catch {
      await failTrendRun(admitted.run.id, 'Nie potwierdzono uruchomienia przygotowania. Zachowano istniejące żądanie i gotowe materiały.', true, admitted.generation);
    }
  }
  return getTrendRun(admitted.run.id);
}

/** Noon researches and drafts text; publication is always a human action. */
export async function dispatchDailyPreparation() {
  let publication: Awaited<ReturnType<typeof dispatchPublicationTimer>> | { retry: true };
  try { publication = await dispatchPublicationTimer(); }
  catch { publication = { retry: true }; }
  // Existing terminal receipts update actual cost reporting independently of
  // today's admission. A missing bill never causes a provider submission.
  let billing: { status: string; reconciledJobs?: number };
  try {
    const report = await reconcileAutomatedTrendPhotoCosts();
    billing = { status: report.read.status, reconciledJobs: report.reconciledJobs };
  } catch { billing = { status: 'unavailable' }; }
  // Preparation has its own explicit switch and provider configuration gate. A disabled
  // publisher or unavailable timer engine must not suppress that independent work.
  try {
    const admitted = await admitTrendRun('daily');
    if ('skipped' in admitted) return reportedDispatch({ publication, billing, preparation: admitted });
    const detail = await dispatchAdmittedPreparation(admitted);
    return reportedDispatch({ publication, billing, preparation: { run: detail.run, created: admitted.created } });
  } catch (error) {
    // Surface only the safe preparation code; publication remains disabled.
    const failure = error as { code?: string; status?: number };
    if (!failure.code || !failure.status) throw error;
    return reportedDispatch({ publication, billing, preparation: { skipped: true, code: failure.code } });
  }
}
