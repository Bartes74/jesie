import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { Recipe, RecipeStep } from './recipes';
import { inspectRecipeTimingPlan, recipeTimingPlanSchema, recipeTimingVersion, type RecipeTimingPlan } from './recipe-timing-plan';

const step = (id: string): RecipeStep => ({ id, title: { pl: id, en: id }, text: { pl: 'Przygotuj zgodnie z instrukcją.', en: 'Prepare as instructed.' } });
const recipe = (): Pick<Recipe, 'steps' | 'times'> => ({
  steps: [step('prepare'), { ...step('cook'), timerMinutes: 20 }, { ...step('rest'), timerMinutes: 30 }, step('serve')],
  times: { active: 20, cooking: 20, rest: 30, total: 65 },
});
const plan = (): RecipeTimingPlan => ({
  resources: ['pot', 'board'], assumptions: ['Jedna osoba i wymieniony sprzęt; składniki w ilości bazowej.'], excludedSteps: [],
  tasks: [
    { id: 'prepare', stepId: 'prepare', label: 'Przygotowanie', kind: 'prep', startMinute: 0, durationMinutes: 10, dependsOn: [], attendsToTaskId: null, handsOn: true, resources: ['board'] },
    { id: 'cook', stepId: 'cook', label: 'Gotowanie pod pokrywką', kind: 'cooking', startMinute: 10, durationMinutes: 20, dependsOn: ['prepare'], attendsToTaskId: null, handsOn: false, resources: ['pot'] },
    { id: 'garnish', stepId: 'prepare', label: 'Przygotowanie dodatków podczas gotowania', kind: 'prep', startMinute: 10, durationMinutes: 5, dependsOn: ['prepare'], attendsToTaskId: null, handsOn: true, resources: ['board'] },
    { id: 'rest', stepId: 'rest', label: 'Odpoczynek', kind: 'rest', startMinute: 30, durationMinutes: 30, dependsOn: ['cook'], attendsToTaskId: null, handsOn: false, resources: ['pot'] },
    { id: 'serve', stepId: 'serve', label: 'Podanie', kind: 'prep', startMinute: 60, durationMinutes: 5, dependsOn: ['rest', 'garnish'], attendsToTaskId: null, handsOn: true, resources: ['pot', 'board'] },
  ],
});
const rejects = (input: unknown, target = recipe(), field?: string) => {
  const result = inspectRecipeTimingPlan(input, target);
  assert.equal(result.times, null);
  assert(result.issues.length > 0);
  if (field) assert(result.issues.some(issue => issue.field.includes(field)), JSON.stringify(result.issues));
  return result;
};

test('timing contract exports plain strict JSON Schema without transformation', () => {
  assert.equal(recipeTimingVersion, 'dependency-timing-v1');
  const schema = z.toJSONSchema(recipeTimingPlanSchema);
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert(recipeTimingPlanSchema.safeParse(plan()).success);
  assert(!recipeTimingPlanSchema.safeParse({ ...plan(), unexpected: true }).success);
});

test('one cook can prepare a garnish during passive cooking and all times derive from unions', () => {
  const input = plan(), target = recipe(), original = structuredClone({ input, target });
  assert.deepEqual(inspectRecipeTimingPlan(input, target), { issues: [], times: target.times });
  input.tasks.reverse();
  assert.deepEqual(inspectRecipeTimingPlan(input, target), { issues: [], times: target.times });
  input.tasks.reverse();
  assert.deepEqual({ input, target }, original);
});

test('hands-on cooking belongs to both active and cooking without requiring a second cook', () => {
  const input = plan(), target = recipe();
  input.tasks[1].handsOn = true;
  input.tasks[2].startMinute = 30;
  target.times.active = 40;
  assert.deepEqual(inspectRecipeTimingPlan(input, target), { issues: [], times: target.times });
});

test('overlapping hands-on tasks reject even with different equipment', () => {
  const input = plan(); input.tasks[1].handsOn = true;
  const result = rejects(input, recipe(), 'startMinute');
  assert(result.issues.some(issue => issue.message.includes('Jedna osoba')));
});

test('every simultaneous exclusive resource is checked, including a second claim', () => {
  const input = plan(); input.tasks[2].resources.push('pot');
  assert(rejects(input).issues.some(issue => issue.message.includes('Zasób pot')));
  const okay = plan(); okay.tasks[2].resources = ['board'];
  assert.deepEqual(inspectRecipeTimingPlan(okay, recipe()).issues, []);
});

test('concurrent cooking and concurrent rest each count elapsed union only once', () => {
  const input = plan();
  input.resources.push('pan');
  input.tasks.push({ ...input.tasks[1], id: 'second_pan', durationMinutes: 15, resources: ['pan'] });
  input.tasks.push({ ...input.tasks[3], id: 'second_rest', startMinute: 45, durationMinutes: 15, resources: [] });
  assert.deepEqual(inspectRecipeTimingPlan(input, recipe()), { issues: [], times: recipe().times });
});

test('equipment preheating can be passive prep and does not inflate active or food cooking', () => {
  const input = plan(); input.resources.push('oven');
  input.tasks.push({ id: 'preheat', stepId: 'prepare', label: 'Nagrzewanie pustego piekarnika', kind: 'prep', startMinute: 0, durationMinutes: 10, dependsOn: [], attendsToTaskId: null, handsOn: false, resources: ['oven'] });
  assert.deepEqual(inspectRecipeTimingPlan(input, recipe()), { issues: [], times: recipe().times });
});

test('passive waiting accounts for idle hands but unexplained initial and internal gaps reject', () => {
  assert.deepEqual(inspectRecipeTimingPlan(plan(), recipe()).issues, []);
  const initial = plan(); initial.tasks.forEach(task => { task.startMinute += 1; });
  assert(rejects(initial).issues.some(issue => issue.message.includes('lukę')));
  const internal = plan(), target = recipe();
  internal.tasks[3].startMinute = 31; internal.tasks[3].durationMinutes = 29;
  delete target.steps[2].timerMinutes;
  assert(rejects(internal, target).issues.some(issue => issue.message.includes('lukę')));
});

test('dependency endpoints may touch, but prerequisites must finish first', () => {
  assert.deepEqual(inspectRecipeTimingPlan(plan(), recipe()).issues, []);
  const input = plan(); input.tasks[1].startMinute = 9;
  assert(rejects(input).issues.some(issue => issue.message.includes('przed zakończeniem')));
});

test('unknown references, duplicate IDs and dependency cycles are rejected', () => {
  for (const mutate of [
    (input: RecipeTimingPlan) => { input.tasks[0].dependsOn = ['missing']; },
    (input: RecipeTimingPlan) => { input.tasks[0].dependsOn = ['prepare']; },
    (input: RecipeTimingPlan) => { input.tasks[0].dependsOn = ['serve']; },
    (input: RecipeTimingPlan) => { input.tasks[1].id = input.tasks[0].id; },
    (input: RecipeTimingPlan) => { input.tasks[0].stepId = 'missing_step'; },
    (input: RecipeTimingPlan) => { input.tasks[0].resources = ['missing_resource']; },
    (input: RecipeTimingPlan) => { input.resources.push('pot'); },
    (input: RecipeTimingPlan) => { input.tasks[0].resources.push('board'); },
    (input: RecipeTimingPlan) => { input.tasks[4].dependsOn.push('rest'); },
  ]) { const input = plan(); mutate(input); rejects(input); }
  const cycle = plan(); cycle.tasks[0].dependsOn = ['serve'];
  assert(rejects(cycle).issues.some(issue => issue.message.includes('cykl')));
});

test('invalid times, ASCII references, limits and hands-on rests reject', () => {
  for (const value of [-1, NaN, Infinity, 100_001]) { const input = plan(); input.tasks[0].startMinute = value; rejects(input); }
  for (const value of [0, -1, NaN, Infinity, 100_001]) { const input = plan(); input.tasks[0].durationMinutes = value; rejects(input); }
  const end = plan(); end.tasks[0].startMinute = 99_990; end.tasks[0].durationMinutes = 20; rejects(end, recipe(), 'durationMinutes');
  const nonAscii = plan(); nonAscii.tasks[0].id = 'żółć'; rejects(nonAscii);
  const blank = plan(); blank.assumptions = ['   ']; rejects(blank);
  const blankLabel = plan(); blankLabel.tasks[0].label = '  '; rejects(blankLabel);
  const rest = plan(); rest.tasks[3].handsOn = true; rejects(rest, recipe(), 'handsOn');
  const oversized = plan(); oversized.tasks = Array.from({ length: 301 }, () => oversized.tasks[0]); rejects(oversized, recipe(), 'tasks');
});

test('every step needs timing coverage or an explicit optional-variant exclusion', () => {
  const target = recipe(); target.steps.push(step('forgotten')); rejects(plan(), target, 'tasks');
  for (const text of [
    { title: { pl: 'Wariant ubity: schłodź', en: 'Whipped version' }, text: { pl: 'Schłodź dodatkowo.', en: 'Chill further.' } },
    { title: { pl: 'Schłodź', en: 'Chill' }, text: { pl: 'Wyłącznie do wersji ubitej: schłodź.', en: 'Only for the whipped version: chill.' } },
  ]) {
    const input = plan(), optional = recipe();
    optional.steps.push({ id: 'optional_chill', ...text });
    input.excludedSteps.push({ stepId: 'optional_chill', reason: 'Oddzielny, opcjonalny wariant ubity.' });
    assert.deepEqual(inspectRecipeTimingPlan(input, optional).issues, []);
  }
  const mandatory = recipe(), input = plan();
  mandatory.steps.push({ id: 'day_wait', title: { pl: 'Schłodź', en: 'Chill' }, text: { pl: 'Chłodź przez 24 godziny przed podaniem.', en: 'Chill for 24 hours before serving.' } });
  input.excludedSteps.push({ stepId: 'day_wait', reason: 'Chcę krótszy total.' });
  rejects(input, mandatory, 'excludedSteps');
});

test('optional exclusions cannot name unknown, duplicate or already-covered steps', () => {
  const unknown = plan(); unknown.excludedSteps.push({ stepId: 'missing', reason: 'Wariant.' }); rejects(unknown);
  const target = recipe(), covered = plan(); target.steps[0].title.pl = 'Opcjonalna dekoracja';
  covered.excludedSteps.push({ stepId: 'prepare', reason: 'Opcjonalnie.' }); rejects(covered, target);
  const duplicated = plan(), optional = recipe(); optional.steps.push({ ...step('extra'), title: { pl: 'Wariant dodatkowy', en: 'Optional variant' } });
  duplicated.excludedSteps = [{ stepId: 'extra', reason: 'Wariant.' }, { stepId: 'extra', reason: 'Wariant.' }]; rejects(duplicated, optional);
});

test('negated optional markers and contradictory languages cannot exclude mandatory steps', () => {
  for (const title of [
    { pl: 'Nieopcjonalny wariant', en: 'Chill' },
    { pl: 'Nie jest to opcjonalne chłodzenie', en: 'Chill' },
    { pl: 'Chłodzenie', en: 'Not an optional variant' },
    { pl: 'Chłodzenie', en: 'Nonoptional variant' },
    { pl: 'Wariant opcjonalny', en: 'This is not optional' },
  ]) {
    const input = plan(), target = recipe();
    target.steps.push({ ...step('mandatory'), title });
    input.excludedSteps.push({ stepId: 'mandatory', reason: 'Pominięcie.' });
    rejects(input, target, 'excludedSteps');
  }
  const input = plan(), target = recipe();
  target.steps.push({ ...step('mandatory'), title: { pl: 'Wariant', en: 'Variant' }, text: { pl: 'To nie jest opcjonalny postój.', en: 'This is not optional.' } });
  input.excludedSteps.push({ stepId: 'mandatory', reason: 'Pominięcie.' });
  rejects(input, target, 'excludedSteps');
});

test('a base or default variant cannot hide mandatory cooling behind a variant marker', () => {
  for (const title of [
    { pl: 'Wariant podstawowy: schłodź tort', en: 'Base variant: chill the cake' },
    { pl: 'Podstawowy wariant chłodzenia', en: 'Default variant' },
    { pl: 'Wariant bazowy', en: 'Main variant' },
  ]) {
    const input = plan(), target = recipe();
    target.steps.push({ ...step('mandatory_cool'), title, text: { pl: 'Chłodź 4 godziny przed podaniem.', en: 'Chill for 4 hours before serving.' } });
    input.excludedSteps.push({ stepId: 'mandatory_cool', reason: 'Pominięty wariant.' });
    rejects(input, target, 'excludedSteps');
  }
});

test('a continuous timer needs one full task interval rather than a sum of shorter tasks', () => {
  const input = plan(); input.tasks[3].durationMinutes = 15;
  input.tasks.push({ ...input.tasks[3], id: 'rest_second', startMinute: 45, dependsOn: ['rest'] });
  input.tasks[4].dependsOn.push('rest_second');
  assert(rejects(input).issues.some(issue => issue.message.includes('ciągły minutnik')));
});

test('unambiguous bake and chill timers require a full interval in the matching category', () => {
  for (const example of [
    { title: { pl: 'Piecz ciasto', en: 'Bake the cake' }, minutes: 60, wrong: 'prep', correct: 'cooking' },
    { title: { pl: 'Schłodź krem', en: 'Chill the cream' }, minutes: 20, wrong: 'cooking', correct: 'rest' },
  ] as const) {
    const target = { steps: [{ ...step('stage'), title: example.title, timerMinutes: example.minutes }], times: { active: 0, cooking: 0, rest: 0, total: example.minutes } };
    const input: RecipeTimingPlan = { resources: ['equipment'], assumptions: ['Jeden ciągły etap.'], excludedSteps: [], tasks: [
      { id: 'stage', stepId: 'stage', label: 'Etap', kind: example.wrong, startMinute: 0, durationMinutes: example.minutes, dependsOn: [], attendsToTaskId: null, handsOn: false, resources: ['equipment'] },
    ] };
    rejects(input, target);
    input.tasks[0].kind = example.correct;
    target.times[example.correct] = example.minutes;
    assert.deepEqual(inspectRecipeTimingPlan(input, target), { issues: [], times: target.times });
  }
});

test('mixed or unknown timer titles do not invent a thermal or waiting classification', () => {
  for (const title of [
    { pl: 'Przygotuj', en: 'Prepare' },
    { pl: 'Podgrzej i odstaw', en: 'Cook and rest' },
  ]) {
    const target = { steps: [{ ...step('stage'), title, timerMinutes: 5 }], times: { active: 5, cooking: 0, rest: 0, total: 5 } };
    const input: RecipeTimingPlan = { resources: [], assumptions: ['Rodzaj czynności nie wynika jednoznacznie z tytułu.'], excludedSteps: [], tasks: [
      { id: 'stage', stepId: 'stage', label: 'Czynność ręczna', kind: 'prep', startMinute: 0, durationMinutes: 5, dependsOn: [], attendsToTaskId: null, handsOn: true, resources: [] },
    ] };
    assert.deepEqual(inspectRecipeTimingPlan(input, target), { issues: [], times: target.times });
  }
});

test('mandatory day-long rest is neither capped nor turned into a short timer', () => {
  const input = plan(), target = recipe();
  input.tasks[3].durationMinutes = 1440; input.tasks[4].startMinute = 1470;
  delete target.steps[2].timerMinutes;
  target.times = { active: 20, cooking: 20, rest: 1440, total: 1475 };
  assert.deepEqual(inspectRecipeTimingPlan(input, target), { issues: [], times: target.times });
});

test('rounding happens up to whole minutes once per final union, never per task', () => {
  const target = { steps: [step('prepare')], times: { active: 3, cooking: 0, rest: 0, total: 3 } };
  const input: RecipeTimingPlan = { resources: [], assumptions: ['Dwa kolejne krótkie zadania ręczne.'], excludedSteps: [], tasks: [
    { id: 'one', stepId: 'prepare', label: 'Pierwsze', kind: 'prep', startMinute: 0, durationMinutes: 1.1, dependsOn: [], attendsToTaskId: null, handsOn: true, resources: [] },
    { id: 'two', stepId: 'prepare', label: 'Drugie', kind: 'prep', startMinute: 1.1, durationMinutes: 1.1, dependsOn: ['one'], attendsToTaskId: null, handsOn: true, resources: [] },
  ] };
  assert.deepEqual(inspectRecipeTimingPlan(input, target), { issues: [], times: target.times });
  target.times.active = 2; target.times.total = 2;
  const mismatch = inspectRecipeTimingPlan(input, target);
  assert.equal(mismatch.times?.active, 3); assert.equal(mismatch.times?.total, 3);
  assert.deepEqual(mismatch.issues.map(issue => issue.field), ['times.active', 'times.total']);
});

test('IEEE fraction accumulation does not create an extra minute, but genuine 0.01 minute does', () => {
  const target = { steps: [step('prepare')], times: { active: 3, cooking: 0, rest: 0, total: 3 } };
  const input: RecipeTimingPlan = { resources: [], assumptions: ['Kolejne krótkie czynności.'], excludedSteps: [], tasks: Array.from({ length: 30 }, (_, index) => ({
    id: `task_${index}`, stepId: 'prepare', label: 'Krótka czynność', kind: 'prep', startMinute: index * 0.1, durationMinutes: 0.1,
    dependsOn: index === 0 ? [] : [`task_${index - 1}`], attendsToTaskId: null, handsOn: true, resources: [],
  })) };
  assert.deepEqual(inspectRecipeTimingPlan(input, target), { issues: [], times: target.times });
  input.tasks[29].durationMinutes += 0.01;
  target.times = { active: 4, cooking: 0, rest: 0, total: 4 };
  assert.deepEqual(inspectRecipeTimingPlan(input, target), { issues: [], times: target.times });
});

test('disjoint fractional hands-on intervals use one stable final ceil', () => {
  const target = { steps: [step('prepare')], times: { active: 1, cooking: 0, rest: 1, total: 2 } };
  const input: RecipeTimingPlan = { resources: [], assumptions: ['Krótkie czynności w oknie odpoczynku.'], excludedSteps: [], tasks: [
    { id: 'wait', stepId: 'prepare', label: 'Postój', kind: 'rest', startMinute: 0, durationMinutes: 1, dependsOn: [], attendsToTaskId: null, handsOn: false, resources: [] },
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `task_${index}`, stepId: 'prepare', label: 'Krótka czynność', kind: 'prep' as const, startMinute: index * 0.2, durationMinutes: 0.1,
      dependsOn: [], attendsToTaskId: null, handsOn: true, resources: [],
    })),
    { id: 'fill_wait', stepId: 'prepare', label: 'Dalszy postój', kind: 'rest', startMinute: 1, durationMinutes: 1, dependsOn: ['wait'], attendsToTaskId: null, handsOn: false, resources: [] },
  ] };
  target.times.rest = 2;
  assert.deepEqual(inspectRecipeTimingPlan(input, target), { issues: [], times: target.times });
  input.tasks.find(task => task.id === 'task_9')!.durationMinutes += 0.01;
  target.times.active = 2;
  assert.deepEqual(inspectRecipeTimingPlan(input, target), { issues: [], times: target.times });
});

test('old four-number durations do not silently become a structured timing plan', () => {
  rejects(undefined);
  rejects(recipe().times);
  const mismatch = recipe(); mismatch.times.total = 64;
  const result = inspectRecipeTimingPlan(plan(), mismatch);
  assert.deepEqual(result.times, recipe().times);
  assert.deepEqual(result.issues.map(issue => issue.field), ['times.total']);
});

const attendedCooking = (): { input: RecipeTimingPlan; target: Pick<Recipe, 'steps' | 'times'> } => ({
  input: {
    resources: ['pan', 'board'], assumptions: ['Jeden bierny proces i krótkie mieszanie tej samej potrawy.'], excludedSteps: [], tasks: [
      { id: 'simmer', stepId: 'cook', label: 'Gotowanie z okresowym mieszaniem', kind: 'cooking', startMinute: 0, durationMinutes: 30, dependsOn: [], attendsToTaskId: null, handsOn: false, resources: ['pan'] },
      { id: 'stir', stepId: 'cook', label: 'Zamieszanie tej samej potrawy', kind: 'cooking', startMinute: 10, durationMinutes: 1, dependsOn: [], attendsToTaskId: 'simmer', handsOn: true, resources: ['pan'] },
    ],
  },
  target: { steps: [{ ...step('cook'), title: { pl: 'Gotuj sos', en: 'Simmer the sauce' }, timerMinutes: 30 }], times: { active: 1, cooking: 30, rest: 0, total: 30 } },
});

test('periodic hands-on stirring can attend a continuous timed process in the same pan', () => {
  const { input, target } = attendedCooking();
  assert.deepEqual(inspectRecipeTimingPlan(input, target), { issues: [], times: target.times });
  input.tasks.push({ ...input.tasks[1], id: 'stir_again', startMinute: 20 });
  target.times.active = 2;
  assert.deepEqual(inspectRecipeTimingPlan(input, target), { issues: [], times: target.times });
  // Declaring the running process as a completion dependency is still invalid.
  input.tasks[1].dependsOn = ['simmer'];
  rejects(input, target, 'startMinute');
});

test('a short prep action can attend passive cooling without counting as additional rest', () => {
  const { input, target } = attendedCooking();
  input.tasks[0].kind = 'rest'; input.tasks[1].kind = 'prep';
  target.steps[0].title = { pl: 'Schłodź', en: 'Chill' };
  target.times = { active: 1, cooking: 0, rest: 30, total: 30 };
  assert.deepEqual(inspectRecipeTimingPlan(input, target), { issues: [], times: target.times });
});

test('attendance requires a direct passive host, a hands-on child and full containment in the same step', () => {
  for (const mutate of [
    (input: RecipeTimingPlan) => { input.tasks[1].attendsToTaskId = 'missing'; },
    (input: RecipeTimingPlan) => { input.tasks[1].startMinute = 30; },
    (input: RecipeTimingPlan) => { input.tasks[1].startMinute = 29.5; },
    (input: RecipeTimingPlan) => { input.tasks[1].handsOn = false; },
    (input: RecipeTimingPlan) => { input.tasks[1].kind = 'rest'; },
    (input: RecipeTimingPlan) => { input.tasks[0].handsOn = true; },
    (input: RecipeTimingPlan) => { input.tasks[0].kind = 'prep'; },
    (input: RecipeTimingPlan) => { input.tasks[0].attendsToTaskId = 'stir'; },
    (input: RecipeTimingPlan) => { input.tasks[1].attendsToTaskId = 'stir'; },
  ]) {
    const { input, target } = attendedCooking(); mutate(input);
    rejects(input, target, 'attendsToTaskId');
  }
  const { input, target } = attendedCooking();
  target.steps.push(step('other_step')); input.tasks[1].stepId = 'other_step';
  rejects(input, target, 'attendsToTaskId');
  const chain = attendedCooking();
  chain.input.tasks.push({ ...chain.input.tasks[1], id: 'nested', startMinute: 10.2, durationMinutes: 0.2, attendsToTaskId: 'stir' });
  rejects(chain.input, chain.target, 'attendsToTaskId');
});

test('attendance never exempts simultaneous hands-on work or unrelated use of host resources', () => {
  const simultaneous = attendedCooking();
  simultaneous.target.steps.push(step('chop'));
  simultaneous.input.tasks.push({ id: 'chop', stepId: 'chop', label: 'Siekanie', kind: 'prep', startMinute: 10, durationMinutes: 1, dependsOn: [], attendsToTaskId: null, handsOn: true, resources: ['board'] });
  assert(rejects(simultaneous.input, simultaneous.target).issues.some(issue => issue.message.includes('Jedna osoba')));

  const sibling = attendedCooking();
  sibling.input.tasks.push({ ...sibling.input.tasks[1], id: 'other_stir', startMinute: 10.5 });
  assert(rejects(sibling.input, sibling.target).issues.some(issue => issue.message.includes('Jedna osoba')));

  const unrelated = attendedCooking();
  unrelated.input.tasks.push({ ...unrelated.input.tasks[0], id: 'other_food', startMinute: 10, durationMinutes: 1 });
  assert(rejects(unrelated.input, unrelated.target).issues.some(issue => issue.message.includes('Zasób pan')));

  const extraResource = attendedCooking();
  extraResource.input.tasks[1].resources.push('board');
  extraResource.input.tasks.push({ ...extraResource.input.tasks[0], id: 'occupied_board', kind: 'rest', resources: ['board'] });
  assert(rejects(extraResource.input, extraResource.target).issues.some(issue => issue.message.includes('Zasób board')));
});
