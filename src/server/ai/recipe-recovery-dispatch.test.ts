import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { AiError } from './errors';

function harness(options: { status?: string; unknown?: boolean; lostStart?: boolean; lostAttach?: boolean; dispatch?: boolean } = {}) {
  const calls: string[] = []; const job = { id: 'existing', status: 'generating' };
  const imports: Record<string, unknown> = { 'server-only': {}, 'workflow/api': {}, '@/workflows/ai-generation': {}, './errors': { AiError },
    './store': {}, './recipe-recovery': {}, './recipe-recovery-state': {} };
  const exports: Partial<typeof import('./recipe-recovery-dispatch')> = {};
  const code = ts.transpileModule(readFileSync(new URL('./recipe-recovery-dispatch.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, console, require: (path: string) => { assert.ok(Object.hasOwn(imports, path), path); return imports[path]; } });
  const dependencies = {
    state: async () => ({ job, entry: options.status || options.unknown ? { workflowRunId: 'old-run', generation: 4 } : null }),
    read: async () => job,
    begin: async (_id: string, _actor: unknown, evidence: unknown) => { calls.push('begin'); if (options.status) assert.deepEqual(JSON.parse(JSON.stringify(evidence)), { generation: 4, workflowRunId: 'old-run', status: 'terminated' }); return { job, generation: 5, dispatch: options.dispatch !== false }; },
    start: async (id: string, generation: number) => { assert.equal(id, 'existing'); assert.equal(generation, 5); calls.push('start'); if (options.lostStart) throw new Error('lost'); return { runId: 'new-run' }; },
    record: async () => { calls.push('record'); if (options.lostAttach) throw new Error('db outage'); },
    run: () => ({ status: async () => { if (options.unknown) throw new Error('outage'); return options.status; }, wake: async () => { calls.push('wake'); } }),
    unconfirmed: async () => { calls.push('retain'); },
  };
  const recover = exports.createRecipeRecoveryDispatcher!(dependencies as never);
  return { calls, run: () => recover('original', { id: 'owner', name: 'Owner', email: '', role: 'owner' }) };
}
test('an active worker is woken rather than duplicated', async () => {
  const h = harness({ status: 'running' }); await h.run(); assert.deepEqual(h.calls, ['wake']);
});
test('a confirmed terminated worker permits one guarded replacement', async () => {
  const h = harness({ status: 'failed' }); await h.run(); assert.deepEqual(h.calls, ['begin', 'start', 'record']);
});
test('an unknown engine state cannot reset a lease or start a second worker', async () => {
  const h = harness({ unknown: true }); await assert.rejects(h.run(), { code: 'AI_RECOVERY_WORKFLOW_UNAVAILABLE' }); assert.deepEqual(h.calls, []);
});
test('a lost start response keeps the claim, while a lost attach is left to the first worker claim', async () => {
  const unknown = harness({ lostStart: true }); await unknown.run(); assert.deepEqual(unknown.calls, ['begin', 'start', 'retain']);
  const accepted = harness({ lostAttach: true }); await accepted.run(); assert.deepEqual(accepted.calls, ['begin', 'start', 'record']);
  const duplicate = harness({ dispatch: false }); await duplicate.run(); assert.deepEqual(duplicate.calls, ['begin']);
});
