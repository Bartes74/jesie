import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeAttention, sortAdminAttention, type AttentionRecipe, type AttentionJob } from './admin-attention';
import { recipes } from './recipes';

function recipe(): AttentionRecipe {
  const text = structuredClone(recipes[0]);
  return { id: text.id, revision: 3, content: { recipe: text, originalText: '', author: '', sources: [], photos: { ingredients: {}, steps: {} } }, editorialStatus: 'draft', publicationStatus: 'never_published', publishedRevision: null, hasUnpublishedChanges: true, deletedAt: null, updatedAt: new Date('2026-10-18T10:00:00Z') };
}
function job(status: AttentionJob['status']): AttentionJob {
  return { id: 'job', recipeId: recipes[0].id, kind: 'recipe', targetId: null, status, baseRevision: 3, providerRequestId: null, providerFinishedAt: null, updatedAt: new Date('2026-10-18T10:01:00Z') };
}

test('unconfirmed or cancelled provider work stays actionable instead of admitting a duplicate', () => {
  for (const status of ['uncertain', 'cancelled'] as const) {
    const row = recipeAttention(recipe(), [job(status)], false)!;
    assert.equal(row.kind, 'generation_problem'); assert.equal(row.href, '/admin/ai/job');
  }
  assert.equal(recipeAttention(recipe(), [job('generating')], false)?.kind, 'generating');
});

test('the queue distinguishes human review, missing photos and a complete accepted recipe', () => {
  const record = recipe();
  assert.equal(recipeAttention(record, [], false)?.kind, 'content_review');
  assert.equal(recipeAttention(record, [], true)?.kind, 'photos');
  for (const item of record.content.recipe.ingredients) record.content.photos.ingredients[item.id] = { src: '/image.webp', columns: 1, rows: 1, index: 0, alt: { pl: 'Składnik', en: 'Ingredient' } };
  for (const item of record.content.recipe.steps) record.content.photos.steps[item.id] = { src: '/image.webp', columns: 1, rows: 1, index: 0, alt: { pl: 'Krok', en: 'Step' } };
  assert.equal(recipeAttention(record, [], true)?.kind, 'ready');
  record.publicationStatus = 'published'; record.publishedRevision = record.revision; record.hasUnpublishedChanges = false;
  assert.equal(recipeAttention(record, [], true), null);
});

test('deleted/archived recipes and superseded failures do not create false alarms', () => {
  const record = recipe(); record.deletedAt = new Date();
  assert.equal(recipeAttention(record, [job('uncertain')], false), null);
  record.deletedAt = null; record.editorialStatus = 'archived';
  assert.equal(recipeAttention(record, [job('failed')], false), null);
  record.editorialStatus = 'draft';
  const failed = job('failed'); const newer = { ...job('applied'), id: 'new', providerFinishedAt: new Date(), updatedAt: new Date('2026-10-18T11:00:00Z') };
  assert.equal(recipeAttention(record, [failed, newer], true)?.kind, 'photos');
});

test('human problems precede background jobs and older items precede newer peers', () => {
  const first = recipeAttention(recipe(), [job('uncertain')], false)!;
  const second = { ...first, id: 'older', updatedAt: '2026-10-17T10:00:00Z' };
  const running = recipeAttention(recipe(), [job('generating')], false)!;
  assert.deepEqual(sortAdminAttention([running, first, second]).map(row => row.id), ['older', first.id, running.id]);
});

test('a blocked packet is an intervention even when its unsubmitted children remain queued', () => {
  assert.equal(recipeAttention(recipe(), [job('queued')], true, { status: 'blocked', updatedAt: new Date() })?.kind, 'generation_problem');
});

test('review-only revisions do not create attention when the draft matches its public snapshot', () => {
  const record = recipe();
  record.publicationStatus = 'published'; record.publishedRevision = record.revision;
  record.revision += 6; record.editorialStatus = 'in_review'; record.hasUnpublishedChanges = false;
  assert.equal(recipeAttention(record, [], false), null);
  record.hasUnpublishedChanges = true;
  assert.equal(recipeAttention(record, [], false)?.kind, 'content_review');
  record.hasUnpublishedChanges = false;
  assert.equal(recipeAttention(record, [job('uncertain')], false)?.kind, 'generation_problem');
});
