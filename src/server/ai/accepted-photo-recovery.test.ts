import test from 'node:test';
import assert from 'node:assert/strict';
import { BlobError } from '@vercel/blob';
import type { AiJob } from '@/lib/ai-types';
import type { EditorialContent } from '@/lib/editorial-types';
import { recipes } from '@/lib/recipes';
import { createAcceptedPhotoRecovery, type AcceptedPhotoRecoveryDependencies } from './accepted-photo-recovery';
import { approvedImageModel, heroCutoutModel } from './image-actions';
import { ProviderError } from './provider-error';

const id = 'c9fa7908-1c65-4e5d-9afc-66a1928cd227';
const receipt = '01a13708-9d4d-7ce2-98a2-a177d0e4c4cf';
const input: EditorialContent = { recipe: structuredClone(recipes[0]), originalText: '', author: '', sources: [], photos: { ingredients: {}, steps: {} } };
const source = () => ({ id, provider: 'fal' as const, model: heroCutoutModel, kind: 'hero' as const, targetId: null, providerRequestId: receipt, status: 'generating' as const, result: null, input });
const dto = (status: AiJob['status']): AiJob => ({ id, recipeId: input.recipe.id, recipeTitle: input.recipe.title.pl, baseRevision: 2, kind: 'hero', targetId: null, status, provider: 'fal', model: heroCutoutModel, brief: '', createdByName: 'Owner', createdAt: '2026-10-13T20:50:00Z', updatedAt: '2026-10-14T00:00:00Z', providerRequestId: receipt, reservedUsd: '0.10000000', chargedUsd: null, costBasis: 'reservation', usage: null, errorCode: null, errorMessage: null, result: null, appliedRevision: null });
const forbidden = async (): Promise<never> => assert.fail('Unexpected state mutation or provider operation.');
const base = (overrides: Partial<AcceptedPhotoRecoveryDependencies> = {}): Partial<AcceptedPhotoRecoveryDependencies> => ({ getJobForExecution: async () => source(), getJob: async () => dto('ready'), pollImage: forbidden, markProviderTerminal: forbidden, finishAsset: forbidden, failJob: forbidden, ...overrides });

test('completed recovery retains the exact accepted request, captured content and same job without applying or admitting another request', async () => {
  const snapshot = structuredClone(source());
  const asset = { blobPathname: `ai/${id}/web-v1.webp`, originalBlobPathname: `ai/${id}/original-v1.webp`, width: 2560, height: 1920, contentType: 'image/webp' as const, alt: { pl: 'Policzki wołowe', en: 'Beef cheeks' }, caption: { pl: '', en: '' }, hasTransparency: true };
  let terminal = 0; let finishes = 0;
  const recover = createAcceptedPhotoRecovery(base({
    pollImage: async (model, requestId, jobId, kind, captured, target, onTerminal) => {
      assert.equal(model, heroCutoutModel); assert.equal(requestId, receipt); assert.equal(jobId, id); assert.equal(kind, 'hero');
      assert.equal(captured, input); assert.equal(target, null); await onTerminal!();
      return { done: true, asset, cost: { chargedUsd: '0.00500000', costBasis: 'usage' }, notes: ['Review required.'] };
    },
    markProviderTerminal: async jobId => { terminal++; assert.equal(jobId, id); return dto('generating'); },
    finishAsset: async (jobId, received, cost, notes) => { finishes++; assert.equal(jobId, id); assert.equal(received, asset); assert.equal(cost?.chargedUsd, '0.00500000'); assert.deepEqual(notes, ['Review required.']); return dto('ready'); },
  }));
  const result = await recover(id);
  assert.equal(result.handled, true); if (result.handled) { assert.equal(result.job.id, id); assert.equal(result.job.providerRequestId, receipt); assert.equal(result.job.reservedUsd, '0.10000000'); }
  assert.equal(terminal, 1); assert.equal(finishes, 1); assert.deepEqual(source(), snapshot);
});

test('a pending accepted result leaves normal workflow fallback available without terminal or settlement writes', async () => {
  const recover = createAcceptedPhotoRecovery(base({ pollImage: async () => ({ done: false }) }));
  assert.deepEqual(await recover(id), { handled: false });
});

test('a temporary capture read failure retains normal workflow fallback and exposes no raw error', async () => {
  const recover = createAcceptedPhotoRecovery(base({ getJobForExecution: async () => { throw new Error('private SQL postgres://secret token=secret'); } }));
  assert.deepEqual(await recover(id), { handled: false });
});

test('ineligible jobs cannot enter the accepted-photo recovery transport', async () => {
  for (const change of [{ providerRequestId: null }, { providerRequestId: 'https://private.invalid' }, { kind: 'recipe' as const }, { provider: 'openai' as const }, { model: 'unapproved/model' }, { status: 'queued' as const }, { status: 'failed' as const }, { id: 'other-job' }]) {
    const recover = createAcceptedPhotoRecovery(base({ getJobForExecution: async () => ({ ...source(), ...change }) }));
    assert.deepEqual(await recover(id), { handled: false });
  }
});

test('already ready or applied results return their authoritative DTO without polling or another store write', async () => {
  for (const status of ['ready', 'applied'] as const) {
    const result = { content: null, asset: null, notes: ['Already stored.'] };
    const current = { ...dto(status), result };
    const recover = createAcceptedPhotoRecovery(base({ getJobForExecution: async () => ({ ...source(), status, result }), getJob: async jobId => { assert.equal(jobId, id); return current; } }));
    assert.deepEqual(await recover(id), { handled: true, job: current });
  }
});

test('known photo and storage failures retain the original receipt and reservation without inventing zero cost', async () => {
  for (const error of [new BlobError('Storage quota exceeded'), new ProviderError('AI_IMAGE_INVALID', 'Invalid accepted photo.'), new ProviderError('AI_IMAGE_INVALID', 'Invalid accepted photo.', false, '0')]) {
    let failure: Parameters<AcceptedPhotoRecoveryDependencies['failJob']>[1] | undefined;
    const recover = createAcceptedPhotoRecovery(base({ pollImage: async () => { throw error; }, failJob: async (jobId, recorded) => { assert.equal(jobId, id); failure = recorded; return dto(recorded.uncertain ? 'uncertain' : 'failed'); } }));
    const result = await recover(id);
    assert.equal(result.handled, true); assert.equal(failure?.chargedUsd, undefined);
    if (result.handled) { assert.equal(result.job.providerRequestId, receipt); assert.equal(result.job.reservedUsd, '0.10000000'); }
    assert.equal(failure?.code, error instanceof BlobError ? 'AI_RESULT_STORAGE_CAPACITY' : 'AI_IMAGE_INVALID');
  }
});

test('unknown transport or registration errors preserve uncertainty and never expose raw prompts, URLs or credentials', async () => {
  for (const failedStage of ['poll', 'registration'] as const) {
    let failure: Parameters<AcceptedPhotoRecoveryDependencies['failJob']>[1] | undefined;
    const error = new Error('private prompt https://secret.invalid token=secret');
    const recover = createAcceptedPhotoRecovery(base({
      pollImage: async () => { if (failedStage === 'poll') throw error; return { done: true, asset: { blobPathname: 'private/retained.webp', width: 1, height: 1, contentType: 'image/webp', alt: { pl: 'Danie', en: 'Dish' }, caption: { pl: '', en: '' } }, cost: {}, notes: [] }; },
      finishAsset: async () => { throw error; },
      failJob: async (_jobId, recorded) => { failure = recorded; return dto('uncertain'); },
    }));
    assert.equal((await recover(id)).handled, true);
    assert.equal(failure?.code, 'AI_RESULT_UNCONFIRMED'); assert.equal(failure?.uncertain, true); assert.equal(failure?.chargedUsd, undefined);
    assert.doesNotMatch(JSON.stringify(failure), /private|secret|https|prompt|token/);
    assert.match(failure!.message, /to samo zlecenie bez nowej generacji/);
  }
});

test('both approved photographic models use the same recovery path without a submission port', async () => {
  for (const model of [approvedImageModel, heroCutoutModel]) {
    let seen: string | undefined;
    const recover = createAcceptedPhotoRecovery(base({ getJobForExecution: async () => ({ ...source(), model }), pollImage: async received => { seen = received; return { done: false }; } }));
    await recover(id); assert.equal(seen, model);
  }
});

test('failure to record retrieval uncertainty retains the same receipt workflow fallback without another paid operation', async () => {
  for (const retrievalError of [new ProviderError('AI_IMAGE_DOWNLOAD_UNAVAILABLE', 'Accepted image unavailable.', true), new Error('private provider failure')]) {
    let polls = 0; let failureWrites = 0;
    const original = structuredClone(source());
    const recover = createAcceptedPhotoRecovery(base({
      pollImage: async (_model, receivedReceipt, jobId) => { polls++; assert.equal(receivedReceipt, receipt); assert.equal(jobId, id); throw retrievalError; },
      failJob: async (jobId, recorded) => { failureWrites++; assert.equal(jobId, id); assert.equal(recorded.uncertain, true); assert.equal(recorded.chargedUsd, undefined); throw new Error('private SQL postgres://secret'); },
    }));
    assert.deepEqual(await recover(id), { handled: false });
    assert.equal(polls, 1); assert.equal(failureWrites, 1);
    assert.deepEqual(source(), original);
  }
});
