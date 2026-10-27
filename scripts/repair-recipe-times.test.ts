import test from 'node:test';
import assert from 'node:assert/strict';
import { recipes } from '../src/lib/recipes';
import { citrusRepairHash as hash, type CitrusRepairRecipe } from './repair-citrus-ingredient-photos';
import { buildTimingPlan, patchRecipeTimes, timingPlanState, validateTimingManifest, type TimingManifest } from './repair-recipe-times';

function row(): CitrusRepairRecipe {
  const recipe = structuredClone(recipes[0]); recipe.id = 'timing-fixture';
  const content = { recipe, originalText: 'Original author text', author: 'Author', sources: [], photos: { ingredients: {}, steps: {} } };
  const checks = { pl: true, en: true, quantities: true, method: true, photos: true, sources: true };
  return { id: recipe.id, revision: 10, content, content_hash: hash(content), editorial_status: 'approved', checks, checks_revision: 10, approved_revision: 10,
    publication_status: 'published', published_id: 'old-publication', published_revision: 8, deleted_at: null,
    publication: { id: 'old-publication', recipe_id: recipe.id, revision: 8, snapshot: structuredClone(content), content_hash: hash(content), checks,
      approval_origin: 'manual', published_by: 'owner', published_by_name: 'Owner', reviewed_by: 'reviewer', reviewed_by_name: 'Reviewer', reviewed_revision: 7 } };
}
function manifest(): TimingManifest {
  return { version: 1, reason: 'Owner requested a realistic timing correction after reviewing the complete method.', rules: [{ recipeId: row().id,
    scope: 'both', before: row().content.recipe.times, after: { active: 20, cooking: 15, rest: 10, total: 35 },
    reason: 'Hands-on preparation overlaps cooking; ten minutes of final resting follows.' }] };
}
const context = { actor: { id: 'owner', name: 'Owner' }, databaseScope: 'fixture', history: { versions: [], publications: [], approvals: [] } };

test('timing correction changes only exact times and preserves every method, timer, photo and source', () => {
  const source = row().content, before = structuredClone(source), input = manifest();
  const result = patchRecipeTimes(source, 'draft', input);
  assert.equal(result.changed, true); assert.deepEqual(source, before);
  const expected = structuredClone(before); expected.recipe.times = input.rules[0].after;
  assert.deepEqual(result.content, expected);
  assert.throws(() => patchRecipeTimes(result.content, 'draft', input), /TIMING_VALUES_CHANGED/);
});

test('validation permits overlapping components but rejects invalid values and overlapping scopes', () => {
  const input = manifest(); validateTimingManifest(input); // sum45, elapsed35
  for (const invalid of [-1, NaN, 1.5]) {
    const changed = structuredClone(input); changed.rules[0].after.active = invalid;
    assert.throws(() => validateTimingManifest(changed), /TIMING_MANIFEST_INVALID/);
  }
  const tooShort = structuredClone(input); tooShort.rules[0].after.total = 5;
  assert.throws(() => validateTimingManifest(tooShort), /TIMING_MANIFEST_INVALID/);
  const duplicate = structuredClone(input); duplicate.rules.push({ ...duplicate.rules[0], scope: 'publication' });
  assert.throws(() => validateTimingManifest(duplicate), /TIMING_RULE_OVERLAP/);
});

test('private unpublished edits do not leak into an existing publication and no new review is invented', () => {
  const original = row(); original.content.recipe.description.en = 'Private unpublished draft edit'; original.content_hash = hash(original.content);
  const old = structuredClone(original), plan = buildTimingPlan([original], manifest(), context);
  const r = plan.records[0];
  assert.deepEqual(original, old); assert.equal(timingPlanState(plan, [original]), 'before');
  assert.equal(r.afterDraft.recipe.description.en, 'Private unpublished draft edit');
  assert.equal(r.afterPublication!.recipe.description.en, old.publication!.snapshot.recipe.description.en);
  assert.equal(plan.after[0].approved_revision, null); assert.equal(plan.after[0].checks.method, false);
  assert.equal(plan.after[0].editorial_status, 'in_review'); assert.equal(plan.after[0].publication_status, 'published');
  assert.equal(plan.after[0].publication!.reviewed_revision, null); assert.equal(plan.after[0].publication!.approval_origin, 'manual');
  assert.deepEqual(plan.history.approvals, []);
});

test('plan replay recognises exact applied state and rejects concurrent edits and tampered method', () => {
  const original = row(), plan = buildTimingPlan([original], manifest(), context), record = plan.records[0], after = plan.after[0];
  const applied: CitrusRepairRecipe = { ...structuredClone(original), ...after, deleted_at: null, content: record.afterDraft,
    publication: { ...after.publication!, snapshot: record.afterPublication! } };
  assert.equal(timingPlanState(plan, [applied]), 'after');
  const edited = structuredClone(original); edited.content.recipe.title.pl += ' new'; edited.content_hash = hash(edited.content);
  assert.throws(() => timingPlanState(plan, [edited]), /TIMING_REVISION_CONFLICT/);
  const altered = structuredClone(plan); altered.records[0].afterDraft.recipe.steps[0].timerMinutes = 123;
  assert.throws(() => timingPlanState(altered, [original]), /TIMING_PLAN_DRAFT_INVALID/);
  const forgedApproval = structuredClone(plan); forgedApproval.after[0].approved_revision = 11;
  assert.throws(() => timingPlanState(forgedApproval, [original]), /TIMING_PLAN_METADATA_INVALID/);
  const missingOutbox = structuredClone(plan); missingOutbox.records[0].outboxId = null;
  assert.throws(() => timingPlanState(missingOutbox, [original]), /TIMING_OUTBOX_REQUIRED/);
  const missingPublication = structuredClone(plan); missingPublication.records[0].publicationChanged = false;
  missingPublication.records[0].publicationId = null; missingPublication.records[0].outboxId = null;
  missingPublication.records[0].afterPublication = missingPublication.records[0].beforePublication;
  assert.throws(() => timingPlanState(missingPublication, [original]), /TIMING_PLAN_PUBLICATION_INVALID/);
});

test('text corrections are exact and limited to non-method timing claims', () => {
  const original = row(), input = manifest();
  const beforeTip = { pl: original.content.recipe.tips.pl[0], en: original.content.recipe.tips.en[0] };
  input.rules[0].textEdits = [{ field: 'tip', index: 0, before: beforeTip, after: { pl: 'Około 35 minut do podania.', en: 'Allow about 35 minutes until serving.' } }];
  const result = patchRecipeTimes(original.content, 'draft', input).content;
  assert.deepEqual(result.recipe.steps, original.content.recipe.steps); assert.deepEqual(result.photos, original.content.photos);
  assert.equal(result.recipe.tips.pl[0], input.rules[0].textEdits[0].after.pl);
  assert.deepEqual(result.recipe.tips.pl.slice(1), original.content.recipe.tips.pl.slice(1));
  const stale = structuredClone(input); stale.rules[0].textEdits![0].before.en = 'A stale value';
  assert.throws(() => patchRecipeTimes(original.content, 'draft', stale), /TIMING_PROSE_CHANGED/);
  const illegal = structuredClone(input) as unknown as { rules: { textEdits: { field: string }[] }[] };
  illegal.rules[0].textEdits[0].field = 'steps';
  assert.throws(() => validateTimingManifest(illegal), /TIMING_MANIFEST_INVALID/);
});

test('timing SEO edits remove stale duration claims without changing unrelated discovery fields', () => {
  const source = row().content, input = manifest();
  source.recipe.seo = { title: { pl: 'Obiad w 30 minut', en: 'Dinner in 30 minutes' }, keywords: { pl: ['obiad do 30 minut', 'makaron'], en: ['30-minute dinner', 'pasta'] },
    collectionIds: ['quick-dinners', 'pantry'], relatedRecipeIds: ['other'] };
  input.rules[0].textEdits = [{ field: 'seoTitle', before: source.recipe.seo.title!, after: { pl: 'Obiad w 35 minut', en: 'Dinner in 35 minutes' } }];
  input.rules[0].listEdits = [{ field: 'seoKeywords', before: source.recipe.seo.keywords!, after: { pl: ['obiad do 35 minut', 'makaron'], en: ['35-minute dinner', 'pasta'] } },
    { field: 'seoCollectionIds', before: ['quick-dinners', 'pantry'], after: ['pantry'] }];
  const result = patchRecipeTimes(source, 'draft', input).content;
  assert.deepEqual(result.recipe.seo?.relatedRecipeIds, ['other']); assert.deepEqual(result.recipe.seo?.collectionIds, ['pantry']);
  assert.deepEqual(result.recipe.seo?.keywords?.en, ['35-minute dinner', 'pasta']);
  const stale = structuredClone(input); stale.rules[0].listEdits![1].before = [];
  assert.throws(() => patchRecipeTimes(source, 'draft', stale), /TIMING_SEO_LIST_CHANGED/);
});

test('a draft correction never releases an unpublished recipe and optional notes are bilingual and additive', () => {
  const original = row(); original.publication = null; original.publication_status = 'never_published'; original.published_id = null; original.published_revision = null;
  const input = manifest(); input.rules[0].scope = 'draft'; input.rules[0].note = { pl: 'Czas obejmuje studzenie.', en: 'The estimate includes cooling.' };
  const plan = buildTimingPlan([original], input, context), record = plan.records[0];
  assert.equal(record.publicationId, null); assert.equal(plan.after[0].publication_status, 'never_published');
  assert.deepEqual(record.afterDraft.recipe.tips.pl, [...original.content.recipe.tips.pl, input.rules[0].note.pl]);
  assert.deepEqual(record.afterDraft.recipe.tips.en, [...original.content.recipe.tips.en, input.rules[0].note.en]);
  assert.deepEqual(record.afterDraft.recipe.steps, original.content.recipe.steps);
});
