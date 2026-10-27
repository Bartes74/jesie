import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipes } from '../src/lib/recipes';
import { createStepPhotoOmission, stepPhotoSignature } from '../src/lib/step-photo-selection';
import { citrusRepairHash as hash, type CitrusRepairRecipe } from './repair-citrus-ingredient-photos';
import { buildDishStepPhotoRepairPlan, dishStepPhotoRepairPlanState, dishStepRepairMode, dishStepHeroNeedsSolidProof, patchReviewedDishStepPhotos,
  validateDishStepPhotoRepairManifest, type DishStepPhotoRepairManifest } from './repair-dish-step-photos';

const originalPhoto = { src: '/images/steps-lemon-pasta.webp', columns: 2, rows: 3, index: 4, alt: { pl: 'Podaj', en: 'Serve' }, aspectRatio: 2.25 };
const replacementPhoto = { src: '/images/steps/lemon-pasta-serve.webp', columns: 1, rows: 1, index: 0, alt: { pl: 'Polej sosem', en: 'Pour sauce' }, aspectRatio: 21 / 9 };
function row(): CitrusRepairRecipe {
  const recipe = structuredClone(recipes.find(recipe => recipe.id === 'lemon-pasta')!); recipe.id = 'fixture';
  const content = { recipe, originalText: 'Private source', author: 'Author', sources: [],
    photos: { ingredients: { test: { src: '/images/lemon-juice.webp', columns: 1, rows: 1, index: 0, alt: { pl: 'Sok', en: 'Juice' } } }, steps: { serve: structuredClone(originalPhoto) } } };
  const checks = { pl: true, en: true, quantities: true, method: true, photos: true, sources: true };
  return { id: 'fixture', content, content_hash: hash(content), revision: 10, editorial_status: 'approved', checks, checks_revision: 10, approved_revision: 10,
    publication_status: 'published', published_id: 'old-publication', published_revision: 8, deleted_at: null,
    publication: { id: 'old-publication', recipe_id: 'fixture', revision: 8, snapshot: structuredClone(content), content_hash: hash(content), checks,
      approval_origin: 'manual_scheduled', published_by: 'old-owner', published_by_name: 'Old owner', reviewed_by: 'reviewer', reviewed_by_name: 'Reviewer', reviewed_revision: 7 } };
}
function manifest(): DishStepPhotoRepairManifest {
  const content = row().content, step = content.recipe.steps.find(step => step.id === 'serve')!;
  return { version: 1, reason: 'Reviewed dish and instructional photo correction', rules: [{ recipeId: 'fixture', scope: 'both', review: 'Exact reviewed photo selection',
    hero: { before: { src: content.recipe.image, alt: content.recipe.imageAlt }, after: { src: '/images/heroes/lemon-pasta-cutout.webp', alt: content.recipe.imageAlt } },
    steps: [{ stepId: 'serve', signature: stepPhotoSignature(step), before: structuredClone(originalPhoto), after: null, beforeOmission: null,
      afterOmission: createStepPhotoOmission(step, { pl: 'Kadr powtarza gotowe danie.', en: 'Frame repeats the finished hero.' }), review: 'Serving-only beauty shot manually reviewed.' }] }] };
}
const context = { actor: { id: 'owner', name: 'Owner' }, databaseScope: 'fixture', manifestSha256: 'fixture-sha', proofs: [],
  historyBefore: { versions: [], publications: [], approvals: [] } };

test('exact hero/step/omission edits preserve food text, quantities, other photos and original objects', () => {
  const original = row(), before = structuredClone(original), input = manifest();
  validateDishStepPhotoRepairManifest(input);
  const patched = patchReviewedDishStepPhotos(original.content, original.id, 'draft', input);
  assert.deepEqual(original, before); assert.equal(patched.changes.length, 2);
  assert.equal(patched.content.photos.steps.serve, undefined);
  assert.deepEqual(patched.content.photos.omittedSteps?.serve, input.rules[0].steps![0].afterOmission);
  assert.deepEqual(patched.content.photos.ingredients, original.content.photos.ingredients);
  const expected = structuredClone(original.content); expected.recipe.image = input.rules[0].hero!.after.src;
  delete expected.photos.steps.serve;
  assert.deepEqual({ ...patched.content, photos: { ...patched.content.photos, omittedSteps: undefined } },
    { ...expected, photos: { ...expected.photos, omittedSteps: undefined } });
});

test('draft and publication changes are independent, preserving private draft text and review state', () => {
  const original = row(); original.content.recipe.description.en = 'Private unpublished changes'; original.content_hash = hash(original.content);
  const before = structuredClone(original), plan = buildDishStepPhotoRepairPlan([original], manifest(), context), record = plan.records[0];
  assert.deepEqual(original, before); assert.equal(plan.records.length, 1); assert.equal(record.nextRevision, 11);
  assert.equal(record.afterDraft.recipe.description.en, 'Private unpublished changes');
  assert.equal(record.afterPublication!.recipe.description.en, before.publication!.snapshot.recipe.description.en);
  assert.notEqual(record.nextContentHash, record.nextPublicationHash);
  assert.equal(plan.after[0].checks_revision, 11); assert.equal(plan.after[0].approved_revision, 11);
  assert.equal(plan.after[0].editorial_status, 'approved'); assert.deepEqual(plan.after[0].checks, original.checks);
  assert.equal(plan.after[0].publication!.approval_origin, 'manual'); assert.equal(plan.after[0].publication!.reviewed_revision, 7);
  assert.equal(original.publication!.approval_origin, 'manual_scheduled');
});

test('publication-only repair leaves pending draft content/photos and stale checks untouched', () => {
  const original = row(), input = manifest(); input.rules[0].scope = 'publication';
  original.content.recipe.description.en = 'Pending private text'; original.content_hash = hash(original.content);
  original.checks_revision = 9; original.approved_revision = null; original.editorial_status = 'draft';
  const plan = buildDishStepPhotoRepairPlan([original], input, context), record = plan.records[0];
  assert.equal(record.draft.length, 0); assert.equal(record.nextContentHash, original.content_hash);
  assert.deepEqual(record.afterDraft, original.content); assert.equal(plan.after[0].checks_revision, 9); assert.equal(plan.after[0].approved_revision, null);
  assert.equal(record.afterPublication!.recipe.description.en, original.publication!.snapshot.recipe.description.en);
});

test('a replacement clears only the exact prior omission and preserves all other omissions', () => {
  const original = row(), input = manifest(), edit = input.rules[0].steps![0], step = original.content.recipe.steps.find(step => step.id === 'serve')!;
  const omission = createStepPhotoOmission(step, { pl: 'Poprzedni przegląd.', en: 'Previous review.' });
  original.content.photos.omittedSteps = { serve: omission, other: structuredClone(omission) };
  edit.beforeOmission = omission; edit.afterOmission = null; edit.after = structuredClone(replacementPhoto);
  const result = patchReviewedDishStepPhotos(original.content, original.id, 'draft', input).content;
  assert.deepEqual(result.photos.steps.serve, replacementPhoto); assert.equal(result.photos.omittedSteps?.serve, undefined);
  assert.deepEqual(result.photos.omittedSteps?.other, omission);
});

test('a changed draft method needs a separate exact review from its published instruction', () => {
  const original = row(), input = manifest();
  original.content.recipe.steps.find(step => step.id === 'serve')!.text.en += ' Revised private serving instruction.';
  original.content_hash = hash(original.content);
  assert.throws(() => buildDishStepPhotoRepairPlan([original], input, context), /STEP_CHANGED/);
  input.rules[0].scope = 'publication';
  const draftRule = structuredClone(input.rules[0]); draftRule.scope = 'draft';
  const step = original.content.recipe.steps.find(step => step.id === 'serve')!;
  draftRule.steps![0].signature = stepPhotoSignature(step);
  draftRule.steps![0].afterOmission = createStepPhotoOmission(step, { pl: 'Przegląd aktualnego szkicu.', en: 'Review of current draft.' });
  input.rules.push(draftRule);
  const plan = buildDishStepPhotoRepairPlan([original], input, context), record = plan.records[0];
  assert.equal(record.afterDraft.photos.omittedSteps!.serve.signature, stepPhotoSignature(step));
  assert.notEqual(record.afterDraft.photos.omittedSteps!.serve.signature, record.afterPublication!.photos.omittedSteps!.serve.signature);
  assert.equal(record.afterDraft.recipe.steps.find(step => step.id === 'serve')!.text.en, step.text.en);
  assert.equal(record.afterPublication!.recipe.steps.find(step => step.id === 'serve')!.text.en, original.publication!.snapshot.recipe.steps.find(step => step.id === 'serve')!.text.en);
});

test('changed method, tile, hero and omission each invalidate a reviewed repair', () => {
  for (const change of ['method', 'timer', 'tile', 'hero', 'omission'] as const) {
    const original = row(), input = manifest();
    if (change === 'method') original.content.recipe.steps.find(step => step.id === 'serve')!.text.en += ' New technique.';
    if (change === 'timer') original.content.recipe.steps.find(step => step.id === 'serve')!.timerMinutes = 5;
    if (change === 'tile') original.content.photos.steps.serve.index = 3;
    if (change === 'hero') original.content.recipe.image = '/images/new-current.webp';
    if (change === 'omission') original.content.photos.omittedSteps = { serve: input.rules[0].steps![0].afterOmission! };
    assert.throws(() => patchReviewedDishStepPhotos(original.content, original.id, 'draft', input), /CHANGED/);
  }
});

test('removals require a current explicit review, replacement cannot also be omitted, traversal and overlaps fail', () => {
  const missing = manifest(); missing.rules[0].steps![0].afterOmission = null;
  assert.throws(() => validateDishStepPhotoRepairManifest(missing), /EXPLICIT_REMOVAL_REVIEW_REQUIRED/);
  const both = manifest(); both.rules[0].steps![0].after = replacementPhoto;
  assert.throws(() => validateDishStepPhotoRepairManifest(both), /PHOTO_AND_OMISSION_CONFLICT/);
  const stale = manifest(); stale.rules[0].steps![0].afterOmission!.signature = '0000000000000000';
  assert.throws(() => patchReviewedDishStepPhotos(row().content, 'fixture', 'draft', stale), /OMISSION_SIGNATURE_INVALID/);
  const duplicate = manifest(); duplicate.rules.push(structuredClone(duplicate.rules[0]));
  assert.throws(() => validateDishStepPhotoRepairManifest(duplicate), /OVERLAPPING_RULES/);
  const traversal = manifest(); traversal.rules[0].hero!.after.src = '/images/../secret.webp';
  assert.throws(() => validateDishStepPhotoRepairManifest(traversal), /HERO_REPLACEMENT_INVALID/);
  const crop = manifest(); crop.rules[0].steps![0].after = { ...replacementPhoto, aspectRatio: 1 }; crop.rules[0].steps![0].afterOmission = null;
  assert.throws(() => validateDishStepPhotoRepairManifest(crop), /STEP_REPLACEMENT_INVALID/);
  const arbitrary = manifest() as unknown as { rules: { arbitrary?: string }[] }; arbitrary.rules[0].arbitrary = 'unscoped mutation';
  assert.throws(() => validateDishStepPhotoRepairManifest(arbitrary), /MANIFEST_INVALID/);
});

test('exact before and after inventory fences support replay while detecting unrelated changes and plan tampering', () => {
  const original = row(), input = manifest(), plan = buildDishStepPhotoRepairPlan([original], input, context);
  assert.equal(dishStepPhotoRepairPlanState(plan, [original]), 'before');
  const record = plan.records[0], after = structuredClone(original);
  after.content = record.afterDraft; after.publication!.snapshot = record.afterPublication!;
  Object.assign(after, plan.after[0], { content: after.content, publication: { ...after.publication!, ...plan.after[0].publication } });
  assert.equal(dishStepPhotoRepairPlanState(plan, [after]), 'after');
  const changed = structuredClone(original); changed.checks.photos = false;
  assert.throws(() => dishStepPhotoRepairPlanState(plan, [changed]), /INVENTORY_CHANGED/);
  const added = row(); added.id = 'unplanned'; added.content.recipe.id = added.id; added.content_hash = hash(added.content); added.publication = null; added.publication_status = 'never_published';
  assert.throws(() => dishStepPhotoRepairPlanState(plan, [original, added]), /INVENTORY_CHANGED/);
  const tampered = structuredClone(plan); tampered.records[0].afterDraft.recipe.baseServings += 1;
  assert.throws(() => dishStepPhotoRepairPlanState(tampered, [original]), /PLANNED_CHANGES_INVALID/);
});

test('deleted/publication-absent targets fail and archived drafts keep their state', () => {
  const deleted = row(); deleted.deleted_at = '2026-10-24T00:00:00Z';
  assert.throws(() => buildDishStepPhotoRepairPlan([deleted], manifest(), context), /RECIPE_OUTSIDE_SCOPE/);
  const archived = row(), input = manifest(); archived.editorial_status = 'archived'; archived.publication_status = 'unpublished'; archived.publication = null;
  assert.throws(() => buildDishStepPhotoRepairPlan([archived], input, context), /PUBLICATION_OUTSIDE_SCOPE/);
  input.rules[0].scope = 'draft'; const plan = buildDishStepPhotoRepairPlan([archived], input, context);
  assert.equal(plan.after[0].editorial_status, 'archived'); assert.equal(plan.after[0].publication_status, 'unpublished'); assert.equal(plan.records[0].publicationId, null);
});

test('default invocation is read-only; only an explicit apply mode can write', () => {
  assert.equal(dishStepRepairMode([]), 'preflight'); assert.equal(dishStepRepairMode(['--plan=reviewed.json']), 'preflight');
  assert.equal(dishStepRepairMode(['--manifest=reviewed.json']), 'prepare'); assert.equal(dishStepRepairMode(['--prepare']), 'prepare');
  assert.equal(dishStepRepairMode(['--apply']), 'apply');
  assert.throws(() => dishStepRepairMode(['--apply', '--prepare']), /CHOOSE_ONE_MODE/);
});

test('hero solidity proof follows each selected scope rather than a pending draft vessel', () => {
  const original = row();
  const presentation = { container: 'jar' as const, profileVersion: 'jesie-finished-dish-v2' as const,
    evidenceStepIds: ['serve'], finalAppearance: { pl: 'Potrawa w słoiku.', en: 'Food in a jar.' } };
  original.content.recipe.heroPresentation = presentation;
  assert.equal(dishStepHeroNeedsSolidProof(original, ['draft']), false);
  assert.equal(dishStepHeroNeedsSolidProof(original, ['publication']), true);
  assert.equal(dishStepHeroNeedsSolidProof(original, ['draft', 'publication']), true);
  original.publication!.snapshot.recipe.heroPresentation = presentation;
  assert.equal(dishStepHeroNeedsSolidProof(original, ['draft', 'publication']), false);
  assert.throws(() => dishStepHeroNeedsSolidProof(original, []), /HERO_PROOF_SCOPE_MISSING/);
});
