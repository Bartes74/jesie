import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRecipeDiet, getRecipeDiet, inspectRecipeDiet, recipeDiets, unrecognisedRecipeIngredientNames, type VerifiedIngredientDictionary } from './recipe-diet';
import { normalizeIngredientVerificationName } from './ingredient-verification';
import type { Ingredient, Recipe } from './recipes';

function ingredient(en: string, pl = en, note?: { pl: string; en: string }): Ingredient {
  return { id: en.replace(/[^a-z0-9]/gi, '-').slice(0, 80), name: { pl, en }, amount: { kind: 'exact', value: '1' },
    unit: 'g', scaling: 'linear', group: { pl: 'Składniki', en: 'Ingredients' }, note };
}
function recipe(...names: string[]): Pick<Recipe, 'ingredients'> {
  return { ingredients: names.map(name => ingredient(name)) };
}

test('three exclusive categories classify the base ingredients, without treating every nonmeat dish as vegan', () => {
  assert.deepEqual(recipeDiets.map(diet => diet.id), ['meat', 'vegetarian', 'vegan']);
  assert.equal(getRecipeDiet(recipe('potatoes', 'olive oil', 'salt')), 'vegan');
  assert.equal(getRecipeDiet(recipe('potatoes', 'eggs', 'butter')), 'vegetarian');
  assert.equal(getRecipeDiet(recipe('potatoes', 'chicken thigh')), 'meat');
  assert.equal(getRecipeDiet(recipe('plums', 'honey')), 'vegetarian');
});

test('meat category includes fish, seafood, meat stocks, fats, gelatin and animal rennet', () => {
  for (const name of ['sea bass', 'salmon', 'tuna', 'prawns', 'fish sauce', 'oyster sauce', 'chicken stock',
    'beef broth', 'pork lard', 'gelatin', 'gelatine', 'animal rennet', 'calf rennet', 'pepsin',
    'Łosoś', 'bulion drobiowy', 'żelatyna', 'podpuszczka zwierzęca', 'mielone mięso']) {
    const inspected = inspectRecipeDiet(recipe(name));
    assert.equal(inspected.inferredDiet, 'meat', name);
    assert.equal(inspected.uncertainIngredients.length, 0, name);
  }
});

test('named plant milks, creams, butters and vegan alternatives do not match animal product keywords', () => {
  for (const name of ['coconut milk', 'full-fat unsweetened coconut milk', 'oat milk', 'soy milk', 'almond milk',
    'coconut cream', 'vegan butter', 'plant-based mayonnaise', 'vegan cheese', 'peanut butter', 'almond butter',
    'apple butter', 'cocoa butter', 'milk of lime', 'milk thistle', 'eggplant', 'vegan sausage',
    'plant-based chicken', 'mleczko kokosowe', 'pełnotłuste mleczko kokosowe bez cukru', 'mleko owsiane',
    'masło orzechowe', 'masło jabłkowe', 'masło wegańskie', 'roślinne masło', 'butter beans', 'oyster mushrooms',
    'king oyster mushrooms', 'chicken of the woods', 'turkey tail mushrooms', "lamb's lettuce", 'beef tomatoes', 'białko grochu']) {
    assert.equal(getRecipeDiet(recipe(name)), 'vegan', name);
    assert.equal(inspectRecipeDiet(recipe(name)).uncertainIngredients.length, 0, name);
  }
});

test('a plant replacement cannot conceal another animal ingredient in the same base ingredient', () => {
  assert.equal(getRecipeDiet(recipe('coconut milk and whipping cream')), 'vegetarian');
  assert.equal(getRecipeDiet(recipe('peanut butter and honey')), 'vegetarian');
  assert.equal(getRecipeDiet(recipe('oat milk and eggs')), 'vegetarian');
  assert.equal(getRecipeDiet(recipe('vegetable stock and beef stock')), 'meat');
  assert.equal(getRecipeDiet(recipe('vegan chicken and bacon')), 'meat');
  assert.equal(getRecipeDiet(recipe('wegański kurczak i boczek')), 'meat');
  assert.equal(getRecipeDiet(recipe('plant-based sausage with dairy cream')), 'vegetarian');
  assert.equal(getRecipeDiet(recipe('vegan sausage')), 'vegan');
  assert.equal(getRecipeDiet(recipe('vegan Parmesan-style cheese with dairy cream')), 'vegetarian');
  assert.equal(getRecipeDiet(recipe('vegan chicken with Parmesan')), 'meat');
  assert.equal(inspectRecipeDiet(recipe('vegan chicken and unspecified cheese')).inferredDiet, null);
});

test('known traditional rennet cheeses are nonvegetarian; style cheeses require explicit suitable rennet', () => {
  for (const name of ['Parmesan', 'parmezan', 'Parmigiano Reggiano', 'Grana Padano', 'Pecorino Romano', 'Roquefort']) {
    assert.equal(inspectRecipeDiet(recipe(name)).inferredDiet, 'meat', name);
  }
  for (const name of ['Cheddar', 'burrata', 'feta', 'mozzarella', 'mature hard cheese', 'Parmesan-style hard cheese']) {
    assert.equal(inspectRecipeDiet(recipe(name)).inferredDiet, null, name);
    assert.equal(inspectRecipeDiet(recipe(name)).uncertainIngredients.length, 1, name);
    assert.equal(getRecipeDiet(recipe(name)), 'meat', name);
  }
  assert.equal(getRecipeDiet(recipe('hard cheese made with microbial rennet')), 'vegetarian');
  assert.equal(getRecipeDiet(recipe('ser z podpuszczką mikrobiologiczną')), 'vegetarian');
  assert.equal(getRecipeDiet(recipe('vegan Parmesan-style cheese')), 'vegan');
  for (const name of ['Parmesan', 'Parmigiano Reggiano']) assert.equal(getRecipeDiet({ ingredients: [ingredient(name, name, { pl: 'Użyj sera z podpuszczką mikrobiologiczną.', en: 'Use cheese made with microbial rennet.' })] }), 'meat');
  for (const name of ['ricotta', 'paneer', 'cottage cheese', 'cream cheese', 'mascarpone']) {
    assert.equal(getRecipeDiet(recipe(name)), 'vegetarian', name);
  }
});

test('optional substitutions and conditional notes do not change the base recipe category', () => {
  const dairy = ingredient('butter', 'masło', { pl: 'Możesz zastąpić masłem wegańskim.', en: 'You can replace with vegan butter.' });
  assert.equal(getRecipeDiet({ ingredients: [dairy] }), 'vegetarian');
  const cheese = ingredient('hard cheese', 'twardy ser', {
    pl: 'Dla wersji wegetariańskiej wybierz ser z podpuszczką mikrobiologiczną.',
    en: 'For a vegetarian version, choose cheese made with microbial rennet.',
  });
  assert.equal(inspectRecipeDiet({ ingredients: [cheese] }).inferredDiet, null);
  const requiredCheese = ingredient('hard cheese', 'twardy ser', {
    pl: 'Użyj sera z podpuszczką mikrobiologiczną.', en: 'Use cheese made with microbial rennet.',
  });
  assert.equal(getRecipeDiet({ ingredients: [requiredCheese] }), 'vegetarian');
  assert.equal(getRecipeDiet(recipe('cane sugar or honey')), 'vegetarian');
});

test('titles, old dietary tags and optional substitutions never override ingredient evidence', () => {
  const data = { ...recipe('chicken stock'), title: { pl: 'Wegańska zupa', en: 'Vegan soup' },
    dietaryTags: [{ id: 'vegan', status: 'to_review', label: { pl: 'Wegańskie', en: 'Vegan' } }],
    substitutions: [{ name: { pl: 'Bulion warzywny', en: 'Vegetable stock' } }] };
  assert.equal(getRecipeDiet(data), 'meat');
});

test('explicit base-composition notes count animal ingredients but optional replacements and trace warnings do not', () => {
  const withNote = (name: string, en: string) => ({ ingredients: [ingredient(name, name, { pl: '', en })] });
  assert.equal(getRecipeDiet(withNote('cream', 'Contains gelatin.')), 'meat');
  assert.equal(getRecipeDiet(withNote('hard cheese', 'Made with animal rennet.')), 'meat');
  assert.equal(getRecipeDiet(withNote('coconut milk', 'Contains whole milk.')), 'vegetarian');
  assert.equal(getRecipeDiet(withNote('coconut milk', 'May contain traces of milk.')), 'vegan');
  assert.equal(getRecipeDiet(withNote('vegetable stock', 'For an alternative, use stock made with chicken.')), 'vegan');
});

test('unknown ingredients and ambiguous compound products never silently become vegan or vegetarian', () => {
  for (const name of ['mystery seasoning', 'stock', 'broth', 'dashi', 'Worcestershire sauce', 'pesto',
    'margarine', 'gnocchi', 'red wine', 'kimchi', 'curry paste']) {
    const inspected = inspectRecipeDiet(recipe(name));
    assert.equal(inspected.inferredDiet, null, name);
    assert.equal(inspected.uncertainIngredients.length, 1, name);
    assert.equal(inspected.diet, 'meat', name);
  }
  assert.equal(inspectRecipeDiet(recipe()).inferredDiet, null);
  assert.equal(getRecipeDiet(recipe()), 'meat');
});

test('compound ingredient requirements resolve a base product without assuming all margarine or gnocchi is vegan', () => {
  const margarine = ingredient('margarine', 'margaryna', { pl: 'Wybierz produkt wegetariański na tłuszczach roślinnych.', en: 'Use a vegetarian product made with plant fats.' });
  assert.equal(inspectRecipeDiet({ ingredients: [margarine] }).inferredDiet, 'vegetarian');
  const gnocchi = ingredient('potato gnocchi', 'gnocchi ziemniaczane', { pl: 'Wybierz produkt wegetariański bez nadzienia.', en: 'Use vegetarian unfilled potato gnocchi.' });
  assert.equal(inspectRecipeDiet({ ingredients: [gnocchi] }).inferredDiet, 'vegetarian');
  const sauce = ingredient('Worcestershire sauce', 'sos Worcestershire', { pl: 'Użyj wyłącznie produktu wegańskiego.', en: 'Use only a vegan product.' });
  assert.equal(inspectRecipeDiet({ ingredients: [sauce] }).inferredDiet, 'vegan');
  const optional = ingredient('gnocchi', 'gnocchi', { pl: 'Dla wersji wegetariańskiej wybierz produkt wegetariański.', en: 'For a vegetarian version, choose vegetarian gnocchi.' });
  assert.equal(inspectRecipeDiet({ ingredients: [optional] }).inferredDiet, null);
});

test('recognised plant compounds remain vegan and plant textures do not create meat evidence', () => {
  for (const name of ['vegetable stock', 'lightly salted vegetable stock', 'bulion warzywny', 'soy sauce',
    'miso paste', 'pepper paste', 'curry powder', 'papryka mięsista', 'large, ripe, fleshy tomatoes',
    'chilli con carne spice blend', 'pasta cooking water', 'dried tagliatelle']) {
    assert.equal(inspectRecipeDiet(recipe(name)).inferredDiet, 'vegan', name);
  }
});

test('plain nori, sea vegetables and chicory are recognised without changing their recipe names', () => {
  const names = [
    ['nori', 'nori'],
    ['roasted nori sheets', 'prażone arkusze nori'],
    ['dried nori seaweed', 'suszone wodorosty nori'],
    ['seaweed', 'wodorosty'],
    ['algae', 'glony'],
    ['chicory', 'cykoria'],
    ['witloof', 'witloof'],
    ['endive', 'endywia'],
    ['fresh chicory leaves', 'świeże liście cykorii'],
    ['fresh witloof chicory leaves', 'świeża cykoria sałatowa (witloof), surowe liście'],
    ['Belgian endive leaves', 'liście endywii'],
  ];
  for (const [en, pl] of names) {
    const input = { ingredients: [ingredient(en, pl)] };
    const before = structuredClone(input);
    const inspected = inspectRecipeDiet(input);
    assert.equal(inspected.inferredDiet, 'vegan', en);
    assert.deepEqual(inspected.uncertainIngredients, [], en);
    assert.deepEqual(input, before);
  }
  const eggs = recipe('hard-boiled eggs', 'shiro miso', 'Japanese mayonnaise', 'soy sauce', 'nori', 'shichimi togarashi');
  assert.equal(inspectRecipeDiet(eggs).inferredDiet, 'vegetarian');
  assert.deepEqual(inspectRecipeDiet(eggs).uncertainIngredients, []);
});

test('recognised seaweed and chicory cannot conceal animal ingredients or unspecified compounds', () => {
  for (const [name, diet] of [
    ['nori with bonito flakes', 'meat'],
    ['nori z płatkami bonito', 'meat'],
    ['seaweed with fish sauce', 'meat'],
    ['nori with chicken', 'meat'],
    ['chicory leaves with bacon', 'meat'],
    ['endive with dairy cream', 'vegetarian'],
    ['nori with whole milk', 'vegetarian'],
  ] as const) {
    assert.equal(inspectRecipeDiet(recipe(name)).inferredDiet, diet, name);
  }
  for (const [note, diet] of [['Contains bonito flakes.', 'meat'], ['Contains whole milk.', 'vegetarian']] as const) {
    const input = { ingredients: [ingredient('nori', 'nori', { pl: '', en: note })] };
    assert.equal(inspectRecipeDiet(input).inferredDiet, diet, note);
  }
  for (const name of ['nori dashi', 'chicory sauce']) {
    const inspected = inspectRecipeDiet(recipe(name));
    assert.equal(inspected.inferredDiet, null, name);
    assert.equal(inspected.uncertainIngredients.length, 1, name);
  }
});

test('Badrijani plants are recognised in either language without rewriting the author ingredient names', () => {
  const names = [
    'aubergine', 'aubergines', 'large purple aubergine', 'bakłażan', 'plastry bakłażana', 'bakłażany',
    'blue fenugreek', 'ground blue fenugreek seeds', 'utskho-suneli', 'utskho suneli',
    'kozieradka błękitna', 'mielona kozieradka niebieska', 'nasiona niebieskiej kozieradki',
    'dried culinary marigold petals', 'ground marigold', 'Tagetes patula', 'maritsa',
    'suszona aksamitka', 'mielone płatki aksamitki', 'suszona mielona aksamitka (szafran imeretyński)',
  ];
  for (const name of names) {
    // Both fields use the same name so one translation cannot hide a missing alias.
    const input = recipe(name);
    const before = structuredClone(input);
    const inspected = inspectRecipeDiet(input);
    assert.equal(inspected.inferredDiet, 'vegan', name);
    assert.deepEqual(inspected.uncertainIngredients, [], name);
    assert.deepEqual(input, before);
  }
  const input = {
    ingredients: [
      ingredient('aubergine', 'bakłażan'), ingredient('rapeseed oil', 'olej rzepakowy'),
      ingredient('walnuts', 'orzechy włoskie'), ingredient('garlic', 'czosnek'),
      ingredient('coriander', 'kolendra'), ingredient('blue fenugreek', 'kozieradka błękitna'),
      ingredient('dried marigold petals', 'suszone płatki aksamitki'), ingredient('cumin', 'kumin'),
      ingredient('cayenne', 'cayenne'), ingredient('water', 'woda'), ingredient('salt', 'sól'),
      ingredient('black pepper', 'czarny pieprz'), ingredient('pomegranate arils', 'pestki granatu'),
    ],
  };
  assert.equal(inspectRecipeDiet(input).inferredDiet, 'vegan');
  assert.deepEqual(inspectRecipeDiet(input).uncertainIngredients, []);
});

test('ordinary produce and culinary herbs have bilingual aliases rather than depending on recipe IDs', () => {
  for (const name of [
    'leeks', 'pora', 'fennel', 'fenkuł', 'kohlrabi', 'kalarepa', 'artichokes', 'karczochy',
    'asparagus', 'szparagi', 'radishes', 'rzodkiewki', 'turnips', 'rzepa', 'swede', 'brukiew',
    'chard', 'boćwina', 'sorrel', 'szczaw', 'horseradish', 'chrzan', 'capers', 'kapary',
    'Brussels sprouts', 'brukselka', 'avocados', 'awokado', 'banana', 'banan', 'grapes', 'winogrona',
    'pineapple', 'ananas', 'grapefruit', 'grejpfrut', 'gooseberries', 'agrest', 'blackberries', 'jeżyny',
    'chives', 'szczypiorek', 'tarragon', 'estragon', 'caraway', 'nigella', 'czarnuszka',
    'juniper', 'jałowiec', 'lovage', 'lubczyk', 'wakame', 'kombu', 'agar-agar',
  ]) {
    const inspected = inspectRecipeDiet(recipe(name));
    assert.equal(inspected.inferredDiet, 'vegan', name);
    assert.deepEqual(inspected.uncertainIngredients, [], name);
  }
});

test('plant vocabulary additions preserve animal precedence and compound uncertainty', () => {
  for (const [name, diet] of [
    ['aubergine with bacon', 'meat'], ['bakłażan z boczkiem', 'meat'],
    ['blue fenugreek with fish stock', 'meat'], ['marigold with gelatin', 'meat'],
    ['marigold with honey', 'vegetarian'], ['aubergine with dairy cream', 'vegetarian'],
  ] as const) assert.equal(inspectRecipeDiet(recipe(name)).inferredDiet, diet, name);
  for (const name of ['aubergine sauce', 'fenugreek paste', 'marigold stock', 'sos z bakłażana']) {
    const inspected = inspectRecipeDiet(recipe(name));
    assert.equal(inspected.inferredDiet, null, name);
    assert.equal(inspected.uncertainIngredients[0]?.kind, 'ambiguous-composition', name);
  }
  const unknown = inspectRecipeDiet(recipe('unlisted mystery ingredient'));
  assert.equal(unknown.inferredDiet, null);
  assert.equal(unknown.uncertainIngredients[0]?.kind, 'unrecognised-ingredient');
  assert.equal(inspectRecipeDiet(recipe('unclassified hard cheese')).uncertainIngredients[0]?.kind, 'uncertain-rennet');
});

test('explicit reviewed categories cannot override clear animal conflicts; automatic classification ignores stale data', () => {
  const declaredVegan = { ...recipe('eggs'), diet: 'vegan' as const };
  assert.equal(getRecipeDiet(declaredVegan), 'vegetarian');
  assert.ok(inspectRecipeDiet(declaredVegan).issues.some(issue => issue.field === 'diet'));
  assert.equal(getRecipeDiet({ ...recipe('fish sauce'), diet: 'vegetarian' }), 'meat');
  assert.equal(getRecipeDiet({ ...recipe('potatoes'), diet: 'meat' }), 'meat');
  assert.equal(classifyRecipeDiet({ ...recipe('potatoes'), diet: 'meat' } as Pick<Recipe, 'ingredients'>), 'vegan');
});

test('verified exact ingredient aliases classify real unfamiliar foods without changing their spelling', () => {
  const dictionary: VerifiedIngredientDictionary = new Map([
    [normalizeIngredientVerificationName('Kōji'), 'vegan'],
    [normalizeIngredientVerificationName('Skyr'), 'vegetarian'],
    [normalizeIngredientVerificationName('Biltong'), 'meat'],
  ]);
  for (const [name, diet] of [['KŌJI', 'vegan'], ['Skyr', 'vegetarian'], ['Biltong', 'meat']] as const) {
    const input = recipe(name), before = structuredClone(input);
    assert.equal(inspectRecipeDiet(input, dictionary).inferredDiet, diet, name);
    assert.equal(classifyRecipeDiet(input, dictionary), diet, name);
    assert.deepEqual(input, before);
  }
  assert.equal(inspectRecipeDiet(recipe('koji'), dictionary).inferredDiet, 'vegan');
  assert.equal(inspectRecipeDiet(recipe('koji extra'), dictionary).inferredDiet, null);
  assert.equal(inspectRecipeDiet(recipe('koij'), dictionary).inferredDiet, null);
});

test('verified vegan aliases cannot hide meat, dairy, ambiguous composition or uncertain rennet', () => {
  for (const [name, expected] of [
    ['koji with bonito', 'meat'], ['koji with cream', 'vegetarian'],
    ['koji sauce', null], ['koji dashi', null], ['koji cheese', null],
  ] as const) {
    const dictionary: VerifiedIngredientDictionary = new Map([[normalizeIngredientVerificationName(name), 'vegan']]);
    const inspected = inspectRecipeDiet(recipe(name), dictionary);
    assert.equal(inspected.inferredDiet, expected, name);
    if (expected === null) assert.notEqual(inspected.uncertainIngredients[0]?.kind, 'unrecognised-ingredient');
  }
  const dictionary: VerifiedIngredientDictionary = new Map([['koji', 'vegan'], ['biltong', 'meat']]);
  for (const [note, expected] of [['Contains bonito.', 'meat'], ['Contains cream.', 'vegetarian']] as const) {
    assert.equal(inspectRecipeDiet({ ingredients: [ingredient('koji', 'koji', { pl: '', en: note })] }, dictionary).inferredDiet, expected);
  }
  assert.equal(inspectRecipeDiet({ ingredients: [ingredient('biltong', 'biltong', { pl: '', en: 'Contains cream.' })] }, dictionary).inferredDiet, 'meat');
  const conflictingTranslations = { ingredients: [ingredient('biltong', 'koji')] };
  assert.equal(inspectRecipeDiet(conflictingTranslations, dictionary).inferredDiet, 'meat');
});

test('dictionary candidates include unknown translations despite dairy notes and skip known ingredients and formulations', () => {
  assert.deepEqual(unrecognisedRecipeIngredientNames([
    ingredient('carrot', 'marchew'), ingredient('hard cheese', 'twardy ser'),
    ingredient('stock', 'bulion'), ingredient('biltong', 'biltong', { pl: '', en: 'Contains cream.' }),
    ingredient('koji', 'ryż'),
  ]), ['biltong', 'koji']);
});
