import test from 'node:test';
import assert from 'node:assert/strict';
import type { Ingredient } from './recipes';
import { getIngredientImage, type MediaTile } from './recipe-media';
import { ingredientPhotoIdentity, lemonIngredientPhotoForm, lemonIngredientPhotoIssue, lemonPhotoPolicyIssues, lemonPhotoSources } from './citrus-photo-policy';

const ingredient = (id: string, pl: string, en: string, note?: Ingredient['note']) => ({ id, name: { pl, en }, note });
const photo = (src: string, index = 0, columns = 1, rows = 1): MediaTile => ({ src, index, columns, rows, alt: { pl: 'Składnik', en: 'Ingredient' } });

test('seed and public fallback mappings use separate standalone photographs', () => {
  const juice=getIngredientImage('lemon-pasta','lemon-juice'),zest=getIngredientImage('lemon-pasta','lemon-zest');
  assert.equal(juice.src,lemonPhotoSources.juice);assert.equal(zest.src,lemonPhotoSources.zest);
  assert.notEqual(ingredientPhotoIdentity(juice),ingredientPhotoIdentity(zest));
  assert.deepEqual([juice.columns,juice.rows,juice.index],[1,1,0]);
});

test('lemon photo forms use bilingual names, aliases and explicit target IDs', () => {
  for (const item of [ingredient('custom', 'sok cytrynowy', 'freshly squeezed lemon juice'), ingredient('juice', 'sok z cytryny', ''), ingredient('lemon-juice', 'sok', '')]) assert.equal(lemonIngredientPhotoForm(item), 'juice');
  for (const item of [ingredient('custom', 'skórka cytrynowa', 'finely grated lemon zest'), ingredient('custom', 'otarta skórka z niewoskowanej cytryny', 'lemon rind'), ingredient('lemon-zest', 'skórka', '')]) assert.equal(lemonIngredientPhotoForm(item), 'zest');
  assert.equal(lemonIngredientPhotoForm(ingredient('lemon-juice', 'oliwa', 'olive oil')), null, 'A stale target ID cannot relabel another product.');
  assert.equal(lemonIngredientPhotoForm(ingredient('lemon-juice', 'cytryna', 'lemon')), null, 'A stale form ID cannot override an explicitly named whole lemon.');
  assert.equal(lemonIngredientPhotoForm(ingredient('lemon', 'cytryna', 'lemon', { pl: 'Wyciśnij sok później.', en: 'Use the juice later.' })), null, 'Whole lemons used during preparation retain their own form.');
  assert.equal(lemonIngredientPhotoForm(ingredient('lemon-juice', 'sok z limonki', 'lime juice')), null);
  assert.equal(lemonIngredientPhotoForm(ingredient('custom', 'sok z cytryny', 'lemon zest')), 'conflict');
});

test('known canonical photos and the historical zest tile cannot be assigned to the opposite form', () => {
  const juice = ingredient('juice', 'sok z cytryny', 'lemon juice');
  const zest = ingredient('zest', 'skórka cytrynowa', 'lemon zest');
  assert(lemonIngredientPhotoIssue(juice, photo('/images/ingredients-1.webp', 4, 4, 3)));
  assert(lemonIngredientPhotoIssue(juice, photo(lemonPhotoSources.zest)));
  assert(lemonIngredientPhotoIssue(zest, photo(lemonPhotoSources.juice)));
  assert.equal(lemonIngredientPhotoIssue(juice, photo(lemonPhotoSources.juice)), null);
  assert.equal(lemonIngredientPhotoIssue(zest, photo(lemonPhotoSources.zest)), null);
  assert(lemonIngredientPhotoIssue(juice, photo('/media/known-zest'), new Map([['/media/known-zest', 'zest']])));
});

test('duplicate guards compare the full source and crop, not the shared atlas alone', () => {
  const ingredients = [ingredient('juice', 'sok cytrynowy', 'lemon juice'), ingredient('zest', 'skórka cytrynowa', 'lemon zest')];
  const shared = photo('/media/shared');
  assert.equal(lemonPhotoPolicyIssues(ingredients, { juice: shared, zest: shared }).length, 2);
  const first = photo('/images/ingredients-2.webp', 2, 4, 3), second = photo('/images/ingredients-2.webp', 3, 4, 3);
  assert.notEqual(ingredientPhotoIdentity(first), ingredientPhotoIdentity(second));
  assert.deepEqual(lemonPhotoPolicyIssues(ingredients, { juice: first, zest: second }), []);
});
