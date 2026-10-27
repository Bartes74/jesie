import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const actor = { id: 'owner', name: 'Owner', email: '', role: 'owner' };
function harness(deny = false, action = 'recover') {
  const calls: string[] = []; let input: unknown = { action };
  const realRequire = createRequire(import.meta.url);
  const httpExports: Partial<typeof import('../http/ai')> = {};
  const schemaCode = ts.transpileModule(readFileSync(new URL('../http/ai.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(schemaCode, { exports: httpExports, require: (path: string) => path === 'zod' ? realRequire(path) : {} });
  const imports: Record<string, unknown> = {
    'workflow/api': {}, '@/workflows/ai-generation': {}, '@/server/ai/store': { getJobForExecution: async () => ({ kind: 'recipe' }) }, '@/server/ai/text-provider': {}, '@/server/ai/image-provider': {}, '@/server/ai/accepted-photo-recovery': {},
    '@/server/ai/recipe-recovery-dispatch': Object.fromEntries(['recover', 'recheck'].map(action => [`${action}RecipeResult`, async (id: string, received: unknown) => { assert.equal(id, 'job'); assert.equal(received, actor); calls.push(action); return { id: 'effective', status: 'generating' }; }])),
    '@/server/http/admin': { adminActor: async (_request: unknown, mutate: boolean) => { assert.equal(mutate, true); calls.push('auth'); if (deny) throw new Error('forbidden'); return actor; },
      readJson: async () => { calls.push('read'); return input; }, adminResponse: (body: unknown, status = 200) => ({ body, status }) },
    '@/server/http/ai': { aiActionInput: httpExports.aiActionInput, aiFailure: () => ({ status: 400 }) },
  };
  const exports: Partial<typeof import('../../app/api/admin/ai/[id]/actions/route')> = {};
  const code = ts.transpileModule(readFileSync(new URL('../../app/api/admin/ai/[id]/actions/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, require: (path: string) => { assert.ok(Object.hasOwn(imports, path), path); return imports[path]; } });
  return { calls, invalid: () => { input = { action, previousResponseId: 'injected' }; }, run: () => exports.POST!({} as Request, { params: Promise.resolve({ id: 'job' }) }) };
}
test('recover authenticates mutation first and returns the effective job without apply or publish', async () => {
  const h = harness(); const result = await h.run() as unknown as { status: number; body: { job: { id: string } } };
  assert.equal(result.status, 202); assert.equal(result.body.job.id, 'effective'); assert.deepEqual(h.calls, ['auth', 'read', 'recover']);
});
test('recheck is separately authenticated, strict and does not call automatic recovery', async () => {
  const h = harness(false, 'recheck'); const result = await h.run() as unknown as { status: number };
  assert.equal(result.status, 202); assert.deepEqual(h.calls, ['auth', 'read', 'recheck']);
  const denied = harness(true, 'recheck'); await denied.run(); assert.deepEqual(denied.calls, ['auth']);
  const invalid = harness(false, 'recheck'); invalid.invalid(); await invalid.run(); assert.deepEqual(invalid.calls, ['auth', 'read']);
});
test('legacy recipe resume also performs only the guarded retained-result recheck', async () => {
  const h = harness(false, 'resume'); const result = await h.run() as unknown as { status: number };
  assert.equal(result.status, 202); assert.deepEqual(h.calls, ['auth', 'read', 'recheck']);
});
test('recover rejects unauthorized requests and extra injected repair parameters', async () => {
  const denied = harness(true); await denied.run(); assert.deepEqual(denied.calls, ['auth']);
  const invalid = harness(); invalid.invalid(); await invalid.run(); assert.deepEqual(invalid.calls, ['auth', 'read']);
});
