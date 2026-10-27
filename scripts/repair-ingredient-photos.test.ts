import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipes } from '../src/lib/recipes';
import { citrusRepairHash as hash, type CitrusRepairRecipe } from './repair-citrus-ingredient-photos';
import { buildIngredientPhotoRepairPlan, ingredientPhotoRepairPlanState, patchReviewedIngredientPhotos, validateIngredientPhotoRepairManifest, type IngredientPhotoRepairManifest } from './repair-ingredient-photos';
const assetId = '09575620-d92a-43b6-bec9-e2f32b8f31aa';
const oldPhoto = { src: '/images/ingredients-1.webp', columns: 4, rows: 3, index: 4, alt: { pl: 'sok z cytryny', en: 'lemon juice' } };
const newPhoto = { src: '/images/lemon-juice.webp', columns: 1, rows: 1, index: 0, alt: { pl: 'sok z cytryny', en: 'lemon juice' }, aspectRatio: 1 };
function row(): CitrusRepairRecipe {
  const recipe = structuredClone(recipes.find(item => item.id === 'lemon-pasta')!); recipe.id = 'fixture';
  const content = { recipe, originalText: 'Private source', author: 'Author', sources: [], photos: { ingredients: { 'lemon-juice': structuredClone(oldPhoto) }, steps: {} } };
  const checks = { pl: true, en: true, quantities: true, method: true, photos: true, sources: true };
  return { id: recipe.id, content, content_hash: hash(content), revision: 10, editorial_status: 'draft', checks, checks_revision: 9, approved_revision: null,
    publication_status: 'published', published_id: 'old-publication', published_revision: 8, deleted_at: null,
    publication: { id: 'old-publication', recipe_id: recipe.id, revision: 8, snapshot: structuredClone(content), content_hash: hash(content), checks,
      approval_origin: 'manual_scheduled', published_by: 'old-owner', published_by_name: 'Old owner', reviewed_by: 'reviewer', reviewed_by_name: 'Reviewer', reviewed_revision: 7 } };
}
function manifest(): IngredientPhotoRepairManifest { return { version: 1, reason: 'Reviewed photo-only correction', rejectAssets: [assetId], rules: [
  { recipeId: 'fixture', ingredientId: 'lemon-juice', scope: 'both', before: structuredClone(oldPhoto), after: structuredClone(newPhoto), review: 'Confirmed juice photograph; legacy crop is zest.' },
] }; }
const catalog = [{ key: 'image-key', product: 'lemon', form: 'juice', style_profile: 'legacy', asset_id: assetId, source_job_id: assetId, photo: { ...oldPhoto }, eligibility: 'usable', created_at: '2026-10-23 00:00:00+00' }];
const context = { actor: { id: 'owner', name: 'Owner' }, databaseScope: 'fixture', manifestSha256: 'fixture-sha', proofs: [], catalog,
  assets: [{ id: assetId, recipe_id: 'fixture', kind: 'ingredient', blob_pathname: 'fixture.webp', original_blob_pathname: null, width: 1024, height: 1024 }] };

test('reviewed explicit rules preserve all body fields and keep pending draft text out of a new manual publication', () => {
  const original = row(); original.content.recipe.description.pl = 'Unpublished draft text'; original.content_hash = hash(original.content);
  const before = structuredClone(original), input = manifest(), plan = buildIngredientPhotoRepairPlan([original], input, context);
  assert.deepEqual(original, before);
  assert.equal(plan.records.length, 1); assert.equal(plan.records[0].draft.length, 1); assert.equal(plan.records[0].publication.length, 1);
  assert.notEqual(plan.records[0].nextContentHash, plan.records[0].nextPublicationHash);
  assert.equal(plan.after[0].editorial_status, 'draft'); assert.equal(plan.after[0].approved_revision, null); assert.equal(plan.after[0].checks_revision, 9);
  assert.deepEqual(plan.after[0].checks, original.checks);
  assert.equal(plan.after[0].publication!.approval_origin, 'manual');
  assert.equal(plan.after[0].publication!.reviewed_revision, 7);
  assert.equal(original.publication!.approval_origin, 'manual_scheduled');
  const patched = patchReviewedIngredientPhotos(original.content, original.id, 'draft', input).content;
  assert.deepEqual(patched.recipe, original.content.recipe);
  assert.deepEqual({ ...patched, photos: undefined }, { ...original.content, photos: undefined });
});

test('publication-only scope leaves the draft photo untouched and never publishes the draft body', () => {
  const original = row(), input = manifest(); input.rules[0].scope = 'publication';
  original.content.recipe.description.en = 'Private changes'; original.content_hash = hash(original.content);
  const plan = buildIngredientPhotoRepairPlan([original], input, context);
  assert.equal(plan.records[0].draft.length, 0); assert.equal(plan.records[0].publication.length, 1);
  assert.equal(plan.records[0].nextContentHash, original.content_hash);
  assert.equal(plan.records[0].nextPublicationHash, hash(patchReviewedIngredientPhotos(original.publication!.snapshot, original.id, 'publication', input).content));
});

test('photo conflicts, deleted targets and duplicate or rejected replacement rules fail before planning', () => {
  const original = row(), input = manifest();
  original.content.photos.ingredients['lemon-juice'].src = '/media/concurrent-photo';
  original.content_hash = hash(original.content);
  assert.throws(() => buildIngredientPhotoRepairPlan([original], input, context), /PHOTO_CHANGED/);
  const deleted = row(); deleted.deleted_at = '2026-10-24T00:00:00Z';
  assert.throws(() => buildIngredientPhotoRepairPlan([deleted], input, context), /RECIPE_OUTSIDE_SCOPE/);
  const duplicate = manifest(); duplicate.rules.push(structuredClone(duplicate.rules[0]));
  assert.throws(() => validateIngredientPhotoRepairManifest(duplicate), /OVERLAPPING_RULES/);
  const rejected = manifest(); rejected.rules[0].after.src = `/media/${assetId}`;
  assert.throws(() => validateIngredientPhotoRepairManifest(rejected), /REJECTED_REPLACEMENT/);
  const traversal = manifest(); traversal.rules[0].after.src = '/images/../secret.webp';
  assert.throws(() => validateIngredientPhotoRepairManifest(traversal), /REPLACEMENT_INVALID/);
});

test('catalog quarantine is fenced with editorial changes and exact after state supports replay without new revisions', () => {
  const original = row(), input = manifest(), plan = buildIngredientPhotoRepairPlan([original], input, context);
  assert.equal(ingredientPhotoRepairPlanState(plan, [original], structuredClone(catalog)), 'before');
  assert.equal(plan.afterCatalog[0].eligibility, 'rejected'); assert.equal(catalog[0].eligibility, 'usable');
  assert.equal(plan.quarantineAudits.length, 1); assert.equal(plan.quarantineAudits[0].revision, 11);
  const after = structuredClone(original);
  after.content = patchReviewedIngredientPhotos(after.content, after.id, 'draft', input).content;
  after.publication!.snapshot = patchReviewedIngredientPhotos(after.publication!.snapshot, after.id, 'publication', input).content;
  Object.assign(after, plan.after[0], { publication: { ...after.publication!, ...plan.after[0].publication }, content: after.content });
  assert.equal(ingredientPhotoRepairPlanState(plan, [after], plan.afterCatalog), 'after');
  assert.throws(() => ingredientPhotoRepairPlanState(plan, [after], catalog), /CATALOG_INVENTORY_CHANGED/);
  assert.throws(() => ingredientPhotoRepairPlanState(plan, [original], [...catalog, { ...catalog[0], key: 'new-key' }]), /CATALOG_INVENTORY_CHANGED/);
  const changed = structuredClone(plan); changed.afterCatalog[0].photo.src = '/media/rewritten-source';
  assert.throws(() => ingredientPhotoRepairPlanState(changed, [original], catalog), /PLANNED_CATALOG_INVALID/);
});

test('archived draft repair keeps archival status and already rejected catalog sources remain unchanged', () => {
  const original = row(), input = manifest(); original.editorial_status = 'archived'; original.publication_status = 'never_published';
  original.publication = null; original.published_id = null; original.published_revision = null; input.rules[0].scope = 'draft';
  const alreadyRejected = catalog.map(item => ({ ...item, eligibility: 'rejected' }));
  const plan = buildIngredientPhotoRepairPlan([original], input, { ...context, catalog: alreadyRejected });
  assert.equal(plan.after[0].editorial_status, 'archived'); assert.equal(plan.after[0].publication_status, 'never_published');
  assert.equal(plan.records[0].publicationId, null); assert.deepEqual(plan.beforeCatalog, plan.afterCatalog); assert.equal(plan.quarantineAudits.length, 0);
  const patched = patchReviewedIngredientPhotos(original.content, original.id, 'draft', input).content;
  assert.equal(patchReviewedIngredientPhotos(patched, original.id, 'draft', input).changes.length, 0);
});
