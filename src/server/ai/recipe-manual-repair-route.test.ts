import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { manualRecipeRepairInput } from './recipe-manual-repair';
import { AiError } from './errors';

function harness(options: { denied?: boolean; dispatchFailure?: boolean } = {}) {
  const calls: string[] = [];
  let input: unknown = { expectedRevision: 1, expectedVersion: 0, proposal: {}, reviewedIngredients: [], reason: 'Sprawdzono skład produktu.' };
  const actor = { id: 'owner', role: 'owner' };
  const imports: Record<string, unknown> = {
    '@/server/http/admin': {
      adminActor: async (_request: unknown, mutation: boolean) => { assert.equal(mutation, true); calls.push('auth'); if (options.denied) throw new Error('denied'); return actor; },
      readJson: async () => { calls.push('read'); return input; }, adminResponse: (body: unknown, status = 200) => ({ body, status }),
    },
    '@/server/http/ai': { aiFailure: () => ({ status: 400 }) }, '@/server/ai/errors': { AiError },
    '@/server/ai/recipe-manual-repair': { manualRecipeRepairInput,
      saveManualRecipeRepair: async (id: string, _input: unknown, account: unknown) => { assert.equal(id, 'job'); assert.equal(account, actor); calls.push('save'); return { jobId: id, version: 1 }; } },
    '@/server/ai/recipe-recovery-dispatch': { recheckRecipeResult: async () => { calls.push('recheck'); if (options.dispatchFailure) throw new AiError(503, 'UNAVAILABLE', 'Wznów ponownie.'); return { status: 'generating' }; } },
  };
  const exports: Partial<typeof import('../../app/api/admin/ai/[id]/recipe-repair/route')> = {};
  const code = ts.transpileModule(readFileSync(new URL('../../app/api/admin/ai/[id]/recipe-repair/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, require: (name: string) => { assert(Object.hasOwn(imports, name), name); return imports[name]; } });
  return { calls, inject: () => { input = { ...(input as object), providerRequestId: 'resp_forged' }; }, run: () => exports.POST!({} as Request, { params: Promise.resolve({ id: 'job' }) }) };
}

test('manual correction requires same-origin administrator authorization before reading or saving data', async () => {
  const h = harness({ denied: true }); await h.run(); assert.deepEqual(h.calls, ['auth']);
  const injection = harness(); injection.inject(); await injection.run(); assert.deepEqual(injection.calls, ['auth', 'read']);
});
test('the correction is saved before receipt-only recovery, with no paid-generation action', async () => {
  const h = harness(); const result = await h.run() as unknown as { status: number };
  assert.equal(result.status, 202); assert.deepEqual(h.calls, ['auth', 'read', 'save', 'recheck']);
});
test('a workflow outage returns the persisted correction version and an explicit retry message', async () => {
  const h = harness({ dispatchFailure: true });
  const result = await h.run() as unknown as { status: number; body: { version: number; recoveryPending: boolean; message: string } };
  assert.equal(result.status, 202); assert.equal(result.body.version, 1); assert.equal(result.body.recoveryPending, true);
  assert.equal(result.body.message, 'Wznów ponownie.');
});
