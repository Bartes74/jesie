import test from 'node:test';
import assert from 'node:assert/strict';
import type { AiJob } from '@/lib/ai-types';
import { createAcceptedPhotoBatchRecovery, type AcceptedPhotoBatchChild } from './accepted-photo-batch-recovery';
import { approvedImageModel, heroCenterFoodRejectionMessage, heroCutoutModel, heroMaskPromptVersion } from './image-actions';
import { recipes } from '@/lib/recipes';
import { AiError } from './errors';

const batchId = '06a2f1ef-f716-48de-86a8-8b1e5578208d';
const ids = ['c9fa7908-1c65-4e5d-9afc-66a1928cd227', '335e9a28-f53d-486e-a93a-ebd115cde804', '445c5408-7c76-40bd-bb51-53fdc181c8d7'];
const child = (id = ids[0], change: Partial<AcceptedPhotoBatchChild> = {}): AcceptedPhotoBatchChild => ({
  id, photoBatchId: batchId, recipeId: recipes[0].id, provider: 'fal', model: heroCutoutModel, kind: 'hero', status: 'generating',
  input: { recipe: { ...structuredClone(recipes[0]), image: '/ai-result/62a15f5e-4294-4af3-9249-a72edbf61e1e',
    heroPresentation: { container: 'pan', profileVersion: 'jesie-finished-dish-v2', evidenceStepIds: [], finalAppearance: { pl: 'Gotowa potrawa.', en: 'Finished dish.' } } },
    author: '', originalText: '', sources: [], photos: { ingredients: {}, steps: {} }, aiPhotography: { heroMaskPromptVersion } },
  errorCode: null, errorMessage: null, chargedUsd: null, costBasis: null, appliedRevision: null,
  providerRequestId: '01a13708-9d4d-7ce2-98a2-a177d0e4c4cf', providerFinishedAt: new Date('2026-10-13T22:29:00Z'), result: null, ...change,
});
const actor = { id: 'owner', name: 'Owner', email: 'owner@example.invalid', role: 'owner' as const };
const failedHero = (change: Partial<AcceptedPhotoBatchChild> = {}) => child(ids[0], {
  status: 'failed', errorCode: 'AI_IMAGE_INVALID', errorMessage: heroCenterFoodRejectionMessage,
  chargedUsd: '0.00500000', costBasis: 'usage', ...change,
});

test('authenticated continuation restores only an allowlisted failed hero through its same accepted receipt', async () => {
  const failed = failedHero(); const snapshot = structuredClone(failed); const calls: string[] = [];
  const recover = createAcceptedPhotoBatchRecovery({
    list: async () => [failed],
    resume: async (id, account) => { assert.equal(id, failed.id); assert.deepEqual(account, actor); calls.push('resume'); return { id, status: 'generating' } as AiJob; },
    recover: async id => { assert.equal(id, failed.id); calls.push('read'); return { handled: false }; },
  });
  assert.deepEqual(await recover(batchId, actor), { attempted: [failed.id], handled: [] });
  assert.deepEqual(calls, ['resume', 'read']); assert.deepEqual(failed, snapshot);
});

test('failed receipt restoration requires an actor, a confirmed bill and the exact supported mask failure', async () => {
  const invalid: Partial<AcceptedPhotoBatchChild>[] = [
    { errorCode: 'AI_MASK_NOT_FOUND' }, { errorMessage: 'Other invalid image' }, { chargedUsd: null },
    { chargedUsd: '0' }, { costBasis: 'reservation' }, { appliedRevision: 3 }, { model: approvedImageModel },
    { input: { ...failedHero().input, aiPhotography: {} } },
  ];
  for (const change of invalid) {
    const recover = createAcceptedPhotoBatchRecovery({
      list: async () => [failedHero(change)], resume: async () => assert.fail('An ineligible failure was resumed.'),
      recover: async () => assert.fail('An ineligible failure was read.'),
    });
    assert.deepEqual(await recover(batchId, actor), { attempted: [], handled: [] });
  }
  const unauthenticated = createAcceptedPhotoBatchRecovery({ list: async () => [failedHero()], recover: async () => assert.fail('Failed restoration requires an actor.') });
  assert.deepEqual(await unauthenticated(batchId), { attempted: [], handled: [] });
});

test('restoration respects fresh authorization and source guards while simultaneous continuations may finish the same read', async () => {
  for (const code of ['FORBIDDEN', 'PHOTO_CONTENT_CHANGED', 'CORRECTION_SOURCE_STALE']) {
    const recover = createAcceptedPhotoBatchRecovery({
      list: async () => [failedHero()], resume: async () => { throw new AiError(409, code, 'Guard rejected restoration.'); },
      recover: async () => assert.fail('A rejected restoration cannot read a result.'),
    });
    await assert.rejects(recover(batchId, actor), error => error instanceof AiError && error.code === code);
  }
  let reads = 0;
  const concurrent = createAcceptedPhotoBatchRecovery({
    list: async () => [failedHero()], resume: async () => { throw new AiError(409, 'CANNOT_RESUME', 'Already resumed.'); },
    recover: async () => { reads++; return { handled: false }; },
  });
  assert.deepEqual(await concurrent(batchId, actor), { attempted: [ids[0]], handled: [] }); assert.equal(reads, 1);
});

test('manual batch recovery reads at most two distinct accepted completed children of the same package without mutating captures', async () => {
  const children = [child(), child(), child(ids[1], { model: approvedImageModel, kind: 'ingredient', status: 'uncertain' }), child(ids[2])];
  const snapshot = structuredClone(children); const recovered: string[] = [];
  const recover = createAcceptedPhotoBatchRecovery({
    list: async id => { assert.equal(id, batchId); return children; },
    recover: async id => { recovered.push(id); return { handled: false }; },
  });
  assert.deepEqual(await recover(batchId), { attempted: ids.slice(0, 2), handled: [] });
  assert.deepEqual(recovered, ids.slice(0, 2)); assert.deepEqual(children, snapshot);
});

test('only accepted image results with a completed provider timestamp enter recovery', async () => {
  const invalid: Partial<AcceptedPhotoBatchChild>[] = [
    { photoBatchId: 'fc71fcf7-0428-4ac9-a13a-564a9d7a3439' }, { provider: 'openai' }, { model: 'unapproved/model' },
    { kind: 'recipe' }, { status: 'queued' }, { status: 'submitting' }, { status: 'failed' }, { status: 'cancelled' }, { status: 'ready' }, { status: 'applied' },
    { providerRequestId: null }, { providerRequestId: '' }, { providerRequestId: 'https://private.invalid/request' },
    { providerFinishedAt: null }, { result: { content: null, asset: null, notes: [] } }, { id: 'other-job' },
  ];
  for (const change of invalid) {
    let calls = 0;
    const recover = createAcceptedPhotoBatchRecovery({ list: async () => [child(ids[0], change)], recover: async () => { calls++; assert.fail('Ineligible child reached recovery.'); } });
    assert.deepEqual(await recover(batchId), { attempted: [], handled: [] }); assert.equal(calls, 0);
  }
});

test('skipped rows do not consume the two-child recovery limit and all three image kinds retain the same child IDs', async () => {
  for (const kind of ['hero', 'ingredient', 'step'] as const) {
    const recover = createAcceptedPhotoBatchRecovery({
      list: async () => [child(ids[0], { providerFinishedAt: null }), child(ids[1], { kind, model: approvedImageModel }), child(ids[2], { kind })],
      recover: async () => ({ handled: false }),
    });
    assert.deepEqual((await recover(batchId)).attempted, ids.slice(1));
  }
});

test('a registered result is reported for the existing child while an unconfirmed child remains with the worker', async () => {
  const job: AiJob = {
    id: ids[0], recipeId: 'cf01cecf-516b-41b4-9fc3-f8e956243637', recipeTitle: 'Policzki wołowe', baseRevision: 2,
    kind: 'hero', targetId: null, status: 'ready', provider: 'fal', model: heroCutoutModel, brief: '', createdByName: 'Owner',
    createdAt: '2026-10-13T22:28:00Z', updatedAt: '2026-10-14T00:00:00Z', providerRequestId: child().providerRequestId,
    reservedUsd: '0.10000000', chargedUsd: '0.00500000', costBasis: 'usage', usage: null,
    errorCode: null, errorMessage: null, result: { content: null, asset: null, notes: ['Review required.'] }, appliedRevision: null,
  };
  const original = structuredClone(job);
  const recover = createAcceptedPhotoBatchRecovery({
    list: async () => [child(), child(ids[1])],
    recover: async id => id === ids[0] ? { handled: true, job } : { handled: false },
  });
  assert.deepEqual(await recover(batchId), { attempted: ids.slice(0, 2), handled: [ids[0]] });
  assert.deepEqual(job, original);
});

test('temporary list, pending result and child failures retain normal batch recovery fallback without exposing private errors', async () => {
  const error = new Error('private SQL https://private.invalid token=secret');
  const unavailable = createAcceptedPhotoBatchRecovery({ list: async () => { throw error; }, recover: async () => assert.fail('Unavailable list reached recovery.') });
  assert.deepEqual(await unavailable(batchId), { attempted: [], handled: [] });
  const calls: string[] = [];
  const recover = createAcceptedPhotoBatchRecovery({
    list: async () => [child(), child(ids[1])],
    recover: async id => { calls.push(id); if (id === ids[0]) throw error; return { handled: false }; },
  });
  const result = await recover(batchId);
  assert.deepEqual(result, { attempted: ids.slice(0, 2), handled: [] }); assert.deepEqual(calls, ids.slice(0, 2));
  assert.doesNotMatch(JSON.stringify(result), /private|https|token|secret/);
});

test('malformed batch IDs never query children or invoke a provider operation', async () => {
  const recover = createAcceptedPhotoBatchRecovery({ list: async () => assert.fail('Malformed ID queried jobs.'), recover: async () => assert.fail('Malformed ID reached recovery.') });
  assert.deepEqual(await recover('https://private.invalid'), { attempted: [], handled: [] });
});
