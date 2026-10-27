import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIngredientCatalog, ingredientProductIds, searchIngredientCatalog } from './ingredient-catalog';
import { isPantryProducts, isPopularNow, matchPantryRecipes, formatSubstitutionAmount } from './pantry';
import { ingredientCatalogResponse, recipeMatchesResponse, PantryQueryError } from './pantry-api';
import { recipes, type Ingredient, type IngredientSubstitution, type Recipe } from './recipes';
import { toPublicRecipe } from './recipe-presentation';

const ingredient = (pl: string, en: string, id = pl): Ingredient => ({ id, name: { pl, en }, amount: { kind: 'exact', value: '100' }, unit: 'g', scaling: 'linear', group: { pl: 'Składniki', en: 'Ingredients' } });
const milkAlternative: IngredientSubstitution = { id: 'milk-alternative', ingredientId: 'coconut', name: { pl: 'Mleko', en: 'Milk' }, amount: { kind: 'exact', value: '120' }, unit: 'ml', scaling: 'linear', note: { pl: 'Mniej kokosowego smaku. Podgrzewaj łagodnie.', en: 'Less coconut flavour. Warm gently.' }, status: 'approved' };
const sample = (id: string, ingredients: Ingredient[], minutes = 20): Recipe => ({ ...recipes[0], id, ingredients, times: { active: minutes, cooking: 0, rest: 0, total: minutes } });

test('catalog recognises bilingual aliases and preparation without merging distinct milks, fats or flours', () => {
  assert.deepEqual(ingredientProductIds(ingredient('mąka pszenna', 'plain flour')), ['plain-flour']);
  assert.deepEqual(ingredientProductIds(ingredient('cebula, posiekana', 'onion, finely chopped')), ['onion']);
  assert.deepEqual(ingredientProductIds(ingredient('olej rzepakowy', 'canola oil')), ['rapeseed-oil']);
  assert.notDeepEqual(ingredientProductIds(ingredient('mleko', 'milk')), ingredientProductIds(ingredient('mleczko kokosowe', 'coconut milk')));
  assert.notDeepEqual(ingredientProductIds(ingredient('masło', 'butter')), ingredientProductIds(ingredient('masło klarowane', 'ghee')));
  assert.notDeepEqual(ingredientProductIds(ingredient('mąka pszenna', 'plain flour')), ingredientProductIds(ingredient('mąka żytnia', 'rye flour')));
  const conflict = ingredientProductIds(ingredient('mleko', 'coconut milk'))[0];
  assert.ok(conflict.startsWith('literal:'));
  const unknown = ingredient('sos z tamaryndowca', 'tamarind sauce');
  assert.equal(ingredientProductIds(unknown)[0], ingredientProductIds(structuredClone(unknown))[0]);
  assert.notEqual(ingredientProductIds(unknown)[0], ingredientProductIds(ingredient('pasta z tamaryndowca', 'tamarind paste'))[0]);
  const longName = ingredient('nieznany produkt '.repeat(300), 'unknown ingredient '.repeat(300));
  const longId = ingredientProductIds(longName)[0];
  assert.equal(isPantryProducts([longId]), true);
  assert.ok(longId.length < 300);
  assert.notEqual(longId, ingredientProductIds({ ...longName, name: { ...longName.name, pl: `${longName.name.pl} inny` } })[0]);
  const catalog = buildIngredientCatalog([sample('unknown', [unknown])]);
  assert.ok(searchIngredientCatalog(catalog, 'tamaryndowca', 'pl').some(item => item.name.en === 'tamarind sauce'));
  assert.ok(searchIngredientCatalog(catalog, 'coconut milk', 'en').some(item => item.id === 'coconut-milk'));
  assert.ok(searchIngredientCatalog(catalog, '', 'pl').length <= 30);
});

test('pantry ranks missing count, coverage and time, with no matches for zero overlap', () => {
  const records = [
    sample('one-missing-long', [ingredient('mleko', 'milk'), ingredient('jajka', 'eggs'), ingredient('mąka pszenna', 'plain flour')], 40),
    sample('one-missing-short', [ingredient('mleko', 'milk'), ingredient('jajka', 'eggs'), ingredient('mąka pszenna', 'plain flour')], 20),
    sample('lower-coverage', [ingredient('mleko', 'milk'), ingredient('mleczko kokosowe', 'coconut milk')], 5),
    sample('complete', [ingredient('mleko', 'milk')], 50),
    sample('no-overlap', [ingredient('czosnek', 'garlic')], 1),
  ].map(toPublicRecipe);
  const matches = matchPantryRecipes(records, ['milk', 'eggs']);
  assert.deepEqual(matches.map(item => item.recipe.id), ['complete', 'one-missing-short', 'one-missing-long', 'lower-coverage']);
  assert.equal(matches[1].missing[0].id, 'plain-flour');
  assert.equal(matches[3].owned[0].id, 'milk');
  assert.equal(matches[3].missing[0].id, 'coconut-milk');
  assert.deepEqual(matchPantryRecipes(records, []), []);
  assert.deepEqual(matchPantryRecipes(records, ['not-in-catalog']), []);
});

test('main ingredients outweigh seasonings and selected use-first ingredients guide the shortlist', () => {
  const records = [sample('spice-only', [ingredient('Sól', 'Salt'), ingredient('Dynia', 'Pumpkin')]),
    sample('main-owned', [ingredient('Mleko', 'Milk'), ingredient('Jajka', 'Eggs')]),
    sample('urgent', [ingredient('Szpinak świeży', 'Fresh spinach'), ingredient('Mąka pszenna', 'Plain flour'), ingredient('Jajka', 'Eggs')])].map(toPublicRecipe);
  assert.equal(matchPantryRecipes(records, ['salt', 'milk', 'spinach'])[0].recipe.id, 'main-owned');
  assert.deepEqual(matchPantryRecipes(records, ['salt']), []);
  const withPriority = matchPantryRecipes(records, ['salt', 'milk', 'spinach'], ['spinach']);
  assert.equal(withPriority[0].recipe.id, 'urgent');
  assert.deepEqual(withPriority[0].priorityOwned.map(item => item.id), ['spinach']);
});

test('compound ingredients require both products and whole lemon supplies juice and zest', () => {
  const record = toPublicRecipe(sample('compound', [ingredient('sól i pieprz', 'salt and pepper'), ingredient('sok z cytryny', 'lemon juice'), ingredient('skórka cytrynowa', 'lemon zest')]));
  const match = matchPantryRecipes([record], ['salt', 'lemon'])[0];
  assert.deepEqual(match.missing.map(item => item.id), ['black-pepper']);
  const bottled = matchPantryRecipes([record], ['lemon-juice'])[0];
  assert.ok(bottled.missing.some(item => item.id === 'lemon-zest'));
});

test('approved substitutions stay suggestions, scale independently and do not replace missing ingredients', () => {
  const record = sample('substitution', [ingredient('mleko', 'milk', 'milk'), ingredient('mleczko kokosowe', 'coconut milk', 'coconut')]);
  record.substitutions = [milkAlternative, { ...milkAlternative, id: 'review', status: 'to_review', note: { pl: 'prywatna uwaga', en: 'private note' } }, { ...milkAlternative, id: 'orphan', ingredientId: 'removed' }];
  const original = structuredClone(record);
  const publicRecord = toPublicRecipe(record);
  assert.equal(publicRecord.substitutions?.length, 1);
  assert.ok(!JSON.stringify(publicRecord).includes('private note'));
  assert.ok(!JSON.stringify(publicRecord).includes('"provenance"'));
  const match = matchPantryRecipes([publicRecord], ['milk'])[0];
  assert.deepEqual(match.missing.map(item => item.id), ['coconut-milk']);
  assert.equal(match.alternatives.length, 1);
  assert.equal(formatSubstitutionAmount(milkAlternative, 4, 8, 'metric', 'pl'), '240 ml');
  assert.ok(formatSubstitutionAmount(milkAlternative, 4, 8, 'uk', 'en')?.endsWith('Imperial fl oz'));
  assert.equal(formatSubstitutionAmount({ ...milkAlternative, amount: undefined, unit: undefined }, 4, 8, 'metric', 'pl'), null);
  assert.deepEqual(record, original);
});

test('public API responses use only supplied published snapshots and bound invalid queries', () => {
  const published = [toPublicRecipe(sample('published', [ingredient('mleko', 'milk')]))];
  const result = recipeMatchesResponse(published, new URLSearchParams({ products: 'milk', locale: 'en' }));
  assert.deepEqual(result.matches.map(item => item.recipe.id), ['published']);
  assert.equal(result.matches[0].owned[0].name, 'Milk');
  assert.ok(!JSON.stringify(result).includes('provenance'));
  assert.deepEqual(recipeMatchesResponse([], new URLSearchParams({ products: 'milk' })).matches, []);
  assert.ok(ingredientCatalogResponse(published, new URLSearchParams({ q: 'mleko' })).products.some(item => item.id === 'milk'));
  assert.throws(() => recipeMatchesResponse(published, new URLSearchParams({ products: 'milk,milk' })), PantryQueryError);
  assert.throws(() => recipeMatchesResponse(published, new URLSearchParams({ products: Array.from({ length: 31 }, (_, i) => `p${i}`).join(',') })), PantryQueryError);
  assert.throws(() => ingredientCatalogResponse(published, new URLSearchParams({ q: 'a'.repeat(101) })), PantryQueryError);
  assert.throws(() => recipeMatchesResponse(published, new URLSearchParams({ locale: 'fr' })), PantryQueryError);
});

test('substitution ranges, fixed quantities and qualitative amounts scale without changing their meaning', () => {
  assert.equal(formatSubstitutionAmount({ ...milkAlternative, scaling: 'fixed' }, 4, 8, 'metric', 'pl'), '120 ml');
  assert.equal(formatSubstitutionAmount({ ...milkAlternative, scaling: undefined }, 4, 8, 'metric', 'pl'), '240 ml');
  assert.equal(formatSubstitutionAmount({ ...milkAlternative, amount: { kind: 'range', min: '100', max: '150' } }, 4, 8, 'metric', 'en'), '200–300 ml');
  const qualitative: IngredientSubstitution = { ...milkAlternative, amount: { kind: 'qualitative', text: { pl: 'do smaku', en: 'to taste' } }, unit: null };
  assert.equal(formatSubstitutionAmount(qualitative, 4, 8, 'uk', 'pl'), 'do smaku');
  assert.equal(formatSubstitutionAmount(qualitative, 4, 1, 'metric', 'en'), 'to taste');
  assert.equal(formatSubstitutionAmount({ ...milkAlternative, amount: { kind: 'exact', value: '28.4130625' } }, 4, 4, 'uk', 'en'), '1 Imperial fl oz');
});

test('local pantry storage validator recovers safely from malformed and oversized persisted values', () => {
  assert.equal(isPantryProducts(['milk', 'eggs']), true);
  for (const value of [null, {}, ['milk', 'milk'], ['a,b'], [123], [''], ['x'.repeat(601)], Array.from({ length: 31 }, (_, i) => `p${i}`)]) assert.equal(isPantryProducts(value), false);
});

test('popular badge expires exactly after 14 days and rejects invalid or future dates', () => {
  const now = Date.parse('2026-10-04T08:00:00Z');
  assert.equal(isPopularNow({ collection: 'trends', trendConfirmedAt: '2026-09-21T08:00:00Z' }, now), true);
  assert.equal(isPopularNow({ collection: 'trends', trendConfirmedAt: '2026-09-20T08:00:00Z' }, now), false);
  assert.equal(isPopularNow({ collection: 'trends', trendConfirmedAt: '2026-10-05T08:00:00Z' }, now), false);
  assert.equal(isPopularNow({ collection: 'trends', trendConfirmedAt: 'invalid' }, now), false);
  assert.equal(isPopularNow({ collection: 'author', trendConfirmedAt: '2026-10-04T08:00:00Z' }, now), false);
});
