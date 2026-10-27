import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRecipeShopping, combineShoppingLines, EMPTY_SHOPPING_SELECTION, formatShoppingAmount, isShoppingSelection, shoppingText } from './shopping';
import { recipes, type Ingredient, type IngredientSubstitution } from './recipes';
import { toPublicRecipe } from './recipe-presentation';

const ingredient = (id: string, pl = 'Mleko', en = 'Milk', amount: Ingredient['amount'] = { kind: 'exact', value: '100' }, unit: Ingredient['unit'] = 'ml', scaling: Ingredient['scaling'] = 'linear'): Ingredient => ({ id, name: { pl, en }, amount, unit, scaling, group: { pl: 'Składniki', en: 'Ingredients' } });
const recipe = (ingredients: Ingredient[], substitutions: IngredientSubstitution[] = []) => toPublicRecipe({ ...recipes[0], id: 'shopping', baseServings: 4, ingredients, substitutions });

test('shopping scales exact and range values from base quantities and preserves fixed and qualitative amounts', () => {
  const record = recipe([ingredient('milk'), ingredient('range', 'Mąka pszenna', 'Plain flour', { kind: 'range', min: '100', max: '150' }, 'g'), ingredient('fixed', 'Sól', 'Salt', { kind: 'exact', value: '1' }, 'tsp', 'fixed'), ingredient('taste', 'Pieprz', 'Black pepper', { kind: 'qualitative', text: { pl: 'do smaku', en: 'to taste' } }, null)]);
  const lines = buildRecipeShopping(record, 8, []);
  assert.deepEqual(lines[0].amount, { kind: 'exact', value: '200' });
  assert.deepEqual(lines[1].amount, { kind: 'range', min: '200', max: '300' });
  assert.deepEqual(lines[2].amount, { kind: 'exact', value: '1' });
  assert.equal(formatShoppingAmount(lines[3], 'pl'), 'do smaku');
  assert.equal(formatShoppingAmount(lines[0], 'en', 'uk').includes('Imperial fl oz'), true);
  assert.equal(record.ingredients[0].amount.kind === 'exact' && record.ingredients[0].amount.value, '100');
});

test('pantry has no quantities: separate owned products and allow an explicit buy-anyway override', () => {
  const record = recipe([ingredient('milk'), ingredient('milk2', 'Mleko krowie', 'Cow milk')]);
  const lines = buildRecipeShopping(record, 4, ['milk', 'literal:mleko|milk']);
  assert.equal(lines.every(line => line.owned && !line.included), true);
  assert.equal(combineShoppingLines(lines).length, 1);
  const overridden = buildRecipeShopping(record, 4, ['milk'], { ...EMPTY_SHOPPING_SELECTION, includeOwnedProductIds: ['milk'] });
  assert.equal(overridden.every(line => line.included), true);
  assert.equal(formatShoppingAmount(combineShoppingLines(overridden)[0], 'pl'), '200 ml');
});

test('optional ingredients are excluded until selected and pasta water is never a purchase', () => {
  const record = recipe([ingredient('main'), ingredient('optional', 'Bazylia (opcjonalnie)', 'Basil (optional)'), ingredient('water', 'Woda z gotowania makaronu', 'Pasta cooking water')]);
  const lines = buildRecipeShopping(record, 4, []);
  assert.deepEqual(lines.filter(line => line.included).map(line => line.ingredientId), ['main']);
  assert.equal(lines.some(line => line.ingredientId === 'water'), false);
  assert.equal(buildRecipeShopping(record, 4, [], { ...EMPTY_SHOPPING_SELECTION, optionalIngredientIds: ['optional'] }).filter(line => line.included).length, 2);
  const required = ingredient('required');
  required.note = { pl: 'Nie jest opcjonalny.', en: 'Not optional.' };
  assert.equal(buildRecipeShopping(recipe([required]), 4, [])[0].included, true);
});

test('a conscious approved alternative uses its own quantity, never the original quantity', () => {
  const alternative: IngredientSubstitution = { id: 'oat', ingredientId: 'milk', name: { pl: 'Napój owsiany', en: 'Oat milk' }, amount: { kind: 'exact', value: '120' }, unit: 'ml', note: { pl: 'Łagodniejszy smak.', en: 'Milder flavour.' }, status: 'approved' };
  const record = recipe([ingredient('milk')], [alternative, { ...alternative, id: 'unapproved', status: 'to_review' }]);
  assert.equal(buildRecipeShopping(record, 8, [])[0].productId, 'milk');
  const selected = { ...EMPTY_SHOPPING_SELECTION, substitutions: { milk: 'oat' } };
  const replaced = buildRecipeShopping(record, 8, ['oat-milk'], selected)[0];
  assert.equal(replaced.productId, 'oat-milk');
  assert.deepEqual(replaced.amount, { kind: 'exact', value: '240' });
  assert.equal(replaced.included, false);
  assert.equal(buildRecipeShopping(record, 8, [], { ...selected, substitutions: { milk: 'unapproved' } })[0].productId, 'milk');
  const unknown = recipe([ingredient('milk')], [{ ...alternative, amount: undefined, unit: undefined }]);
  const line = buildRecipeShopping(unknown, 8, [], selected)[0];
  assert.equal(line.amount.kind, 'qualitative');
  assert.equal(line.quantityKnown, false);
  assert.equal(formatShoppingAmount(line, 'en'), 'check the quantity needed');
});

test('aggregation adds exact values and ranges, converts spoon volume, and keeps mass, volume and count separate', () => {
  const record = recipe([ingredient('exact'), ingredient('range', 'Mleko', 'Milk', { kind: 'range', min: '20', max: '30' }), ingredient('mass', 'Mleko', 'Milk', { kind: 'exact', value: '50' }, 'g'), ingredient('spoon', 'Mleko', 'Milk', { kind: 'exact', value: '1' }, 'tbsp'), ingredient('count', 'Mleko', 'Milk', { kind: 'exact', value: '1' }, 'count')]);
  const items = combineShoppingLines(buildRecipeShopping(record, 4, []));
  assert.equal(items.length, 3);
  assert.deepEqual(items.find(item => item.unit === 'ml')?.amount, { kind: 'range', min: '135', max: '145' });
  assert.deepEqual(items.find(item => item.unit === 'g')?.amount, { kind: 'exact', value: '50' });
  assert.deepEqual(items.find(item => item.unit === 'count')?.amount, { kind: 'exact', value: '1' });
});

test('copy includes only supplied shopping selections; changed quantities invalidate checked keys', () => {
  const record = recipe([ingredient('milk'), ingredient('salt', 'Sól', 'Salt', { kind: 'qualitative', text: { pl: 'do smaku', en: 'to taste' } }, null)]);
  const list = combineShoppingLines(buildRecipeShopping(record, 4, ['salt']).filter(line => line.included));
  assert.equal(shoppingText(list, 'pl'), '☐ Mleko — 100 ml');
  const bigger = combineShoppingLines(buildRecipeShopping(record, 8, ['salt']).filter(line => line.included));
  assert.notEqual(list[0].id, bigger[0].id);
  assert.equal(isShoppingSelection({ ...EMPTY_SHOPPING_SELECTION, substitutions: [] }), false);
  assert.equal(isShoppingSelection({ ...EMPTY_SHOPPING_SELECTION, optionalIngredientIds: ['x', 'x'] }), false);
});

test('compound ingredients never duplicate a numeric amount as if each product needed the full dose', () => {
  const lines = buildRecipeShopping(recipe([ingredient('compound', 'Sól i pieprz', 'Salt and pepper', { kind: 'exact', value: '10' }, 'g')]), 4, ['salt']);
  assert.equal(lines.length, 2);
  assert.equal(lines.every(line => line.unit === null && line.amount.kind === 'qualitative'), true);
  assert.deepEqual(lines.filter(line => line.included).map(line => line.productId), ['black-pepper']);
});
