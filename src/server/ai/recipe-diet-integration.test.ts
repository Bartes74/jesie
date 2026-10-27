import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditorialContent } from '../../lib/editorial-types';
import { recipes, type Ingredient } from '../../lib/recipes';
import { buildRecipeProposal, legacyRecipeProposalSchema } from './recipe-proposal';
import { recipeDietVersion } from './recipe-diet-instructions';
import { ProviderError } from './provider-error';
import { responseRequest, responseRepairRequest } from './text-provider';
import { publicationIssues } from '../editorial/validation';
import { normalizeIngredientVerificationName } from '../../lib/ingredient-verification';

const ingredient = (id: string, pl: string, en: string): Ingredient => ({
  id, name: { pl, en }, amount: { kind: 'exact', value: '100' }, unit: 'g', scaling: 'linear',
  group: { pl: 'Składniki', en: 'Ingredients' },
});
function fixture(ingredients: Ingredient[]): EditorialContent {
  const recipe = structuredClone(recipes[0]);
  recipe.ingredients = ingredients;
  recipe.steps = [{ id: 'prepare', title: { pl: 'Przygotuj i podaj', en: 'Prepare and serve' },
    text: { pl: 'Przygotuj składniki według przepisu i podaj.', en: 'Prepare the ingredients according to the recipe and serve.' } }];
  delete recipe.diet;
  return { recipe, author: 'Redakcja', originalText: 'Zachowaj zamysł dania.', sources: [], photos: { ingredients: {}, steps: {} },
    aiPhotography: { recipeDietVersion } };
}
function rawProposal(input: EditorialContent) {
  const recipe = input.recipe;
  const raw = Object.fromEntries(Object.entries(recipe).filter(([key]) => key in legacyRecipeProposalSchema.shape));
  return legacyRecipeProposalSchema.parse({
    ...raw,
    ingredients: recipe.ingredients.map(item => ({ ...item, amount: { ...item.amount, approximate: false }, note: item.note ?? null })),
    steps: recipe.steps.map(item => ({ ...item, timerMinutes: item.timerMinutes ?? null })),
    scalingNote: recipe.scalingNote ?? null, substitutions: [], notes: [],
  });
}

test('new proposals derive one category from the base ingredients and ignore stale source labels', () => {
  for (const [diet, ingredients] of [
    ['vegan', [ingredient('carrot', 'marchew', 'carrot'), ingredient('coconut', 'mleczko kokosowe', 'coconut milk')]],
    ['vegetarian', [ingredient('carrot', 'marchew', 'carrot'), ingredient('milk', 'mleko', 'milk')]],
    ['meat', [ingredient('chicken', 'kurczak', 'chicken'), ingredient('carrot', 'marchew', 'carrot')]],
  ] as const) {
    const input = fixture([...ingredients]); input.recipe.diet = 'vegan';
    const raw = rawProposal(input), before = structuredClone(raw);
    const result = buildRecipeProposal(raw, input);
    assert.equal(result.content.recipe.diet, diet);
    assert.deepEqual(raw, before);
  }
});

test('an existing recipe response can use verified exact aliases without regenerating or correcting author text', () => {
  const input = fixture([ingredient('koji', 'Kōji', 'Koji')]);
  const raw = rawProposal(input), before = structuredClone(raw);
  assert.throws(() => buildRecipeProposal(raw, input), error => error instanceof ProviderError
    && error.issues.some(issue => issue.code === 'DIET_INGREDIENT_UNRECOGNISED'));
  const dictionary = new Map([[normalizeIngredientVerificationName('Kōji'), 'vegan' as const]]);
  const result = buildRecipeProposal(raw, input, dictionary);
  assert.equal(result.content.recipe.diet, 'vegan');
  assert.equal(result.content.originalText, input.originalText);
  assert.deepEqual(raw, before);
  assert.deepEqual(result.content.recipe.ingredients[0].name, input.recipe.ingredients[0].name);
  assert.equal(publicationIssues(result.content, undefined, undefined, dictionary).some(issue => issue.field === 'ingredients.koji.name'), false);
  assert.equal(publicationIssues(result.content).some(issue => issue.field === 'ingredients.koji.name'), true);
});

test('a selected vegan dish cannot be accepted with dairy or relabelled to meet a quota', () => {
  const input = fixture([ingredient('milk', 'mleko', 'milk')]);
  input.aiPhotography!.recipeDietTarget = 'vegan';
  assert.throws(() => buildRecipeProposal(rawProposal(input), input), error => error instanceof ProviderError
    && error.repairable && error.issues.some(issue => issue.field === 'diet'));
});

test('ambiguous base compounds require a precise formulation for new jobs', () => {
  const input = fixture([ingredient('stock', 'bulion', 'stock')]);
  assert.throws(() => buildRecipeProposal(rawProposal(input), input), error => error instanceof ProviderError
    && error.repairable && error.issues.some(issue => issue.field === 'ingredients.stock.name'
      && issue.code !== 'DIET_INGREDIENT_UNRECOGNISED'));
  input.recipe.ingredients[0].name = { pl: 'bulion warzywny', en: 'vegetable stock' };
  assert.equal(buildRecipeProposal(rawProposal(input), input).content.recipe.diet, 'vegan');
  delete input.aiPhotography;
  input.recipe.ingredients[0].name = { pl: 'bulion', en: 'stock' };
  assert.doesNotThrow(() => buildRecipeProposal(rawProposal(input), input));
});

test('strict generated proposals accept plain nori and chicory while preserving ingredient identity', () => {
  for (const [expectedDiet, ingredients] of [
    ['vegan', [ingredient('nori', 'arkusz nori', 'nori sheet')]],
    ['vegetarian', [ingredient('eggs', 'jajka ugotowane na twardo', 'hard-boiled eggs'), ingredient('nori', 'nori', 'nori')]],
    ['vegan', [ingredient('chicory_leaves', 'liście cykorii', 'chicory leaves')]],
  ] as const) {
    const input = fixture([...ingredients]);
    const raw = rawProposal(input), before = structuredClone(raw);
    const result = buildRecipeProposal(raw, input);
    assert.equal(result.content.recipe.diet, expectedDiet);
    assert.deepEqual(result.content.recipe.ingredients.map(item => ({ id: item.id, name: item.name })),
      ingredients.map(item => ({ id: item.id, name: item.name })));
    assert.deepEqual(raw, before);
  }
  const ambiguous = fixture([ingredient('nori', 'dashi z nori', 'nori dashi')]);
  assert.throws(() => buildRecipeProposal(rawProposal(ambiguous), ambiguous), error => error instanceof ProviderError
    && error.issues.some(issue => issue.field === 'ingredients.nori.name'));
  const withFish = fixture([ingredient('nori', 'nori z płatkami bonito', 'nori with bonito flakes')]);
  assert.equal(buildRecipeProposal(rawProposal(withFish), withFish).content.recipe.diet, 'meat');
});

test('generated Badrijani accepts its precisely named plant ingredients without rewriting them', () => {
  // Exact names retained in the third failed live response; this regression is offline.
  const ingredients = [
    ingredient('aubergine', 'świeży bakłażan (Solanum melongena)', 'fresh aubergine (Solanum melongena)'),
    ingredient('rapeseed_oil', 'olej rzepakowy', 'rapeseed oil'),
    ingredient('walnuts', 'łuskane orzechy włoskie', 'shelled walnuts'),
    ingredient('garlic', 'ząbki czosnku', 'garlic cloves'),
    ingredient('fresh_coriander', 'świeża kolendra', 'fresh coriander'),
    ingredient('blue_fenugreek', 'suszona mielona kozieradka błękitna (Trigonella caerulea), bez dodatków',
      'dried ground blue fenugreek (Trigonella caerulea), with no additions'),
    ingredient('marigold', 'suszone mielone płatki aksamitki (Tagetes), spożywcze, bez dodatków',
      'dried ground culinary marigold petals (Tagetes), with no additions'),
    ingredient('cumin', 'mielony kumin', 'ground cumin'),
    ingredient('cayenne', 'pieprz cayenne', 'cayenne pepper'),
    ingredient('water', 'woda', 'water'),
    ingredient('salt', 'sól', 'salt'),
    ingredient('black_pepper', 'świeżo mielony czarny pieprz', 'freshly ground black pepper'),
    ingredient('pomegranate', 'świeże pestki granatu', 'fresh pomegranate seeds'),
  ];
  const input = fixture(ingredients);
  input.recipe.title = { pl: 'Badrijani — roladki z bakłażana z pastą orzechową', en: 'Badrijani — aubergine rolls with walnut paste' };
  const raw = rawProposal(input), before = structuredClone(raw), sourceBefore = structuredClone(input);
  const result = buildRecipeProposal(raw, input);
  assert.equal(result.content.recipe.diet, 'vegan');
  assert.deepEqual(result.content.recipe.ingredients, before.ingredients.map(item => ({ ...item, note: item.note ?? undefined })));
  assert.deepEqual(raw, before);
  assert.deepEqual(input, sourceBefore);
});

test('an unsupported ingredient is a structured application knowledge gap rather than a paid model repair', () => {
  const input = fixture([ingredient('unknown', 'nieznany produkt xyloroot', 'unrecognised xyloroot')]);
  const raw = rawProposal(input), before = structuredClone(raw), sourceBefore = structuredClone(input);
  assert.throws(() => buildRecipeProposal(raw, input), error => error instanceof ProviderError
    && error.code === 'AI_RESULT_INVALID' && error.repairable === false
    && error.issues.some(issue => issue.field === 'ingredients.unknown.name' && issue.code === 'DIET_INGREDIENT_UNRECOGNISED'));
  assert.deepEqual(raw, before);
  assert.deepEqual(input, sourceBefore);
});

test('generation and correction use the same captured dietary policy without upgrading legacy jobs', () => {
  const input = fixture([ingredient('carrot', 'marchew', 'carrot')]);
  input.aiPhotography!.recipeDietTarget = 'vegan';
  const request = responseRequest('gpt-6-astra', input, 'Przygotuj danie.');
  const repair = responseRepairRequest('gpt-6-astra', input, 'Przygotuj danie.', 'resp_existing', [{ field: 'diet', message: 'Sprawdź skład.' }]);
  for (const value of [request, repair]) {
    assert.match(value.instructions, /selected for the vegan category/);
    assert.match(value.instructions, /Optional substitutions never change the base recipe/);
    assert.match(value.instructions, /Traditional Parmesan/);
  }
  assert.deepEqual(request.text.format.schema, repair.text.format.schema);
  delete input.aiPhotography;
  assert.doesNotMatch(responseRequest('gpt-6-astra', input, '').instructions, /BASE RECIPE DIET/);
});

test('publication checks also block a manually supplied incompatible or unresolved category', () => {
  const input = fixture([ingredient('milk', 'mleko', 'milk')]);
  input.recipe.diet = 'vegan';
  assert(publicationIssues(input).some(issue => issue.field === 'diet'));
  input.recipe.ingredients = [ingredient('stock', 'bulion', 'stock')];
  input.recipe.diet = 'meat';
  assert(publicationIssues(input).some(issue => issue.field === 'ingredients.stock.name'));
  input.recipe.ingredients[0].name = { pl: 'bulion warzywny', en: 'vegetable stock' };
  input.recipe.diet = 'vegan';
  assert(!publicationIssues(input).some(issue => issue.field === 'diet' || issue.field === 'ingredients.stock.name'));
});
