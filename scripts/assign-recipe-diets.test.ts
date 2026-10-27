import assert from 'node:assert/strict';
import test from 'node:test';
import { recipes } from '../src/lib/recipes';
import { recipeDietBaseNotes } from '../src/lib/recipe-diet';
import { citrusRepairHash as hash, type CitrusRepairRecipe } from './repair-citrus-ingredient-photos';
import { buildDietPlan, dietPlanState, patchRecipeDiet, validateDietManifest, type DietManifest } from './assign-recipe-diets';

function row(): CitrusRepairRecipe {
  const recipe = structuredClone(recipes.find(item => item.id === 'pumpkin-soup')!); recipe.id = 'diet-fixture'; delete recipe.diet;
  const content = { recipe, originalText: 'Author original', author: 'Author', sources: [], photos: { ingredients: {}, steps: {} } };
  const checks = { pl: true, en: true, quantities: true, method: true, photos: true, sources: true };
  return { id: recipe.id, revision: 10, content, content_hash: hash(content), editorial_status: 'approved', checks, checks_revision: 10, approved_revision: 10,
    publication_status: 'published', published_id: 'old-publication', published_revision: 8, deleted_at: null,
    publication: { id: 'old-publication', recipe_id: recipe.id, revision: 8, snapshot: structuredClone(content), content_hash: hash(content), checks,
      approval_origin: 'manual', published_by: 'owner', published_by_name: 'Owner', reviewed_by: 'reviewer', reviewed_by_name: 'Reviewer', reviewed_revision: 7 } };
}
const emptyManifest = (): DietManifest => ({ version: 1, reason: 'Owner requested exclusive ingredient-based dietary classification across all existing recipes.', corrections: [] });
const context = { actor: { id: 'owner', name: 'Owner' }, databaseScope: 'fixture', history: { versions: [], publications: [], approvals: [] } };
function withCheese() {
  const source = row();
  for (const content of [source.content, source.publication!.snapshot]) content.recipe.ingredients.push({ id: 'hard-cheese', name: { pl: 'twardy ser', en: 'hard cheese' },
    amount: { kind: 'exact', value: '20' }, unit: 'g', scaling: 'linear', group: { pl: 'Do podania', en: 'To serve' }, note: { pl: 'Drobno starty.', en: 'Finely grated.' } });
  source.content_hash = hash(source.content); source.publication!.content_hash = hash(source.publication!.snapshot);
  const manifest = emptyManifest();
  for (const scope of ['draft', 'publication'] as const) manifest.corrections.push({ scope, recipeId: source.id, ingredientId: 'hard-cheese',
    beforeNote: { pl: 'Drobno starty.', en: 'Finely grated.' },
    afterNote: { pl: `Drobno starty. ${recipeDietBaseNotes.cheese.pl}`, en: `Finely grated. ${recipeDietBaseNotes.cheese.en}` },
    reason: 'Require vegetarian rennet for the existing base cheese while retaining its physical form.' });
  return { source, manifest };
}

test('assignment changes only derived category when no product clarification is needed', () => {
  const source = row().content, before = structuredClone(source), result = patchRecipeDiet(source, 'draft', emptyManifest());
  assert.equal(result.changed, true); assert.equal(result.notesChanged, false); assert.deepEqual(source, before);
  const expected = structuredClone(source); expected.recipe.diet = 'vegan'; assert.deepEqual(result.content, expected);
  assert.equal(patchRecipeDiet(result.content, 'draft', emptyManifest()).changed, false);
});

test('note clarification is exact, bilingual, additive and preserves quantities, method, source and all photographs', () => {
  const { source, manifest } = withCheese(); validateDietManifest(manifest);
  const before = structuredClone(source.content), result = patchRecipeDiet(source.content, 'draft', manifest);
  const expected = structuredClone(before); expected.recipe.diet = 'vegetarian'; expected.recipe.ingredients.at(-1)!.note = manifest.corrections[0].afterNote;
  assert.deepEqual(result.content, expected); assert.deepEqual(source.content, before); assert.equal(result.notesChanged, true);
  const stale = structuredClone(manifest); stale.corrections[0].beforeNote!.en = 'Old different text.';
  assert.throws(() => patchRecipeDiet(source.content, 'draft', stale), /DIET_NOTE_CHANGED/);
  const missing = structuredClone(manifest); missing.corrections[0].ingredientId = 'missing';
  assert.throws(() => patchRecipeDiet(source.content, 'draft', missing), /DIET_INGREDIENT_MISSING/);
});

test('manifest cannot conceal arbitrary ingredient-note edits, partial-language changes or duplicate rules', () => {
  const { manifest } = withCheese();
  const rewritten = structuredClone(manifest); rewritten.corrections[0].afterNote.pl = 'Podmień ser na mięso.';
  assert.throws(() => validateDietManifest(rewritten), /DIET_NOTE_NOT_ADDITIVE/);
  const mismatch = structuredClone(manifest); mismatch.corrections[0].afterNote.en = recipeDietBaseNotes.cheese.en;
  assert.throws(() => validateDietManifest(mismatch), /DIET_NOTE_NOT_ADDITIVE/);
  const duplicate = structuredClone(manifest); duplicate.corrections.push(duplicate.corrections[0]);
  assert.throws(() => validateDietManifest(duplicate), /DIET_NOTE_RULE_OVERLAP/);
  const illegal = structuredClone(manifest) as unknown as { corrections: { field: string }[] }; illegal.corrections[0].field = 'steps';
  assert.throws(() => validateDietManifest(illegal), /DIET_MANIFEST_INVALID/);
});

test('an unresolved ingredient cannot be used to fabricate meat or nonmeat inventory balance', () => {
  const source = row().content; source.recipe.ingredients = [{ ...source.recipe.ingredients[0], name: { pl: 'nieznany produkt', en: 'mystery ingredient' } }];
  assert.throws(() => patchRecipeDiet(source, 'draft', emptyManifest()), /DIET_INGREDIENT_REVIEW_REQUIRED/);
});

test('diet-only records preserve actual approval status and carry only linked revision metadata forward', () => {
  const source = row(), plan = buildDietPlan([source], emptyManifest(), context), after = plan.after[0];
  assert.equal(after.editorial_status, 'approved'); assert.equal(after.approved_revision, 11); assert.equal(after.checks_revision, 11);
  assert.deepEqual(after.checks, source.checks); assert.equal(after.publication!.reviewed_by, 'reviewer'); assert.equal(after.publication!.reviewed_revision, 7);
  assert.deepEqual(plan.history.approvals, []); assert.equal(dietPlanState(plan, [source]), 'before');
  const oldLinked = row(); oldLinked.approved_revision = 8; oldLinked.checks_revision = 9;
  const linkedPlan = buildDietPlan([oldLinked], emptyManifest(), context);
  assert.equal(linkedPlan.after[0].approved_revision, 8); assert.equal(linkedPlan.after[0].checks_revision, 9);
});

test('product notes invalidate quantities only; existing manual approval receipts remain untouched', () => {
  const { source, manifest } = withCheese(), plan = buildDietPlan([source], manifest, context), after = plan.after[0];
  assert.equal(after.editorial_status, 'in_review'); assert.equal(after.approved_revision, null); assert.equal(after.checks.quantities, false);
  assert.equal(after.checks.method, true); assert.equal(after.checks.photos, true); assert.equal(after.publication!.checks.quantities, false);
  assert.equal(after.publication!.reviewed_by, null); assert.equal(after.publication!.reviewed_revision, null); assert.deepEqual(plan.history.approvals, []);
});

test('private draft changes do not leak into the existing publication and unpublished recipes remain unpublished', () => {
  const source = row(); source.content.recipe.description.en = 'Private draft'; source.content_hash = hash(source.content);
  const plan = buildDietPlan([source], emptyManifest(), context), record = plan.records[0];
  assert.equal(record.afterDraft.recipe.description.en, 'Private draft');
  assert.equal(record.afterPublication!.recipe.description.en, source.publication!.snapshot.recipe.description.en);
  const draft = row(); draft.publication = null; draft.publication_status = 'never_published'; draft.published_id = null; draft.published_revision = null;
  const draftPlan = buildDietPlan([draft], emptyManifest(), context);
  assert.equal(draftPlan.records[0].publicationId, null); assert.equal(draftPlan.after[0].publication_status, 'never_published');
});

test('replay recognises the exact applied state and rejects concurrent edits, tampering and invented approvals', () => {
  const { source, manifest } = withCheese(), plan = buildDietPlan([source], manifest, context), record = plan.records[0], after = plan.after[0];
  const applied: CitrusRepairRecipe = { ...structuredClone(source), ...after, deleted_at: null, content: record.afterDraft,
    publication: { ...after.publication!, snapshot: record.afterPublication! } };
  assert.equal(dietPlanState(plan, [applied]), 'after');
  const concurrent = structuredClone(source); concurrent.content.recipe.title.pl += ' edited'; concurrent.content_hash = hash(concurrent.content);
  assert.throws(() => dietPlanState(plan, [concurrent]), /DIET_REVISION_CONFLICT/);
  const altered = structuredClone(plan); altered.records[0].afterDraft.recipe.steps[0].timerMinutes = 500;
  assert.throws(() => dietPlanState(altered, [source]), /DIET_PLAN_DRAFT_INVALID/);
  const fakeApproval = structuredClone(plan); fakeApproval.after[0].approved_revision = 11;
  assert.throws(() => dietPlanState(fakeApproval, [source]), /DIET_PLAN_METADATA_INVALID/);
  const missingOutbox = structuredClone(plan); missingOutbox.records[0].outboxId = null;
  assert.throws(() => dietPlanState(missingOutbox, [source]), /DIET_OUTBOX_REQUIRED/);
});
