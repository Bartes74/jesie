import test from 'node:test';
import assert from 'node:assert/strict';
import type { AiJob } from './ai-types';
import type { AiPhotoBatch } from './ai-photo-batch-types';
import { generationRequest, readPendingPreparation, readyPreparationAction } from './preparation-client';

test('an unconfirmed request survives reload with its original key and revision, without local metadata in the POST payload', () => {
  const pending = readPendingPreparation(JSON.stringify({ version: 1, action: 'generate_text', expectedRevision: 3, requestKey: '8bdf474d-ae04-4b07-9786-15bd7ef05795' }));
  assert.ok(pending);
  assert.deepEqual(generationRequest(pending), { action: 'generate_text', expectedRevision: 3, requestKey: '8bdf474d-ae04-4b07-9786-15bd7ef05795' });
  assert.deepEqual(generationRequest(readPendingPreparation(JSON.stringify(pending))!), generationRequest(pending));
});

test('invalid local requests cannot trigger a generation retry', () => {
  for (const raw of [null, '{', '{}', '{"version":2}', JSON.stringify({ version: 1, action: 'publish', expectedRevision: 1, requestKey: '8bdf474d-ae04-4b07-9786-15bd7ef05795' }), JSON.stringify({ version: 1, action: 'generate_text', expectedRevision: -1, requestKey: 'not-a-key' })]) assert.equal(readPendingPreparation(raw), null);
});

test('only ready results for the current revision can apply automatically, and no state automatically publishes', () => {
  const text = { id: 'text', status: 'ready', baseRevision: 4 } as AiJob;
  const photos = { id: 'photos', status: 'ready', baseRevision: 4 } as AiPhotoBatch;
  assert.deepEqual(readyPreparationAction(4, text, photos), { action: 'apply_text', jobId: 'text' });
  assert.deepEqual(readyPreparationAction(4, { ...text, status: 'applied' }, photos), { action: 'apply_photos', batchId: 'photos' });
  assert.equal(readyPreparationAction(5, text, photos), null);
  for (const status of ['failed', 'uncertain', 'generating', 'applied'] as const) assert.equal(readyPreparationAction(4, { ...text, status }, null), null);
  assert.equal(readyPreparationAction(4, null, { ...photos, status: 'applied' }), null);
});

test('only server-confirmed photo compatibility permits a photo-only revision to reuse the ready package', () => {
  const text = { id: 'text', status: 'ready', baseRevision: 4 } as AiJob;
  const photos = { id: 'photos', status: 'ready', baseRevision: 4 } as AiPhotoBatch;
  assert.equal(readyPreparationAction(5, null, photos), null);
  assert.equal(readyPreparationAction(5, null, photos, false), null);
  assert.deepEqual(readyPreparationAction(5, text, photos, true), { action: 'apply_photos', batchId: 'photos' });
  assert.equal(readyPreparationAction(5, text, null, true), null);
  assert.equal(readyPreparationAction(5, null, { ...photos, status: 'failed' }, true), null);
});
