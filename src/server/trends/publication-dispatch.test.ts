import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('./daily-dispatch.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(options: { enabled?: boolean; billingFails?: boolean; preparationFails?: boolean } = {}) {
  const events: string[] = []; const logs: Record<string, unknown>[] = []; let admitted = false; let workflowId: string | null = null;
  const prepare = () => {};
  const imports: Record<string, unknown> = {
    'server-only': {},
    'workflow/api': { start: async (workflow: unknown, args: unknown[]) => { assert.equal(workflow, prepare); assert.deepEqual(Array.from(args), ['run', 1]); events.push('research-worker'); return { runId: 'research-workflow' }; } },
    '@/workflows/daily-preparation': { prepareDailyRecipe: prepare },
    './automated-publication': { dailyAutomationGate: async () => ({ enabled: false, reason: 'Manual publication required' }) },
    '@/server/ai/photo-cost-reconciliation': { reconcileAutomatedTrendPhotoCosts: async () => { events.push('billing'); if (options.billingFails) throw new Error('Private billing failure'); return { read: { status: 'verified' }, reconciledJobs: 2 }; } },
    './store': {
      admitTrendRun: async () => { events.push('research-admission'); if (options.preparationFails) throw { code: 'TREND_NOT_CONFIGURED', status: 503 }; if (options.enabled === false) return { skipped: true }; const created = !admitted; admitted = true; return { run: { id: 'run', status: 'queued', workflowId }, created, restarted: false, generation: 1 }; },
      attachTrendWorkflow: async (_id: string, value: string) => { workflowId = value; },
      failTrendRun: async () => { throw new Error('Unexpected dispatch failure'); },
      getTrendRun: async () => ({ run: { id: 'run', status: 'queued', workflowId } }),
    },
  };
  const exports: { dispatchPublicationTimer: () => Promise<{ skipped: boolean; reason: string }>; rearmPublicationTimerForPlan: () => Promise<{ skipped: boolean }>; dispatchDailyPreparation: () => Promise<{ publication: { skipped: boolean }; billing: { status: string }; preparation: { skipped?: boolean; code?: string } }> } = {} as never;
  runInNewContext(source, { exports, console: { info: (value: string) => logs.push(JSON.parse(value)), warn: (value: string) => logs.push(JSON.parse(value)) }, require: (name: string) => { assert(Object.hasOwn(imports, name), `Unexpected dispatch dependency: ${name}`); return imports[name]; } });
  return { ...exports, events, logs };
}

test('obsolete publication timer and rearm never access an engine or create a timer', async () => {
  const h = harness();
  assert.equal((await h.dispatchPublicationTimer()).skipped, true);
  assert.equal((await h.rearmPublicationTimerForPlan()).skipped, true);
  assert.deepEqual(h.events, []);
});
test('repeated daily cron starts one research worker while publication remains disabled', async () => {
  const h = harness();
  const first = await h.dispatchDailyPreparation(); const second = await h.dispatchDailyPreparation();
  assert.equal(first.publication.skipped, true); assert.equal(second.publication.skipped, true);
  assert.equal(h.events.filter(value => value === 'research-worker').length, 1);
  assert.equal(h.events.filter(value => value === 'research-admission').length, 2);
});
test('billing unavailability cannot suppress the enabled research schedule', async () => {
  const h = harness({ billingFails: true }); const result = await h.dispatchDailyPreparation();
  assert.equal(result.billing.status, 'unavailable'); assert.equal(h.events.includes('research-worker'), true);
  assert.equal(JSON.stringify(h.logs).includes('Private billing failure'), false);
});
test('disabled research schedule does not start any workflow', async () => {
  const h = harness({ enabled: false }); const result = await h.dispatchDailyPreparation();
  assert.equal(result.preparation.skipped, true); assert.equal(h.events.includes('research-worker'), false);
});
test('configuration failures return a safe exact code without publication work', async () => {
  const h = harness({ preparationFails: true }); const result = await h.dispatchDailyPreparation();
  assert.equal(result.preparation.code, 'TREND_NOT_CONFIGURED'); assert.equal(h.events.includes('research-worker'), false);
});
