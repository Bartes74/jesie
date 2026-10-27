import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipes } from '../src/lib/recipes';
import type { EditorialContent } from '../src/lib/editorial-types';
import { buildCitrusRepairPlan, citrusRepairHash, citrusRepairPlanState, repairCitrusPhotos, type CitrusRepairRecipe } from './repair-citrus-ingredient-photos';

function content(): EditorialContent {
  const recipe = structuredClone(recipes.find(item => item.id === 'lemon-pasta')!);
  return { recipe, originalText: 'Unchanged private source', author: 'Original author', sources: [], photos: { ingredients: {
    'lemon-juice': { src: '/images/ingredients-1.webp', columns: 4, rows: 3, index: 4, alt: recipe.ingredients.find(item => item.id === 'lemon-juice')!.name },
    'lemon-zest': { src: '/images/ingredients-1.webp', columns: 4, rows: 3, index: 4, alt: recipe.ingredients.find(item => item.id === 'lemon-zest')!.name },
    butter: { src: '/media/unrelated', columns: 1, rows: 1, index: 0, alt: { pl: 'masło', en: 'butter' }, caption: { pl: 'Bez zmian', en: 'Unchanged' } },
  }, steps: { prep: { src: '/media/step', columns: 1, rows: 1, index: 0, alt: { pl: 'Przygotowanie', en: 'Preparation' } } } } };
}
function row(id = 'fixture'): CitrusRepairRecipe {
  const draft = content(); draft.recipe.id = id;
  const snapshot = structuredClone(draft), checks = { pl: true, en: true, quantities: true, method: true, photos: true, sources: true };
  return { id, revision: 8, content: draft, content_hash: citrusRepairHash(draft), editorial_status: 'approved', publication_status: 'published',
    checks, checks_revision: 8, approved_revision: 8, published_id: `publication-${id}`, published_revision: 8, deleted_at: null,
    publication: { id: `publication-${id}`, recipe_id: id, revision: 8, snapshot, content_hash: citrusRepairHash(snapshot), checks,
      approval_origin: 'manual', published_by: 'previous-owner', published_by_name: 'Previous owner', reviewed_by: 'reviewer', reviewed_by_name: 'Reviewer', reviewed_revision: 7 } };
}
const context = { actor: { id: 'owner', name: 'Owner' }, databaseScope: 'fixture-only', assets: [] };

test('canonical juice and zest photos replace only matching tiles while whole lemons and cooking text remain unchanged', () => {
  const source = content();
  source.recipe.ingredients.push({ ...structuredClone(source.recipe.ingredients[0]), id: 'whole-lemon', name: { pl: 'cytryna', en: 'lemon' },
    note: { pl: 'Użyj tylko skórki, a sok odłóż.', en: 'Use only the zest and reserve the juice.' } });
  source.photos.ingredients['whole-lemon'] = { src: '/media/whole-lemon', columns: 1, rows: 1, index: 0, alt: { pl: 'cytryna', en: 'lemon' } };
  const untouched = structuredClone(source), result = repairCitrusPhotos(source);
  assert.deepEqual(source, untouched);
  assert.deepEqual(result.changes.map(item => [item.ingredientId, item.form]), [['lemon-zest', 'zest'], ['lemon-juice', 'juice']]);
  assert.equal(result.content.photos.ingredients['lemon-juice'].src, '/images/lemon-juice.webp');
  assert.equal(result.content.photos.ingredients['lemon-zest'].src, '/images/lemon-zest.webp');
  assert.deepEqual(result.content.recipe, source.recipe);
  assert.deepEqual(result.content.photos.steps, source.photos.steps);
  assert.deepEqual(result.content.photos.ingredients.butter, source.photos.ingredients.butter);
  assert.deepEqual(result.content.photos.ingredients['whole-lemon'], source.photos.ingredients['whole-lemon']);
  assert.deepEqual({ ...result.content, photos: undefined }, { ...source, photos: undefined });
  assert.equal(repairCitrusPhotos(result.content).changes.length, 0);
});

test('a fresh publication is based on its own snapshot and cannot publish pending draft edits', () => {
  const original = row();
  original.content.recipe.description.pl = 'Unpublished changes must stay private'; original.content_hash = citrusRepairHash(original.content);
  original.editorial_status = 'draft'; original.approved_revision = null; original.checks_revision = 7;
  original.publication!.approval_origin = 'manual_scheduled';
  const historical = structuredClone(original.publication), before = structuredClone(original);
  const plan = buildCitrusRepairPlan([original], context), record = plan.records[0], expected = plan.after[0];
  assert.deepEqual(original, before);
  assert.deepEqual(original.publication, historical);
  assert.equal(record.nextContentHash, citrusRepairHash(repairCitrusPhotos(original.content).content));
  assert.equal(record.nextPublicationHash, citrusRepairHash(repairCitrusPhotos(original.publication!.snapshot).content));
  assert.notEqual(record.nextContentHash, record.nextPublicationHash);
  assert.equal(expected.editorial_status, 'draft'); assert.equal(expected.publication_status, 'published');
  assert.equal(expected.approved_revision, null); assert.equal(expected.checks_revision, 7);
  assert.deepEqual(expected.checks, original.checks);
  assert.deepEqual(expected.publication!.checks, historical!.checks);
  assert.equal(expected.publication!.approval_origin, 'manual', 'A fresh owner-authorized correction cannot replay a scheduled release.');
  assert.equal(original.publication!.approval_origin, 'manual_scheduled', 'The original scheduled publication receipt remains unchanged.');
  assert.equal(expected.publication!.reviewed_by, historical!.reviewed_by);
  assert.equal(expected.publication!.reviewed_revision, historical!.reviewed_revision);
});

test('archived and unpublished records keep their state, missing tiles are filled, deleted recipes are excluded', () => {
  const archived = row('archived'); archived.editorial_status = 'archived'; archived.publication_status = 'never_published';
  archived.approved_revision = null; archived.published_id = null; archived.published_revision = null; archived.publication = null;
  delete archived.content.photos.ingredients['lemon-juice']; archived.content_hash = citrusRepairHash(archived.content);
  const unpublished = row('unpublished'); unpublished.publication_status = 'unpublished';
  const deleted = row('deleted'); deleted.deleted_at = '2026-10-01T00:00:00Z';
  const plan = buildCitrusRepairPlan([archived, unpublished, deleted], context);
  assert.equal(plan.records.length, 2); assert.equal(plan.before.length, 2);
  for (const record of plan.records) assert.equal(record.publicationId, null);
  assert.equal(plan.after.find(item => item.id === archived.id)!.editorial_status, 'archived');
  assert.equal(plan.after.find(item => item.id === archived.id)!.publication_status, 'never_published');
  assert.equal(plan.after.find(item => item.id === unpublished.id)!.publication_status, 'unpublished');
  assert.equal(plan.records.find(item => item.recipeId === archived.id)!.draft.find(item => item.ingredientId === 'lemon-juice')!.before, null);
});

test('exact before and after inventories support idempotence and reject concurrent content, revision and scope changes', () => {
  const original = row(), plan = buildCitrusRepairPlan([original], context);
  assert.equal(citrusRepairPlanState(plan, [original]), 'before');
  const after = structuredClone(original), expected = plan.after[0], record = plan.records[0];
  after.content = repairCitrusPhotos(after.content).content;
  after.publication!.snapshot = repairCitrusPhotos(after.publication!.snapshot).content;
  Object.assign(after, expected, { publication: { ...after.publication!, ...expected.publication }, content: after.content });
  assert.equal(citrusRepairPlanState(plan, [after]), 'after');
  for (const changed of [
    { ...original, revision: original.revision + 1 },
    { ...original, checks: { ...original.checks, photos: false } },
    { ...original, publication_status: 'unpublished' },
    { ...original, deleted_at: '2026-10-24T00:00:00Z' },
  ]) assert.throws(() => citrusRepairPlanState(plan, [changed]), /INVENTORY_CHANGED/);
  assert.throws(() => citrusRepairPlanState(plan, [original, row('new-recipe')]), /INVENTORY_CHANGED/);
  const bodyChanged = structuredClone(original); bodyChanged.content.recipe.title.pl += ' changed';
  assert.throws(() => citrusRepairPlanState(plan, [bodyChanged]), /CONTENT_HASH_MISMATCH/);
  bodyChanged.content_hash = citrusRepairHash(bodyChanged.content);
  assert.throws(() => citrusRepairPlanState(plan, [bodyChanged]), /INVENTORY_CHANGED/);
  assert.equal(record.nextRevision, original.revision + 1);
  const stalePlan = structuredClone(plan); stalePlan.after[0].publication!.approval_origin = 'manual_scheduled';
  assert.throws(() => citrusRepairPlanState(stalePlan, [original]), /PLANNED_AFTER_STATE_MISMATCH/);
});

test('ambiguous juice-plus-zest ingredient content fails instead of choosing an arbitrary picture', () => {
  const source = content(); source.recipe.ingredients[0].name = { pl: 'sok i skórka z cytryny', en: 'lemon juice and zest' };
  assert.throws(() => repairCitrusPhotos(source), /CITRUS_FORM_CONFLICT/);
});
