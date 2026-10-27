import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryImageCompatible, libraryPhotoIdentity, validLibraryTarget } from './media-library-policy';
import { capturedIngredientStyleProfile, ingredientImageIdentity, paperIngredientStyleProfile } from '@/server/ai/ingredient-profile';
import { recipes } from '@/lib/recipes';
import type { EditorialContent } from '@/lib/editorial-types';

const content = (): EditorialContent => ({ recipe: structuredClone(recipes[0]), author: '', originalText: '', sources: [], photos: { ingredients: {}, steps: {} } });
test('same recipe/target identifiers cannot reuse an old photograph after the food changes', () => {
  const source = content(); const current = structuredClone(source);
  const hero = { kind: 'hero' as const, recipeId: source.recipe.id, targetId: null, input: source };
  const target = { recipeId: source.recipe.id, kind: 'hero' as const };
  assert.equal(libraryImageCompatible(hero, current, target), true);
  current.recipe.image = '/different-photo.webp';
  assert.equal(libraryImageCompatible(hero, current, target), true);
  current.recipe.description.pl = 'Inna potrawa';
  assert.equal(libraryImageCompatible(hero, current, target), false);
});
test('step photographs require the original step and compatible cooking content', () => {
  const source = content(); const current = structuredClone(source); const id = source.recipe.steps[0].id;
  const image = { kind: 'step' as const, recipeId: source.recipe.id, targetId: id, input: source };
  const target = { recipeId: source.recipe.id, kind: 'step' as const, targetId: id };
  assert.equal(libraryImageCompatible(image, current, target), true);
  current.recipe.steps[0].text.pl = 'Zupełnie inna czynność';
  assert.equal(libraryImageCompatible(image, current, target), false);
  assert.equal(libraryImageCompatible({ ...image, recipeId: 'other' }, source, target), false);
});
test('shared ingredient photographs require an eligible exact product/form/style key', () => {
  const current = content(); const ingredient = current.recipe.ingredients[0];
  const key = ingredientImageIdentity(ingredient, capturedIngredientStyleProfile(current)).key;
  const image = { kind: 'ingredient' as const, recipeId: 'other-recipe', targetId: 'other-ingredient', input: content(), ingredientKey: key };
  image.input.recipe.ingredients[0].id='other-ingredient';
  const target = { recipeId: current.recipe.id, kind: 'ingredient' as const, targetId: ingredient.id };
  assert.equal(libraryImageCompatible(image, current, target), true);
  assert.equal(libraryImageCompatible({ ...image, ingredientKey: undefined }, current, target), false);
  const wrong=structuredClone(image);wrong.input.recipe.ingredients[0].name={pl:'czosnek',en:'garlic'};
  assert.equal(libraryImageCompatible(wrong,current,target),false,'A matching catalog key cannot override the captured source product.');
  current.aiPhotography = { ingredientStyleProfile: paperIngredientStyleProfile };
  assert.equal(libraryImageCompatible(image, current, target), false);
});
test('invalid targets and different atlas tiles are kept distinct', () => {
  const recipe = content();
  assert.equal(validLibraryTarget({ recipeId: recipe.recipe.id, kind: 'ingredient' }, recipe), false);
  assert.equal(validLibraryTarget({ recipeId: recipe.recipe.id, kind: 'hero', targetId: 'unexpected' }, recipe), false);
  const photo = { src: '/atlas.webp', columns: 4, rows: 3, index: 0, alt: { pl: '', en: '' } };
  assert.notEqual(libraryPhotoIdentity(photo), libraryPhotoIdentity({ ...photo, index: 1 }));
});

test('a reviewed wrong-state step source cannot re-enter through the media library', () => {
  const input = content(), id = input.recipe.steps[0].id;
  const source = { kind: 'step' as const, recipeId: input.recipe.id, targetId: id, input, src: '/media/aa81db26-6a98-41e7-8f2e-b8a98fd0e325' };
  assert.equal(libraryImageCompatible(source, input, { recipeId: input.recipe.id, kind: 'step', targetId: id }), false);
});
