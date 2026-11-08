import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { recipeReceiptInput } from './recipe-receipt-recovery';
import { AiError } from './errors';

function harness(options: { denied?: boolean; unavailable?: boolean; injected?: boolean } = {}) {
  const calls: string[] = [];
  const actor = { id: 'owner', role: 'owner' };
  const input = { requestId: 'resp_existing_receipt', reason: 'Sprawdzono zgłoszenie u dostawcy.', ...(options.injected ? { metadata: { jesie_job_id: 'forged' } } : {}) };
  const imports: Record<string, unknown> = {
    '@/server/http/admin': { adminActor: async (_request: unknown, mutation: boolean) => { calls.push('auth'); assert.equal(mutation, true); if (options.denied) throw new Error('denied'); return actor; },
      readJson: async () => { calls.push('read'); return input; }, adminResponse: (body: unknown, status = 200) => ({ body, status }) },
    '@/server/http/ai': { aiFailure: () => ({ status: 400 }) }, '@/server/ai/errors': { AiError },
    '@/server/ai/recipe-receipt-recovery': { recipeReceiptInput, attachRecipeReceipt: async (id: string, _input: unknown, account: unknown) => { assert.equal(id, 'job'); assert.equal(account, actor); calls.push('verify-and-attach'); } },
    '@/server/ai/recipe-recovery-dispatch': { recheckRecipeResult: async () => { calls.push('read-existing'); if (options.unavailable) throw new AiError(503, 'UNAVAILABLE', 'Ponów odczyt.'); return { status: 'generating' }; } },
  };
  const exports: Partial<typeof import('../../app/api/admin/ai/[id]/receipt/route')> = {};
  const code = ts.transpileModule(readFileSync(new URL('../../app/api/admin/ai/[id]/receipt/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, require: (name: string) => { assert(Object.hasOwn(imports, name), name); return imports[name]; } });
  return { calls, run: () => exports.POST!({} as Request, { params: Promise.resolve({ id: 'job' }) }) };
}
test('receipt reconciliation checks authenticated same-origin mutation first and rejects forged client evidence', async () => {
  const denied = harness({ denied: true }); await denied.run(); assert.deepEqual(denied.calls, ['auth']);
  const injected = harness({ injected: true }); await injected.run(); assert.deepEqual(injected.calls, ['auth', 'read']);
});
test('a verified receipt is attached before receipt-only recovery, without submitting a generation', async () => {
  const h = harness(); const result = await h.run() as unknown as { status: number };
  assert.equal(result.status, 202); assert.deepEqual(h.calls, ['auth', 'read', 'verify-and-attach', 'read-existing']);
});
test('a dispatch outage retains the attachment and exposes a safe read retry', async () => {
  const h = harness({ unavailable: true });
  const result = await h.run() as unknown as { body: { recoveryPending: boolean; message: string } };
  assert.equal(result.body.recoveryPending, true); assert.equal(result.body.message, 'Ponów odczyt.');
});
