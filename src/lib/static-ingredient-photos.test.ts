import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipes, type Ingredient } from './recipes';
import { getIngredientImage } from './recipe-media';
import { ingredientPhotoIdentitiesCompatible, ingredientPhotoSemanticIdentity } from './ingredient-photo-identity';
import { isKnownStaticIngredientPhoto, knownStaticIngredientPhotoIdentity, standaloneIngredientPhotoPaths, staticIngredientPhotoOverride, staticIngredientPhotoRegistry } from './static-ingredient-photos';

const ingredient = (pl: string, en: string): Ingredient => ({ id: 'test', name: { pl, en }, unit: 'g', amount: { kind: 'exact', value: '1' }, scaling: 'linear', group: { pl: '', en: '' } });
const tile = (sheet: number, index: number) => ({ src: `/images/ingredients-${sheet}.webp`, columns: 4, rows: 3, index });

test('all 36 atlas crops have independent visual truth and invalid crop geometry has no semantic authority', () => {
  assert.equal(staticIngredientPhotoRegistry.filter(entry => entry.photo.columns === 4).length, 36);
  for (let sheet = 1; sheet <= 3; sheet++) for (let index = 0; index < 12; index++) assert(knownStaticIngredientPhotoIdentity(tile(sheet, index)));
  assert.equal(knownStaticIngredientPhotoIdentity({ ...tile(1, 8), columns: 3 }), null);
  assert.equal(new Set(standaloneIngredientPhotoPaths).size, standaloneIngredientPhotoPaths.length);
});

test('actual skin-on ginger and seeded apples reject peeled or cored claims and receive reviewed replacements', () => {
  const ginger = ingredient('obrany imbir', 'peeled ginger'), apples = ingredient('obrane jabłka bez gniazd nasiennych', 'peeled cored apples');
  assert.equal(isKnownStaticIngredientPhoto(tile(2, 0), ginger), false);
  assert.equal(isKnownStaticIngredientPhoto(tile(3, 4), apples), false);
  assert.equal(staticIngredientPhotoOverride('pumpkin-soup', ginger)?.src, '/images/ingredients/ginger-peeled.webp');
  assert.equal(staticIngredientPhotoOverride('apple-cake', apples)?.src, '/images/ingredients/apples-peeled-cored.webp');
});

test('water, pasta water, olive oil, rapeseed oil and neutral oil retain distinct products and photographs', () => {
  const source = knownStaticIngredientPhotoIdentity(tile(1, 8))!;
  assert.equal(ingredientPhotoIdentitiesCompatible(source, ingredientPhotoSemanticIdentity(ingredient('woda', 'water'))), true);
  assert.equal(ingredientPhotoIdentitiesCompatible(source, ingredientPhotoSemanticIdentity(ingredient('woda z gotowania makaronu', 'pasta cooking water'))), false);
  assert.equal(staticIngredientPhotoOverride('lemon-pasta', 'pasta-water')?.src, '/images/ingredients/pasta-water.webp');
  assert.equal(staticIngredientPhotoOverride('spinach-pierogi', 'oil')?.src, '/images/ingredients/rapeseed-oil.webp');
  assert.equal(staticIngredientPhotoOverride('ricotta-pancakes', 'frying-oil')?.src, '/images/ingredients/neutral-oil.webp');
  assert.equal(isKnownStaticIngredientPhoto(tile(2, 1), ingredient('olej rzepakowy', 'rapeseed oil')), false);
});

test('purpose aliases and ordinary butter cuts, ricotta draining and raw egg presentation stay legitimate', () => {
  for (const [photo, target] of [
    [tile(1, 1), ingredient('masło do formy', 'butter for greasing the tin')],
    [tile(1, 1), ingredient('zimne masło w kostkach', 'cold cubed butter')],
    [tile(2, 7), ingredient('ricotta', 'ricotta')],
    [tile(2, 7), ingredient('odsączona ricotta', 'drained ricotta')],
    [tile(2, 10), ingredient('jajko do ciasta', 'egg for the dough')],
  ] as const) assert.equal(isKnownStaticIngredientPhoto(photo, target), true, target.name.en);
});

test('every seeded ingredient resolves to a known compatible source, including the combined salt and pepper', () => {
  for (const recipe of recipes) for (const item of recipe.ingredients) {
    const photo = getIngredientImage(recipe.id, item.id);
    assert.equal(isKnownStaticIngredientPhoto(photo, item), true, `${recipe.id}/${item.id}: ${item.name.en}`);
  }
  assert.equal(getIngredientImage('spinach-pierogi', 'salt').src, '/images/ingredients/salt-and-pepper.webp');
  assert.equal(getIngredientImage('lemon-pasta', 'lemon-juice').src, '/images/lemon-juice.webp');
});
