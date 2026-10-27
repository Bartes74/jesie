import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiPhotoBatch, AiPhotoBatchSlot } from './ai-photo-batch-types';
import { photoBatchPollInterval, shouldShowPhotoBatchStart } from './photo-batch-presentation';

function packet(status: AiPhotoBatch['status'], slots: AiPhotoBatchSlot[] = []): AiPhotoBatch {
  return { id: 'packet', mode: 'missing', recipeId: 'recipe', recipeTitle: 'Przepis', baseRevision: 1, sourceJobId: null,
    status, slots, progress: { completed: 0, failed: 0, total: slots.length }, canResume: false, canApply: false,
    reservedUsd: '1', remainingReservedUsd: '1', errorCode: null, errorMessage: null,
    createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z', appliedRevision: null };
}

function slot(status: Exclude<AiPhotoBatchSlot['status'], 'pending'>, receipt: 'provider' | 'reuse' | null): AiPhotoBatchSlot {
  return { kind: 'hero', targetId: null, label: 'Danie', status, job: {
    id: 'job', recipeId: 'recipe', recipeTitle: 'Przepis', baseRevision: 1, kind: 'hero', targetId: null, status,
    provider: 'fal', model: 'photo', brief: '', createdByName: 'Redakcja', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z',
    providerRequestId: receipt === 'provider' ? 'existing-receipt' : null, reuseSourceJobId: receipt === 'reuse' ? 'source-job' : null,
    reservedUsd: '1', chargedUsd: null, costBasis: null, usage: null, errorCode: null, errorMessage: null, result: null, appliedRevision: null,
  } };
}

const defaults = { saveDraftFirst: false, unconfirmed: false, missingTotal: 5, canResume: false, canApply: false };

test('existing unfinished packets take precedence over saving a proposal or checking an admission', () => {
  for (const status of ['queued', 'generating', 'blocked', 'failed'] as const) {
    assert.equal(shouldShowPhotoBatchStart(packet(status), { ...defaults, saveDraftFirst: true, unconfirmed: true, canResume: true }), false);
  }
  for (const status of ['queued', 'generating'] as const) {
    assert.equal(shouldShowPhotoBatchStart(packet(status), { ...defaults, saveDraftFirst: true }), false);
  }
});

test('ready results stay available for applying before a new package can be admitted', () => {
  for (const status of ['ready', 'failed'] as const) {
    assert.equal(shouldShowPhotoBatchStart(packet(status), { ...defaults, saveDraftFirst: true, canApply: true }), false);
  }
  assert.equal(shouldShowPhotoBatchStart(packet('failed'), defaults), true);
  assert.equal(shouldShowPhotoBatchStart(null, defaults), true);
});

test('an applied package offers new work only when photographs remain missing', () => {
  assert.equal(shouldShowPhotoBatchStart(packet('applied'), { ...defaults, missingTotal: 0 }), false);
  assert.equal(shouldShowPhotoBatchStart(packet('applied'), defaults), true);
});

test('running packets refresh quickly and stopped packets refresh only known unresolved receipts', () => {
  assert.equal(photoBatchPollInterval(packet('generating')), 4000);
  assert.equal(photoBatchPollInterval(packet('queued')), 4000);
  for (const status of ['blocked', 'failed'] as const) {
    for (const receipt of ['provider', 'reuse'] as const) {
      assert.equal(photoBatchPollInterval(packet(status, [slot('uncertain', receipt)])), 15000);
      assert.equal(photoBatchPollInterval(packet(status, [slot('generating', receipt)])), 15000);
    }
    assert.equal(photoBatchPollInterval(packet(status, [slot('uncertain', null)])), null);
    for (const child of ['ready', 'applied', 'failed', 'cancelled'] as const) {
      assert.equal(photoBatchPollInterval(packet(status, [slot(child, 'provider')])), null);
    }
  }
  for (const status of ['ready', 'applied'] as const) assert.equal(photoBatchPollInterval(packet(status, [slot('uncertain', 'provider')])), null);
});

test('saved images stop the paused receipt refresh even if an old child status is still present', () => {
  const child = slot('uncertain', 'provider');
  child.job!.result = { content: null, asset: { id: 'asset', recipeId: 'recipe', jobId: 'job', kind: 'hero', targetId: null, src: '/media/asset', width: 1200, height: 900, alt: { pl: 'Danie', en: 'Dish' }, caption: { pl: '', en: '' }, model: 'photo', createdAt: '2026-10-13T00:00:00Z' }, notes: [] };
  assert.equal(photoBatchPollInterval(packet('blocked', [child])), null);
});
