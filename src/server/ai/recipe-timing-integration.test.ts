import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { EditorialContent } from '@/lib/editorial-types';
import { recipes } from '@/lib/recipes';
import { recipeTimingVersion } from '@/lib/recipe-timing-plan';
import {
  buildRecipeProposal, capturedRecipeProposalSchema, legacyRecipeProposalSchema,
  normalizeRecipeProposal, recipeProposalVersion, recipeResearchVersion,
} from './recipe-proposal';
import { ProviderError } from './provider-error';
import { pollText, responseRepairRequest, responseRequest } from './text-provider';

const model = 'gpt-6-astra';
const localised = (pl: string, en: string) => ({ pl, en });
type Contract = { hero: boolean; research: boolean; timing: boolean };
type TimingPlan = {
  resources: string[]; assumptions: string[]; excludedSteps: { stepId: string; reason: string }[];
  tasks: { id: string; stepId: string; label: string; kind: 'prep' | 'cooking' | 'rest'; startMinute: number;
    durationMinutes: number; dependsOn: string[]; attendsToTaskId: string | null; handsOn: boolean; resources: string[] }[];
};
type Proposal = z.infer<typeof legacyRecipeProposalSchema> & {
  heroPresentation?: { container: 'bowl'; finalAppearance: { pl: string; en: string }; evidenceStepIds: string[] };
  timingPlan?: TimingPlan | null;
  researchSources?: { title: string; url: string }[];
};
const source = { title: 'Porridge technique', url: 'https://www.bbcgoodfood.com/recipes/porridge' };
const assumption = 'One home cook uses a saucepan and a separate board; ingredient preparation is included.';

function input(contract: Contract): EditorialContent {
  const recipe = structuredClone(recipes[0]);
  recipe.id = 'timing-integration';
  recipe.slug = localised('deser-owsiany-z-owocami', 'oat-dessert-with-berries');
  recipe.title = localised('Deser owsiany z owocami', 'Oat dessert with berries');
  recipe.description = localised('Gotowany i ostudzony deser owsiany z owocami.', 'A cooked and cooled oat dessert with berries.');
  recipe.times = { active: 20, cooking: 20, rest: 30, total: 65 };
  recipe.ingredients = [
    { id: 'oats', name: localised('płatki owsiane', 'rolled oats'), amount: { kind: 'exact', value: '100' }, unit: 'g', scaling: 'linear', group: localised('Składniki', 'Ingredients') },
    { id: 'milk', name: localised('mleko', 'milk'), amount: { kind: 'exact', value: '500' }, unit: 'ml', scaling: 'linear', group: localised('Składniki', 'Ingredients') },
    { id: 'berries', name: localised('owoce jagodowe', 'mixed berries'), amount: { kind: 'exact', value: '100' }, unit: 'g', scaling: 'linear', group: localised('Składniki', 'Ingredients') },
  ];
  recipe.steps = [
    { id: 'prepare', title: localised('Przygotuj składniki', 'Prepare the ingredients'),
      text: localised('Odmierz płatki i mleko oraz przygotuj garnek i miseczki.', 'Measure the oats and milk and prepare a saucepan and bowls.') },
    { id: 'cook', title: localised('Ugotuj płatki', 'Cook the oats'),
      text: localised('Wlej {{milk}} mleka i dodaj {{oats}} płatków. Podgrzewaj i gotuj łagodnie przez około 20 minut, aż płatki będą miękkie.',
        'Pour in {{milk}} of milk and add {{oats}} of oats. Heat and simmer gently for about 20 minutes, until the oats are tender.'), timerMinutes: 20 },
    { id: 'fruit', title: localised('Przygotuj owoce', 'Prepare the berries'),
      text: localised('Podczas gotowania płatków umyj {{berries}} owoców i dokładnie osusz. Odłóż je do podania.',
        'While the oats cook, wash {{berries}} of berries and dry thoroughly. Set them aside for serving.') },
    { id: 'cool', title: localised('Ostudź deser', 'Cool the dessert'),
      text: localised('Po ugotowaniu przełóż deser do miseczek i pozostaw na około 30 minut, aż będzie letni.',
        'After cooking, transfer the dessert to bowls and leave for about 30 minutes, until lukewarm.') },
    { id: 'serve', title: localised('Dodaj owoce i podaj', 'Add the berries and serve'),
      text: localised('Rozłóż przygotowane owoce na ostudzonym deserze i podawaj.', 'Arrange the prepared berries over the cooled dessert and serve.') },
  ];
  recipe.equipment = { pl: ['Garnek', 'Miseczki', 'Deska'], en: ['Saucepan', 'Bowls', 'Board'] };
  recipe.tips = { pl: ['Podczas gotowania przygotuj owoce.'], en: ['Prepare the berries while the oats cook.'] };
  recipe.storage = localised('Resztki schłodź i przechowuj w lodówce.', 'Cool leftovers and store in the fridge.');
  return { recipe, originalText: 'Przygotuj deser dla jednej osoby gotującej, uwzględniając wszystkie etapy.', author: 'Autorka',
    sources: [{ id: 'author-source', title: 'Notatki autora', url: 'https://example.invalid/author' }], photos: { ingredients: {}, steps: {} },
    aiPhotography: { ...(contract.hero ? { recipeProposalVersion } : {}), ...(contract.research ? { recipeResearchVersion } : {}),
      ...(contract.timing ? { recipeTimingVersion } : {}) } };
}

function plan(): TimingPlan {
  return { resources: ['hob', 'pan', 'board', 'bowls'], assumptions: [assumption], excludedSteps: [], tasks: [
    { id: 'prepare-task', stepId: 'prepare', label: 'Measure and prepare', kind: 'prep', startMinute: 0, durationMinutes: 10,
      dependsOn: [], attendsToTaskId: null, handsOn: true, resources: ['pan', 'board'] },
    { id: 'cook-task', stepId: 'cook', label: 'Cook the oats', kind: 'cooking', startMinute: 10, durationMinutes: 20,
      dependsOn: ['prepare-task'], attendsToTaskId: null, handsOn: false, resources: ['hob', 'pan'] },
    { id: 'fruit-task', stepId: 'fruit', label: 'Wash and dry the berries', kind: 'prep', startMinute: 10, durationMinutes: 5,
      dependsOn: ['prepare-task'], attendsToTaskId: null, handsOn: true, resources: ['board'] },
    { id: 'cool-task', stepId: 'cool', label: 'Cool the dessert', kind: 'rest', startMinute: 30, durationMinutes: 30,
      dependsOn: ['cook-task'], attendsToTaskId: null, handsOn: false, resources: ['bowls'] },
    { id: 'serve-task', stepId: 'serve', label: 'Finish and serve', kind: 'prep', startMinute: 60, durationMinutes: 5,
      dependsOn: ['cool-task', 'fruit-task'], attendsToTaskId: null, handsOn: true, resources: ['bowls'] },
  ] };
}

function proposal(original: EditorialContent): Proposal {
  const r = original.recipe;
  return { slug: structuredClone(r.slug), title: structuredClone(r.title), description: structuredClone(r.description),
    primaryCategory: r.primaryCategory, categories: [...r.categories], difficulty: r.difficulty, cuisine: structuredClone(r.cuisine),
    baseServings: r.baseServings, times: { ...r.times },
    ingredients: r.ingredients.map(i => ({ ...structuredClone(i), group: i.group ?? localised('Deser', 'Dessert'), note: i.note ?? null,
      amount: i.amount.kind === 'qualitative' ? i.amount : { ...i.amount, approximate: i.amount.approximate ?? false } })),
    steps: r.steps.map(s => ({ ...structuredClone(s), timerMinutes: s.timerMinutes ?? null })),
    equipment: structuredClone(r.equipment), tips: structuredClone(r.tips), storage: structuredClone(r.storage),
    scalingNote: r.scalingNote ?? null, notes: ['Sprawdź końcową konsystencję.'], substitutions: [],
    ...(original.aiPhotography?.recipeProposalVersion === recipeProposalVersion ? { heroPresentation: { container: 'bowl' as const,
      finalAppearance: localised('Ostudzony deser owsiany z owocami w miseczce.', 'Cooled oat dessert topped with berries in a bowl.'), evidenceStepIds: ['cool', 'serve'] } } : {}),
    ...(original.aiPhotography?.recipeTimingVersion === recipeTimingVersion ? { timingPlan: plan() } : {}),
    ...(original.aiPhotography?.recipeResearchVersion === recipeResearchVersion ? { researchSources: [source] } : {}),
  };
}

// Research receipts are checked by pollText, outside the local culinary parser.
function localProposal(original: EditorialContent) {
  const { researchSources, ...raw } = proposal(original); void researchSources; return raw;
}
function invalidTiming(error: unknown) {
  assert(error instanceof ProviderError);
  assert.equal(error.code, 'AI_RESULT_INVALID');
  assert.equal(error.repairable, true);
  assert.equal(error.uncertain, false);
  assert(error.issues.some(i => /^(?:timingPlan(?:\.|$)|times(?:\.|$))/.test(i.field)), JSON.stringify(error.issues));
  return true;
}
function strictObjects(value: unknown) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(strictObjects); return; }
  const node = value as Record<string, unknown>;
  if (node.type === 'object' && node.properties && typeof node.properties === 'object') {
    assert.equal(node.additionalProperties, false);
    assert.deepEqual([...(node.required as string[])].sort(), Object.keys(node.properties).sort());
  }
  Object.values(node).forEach(strictObjects);
}

test('all eight captured hero/research/timing contracts emit the same strict generation and repair schemas', () => {
  for (const hero of [false, true]) for (const research of [false, true]) for (const timing of [false, true]) {
    const original = input({ hero, research, timing }), raw = proposal(original);
    const context = JSON.stringify({ hero, research, timing });
    assert.equal(capturedRecipeProposalSchema(original).safeParse(raw).success, true, context);
    assert.deepEqual(buildRecipeProposal(localProposal(original), original).content.recipe.times, original.recipe.times, context);
    const generation = responseRequest(model, original, 'Dopracuj pełną metodę.');
    const repair = responseRepairRequest(model, original, 'Dopracuj pełną metodę.', 'resp_existing', [
      { field: timing ? 'timingPlan.tasks' : 'steps', message: 'Uzgodnij pełny harmonogram z metodą.' },
    ]);
    assert.deepEqual(repair.text.format.schema, generation.text.format.schema, context);
    for (const [field, required] of [['heroPresentation', hero], ['researchSources', research], ['timingPlan', timing]] as const) {
      assert.equal(generation.text.format.schema.required?.includes(field) ?? false, required, `${context}:${field}`);
    }
    strictObjects(generation.text.format.schema);
    assert.equal('tools' in repair, false, 'A correction never adds another search.');
    assert.equal('tool_choice' in repair, false);
    assert.equal(Buffer.byteLength(JSON.stringify(generation)) <= 60_000, true);
    assert.equal(JSON.parse(repair.input).validationIssues[0].field, timing ? 'timingPlan.tasks' : 'steps');
  }
});

test('a valid dependency timeline is checked against the proposed recipe, stays private and preserves both inputs', () => {
  const original = input({ hero: true, research: true, timing: true }), raw = localProposal(original);
  const before = structuredClone({ original, raw });
  original.recipe.times.total = 99; // A generation is allowed to correct its source.
  before.original.recipe.times.total = 99;
  const result = buildRecipeProposal(raw, original);
  assert.deepEqual(result.content.recipe.times, { active: 20, cooking: 20, rest: 30, total: 65 });
  assert.equal(Object.hasOwn(result.content.recipe, 'timingPlan'), false);
  assert(result.notes.includes(assumption));
  assert.equal(JSON.stringify(result.content.recipe).includes(assumption), false);
  assert.deepEqual(original, before.original);
  assert.deepEqual(raw, before.raw);
});

test('new captured results reject missing plans, incorrect elapsed/active totals and impossible schedules before content exists', () => {
  const original = input({ hero: true, research: false, timing: true });
  const missing = localProposal(original); delete missing.timingPlan;
  assert.throws(() => buildRecipeProposal(missing, original), invalidTiming);
  const empty = localProposal(original); empty.timingPlan = null;
  assert.throws(() => buildRecipeProposal(empty, original), invalidTiming);
  for (const field of ['total', 'active'] as const) {
    const raw = localProposal(original); raw.times[field] -= 1;
    const before = structuredClone(raw);
    assert.throws(() => buildRecipeProposal(raw, original), invalidTiming);
    assert.deepEqual(raw, before);
  }
  const overlap = localProposal(original); overlap.timingPlan!.tasks[2].startMinute = 5;
  assert.throws(() => buildRecipeProposal(overlap, original), invalidTiming);
  const unknown = localProposal(original); unknown.timingPlan!.tasks[1].stepId = 'absent-step';
  assert.throws(() => buildRecipeProposal(unknown, original), invalidTiming);
});

test('ceil of the final interval unions preserves minute precision instead of rounding each task or rounding to five', () => {
  const original = input({ hero: true, research: false, timing: true }), raw = localProposal(original), tasks = raw.timingPlan!.tasks;
  tasks[0].durationMinutes = 9.2;
  tasks[1].startMinute = 9.2; tasks[1].durationMinutes = 20.2;
  tasks[2].startMinute = 9.2; tasks[2].durationMinutes = 5.1;
  tasks[3].startMinute = 29.4; tasks[3].durationMinutes = 30.1;
  tasks[4].startMinute = 59.5; tasks[4].durationMinutes = 6.1;
  raw.times = { active: 21, cooking: 21, rest: 31, total: 66 };
  const result = buildRecipeProposal(raw, original);
  assert.deepEqual(result.content.recipe.times, raw.times);
});

test('one minute of attended stirring fits the same continuous cooking interval and equipment without allowing two simultaneous hands-on tasks', () => {
  const original = input({ hero: true, research: false, timing: true }), raw = localProposal(original);
  raw.steps[1].text = localised('Wlej {{milk}} mleka i dodaj {{oats}} płatków. Gotuj łagodnie przez około 20 minut, aż płatki będą miękkie. Po 10 minutach gotowania mieszaj przez minutę i gotuj dalej.',
    'Pour in {{milk}} of milk and add {{oats}} of oats. Simmer gently for about 20 minutes, until the oats are tender. After 10 minutes of cooking, stir for one minute and continue simmering.');
  raw.timingPlan!.tasks.push({ id: 'stir-task', stepId: 'cook', label: 'Briefly stir the simmering oats', kind: 'cooking',
    startMinute: 20, durationMinutes: 1, dependsOn: ['prepare-task'], attendsToTaskId: 'cook-task', handsOn: true, resources: ['hob', 'pan'] });
  raw.times.active = 21;
  const accepted = buildRecipeProposal(raw, original);
  assert.deepEqual(accepted.content.recipe.times, { active: 21, cooking: 20, rest: 30, total: 65 });
  assert.equal(accepted.content.recipe.steps[1].timerMinutes, 20, 'The full continuous simmer still owns its original timer.');
  const overlapping = structuredClone(raw);
  overlapping.timingPlan!.tasks.at(-1)!.startMinute = 12; // The one cook is preparing fruit at minutes 10–15.
  assert.throws(() => buildRecipeProposal(overlapping, original), invalidTiming);
});

test('step identity normalization rewrites task, exclusion and presentation references consistently', () => {
  const original = input({ hero: true, research: false, timing: true }), raw = localProposal(original);
  raw.steps[3].id = ' chłodzenie deseru '; raw.timingPlan!.tasks[3].stepId = ' chłodzenie deseru ';
  raw.steps[4].id = ' podaj deser '; raw.timingPlan!.tasks[4].stepId = ' podaj deser ';
  raw.heroPresentation!.evidenceStepIds = [' chłodzenie deseru ', ' podaj deser '];
  raw.steps.push({ id: ' opcjonalne dekorowanie ', title: localised('Opcjonalne dekorowanie', 'Optional decoration'),
    text: localised('Opcjonalnie ułóż owoce w dekoracyjny wzór.', 'Optionally arrange the berries in a decorative pattern.'), timerMinutes: null });
  raw.timingPlan!.excludedSteps.push({ stepId: ' opcjonalne dekorowanie ', reason: 'Optional decorative arrangement is not needed for the base serving.' });
  const before = structuredClone(raw);
  const normalized = normalizeRecipeProposal(raw) as typeof raw;
  assert.equal(normalized.timingPlan!.tasks[3].stepId, 'chlodzenie_deseru');
  assert.equal(normalized.timingPlan!.tasks[4].stepId, 'podaj_deser');
  assert.equal(normalized.timingPlan!.excludedSteps[0].stepId, 'opcjonalne_dekorowanie');
  assert.deepEqual(normalized.heroPresentation!.evidenceStepIds, ['chlodzenie_deseru', 'podaj_deser']);
  assert.deepEqual(raw, before);
  const result = buildRecipeProposal(raw, original);
  assert.deepEqual(result.content.recipe.steps.map(s => s.id), ['prepare', 'cook', 'fruit', 'chlodzenie_deseru', 'podaj_deser', 'opcjonalne_dekorowanie']);
});

test('a mandatory 24-hour chill remains in rest and total without inventing an overnight countdown', () => {
  const original = input({ hero: true, research: false, timing: true }), raw = localProposal(original);
  raw.steps[3].text = localised('Schłodź ugotowany deser, wstaw do lodówki i chłodź przez co najmniej 24 godziny przed podaniem.',
    'Cool the fully cooked dessert, refrigerate and chill for at least 24 hours before serving.');
  raw.timingPlan!.tasks[3].durationMinutes = 1440;
  raw.timingPlan!.tasks[4].startMinute = 1470;
  raw.times = { active: 20, cooking: 20, rest: 1440, total: 1475 };
  const result = buildRecipeProposal(raw, original);
  assert.deepEqual(result.content.recipe.times, raw.times);
  assert.equal(result.content.recipe.steps[3].timerMinutes, undefined);
  assert.equal(result.content.recipe.steps[1].timerMinutes, 20);
});

test('clear day-long waiting evidence rejects a mathematically valid short plan while refrigeration deadlines remain preparation', () => {
  const original = input({ hero: true, research: false, timing: true }), shortened = localProposal(original);
  shortened.steps[3].text = localised('Chłodź deser przez co najmniej 24 godziny przed podaniem.',
    'Chill the dessert for at least 24 hours before serving.');
  shortened.timingPlan!.tasks[3].durationMinutes = 1;
  shortened.timingPlan!.tasks[4].startMinute = 31;
  shortened.times = { active: 20, cooking: 20, rest: 1, total: 36 };
  assert.throws(() => buildRecipeProposal(shortened, original), error => {
    invalidTiming(error); assert(error instanceof ProviderError);
    assert(error.issues.some(issue => issue.field.startsWith('timingPlan.tasks')));
    return true;
  });

  const deadline = localProposal(original);
  deadline.steps[3].title = localised('Przełóż porcję do przechowania', 'Pack a portion for storage');
  deadline.steps[3].text = localised('Przełóż część ugotowanego deseru do płytkich pojemników i wstaw do lodówki w ciągu 2 godzin. Nie zostawiaj na blacie przez noc.',
    'Transfer part of the fully cooked dessert to shallow containers and refrigerate within 2 hours. Do not leave it on the worktop overnight.');
  deadline.steps[4].text = localised('Pozostałą porcję podaj na ciepło z przygotowanymi owocami.',
    'Serve the remaining portion warm with the prepared berries.');
  Object.assign(deadline.timingPlan!.tasks[3], { kind: 'prep', durationMinutes: 5, handsOn: true });
  deadline.timingPlan!.tasks[4].startMinute = 35;
  deadline.times = { active: 25, cooking: 20, rest: 0, total: 40 };
  const accepted = buildRecipeProposal(deadline, original);
  assert.deepEqual(accepted.content.recipe.times, deadline.times);
  assert.equal(accepted.content.recipe.steps[3].timerMinutes, undefined);
});

test('legacy in-flight proposals remain readable without a new timing field across existing hero/research contracts', () => {
  for (const hero of [false, true]) for (const research of [false, true]) {
    const original = input({ hero, research, timing: false });
    if (!hero && !research) delete original.aiPhotography;
    const raw = localProposal(original);
    assert.equal('timingPlan' in raw, false);
    assert.deepEqual(buildRecipeProposal(raw, original).content.recipe.times, original.recipe.times);
    const repair = responseRepairRequest(model, original, 'Dopracuj przepis.', 'resp_old', [{ field: 'steps', message: 'Sprawdź metodę.' }]);
    assert.equal(repair.text.format.schema.required?.includes('timingPlan') ?? false, false);
  }
});

function providerReply(id: string, raw: unknown, research = false, parent: string | null = null) {
  return { id, object: 'response', status: 'completed', previous_response_id: parent,
    output: [
      ...(research ? [
        { type: 'web_search_call', id: 'search', status: 'completed', action: { type: 'search', query: 'porridge technique', sources: [{ type: 'url', url: source.url }] } },
        { type: 'web_search_call', id: 'open', status: 'completed', action: { type: 'open_page', url: source.url } },
      ] : []),
      { type: 'message', id: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(raw), annotations: [] }] },
    ], usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 500, cache_write_tokens: 200 } } };
}
async function mockProvider(t: TestContext, respond: (id: string) => unknown, run: (reads: string[]) => Promise<void>) {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'timing-test-never-sent';
  const reads: string[] = [];
  try {
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url), method = init?.method ?? (url instanceof Request ? url.method : 'GET');
      assert.equal(method, 'GET', 'This suite must never submit or cancel a provider job.');
      const parsed = new URL(href);
      assert.equal(parsed.origin, 'https://api.openai.com');
      assert.match(parsed.pathname, /^\/v1\/responses\/resp_[A-Za-z0-9_-]+$/);
      const id = parsed.pathname.split('/').at(-1)!; reads.push(id);
      return Response.json(respond(id));
    });
    await run(reads);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
  }
}

test('actual pollText returns repairable timing issues with known research cost using GET-only mocked transport', async t => {
  const original = input({ hero: true, research: true, timing: true });
  let raw = proposal(original); raw.times.total = 64;
  await mockProvider(t, id => providerReply(id, raw, true), async reads => {
    await assert.rejects(pollText(model, 'resp_timing', original), error => {
      invalidTiming(error); assert(error instanceof ProviderError);
      assert.equal(error.chargedUsd, '0.03600000');
      return true;
    });
    raw = proposal(original);
    const result = await pollText(model, 'resp_timing', original);
    assert.equal(result.done, true); if (!result.done) assert.fail('Expected a valid completed recipe.');
    assert('chargedUsd' in result.cost);
    assert.equal(result.cost.chargedUsd, '0.03600000');
    assert.deepEqual(result.content.recipe.times, original.recipe.times);
    assert.deepEqual(result.content.sources.at(-1), { id: 'research-2', ...source });
    assert(result.notes.includes(assumption));
    assert.deepEqual(reads, ['resp_timing', 'resp_timing']);
  });
});

test('legacy polling and repaired timing results only read their captured receipts, without buying new research', async t => {
  const legacy = input({ hero: true, research: true, timing: false });
  const current = input({ hero: true, research: true, timing: true });
  await mockProvider(t, id => id === 'resp_legacy' ? providerReply(id, proposal(legacy), true)
    : id === 'resp_parent' ? providerReply(id, { invalid: true }, true)
      : providerReply(id, proposal(current), false, 'resp_parent'), async reads => {
    const oldResult = await pollText(model, 'resp_legacy', legacy);
    assert.equal(oldResult.done, true);
    if (!oldResult.done) assert.fail('Expected the legacy result to remain readable.');
    assert.deepEqual(oldResult.content.recipe.times, legacy.recipe.times);
    const repaired = await pollText(model, 'resp_child', current, ['resp_parent']);
    assert.equal(repaired.done, true); if (!repaired.done) assert.fail('Expected the captured repair contract.');
    assert('chargedUsd' in repaired.cost);
    assert.equal(repaired.cost.chargedUsd, '0.01600000', 'Research was billed to its ancestor, not the repair child.');
    assert.deepEqual(repaired.content.sources.at(-1), { id: 'research-2', ...source });
    assert.deepEqual(reads, ['resp_legacy', 'resp_child', 'resp_parent']);
  });
});
