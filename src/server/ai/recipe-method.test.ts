import assert from 'node:assert/strict';
import test from 'node:test';
import type { z } from 'zod';
import type { EditorialContent } from '@/lib/editorial-types';
import { recipes, type Ingredient, type RecipeStep } from '@/lib/recipes';
import { renderStepText } from '@/lib/quantities';
import { buildRecipeProposal, capturedRecipeProposalSchema, legacyRecipeProposalSchema, normalizeRecipeProposal, recipeProposalVersion } from './recipe-proposal';
import { ProviderError } from './provider-error';
import { responseRequest, responseRepairRequest } from './text-provider';
import { maxStepTimerMinutes } from '../../lib/step-timer-policy';

type Proposal = z.infer<typeof legacyRecipeProposalSchema>;
const localised = (pl: string, en: string) => ({ pl, en });
const ingredient = (id: string, pl: string, en: string, value: string, unit: Ingredient['unit'] = 'g'): Ingredient => ({
  id, name: localised(pl, en), amount: { kind: 'exact', value }, unit, scaling: 'linear', group: localised('Składniki', 'Ingredients'),
});
const step = (id: string, plTitle: string, enTitle: string, pl: string, en: string, timerMinutes?: number): RecipeStep => ({
  id, title: localised(plTitle, enTitle), text: localised(pl, en), ...(timerMinutes === undefined ? {} : { timerMinutes }),
});

const simpleIngredients = [ingredient('cucumber', 'ogórek', 'cucumber', '300'), ingredient('yoghurt', 'jogurt naturalny', 'plain yoghurt', '150'), ingredient('salt', 'sól', 'salt', '1')];
const simpleMethod = [
  step('slice', 'Pokrój ogórek', 'Slice the cucumber',
    'Umyj {{cucumber}} ogórka, odetnij końce i pokrój w cienkie plasterki. Przejdź dalej, gdy plasterki mają zbliżoną grubość i nie zostały duże kawałki.',
    'Wash {{cucumber}} of cucumber, trim the ends and cut into thin slices. Continue when the slices have a similar thickness and no large pieces remain.'),
  step('dressing', 'Wymieszaj sos', 'Mix the dressing',
    'W misce wymieszaj {{yoghurt}} jogurtu z {{salt}} soli. Sos jest gotowy, gdy sól się rozpuści, a jogurt ma jednolitą konsystencję.',
    'Mix {{yoghurt}} of yoghurt with {{salt}} of salt in a bowl. The dressing is ready when the salt has dissolved and the yoghurt is uniform.'),
  step('serve', 'Połącz i podaj', 'Combine and serve',
    'Dodaj ogórek do sosu i delikatnie wymieszaj. Podaj od razu, gdy każdy plasterek jest cienko pokryty jogurtem; nie czekaj na zmięknięcie ogórka.',
    'Add the cucumber to the dressing and fold gently. Serve straight away when every slice is lightly coated with yoghurt; do not wait for the cucumber to soften.'),
];

const complexIngredients = [ingredient('flour', 'mąka pszenna', 'plain flour', '200'), ingredient('maslo_ciasta', 'masło', 'butter', '100'), ingredient('water', 'zimna woda', 'cold water', '20', 'ml'), ingredient('apples', 'jabłka', 'apples', '500'), ingredient('sugar', 'cukier', 'sugar', '80')];
const complexMethod = [
  step('weigh', 'Odmierz ciasto', 'Measure the pastry ingredients',
    'Wsyp {{flour}} mąki do miski i pokrój {{maslo_ciasta}} zimnego masła w kostkę. Wszystko jest gotowe do rozcierania, gdy masło nadal jest twarde i zimne.',
    'Put {{flour}} of flour in a bowl and dice {{maslo_ciasta}} of cold butter. Start rubbing in when the butter is still firm and cold.'),
  step('rub', 'Rozetrzyj masło', 'Rub in the butter',
    'Rozcieraj masło z mąką opuszkami palców. Zakończ, gdy masa przypomina grube okruchy; nie rozcieraj jej do gładkiej pasty.',
    'Rub the butter into the flour with your fingertips. Stop when it resembles coarse crumbs; do not work it into a smooth paste.'),
  step('bind', 'Połącz ciasto', 'Bring the pastry together',
    'Dodaj {{water}} zimnej wody i krótko zbierz ciasto dłonią. Przestań ugniatać, gdy trzyma się w jednym kawałku i nie ma suchej mąki.',
    'Add {{water}} of cold water and briefly gather the pastry by hand. Stop working it when it holds together and no dry flour remains.'),
  step('chlodzenie_ciasta', 'Schłodź ciasto', 'Chill the pastry',
    'Spłaszcz ciasto, owiń i włóż do lodówki. Od tego momentu chłodź przez 30 minut. Przejdź do wałkowania, gdy ciasto jest chłodne i sprężyste; jeśli nadal jest miękkie, chłodź jeszcze 10 minut.',
    'Flatten and wrap the pastry, then put it in the fridge. Chill for 30 minutes from this point. Roll it when it feels cool and firm; if it is still soft, chill for another 10 minutes.', 30),
  step('apples', 'Przygotuj jabłka', 'Prepare the apples',
    'Podczas chłodzenia ciasta obierz {{apples}} jabłek, usuń gniazda nasienne i pokrój miąższ w cienkie plasterki. Zakończ, gdy wszystkie twarde części są usunięte; ciasto nadal pozostaje w lodówce.',
    'While the pastry chills, peel {{apples}} of apples, remove the cores and thinly slice the flesh. Finish when all hard pieces are removed; keep the pastry in the fridge meanwhile.'),
  step('sweeten', 'Dopraw nadzienie', 'Sweeten the filling',
    'Wymieszaj jabłka z {{sugar}} cukru. Nadzienie jest gotowe do nakładania, gdy cukier jest równomiernie rozprowadzony; odstaw je do czasu przygotowania spodu.',
    'Mix the apples with {{sugar}} of sugar. The filling is ready when the sugar is evenly distributed; set it aside until the pastry base is ready.'),
  step('prepare_tin', 'Przygotuj formę', 'Prepare the tin',
    'Wyłóż dno formy papierem i rozgrzej piekarnik do 180°C. Zacznij wałkować dopiero po zakończeniu chłodzenia i sprawdzeniu twardości ciasta.',
    'Line the base of the tin and preheat the oven to 180°C. Start rolling only after the chilling time and a check that the pastry is firm.'),
  step('roll', 'Rozwałkuj ciasto', 'Roll the pastry',
    'Oddziel jedną trzecią ciasta na wierzch i pozostaw ją w lodówce. Resztę rozwałkuj na równy płat około 3 mm; zakończ, gdy nie ma grubych zgrubień.',
    'Reserve one third of the pastry for the top and keep it in the fridge. Roll the rest into an even sheet about 3 mm thick; finish when no thick ridges remain.'),
  step('assemble', 'Złóż ciasto', 'Assemble the pie',
    'Wyłóż formę rozwałkowanym spodem, nałóż całe nadzienie i przykryj zachowaną częścią ciasta. Zakończ, gdy jabłka są równo rozłożone i przykryte; zrób nacięcia dla pary.',
    'Line the tin with the rolled base, add all the filling and cover with the reserved pastry. Finish when the apples are evenly spread and covered; cut vents for steam.'),
  step('bake', 'Upiecz ciasto', 'Bake the pie',
    'Wstaw formę do piekarnika rozgrzanego do 180°C i od tego momentu piecz przez około 40 minut. Wyjmij, gdy wierzch jest złoty, a jabłka miękkie po nakłuciu. Jeśli są twarde lub ciasto blade, piecz jeszcze 5 minut i sprawdź ponownie.',
    'Put the tin in the oven preheated to 180°C and bake for about 40 minutes from this point. Remove it when the top is golden and the apples are tender when pierced. If they are hard or the pastry is pale, bake for another 5 minutes and check again.', 40),
  step('cool', 'Ostudź ciasto', 'Cool the pie',
    'Po wyjęciu ustaw formę na kratce i pozostaw na około 30 minut. Nie krój gorącego ciasta; przejdź dalej, gdy nadzienie przestanie wypływać przy delikatnym poruszeniu formą.',
    'After taking it out, put the tin on a rack for about 30 minutes. Do not cut the pie while hot; continue when the filling no longer runs as the tin is gently moved.'),
  step('podaj_ciasto', 'Pokrój i podaj', 'Slice and serve',
    'Oddziel brzeg od formy i pokrój przestudzone ciasto. Porcje są gotowe do podania, gdy spód podtrzymuje jabłka, a nadzienie zachowuje kształt.',
    'Release the edge from the tin and slice the cooled pie. The portions are ready to serve when the base supports the apples and the filling holds its shape.'),
];

function original(method: RecipeStep[], ingredients: Ingredient[], legacy = false): EditorialContent {
  const recipe = structuredClone(recipes[0]);
  recipe.id = 'method-fixture';
  recipe.ingredients = structuredClone(ingredients);
  recipe.steps = structuredClone(method);
  recipe.times = method === complexMethod ? { active: 30, cooking: 40, rest: 60, total: 130 } : { active: 10, cooking: 0, rest: 0, total: 10 };
  return { recipe, originalText: 'Zachowaj pełną metodę i oba niezależne oczekiwania.', author: 'Redakcja',
    sources: [{ id: 'editor-source', title: 'Notatki autora', url: 'https://example.invalid/method' }], photos: { ingredients: {}, steps: {} },
    ...(legacy ? {} : { aiPhotography: { recipeProposalVersion } }) };
}

// The provider fixture uses the same complete proposal shape as providers.test.ts.
function proposal(input: EditorialContent): Proposal {
  const recipe = input.recipe;
  return { slug: structuredClone(recipe.slug), title: structuredClone(recipe.title), description: structuredClone(recipe.description),
    primaryCategory: recipe.primaryCategory, categories: [...recipe.categories], difficulty: recipe.difficulty, cuisine: structuredClone(recipe.cuisine),
    baseServings: recipe.baseServings, times: { ...recipe.times },
    ingredients: recipe.ingredients.map(item => ({ ...structuredClone(item), note: item.note ?? null,
      amount: item.amount.kind === 'qualitative' ? item.amount : { ...item.amount, approximate: item.amount.approximate ?? false } })),
    steps: recipe.steps.map(item => ({ ...structuredClone(item), timerMinutes: item.timerMinutes ?? null })),
    equipment: structuredClone(recipe.equipment), tips: structuredClone(recipe.tips), storage: structuredClone(recipe.storage),
    scalingNote: recipe.scalingNote ?? null, notes: [], substitutions: [] };
}

function currentProposal(input: EditorialContent) {
  return { ...proposal(input), heroPresentation: { container: 'plate' as const,
    finalAppearance: localised('Gotowe porcje na talerzu.', 'Finished portions on a plate.'), evidenceStepIds: [input.recipe.steps.at(-1)!.id] } };
}

const methodSnapshot = (steps: Array<Pick<RecipeStep, 'id' | 'title' | 'text'> & { timerMinutes?: number | null }>) => steps.map(({ id, title, text, timerMinutes }) => ({ id, title, text, timerMinutes: timerMinutes ?? null }));
function assertMethod(content: EditorialContent, expected: RecipeStep[]) {
  assert.deepEqual(methodSnapshot(content.recipe.steps), methodSnapshot(expected), 'Every stage, language, transition, readiness cue and timer must remain intact.');
  for (const locale of ['pl', 'en'] as const) for (const actual of content.recipe.steps) {
    assert.deepEqual([...actual.text[locale].matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]),
      [...expected.find(item => item.id === actual.id)!.text[locale].matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]));
    assert.doesNotMatch(renderStepText(actual, content.recipe, content.recipe.baseServings, 'metric', locale), /\{\{/);
  }
}

test('a complete simple method remains three purposeful stages without padded steps', () => {
  const input = original(simpleMethod, simpleIngredients);
  const raw = currentProposal(input);
  const before = structuredClone(raw);
  const result = buildRecipeProposal(normalizeRecipeProposal(raw), input);
  assertMethod(result.content, simpleMethod);
  assert.deepEqual(result.content.sources, input.sources);
  assert.deepEqual(raw, before, 'Normalization and proposal building must not mutate their input.');
});

test('a twelve-stage method preserves separate waits, parallel preparation and each condition for moving on', () => {
  const input = original(complexMethod, complexIngredients);
  const result = buildRecipeProposal(currentProposal(input), input);
  assertMethod(result.content, complexMethod);
  assert.deepEqual(result.content.recipe.steps.filter(item => item.timerMinutes).map(item => [item.id, item.timerMinutes]), [['chlodzenie_ciasta', 30], ['bake', 40]]);
  assert.deepEqual(result.content.recipe.times, { active: 30, cooking: 40, rest: 60, total: 130 });
  for (const locale of ['pl', 'en'] as const) {
    for (const index of [3, 9]) assert.equal(renderStepText(result.content.recipe.steps[index], result.content.recipe, 4, 'metric', locale), complexMethod[index].text[locale], 'Timer start, readiness and further-check instructions must also reach the displayed method.');
    const renderedAmounts = renderStepText(result.content.recipe.steps[0], result.content.recipe, 8, 'metric', locale);
    assert.match(renderedAmounts, /400 g/);
    assert.match(renderedAmounts, /200 g/);
  }
});

test('representation repairs keep the full method and rewrite only unambiguous ingredient and stage references', () => {
  const input = original(complexMethod, complexIngredients);
  const raw = currentProposal(input);
  raw.slug.pl = ' Ciasto z jabłkami ';
  raw.ingredients[0].amount = { kind: 'exact', value: '199 2/2', approximate: false };
  raw.ingredients[1].id = ' masło ciasta ';
  raw.ingredients[1].amount = { kind: 'exact', value: ' 100,0 ', approximate: false };
  raw.steps[3].id = ' chłodzenie ciasta ';
  raw.steps[11].id = ' podaj ciasto ';
  raw.heroPresentation.evidenceStepIds = [' podaj ciasto '];
  for (const item of raw.steps) for (const locale of ['pl', 'en'] as const) item.text[locale] = ` ${item.text[locale].replaceAll('{{maslo_ciasta}}', '{{ masło ciasta }}')} `;
  const before = structuredClone(raw);
  const result = buildRecipeProposal(normalizeRecipeProposal(raw), input);
  assertMethod(result.content, complexMethod);
  assert.equal(result.content.recipe.slug.pl, 'ciasto-z-jablkami');
  assert.deepEqual(result.content.recipe.ingredients[0].amount, { kind: 'exact', value: '200', approximate: false });
  assert.deepEqual(result.content.recipe.ingredients[1].amount, { kind: 'exact', value: '100.0', approximate: false });
  assert.deepEqual(result.content.recipe.heroPresentation?.evidenceStepIds, ['podaj_ciasto']);
  assert.deepEqual(raw, before);
});

test('captured legacy proposals still accept both short and extended methods without new fields', () => {
  for (const [method, ingredients] of [[simpleMethod, simpleIngredients], [complexMethod, complexIngredients]] as const) {
    const input = original(method, ingredients, true);
    const raw = proposal(input);
    assert.equal(capturedRecipeProposalSchema(input).safeParse(raw).success, true);
    assert.equal('heroPresentation' in raw, false);
    const result = buildRecipeProposal(raw, input);
    assertMethod(result.content, method);
    assert.equal(result.content.recipe.heroPresentation, undefined);
  }
});

test('ambiguous stage identities are rejected rather than dropping a cooking stage to repair the representation', () => {
  const input = original(complexMethod, complexIngredients);
  const raw = currentProposal(input);
  raw.steps[4].id = raw.steps[3].id;
  const before = structuredClone(raw);
  assert.throws(() => buildRecipeProposal(raw, input), error => error instanceof ProviderError && error.code === 'AI_RESULT_INVALID' && error.issues.some(issue => issue.field.startsWith('steps.')));
  assert.equal((normalizeRecipeProposal(raw) as typeof raw).steps.length, complexMethod.length);
  assert.deepEqual(raw, before);
});

test('generation and correction distinguish numeric minutes from hour-based prose and overnight waits', () => {
  const input = original(complexMethod, complexIngredients);
  const generation = responseRequest('gpt-6-astra', input, 'Dopracuj przepis.');
  const correction = responseRepairRequest('gpt-6-astra', input, 'Dopracuj przepis.', 'resp_existing', [{ field: 'steps.chlodzenie_ciasta.timerMinutes', message: 'Usuń minutnik nocnego oczekiwania.' }]);
  for (const request of [generation, correction]) {
    assert.match(request.instructions, /structured numeric time fields in minutes/i);
    assert.match(request.instructions, /may legitimately exceed 1440 minutes/);
    assert.match(request.instructions, /90 minutes becomes "1 godz\. 30 min"/);
    assert.match(request.instructions, /overnight, full-day or multi-day wait.*timerMinutes null/);
    assert.match(request.instructions, /internal dependency timeline for one home cook/);
    assert.match(request.instructions, /maximum deadline for refrigeration is not a compulsory rest/);
    assert.match(request.instructions, /elapsed critical path from starting preparation to being ready to serve/);
    assert.match(request.instructions, /Never obtain total by blindly adding the three fields/);
    assert.match(request.instructions, new RegExp(`up to ${maxStepTimerMinutes} minutes`));
    assert.match(request.instructions, /4-hour chill/);
    assert.match(request.instructions, /never cap it at one day/);
  }
  assert.deepEqual(correction.text.format.schema, generation.text.format.schema);
});

test('an invalid new overnight timer returns a repairable field issue without shortening its method or totals', () => {
  const input = original(complexMethod, complexIngredients);
  const raw = currentProposal(input);
  raw.steps[3] = { ...raw.steps[3], title: localised('Schłodź przez noc', 'Chill overnight'),
    text: localised('Wstaw przykryte ciasto do lodówki i pozostaw na noc, do następnego dnia. Przejdź dalej, gdy jest zimne i zwarte.',
      'Refrigerate the covered pastry overnight, until the next day. Continue when it is cold and firm.'), timerMinutes: 180 };
  raw.times = { active: 30, cooking: 40, rest: 1440, total: 1510 };
  const before = structuredClone(raw);
  assert.throws(() => buildRecipeProposal(raw, input), failure => failure instanceof ProviderError && failure.code === 'AI_RESULT_INVALID'
    && failure.issues.some(issue => issue.field === 'steps.chlodzenie_ciasta.timerMinutes' && /null/.test(issue.message) && /rest i total/.test(issue.message)));
  assert.deepEqual(raw, before);
  raw.steps[3].timerMinutes = null;
  const accepted = buildRecipeProposal(raw, input).content;
  assert.deepEqual(accepted.recipe.times, { active: 30, cooking: 40, rest: 1440, total: 1510 });
  assert.deepEqual(accepted.recipe.steps[3].text, raw.steps[3].text);
  assert.equal(accepted.recipe.steps[3].timerMinutes, undefined);
  assert.equal(accepted.recipe.steps[9].timerMinutes, 40);
});

test('a four-hour chill remains a useful timer while full-day numeric totals and captured schema stay intact', () => {
  const input = original(complexMethod, complexIngredients), raw = currentProposal(input);
  raw.steps[3] = { ...raw.steps[3], title: localised('Schłodź ciasto', 'Chill the pastry'),
    text: localised('Wstaw przykryte ciasto do lodówki i od tego momentu chłodź przez 4 godziny, aż jest zimne i zwarte.',
      'Refrigerate the covered pastry and chill for 4 hours from this point, until cold and firm.'), timerMinutes: 240 };
  raw.times = { active: 30, cooking: 40, rest: 240, total: 310 };
  const accepted = buildRecipeProposal(raw, input).content;
  assert.equal(accepted.recipe.steps[3].timerMinutes, 240);
  raw.steps[3].timerMinutes = maxStepTimerMinutes + 1;
  assert.equal(capturedRecipeProposalSchema(input).safeParse(raw).success, true, 'Captured numeric schemas remain readable; new result policy reports unsupported timers separately.');
  assert.throws(() => buildRecipeProposal(raw, input), failure => failure instanceof ProviderError && failure.issues.some(issue => issue.field === 'steps.chlodzenie_ciasta.timerMinutes'));
  raw.steps[3].timerMinutes = null;
  raw.times = { active: 30, cooking: 40, rest: 2880, total: 2950 };
  const longWait = buildRecipeProposal(raw, input).content;
  assert.deepEqual(longWait.recipe.times, raw.times);
});
