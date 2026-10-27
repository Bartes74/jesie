import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipes, type Ingredient } from './recipes';
import { getIngredientImage, type MediaTile } from './recipe-media';
import { ingredientPhotoIdentity } from './citrus-photo-policy';
import { ingredientPhotoPolicyIssues } from './ingredient-photo-policy';

const ingredient = (id: string, pl: string, en: string): Ingredient => ({ ...structuredClone(recipes[0].ingredients[0]), id, name: { pl, en }, note: undefined });
const photo = (src = '/media/00000000-0000-4000-8000-000000000001'): MediaTile => ({ src, columns: 1, rows: 1, index: 0, alt: { pl: 'Dowolny opis', en: 'Editable description' } });

test('different products cannot share one crop, while distinct atlas crops remain separate', () => {
  const butter = ingredient('butter', 'masło', 'butter'), salt = ingredient('salt', 'sól', 'salt');
  assert.deepEqual(new Set(ingredientPhotoPolicyIssues([butter, salt], { butter: photo(), salt: photo() }).map(issue => issue.ingredientId)), new Set(['butter', 'salt']));
  assert.deepEqual(ingredientPhotoPolicyIssues([butter, salt], { butter: getIngredientImage('lemon-pasta', 'butter'), salt: getIngredientImage('lemon-pasta', 'salt') }), []);
});

test('the visual registry rejects the old oil, clear-water and salt-only aliases', () => {
  const cases = [
    [ingredient('oil', 'olej rzepakowy', 'rapeseed oil'), '/images/ingredients-2.webp', 1],
    [ingredient('pasta-water', 'woda z gotowania makaronu', 'pasta cooking water'), '/images/ingredients-1.webp', 8],
    [ingredient('seasoning', 'sól i pieprz', 'salt and pepper'), '/images/ingredients-1.webp', 6],
  ] as const;
  for (const [item, src, index] of cases) assert(ingredientPhotoPolicyIssues([item], { [item.id]: { ...photo(src), columns: 4, rows: 3, index } }).some(issue => issue.ingredientId === item.id));
});

test('ordinary purpose aliases can share a suitable ingredient illustration', () => {
  const items = [ingredient('butter', 'masło', 'butter'), ingredient('tin-butter', 'masło do formy', 'butter for greasing the tin')];
  const cube = getIngredientImage('lemon-pasta', 'butter');
  assert.deepEqual(ingredientPhotoPolicyIssues(items, Object.fromEntries(items.map(item => [item.id, cube]))), []);
});

test('captured source identity wins over an editable alt even for a single ingredient', () => {
  const butter = ingredient('butter', 'masło', 'butter'), garlic = ingredient('garlic', 'czosnek', 'garlic');
  const tile = { ...photo(), alt: butter.name };
  const issues = ingredientPhotoPolicyIssues([butter], { butter: tile }, new Map([[ingredientPhotoIdentity(tile), garlic]]));
  assert(issues.some(issue => issue.ingredientId === 'butter'));
});

test('captured photos cannot cross material forms or explicit cut requirements', () => {
  for (const [sourcePl, sourceEn, targetPl, targetEn] of [
    ['szpinak', 'spinach', 'szpinak mrożony', 'frozen spinach'],
    ['kurczak', 'chicken', 'ugotowany kurczak', 'cooked chicken'],
    ['orzechy włoskie', 'walnuts', 'mielone orzechy włoskie', 'ground walnuts'],
    ['czosnek', 'garlic', 'posiekany czosnek', 'chopped garlic'],
  ]) {
    const source = ingredient('source', sourcePl, sourceEn), target = ingredient('target', targetPl, targetEn), tile = photo();
    assert(ingredientPhotoPolicyIssues([target], { target: tile }, new Map([[ingredientPhotoIdentity(tile), source]])).some(issue => issue.ingredientId === 'target'), targetEn);
  }
});

test('visually rejected photos cannot be reassigned under their old intended labels', () => {
  const wine = ingredient('wine', 'wytrawne czerwone wino', 'dry red wine');
  assert(ingredientPhotoPolicyIssues([wine], { wine: photo('/media/9ea9e5cb-0b8c-4e6d-8052-45e374ab5505') }).length);
});

test('every bundled ingredient now selects a photograph compatible with its actual product and form', () => {
  for (const recipe of recipes) {
    const photos = Object.fromEntries(recipe.ingredients.map(item => [item.id, getIngredientImage(recipe.id, item.id)]));
    assert.deepEqual(ingredientPhotoPolicyIssues(recipe.ingredients, photos), [], recipe.id);
  }
});
