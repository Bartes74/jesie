import test from 'node:test';
import assert from 'node:assert/strict';
import type { AiJob } from '@/lib/ai-types';
import { heroCutoutSemanticRetryBrief } from '@/lib/ai-types';
import { attachPhotoRecovery, withPhotoRecovery, type PhotoRecoveryChild, type PhotoRecoverySource } from './photo-recovery-readmodel';

const originalId = '6c5e1297-0e20-4a3f-86c0-59bee6ff6072';
const maskId = '2686b779-e93f-4f10-b072-5312b4eb64a1';
const original: PhotoRecoverySource = { id: originalId, recipeId: 'fixture', kind: 'hero', provider: 'fal', model: 'openai/gpt-image-2.5/sunburst/text-to-image',
  status: 'failed', providerRequestId: 'source-receipt', providerFinishedAt: new Date(), result: null, appliedRevision: null, errorCode: 'AI_TRANSPARENCY_MISSING' };
const sourceJob = { ...original, chargedUsd: '1.23', costBasis: 'usage', brief: 'Original photo brief', updatedAt: new Date().toISOString() } as unknown as AiJob;
const mask: PhotoRecoveryChild = { ...original, id: maskId, model: 'fal-ai/sam-3/image', brief: 'Original verbose mask instruction', status: 'failed',
  errorCode: 'AI_MASK_NOT_FOUND', errorMessage: 'Dostawca nie zwrócił maski wycięcia.', sourceImage: '/ai-result/' + originalId,
  heroMaskPromptVersion: null, heroContainer: 'clay-pot', chargedUsd: '0.005', costBasis: 'usage', createdAt: new Date('2026-10-20T18:00:00Z') };

test('linking a separate mask preserves the original ledger and exposes retry only to its owner', () => {
  const [linked] = attachPhotoRecovery([sourceJob], [original], [mask], { allowMaskRetry: true });
  assert.deepEqual(linked.photoRecovery, { jobId: maskId, status: 'failed', errorCode: 'AI_MASK_NOT_FOUND', chargedUsd: '0.005', costBasis: 'usage' });
  assert.equal(linked.canRetryPhotoMask, true);
  assert.equal(linked.id, originalId);
  assert.equal(linked.providerRequestId, 'source-receipt');
  assert.equal(linked.chargedUsd, '1.23');
  assert.equal(linked.status, 'failed');
  assert.equal(linked.result, null);
  assert.equal(sourceJob.photoRecovery, undefined);
  assert.equal(attachPhotoRecovery([sourceJob], [original], [mask])[0].canRetryPhotoMask, undefined);
});

test('a mask points back to its original source and never enables a second semantic retry', () => {
  const maskJob = { ...sourceJob, id: maskId, model: mask.model, errorCode: mask.errorCode };
  const [linked] = attachPhotoRecovery([maskJob], [original], [mask], { allowMaskRetry: true });
  assert.equal(linked.photoSourceJobId, originalId);
  assert.equal(linked.canRetryPhotoMask, true);
  const retry = { ...mask, id: 'second-mask', brief: heroCutoutSemanticRetryBrief, createdAt: new Date(mask.createdAt.getTime() + 1000) };
  assert.equal(attachPhotoRecovery([sourceJob], [original], [mask, retry], { allowMaskRetry: true })[0].canRetryPhotoMask, undefined);
  assert.equal(attachPhotoRecovery([maskJob], [original], [mask, retry], { allowMaskRetry: true })[0].canRetryPhotoMask, undefined);
  assert.equal(attachPhotoRecovery([sourceJob], [original], [{ ...mask, heroMaskPromptVersion: 'vessel-noun-v1' }], { allowMaskRetry: true })[0].canRetryPhotoMask, undefined);
});

test('a result can only be linked through the exact source marker and the same recipe', () => {
  const wrongRecipe = { ...mask, recipeId: 'another-recipe' };
  const wrongSource = { ...mask, sourceImage: '/ai-result/another-source' };
  assert.deepEqual(attachPhotoRecovery([sourceJob], [original], [wrongRecipe, wrongSource]), [sourceJob]);
  assert.deepEqual(attachPhotoRecovery([sourceJob], [{ ...original, errorCode: 'AI_PROVIDER_REJECTED' }], [mask]), [sourceJob]);
});

test('a ready child is the review target while the failed photography receipt remains unchanged', () => {
  const result = { content: null, asset: { id: 'asset', src: '/media/asset' }, notes: [] } as unknown as AiJob['result'];
  const ready = { ...mask, id: 'ready-mask', status: 'ready' as const, errorCode: null, result, createdAt: new Date(mask.createdAt.getTime() + 1000) };
  const [linked] = attachPhotoRecovery([sourceJob], [original], [mask, ready], { allowMaskRetry: true });
  assert.equal(linked.photoRecovery!.jobId, 'ready-mask');
  assert.equal(linked.photoRecovery!.status, 'ready');
  assert.equal(linked.canRetryPhotoMask, undefined);
  assert.equal(linked.status, 'failed');
  assert.equal(linked.chargedUsd, sourceJob.chargedUsd);
  assert.equal(linked.result, null);
});

test('only the exact billed centre-food rejection offers restoration on the existing mask job', () => {
  const rejected: PhotoRecoveryChild = { ...mask, heroMaskPromptVersion: 'vessel-noun-v1', errorCode: 'AI_IMAGE_INVALID',
    errorMessage: 'Wycięcie usuwa środek potrawy lub naczynia. Zachowano oryginał; sprawdź całą potrawę przed zapisem.' };
  const maskJob = { ...sourceJob, id: maskId, model: mask.model, errorCode: rejected.errorCode };
  const [linked] = attachPhotoRecovery([maskJob], [original], [rejected]);
  assert.equal(linked.canRestorePhotoContents, true);
  assert.equal(linked.id, maskId);
  assert.equal(linked.providerRequestId, maskJob.providerRequestId);
  assert.equal(attachPhotoRecovery([sourceJob], [original], [rejected])[0].canRestorePhotoContents, undefined);
  for (const change of [{ errorMessage: 'Inny błąd obrazu.' }, { providerRequestId: null }, { heroContainer: 'jar' }, { heroMaskPromptVersion: null }, { chargedUsd: null }]) {
    assert.equal(attachPhotoRecovery([maskJob], [original], [{ ...rejected, ...change }])[0].canRestorePhotoContents, undefined);
  }
});

const assetId = 'b6f4ed40-ec06-454b-8b76-1a66bbf84bfb';
const completedResult: NonNullable<AiJob['result']> = { content: null, notes: [], asset: {
  id: assetId, jobId: originalId, recipeId: 'fixture', kind: 'hero', targetId: null,
  src: `/media/${assetId}`, width: 1536, height: 1024, alt: { pl: 'Gotowa potrawa', en: 'Finished dish' },
  caption: { pl: 'Gotowa potrawa', en: 'Finished dish' }, model: original.model, createdAt: new Date().toISOString(),
} };

test('a recovered ready or applied original remains the result while its old mask keeps a reliable source link', () => {
  for (const status of ['ready', 'applied'] as const) {
    const source = { ...original, status, errorCode: null, result: completedResult, appliedRevision: status === 'applied' ? 4 : null };
    const readySourceJob = { ...sourceJob, status, errorCode: null, result: completedResult, appliedRevision: source.appliedRevision };
    const maskJob = { ...sourceJob, id: maskId, model: mask.model, errorCode: mask.errorCode };
    const [linkedSource, linkedMask] = attachPhotoRecovery([readySourceJob, maskJob], [source], [mask], { allowMaskRetry: true });
    assert.equal(linkedSource.status, status);
    assert.equal(linkedSource.result, completedResult);
    assert.equal(linkedSource.chargedUsd, sourceJob.chargedUsd);
    assert.equal(linkedSource.photoRecovery, undefined);
    assert.equal(linkedSource.canRetryPhotoMask, undefined);
    assert.equal(linkedMask.photoSourceJobId, originalId);
    assert.equal(linkedMask.photoSourceStatus, status);
    assert.equal(linkedMask.status, 'failed');
    assert.equal(linkedMask.canRetryPhotoMask, undefined);
    assert.equal(linkedMask.canRestorePhotoContents, undefined);
    assert.equal(maskJob.photoSourceJobId, undefined);
  }
});

test('completed source lineage requires its own valid hero asset and confirmed completed receipt', () => {
  const source: PhotoRecoverySource = { ...original, status: 'ready', errorCode: null, result: completedResult };
  const maskJob = { ...sourceJob, id: maskId, model: mask.model, errorCode: mask.errorCode };
  const invalidAssets = [
    { id: 'not-a-media-id' }, { jobId: maskId }, { recipeId: 'another-recipe' }, { kind: 'ingredient' },
    { targetId: 'ingredient' }, { model: mask.model }, { src: 'https://other.test/image.webp' },
  ];
  const invalidSources: PhotoRecoverySource[] = [
    { ...source, result: null }, { ...source, providerRequestId: null }, { ...source, providerFinishedAt: null },
    { ...source, errorCode: 'AI_IMAGE_INVALID' }, { ...source, appliedRevision: 4 },
    { ...source, status: 'applied', appliedRevision: null },
    ...invalidAssets.map(change => ({ ...source, result: { ...completedResult, asset: { ...completedResult.asset!, ...change } } as NonNullable<AiJob['result']> })),
  ];
  for (const invalid of invalidSources) {
    const [linked] = attachPhotoRecovery([maskJob], [invalid], [mask], { allowMaskRetry: true });
    assert.equal(linked.photoSourceJobId, undefined);
    assert.equal(linked.photoSourceStatus, undefined);
  }
  for (const invalid of [{ ...mask, recipeId: 'another-recipe' }, { ...mask, sourceImage: '/ai-result/' + maskId }, { ...mask, provider: 'openai' as const }, { ...mask, model: original.model }]) {
    const [linked] = attachPhotoRecovery([maskJob], [source], [invalid]);
    assert.equal(linked.photoSourceJobId, undefined);
  }
});

test('the GET readmodel queries completed sources and links the historical mask without replacing its receipt', async () => {
  const source: PhotoRecoverySource = { ...original, status: 'ready', errorCode: null, result: completedResult };
  const rows = [[{ sourceImage: mask.sourceImage }], [source], [mask]];
  let reads = 0;
  const db = { select() {
    const result = rows[reads++];
    assert.ok(result, 'Only read-model SELECTs are expected');
    return { from() { return { where() { return Object.assign(Promise.resolve(result), { orderBy: async () => result }); } }; } };
  } } as unknown as NonNullable<Parameters<typeof withPhotoRecovery>[2]>;
  const maskJob = { ...sourceJob, id: maskId, model: mask.model, errorCode: mask.errorCode };
  const [linked] = await withPhotoRecovery([maskJob], { allowMaskRetry: true }, db);
  assert.equal(reads, 3);
  assert.equal(linked.photoSourceJobId, originalId);
  assert.equal(linked.photoSourceStatus, 'ready');
  assert.equal(linked.providerRequestId, maskJob.providerRequestId);
  assert.equal(linked.status, maskJob.status);
  assert.equal(linked.canRetryPhotoMask, undefined);
});

test('manual composition belongs to the photograph and suppresses new mask controls on its children', () => {
  const manual = { ...original, manualPhotoComposition: true };
  const maskJob = { ...sourceJob, id: maskId, model: mask.model, errorCode: mask.errorCode };
  const [linked] = attachPhotoRecovery([maskJob], [manual], [mask], { allowMaskRetry: true });
  assert.equal(linked.photoSourceJobId, originalId);
  assert.equal(linked.manualPhotoComposition, true);
  assert.equal(linked.canRetryPhotoMask, undefined);
  assert.equal(linked.canRestorePhotoContents, undefined);
  const ready = { ...manual, status: 'ready' as const, errorCode: null, result: completedResult };
  const [completed] = attachPhotoRecovery([maskJob], [ready], [mask], { allowMaskRetry: true });
  assert.equal(completed.photoSourceStatus, 'ready');
  assert.equal(completed.manualPhotoComposition, true);
  assert.equal(completed.canRetryPhotoMask, undefined);
});

test('a standard manual retake exposes retained recovery despite its historical regenerate flag', () => {
  const standard = { ...original, manualPhotoComposition: true, brief: 'Gotowa potrawa na talerzu' };
  const maskJob = { ...sourceJob, id: maskId, model: mask.model, errorCode: mask.errorCode };
  const [linked] = attachPhotoRecovery([maskJob], [standard], [mask], { allowMaskRetry: true });
  assert.equal(linked.manualPhotoComposition, undefined);
  assert.equal(linked.canRetryPhotoMask, true);
});
