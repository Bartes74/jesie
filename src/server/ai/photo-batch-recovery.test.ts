import test from 'node:test';
import assert from 'node:assert/strict';
import type { AiPhotoBatch } from '@/lib/ai-photo-batch-types';
import type { EditorialActor } from '@/lib/editorial-types';
import { AiError } from './errors';
import { createPhotoBatchRecoveryService } from './photo-batch-recovery';
import { ProviderError } from './provider-error';

const actor: EditorialActor = { id: 'owner', name: 'Owner', email: 'owner@example.invalid', role: 'owner' };
const original = { generation: 3, status: 'generating' as const, workflowRunId: 'wrun_original', updatedAt: '2026-10-13T00:00:00.000Z' };
const current = { batch: { id: 'packet', status: 'generating' } as AiPhotoBatch, generation: 3, dispatch: false };

test('an active engine run wakes its own receipt polling without replacing its worker', async () => {
  let wakes = 0; const proofs: unknown[] = [];
  const recover = createPhotoBatchRecoveryService({ state: async () => original,
    resume: async (_id, _actor, evidence) => { proofs.push(evidence); return current; },
    run: runId => { assert.equal(runId, original.workflowRunId); return { exists: async () => true,
      status: async () => 'running', wakeUp: async () => { wakes++; } }; } });
  assert.equal((await recover('packet', actor)).dispatch, false);
  assert.equal(wakes, 1); assert.deepEqual(proofs, [undefined]);
});

test('only authoritative terminal or absent engine states supply a matched restart proof', async () => {
  for (const status of ['completed', 'failed', 'cancelled', 'missing']) {
    let evidence: unknown;
    const recover = createPhotoBatchRecoveryService({ state: async () => original,
      resume: async (_id, _actor, proof) => { evidence = proof; return { ...current, dispatch: true }; },
      run: () => ({ exists: async () => status !== 'missing', status: async () => status,
        wakeUp: async () => assert.fail('A terminal worker cannot be woken') }) });
    assert.equal((await recover('packet', actor)).dispatch, true);
    assert.deepEqual(evidence, { generation: 3, runId: 'wrun_original', status });
  }
});

test('unavailable or unrecognized engine status never authorizes another worker', async () => {
  for (const broken of ['unavailable', 'unknown']) {
    let resumed = 0;
    const recover = createPhotoBatchRecoveryService({ state: async () => original,
      resume: async () => { resumed++; return current; },
      run: () => ({ exists: async () => { if (broken === 'unavailable') throw new Error('raw credential-bearing service error'); return true; },
        status: async () => 'unrecognized', wakeUp: async () => assert.fail('No wake allowed') }) });
    await assert.rejects(recover('packet', actor), error => error instanceof AiError && error.code === 'PHOTO_BATCH_WORKFLOW_STATE_UNAVAILABLE');
    assert.equal(resumed, 0);
  }
});

test('a lease changed during inspection does not wake the old worker', async () => {
  let reads = 0; let wakes = 0;
  const recover = createPhotoBatchRecoveryService({ state: async () => ++reads === 1 ? original : { ...original, generation: 4, workflowRunId: 'wrun_new' },
    resume: async () => ({ ...current, generation: 4 }),
    run: () => ({ exists: async () => true, status: async () => 'pending', wakeUp: async () => { wakes++; } }) });
  await recover('packet', actor); assert.equal(wakes, 0);
});

test('uncertain wake dispatch preserves the same worker and reports a recoverable error', async () => {
  const recover = createPhotoBatchRecoveryService({ state: async () => original, resume: async () => current,
    run: () => ({ exists: async () => true, status: async () => 'running', wakeUp: async () => { throw new Error('unconfirmed dispatch'); } }) });
  await assert.rejects(recover('packet', actor), error => error instanceof AiError && error.code === 'PHOTO_BATCH_WAKE_UNCONFIRMED');
});

test('a stopped package resumes its saved jobs, while a missing first claim is fenced in the transaction', async () => {
  for (const status of ['blocked', 'queued'] as const) {
    let evidence: unknown;
    const recover = createPhotoBatchRecoveryService({ state: async () => ({ ...original, status, workflowRunId: null }),
      resume: async (_id, _actor, proof) => { evidence = proof; return current; },
      run: () => assert.fail('There is no engine identity to query') });
    await recover('packet', actor);
    assert.deepEqual(evidence, status === 'blocked' ? undefined : { generation: 3, runId: null, status: 'missing' });
  }
});

test('unavailable storage pauses before re-admitting a paid attempt or dispatching a new worker', async () => {
  let resumes = 0; const pauses: unknown[] = [];
  const recover = createPhotoBatchRecoveryService({ state: async () => ({ ...original, status: 'blocked' }),
    resume: async () => { resumes++; return current; }, run: () => assert.fail('No engine call required'),
    storageReady: async () => { throw new ProviderError('AI_STORAGE_CAPACITY', 'No storage headroom'); },
    pause: async (...args) => { pauses.push(args); return { ...current.batch, status: 'blocked' }; } });
  const result = await recover('packet', actor);
  assert.equal(result.dispatch, false); assert.equal(resumes, 0);
  assert.deepEqual(pauses, [['packet', 3, 'AI_STORAGE_CAPACITY', 'No storage headroom', false]]);
});

test('a storage pause preserves a failed package so continuation can restore its released reservation', async () => {
  let status: 'failed' | 'blocked' = 'failed'; let available = false; let resumes = 0;
  const recover = createPhotoBatchRecoveryService({
    state: async () => ({ ...original, status }),
    resume: async () => {
      assert.equal(status, 'failed', 'Released reservation must retain the failed rebuild path');
      resumes++; return { ...current, dispatch: true };
    },
    run: () => assert.fail('A stopped package has no active engine query'),
    storageReady: async () => { if (!available) throw new ProviderError('AI_STORAGE_CAPACITY', 'No storage headroom'); },
    pause: async (_id, _generation, _code, _message, failed) => {
      status = failed ? 'failed' : 'blocked'; return { ...current.batch, status };
    },
  });
  const paused = await recover('packet', actor);
  assert.equal(paused.batch.status, 'failed'); assert.equal(paused.dispatch, false); assert.equal(resumes, 0);
  available = true;
  assert.equal((await recover('packet', actor)).dispatch, true); assert.equal(resumes, 1);
});
