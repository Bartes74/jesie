import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRecipeCorrection, readStoredRecipeCorrection } from './recipe-correction';
import { recipes } from './recipes';
import type { EditorialContent } from './editorial-types';

function content(): EditorialContent { return { recipe: structuredClone(recipes[0]), author: 'Author', originalText: 'Original', sources: [], photos: { ingredients: {}, steps: {} } }; }
test('a manual ingredient correction preserves the other language, references and unrelated fields', () => {
  const original = content(); const ingredient = structuredClone(original.recipe.ingredients[0]);
  ingredient.name.pl = 'Poprawiona nazwa'; ingredient.amount = { kind: 'exact', value: '125' };
  const next = applyRecipeCorrection(original, { kind: 'ingredient', item: ingredient });
  assert.equal(next.recipe.ingredients[0].name.pl, 'Poprawiona nazwa');
  assert.equal(next.recipe.ingredients[0].name.en, original.recipe.ingredients[0].name.en);
  assert.equal(next.recipe.ingredients[0].id, original.recipe.ingredients[0].id);
  assert.deepEqual(next.recipe.steps, original.recipe.steps); assert.equal(next.originalText, 'Original');
  assert.notEqual(original.recipe.ingredients[0].name.pl, 'Poprawiona nazwa');
});
test('a correction cannot silently add a target deleted in another revision', () => {
  const original = content(); const step = { ...original.recipe.steps[0], id: 'deleted-target' };
  assert.throws(() => applyRecipeCorrection(original, { kind: 'step', item: step }), /nie istnieje/);
});
test('browser recovery accepts only a complete matching correction and a valid revision', () => {
  const item = content().recipe.ingredients[0]; const target = { kind: 'ingredient' as const, id: item.id };
  const stored = JSON.stringify({ revision: 5, correction: { kind: 'ingredient', item } });
  assert.equal(readStoredRecipeCorrection(stored, target)?.revision, 5);
  assert.equal(readStoredRecipeCorrection(stored, { ...target, id: 'other' }), null);
  assert.equal(readStoredRecipeCorrection(JSON.stringify({ revision: 5, correction: { kind: 'ingredient', item: { id: item.id } } }), target), null);
  assert.equal(readStoredRecipeCorrection('{', target), null);
});
