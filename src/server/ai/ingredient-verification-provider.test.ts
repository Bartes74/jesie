import assert from 'node:assert/strict';
import test from 'node:test';
import { ingredientEvidencePolicyVersion, normalizeIngredientVerificationName, type IngredientVerificationInput, type IngredientVerificationProposal } from '@/lib/ingredient-verification';
import { ingredientVerificationModel, ingredientVerificationRequest, ingredientVerificationSourceUrl, pollIngredientVerification,
  submitIngredientVerification, validateIngredientVerification } from './ingredient-verification-provider';
import { ProviderError } from './provider-error';

const input: IngredientVerificationInput = { name: { pl: 'mąka z teffu', en: 'teff flour' }, note: { pl: 'Jednoskładnikowa mąka.', en: 'Single-ingredient flour.' } };
const first = 'https://www.fao.org/test-fixture/teff';
const second = 'https://www.bbcgoodfood.com/test-fixture/teff';
function proposal(): IngredientVerificationProposal {
  return { decision: 'verified', canonicalName: { pl: 'mąka z teffu', en: 'teff flour' }, kind: 'plant', diet: 'vegan', suggestedName: null,
    reason: 'Fixture: established single plant ingredient.', sameIdentity: true, singleIngredient: true, confidence: 'high',
    sources: [
      { title: 'Primary source fixture', url: first, supports: ['identity', 'culinary_use', 'diet'], finding: 'Fixture: identifies the grain and its culinary use.' },
      { title: 'Independent culinary fixture', url: second, supports: ['identity', 'culinary_use'], finding: 'Fixture: corroborates its use as flour.' },
    ] };
}
function searches(urls = [first, second]) {
  return [{ type: 'web_search_call' as const, id: 'search-fixture', status: 'completed' as const,
    action: { type: 'search' as const, query: 'teff flour identity culinary use', sources: urls.map(url => ({ type: 'url' as const, url })) } }];
}
function method(url: RequestInfo | URL, init?: RequestInit) {
  const request = url instanceof Request ? url : new Request(url, init);
  assert.equal(new URL(request.url).origin, 'https://api.openai.com');
  return request.method;
}
async function credentials(action: () => Promise<void>) {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only-not-a-real-key';
  try { await action(); } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
  }
}
function completed(raw: unknown = proposal()) {
  return { id: 'resp_saved', object: 'response', status: 'completed', output: [
    ...searches(), { type: 'message', id: 'msg_fixture', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(raw), annotations: [] }] },
  ], usage: { input_tokens: 10, output_tokens: 20 } };
}

test('verification requests contain only a bounded ingredient name/note and require limited source-backed research', () => {
  const before = structuredClone(input);
  const request = ingredientVerificationRequest(input);
  assert.equal(request.model, ingredientVerificationModel);
  assert.deepEqual(JSON.parse(request.input), input);
  assert.equal(request.max_output_tokens, 4096);
  assert.equal(request.max_tool_calls, 2);
  assert.equal(request.background, true);
  assert.equal(request.store, true);
  assert.deepEqual(request.include, ['web_search_call.action.sources']);
  assert.match(request.instructions, /Existence as a plant or a medicinal\/ornamental product does not establish use as food/);
  assert.match(request.instructions, /possible_typo/);
  assert.deepEqual(input, before);
  assert.throws(() => ingredientVerificationRequest({ ...input, recipe: 'private recipe text' } as IngredientVerificationInput), error => error instanceof ProviderError && error.code === 'AI_INGREDIENT_VERIFICATION_INPUT_INVALID');
  assert.throws(() => ingredientVerificationRequest({ name: { pl: 'x'.repeat(251), en: '' } }), error => error instanceof ProviderError && error.code === 'AI_INGREDIENT_VERIFICATION_INPUT_INVALID');
});

test('a confirmed exact culinary identity from independent searched sources is eligible without rewriting the queried names', () => {
  const raw = proposal();
  const before = structuredClone(raw);
  const result = validateIngredientVerification(searches(), raw, input);
  assert.equal(result.autoLearnEligible, true);
  assert.deepEqual(result.queriedNames, input.name);
  assert.deepEqual(raw, before);
});

test('retained ajwain evidence from Indian institutions is eligible under the current policy without rewriting findings or researching again', async t => {
  await credentials(async () => {
    const query: IngredientVerificationInput = { name: { pl: 'ajwain', en: 'ajwain' } };
    const urls = [
      'https://indiaflora-ces.iisc.ac.in/herbsheet.php?cat=13&id=11902',
      'https://icar.gov.in/sites/default/files/2022-06/Geographical-Indications-of-Plant-Species-in-ITKs-in-Agriculture.pdf',
    ];
    const raw: IngredientVerificationProposal = { ...proposal(), canonicalName: query.name,
      sources: urls.map((url, index) => ({ title: `Retained institutional source ${index + 1}`, url,
        supports: ['identity', 'culinary_use'], finding: 'Retained fixture: identifies ajwain as a culinary plant ingredient.' })) };
    const oldCached = { ...structuredClone(raw), queriedNames: query.name, autoLearnEligible: false };
    const before = structuredClone(oldCached);
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(method(url, init), 'GET'); reads++;
      const response = completed(raw);
      response.output = [...searches(urls), response.output.at(-1)!];
      return Response.json(response);
    });
    assert.equal(oldCached.autoLearnEligible, false);
    assert.equal(ingredientEvidencePolicyVersion, 'ingredient-evidence-v2');
    const refreshed = await pollIngredientVerification('resp_saved', query);
    assert.equal(refreshed.done, true);
    if (!refreshed.done) assert.fail('Expected the retained verification to complete.');
    assert.equal(refreshed.result.autoLearnEligible, true);
    assert.deepEqual(refreshed.result.sources, oldCached.sources);
    assert.deepEqual(refreshed.result.queriedNames, oldCached.queriedNames);
    assert.deepEqual(oldCached, before);
    assert.equal(reads, 1);
  });
});

test('academic country namespaces preserve institution independence and reject misleading suffixes', () => {
  for (const host of ['example-university.edu', 'example-university.edu.au', 'example-university.ac.in', 'example-institute.gov.in']) {
    const raw = proposal(); raw.sources[0].url = `https://${host}/fixture`;
    assert.equal(validateIngredientVerification(searches(raw.sources.map(source => source.url)), raw, input).autoLearnEligible, true, host);
    raw.sources[1].url = `https://catalog.${host}/fixture`;
    assert.equal(validateIngredientVerification(searches(raw.sources.map(source => source.url)), raw, input).autoLearnEligible, false, 'One institution cannot corroborate itself.');
  }
  for (const host of ['example-university.edu.au.evil.org', 'example-institute.gov.in.evil.org', 'example-ac.in', 'ac.in']) {
    const raw = proposal(); raw.sources[0].url = `https://${host}/fixture`;
    assert.equal(validateIngredientVerification(searches(raw.sources.map(source => source.url)), raw, input).autoLearnEligible, false, host);
  }
});

test('plain vegan ingredients need identity and culinary evidence while animal categories retain explicit dietary evidence', () => {
  const raw = proposal();
  for (const source of raw.sources) source.supports = ['identity', 'culinary_use'];
  for (const kind of ['plant', 'fungus', 'mineral'] as const)
    assert.equal(validateIngredientVerification(searches(), { ...raw, kind }, input).autoLearnEligible, true, kind);
  for (const [kind, diet] of [['dairy', 'vegetarian'], ['egg', 'vegetarian'], ['honey', 'vegetarian'], ['meat', 'meat']] as const) {
    assert.equal(validateIngredientVerification(searches(), { ...raw, kind, diet }, input).autoLearnEligible, false, kind);
    assert.equal(validateIngredientVerification(searches(), { ...proposal(), kind, diet }, input).autoLearnEligible, true, kind);
  }
  assert.equal(validateIngredientVerification(searches(), { ...raw, kind: 'compound' }, input).autoLearnEligible, false);
  assert.equal(validateIngredientVerification(searches(), { ...raw, diet: 'vegetarian' }, input).autoLearnEligible, false);
});

test('invented and non-public source URLs cannot support verification even when the model claims high confidence', () => {
  for (const url of ['https://www.fao.org/not-in-the-search', 'http://www.fao.org/test-fixture/teff', 'https://user:secret@www.fao.org/test-fixture/teff', 'https://127.0.0.1/food', 'https://[::1]/food']) {
    const raw = proposal(); raw.sources[0].url = url;
    assert.throws(() => validateIngredientVerification(searches(), raw, input), error => error instanceof ProviderError && error.code === 'AI_INGREDIENT_VERIFICATION_SOURCE_INVALID');
  }
  assert.equal(ingredientVerificationSourceUrl('https://localhost/food'), null);
  assert.equal(ingredientVerificationSourceUrl('https://food.internal/food'), null);
  assert.equal(ingredientVerificationSourceUrl('https://www.example.com/food'), null);
  assert.equal(ingredientVerificationSourceUrl(`${first}#identity`), first);
});

test('two subdomains of one institution do not establish independent corroboration', () => {
  const raw = proposal();
  raw.sources[1].url = 'https://catalog.fao.org/test-fixture/teff';
  assert.equal(validateIngredientVerification(searches([first, raw.sources[1].url]), raw, input).autoLearnEligible, false);
});

test('real searched URLs without institutional evidence or culinary-use evidence do not extend the dictionary', () => {
  const raw = proposal();
  raw.sources[0].url = 'https://www.saveur.com/test-fixture/teff';
  assert.equal(validateIngredientVerification(searches(raw.sources.map(source => source.url)), raw, input).autoLearnEligible, false);
  const botanicalOnly = proposal();
  for (const source of botanicalOnly.sources) source.supports = ['identity', 'diet'];
  assert.equal(validateIngredientVerification(searches(), botanicalOnly, input).autoLearnEligible, false);
  const culinaryBlogOnly = proposal();
  culinaryBlogOnly.sources[0].supports = ['identity', 'diet'];
  assert.equal(validateIngredientVerification(searches(), culinaryBlogOnly, input).autoLearnEligible, false);
  assert.throws(() => validateIngredientVerification([], proposal(), input), error => error instanceof ProviderError && error.code === 'AI_INGREDIENT_VERIFICATION_EVIDENCE_REQUIRED');
});

test('typos, compounds, conflicting classifications and uncertain identities are suggestions only', () => {
  const candidates: Partial<IngredientVerificationProposal>[] = [
    { decision: 'possible_typo', suggestedName: { pl: 'teff', en: 'teff' }, sameIdentity: false },
    { decision: 'ambiguous', kind: 'compound' },
    { decision: 'unverified' },
    { diet: 'vegetarian' }, { kind: 'meat', diet: 'vegan' },
    { confidence: 'medium' }, { sameIdentity: false }, { singleIngredient: false }, { canonicalName: null },
  ];
  for (const changes of candidates) assert.equal(validateIngredientVerification(searches(), { ...proposal(), ...changes }, input).autoLearnEligible, false, JSON.stringify(changes));
});

test('exact-name normalisation does not learn or silently correct a misspelling', () => {
  assert.equal(normalizeIngredientVerificationName('  KOZIERADKA BŁĘKITNA '), normalizeIngredientVerificationName('kozieradka błękitna'));
  assert.notEqual(normalizeIngredientVerificationName('kozieratka błękitna'), normalizeIngredientVerificationName('kozieradka błękitna'));
  assert.notEqual(normalizeIngredientVerificationName('marigold'), normalizeIngredientVerificationName('culinary marigold petals'));
});

test('an ambiguous verification submission performs only one POST and never retries the paid request', async t => {
  await credentials(async () => {
    let posts = 0, claims = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(method(url, init), 'POST'); posts++; throw new Error('simulated lost acknowledgement');
    });
    await assert.rejects(submitIngredientVerification(input, async () => { claims++; }, 'ingredient-verification-test'), error => error instanceof ProviderError && error.uncertain && error.code === 'AI_INGREDIENT_VERIFICATION_SUBMISSION_UNCERTAIN');
    assert.equal(posts, 1); assert.equal(claims, 1);
  });
});

test('a rejected verification submission is terminal and a rejected claim cannot reach the provider', async t => {
  await credentials(async () => {
    let posts = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(method(url, init), 'POST'); posts++;
      return Response.json({ error: { message: 'simulated rejected request' } }, { status: 429 });
    });
    await assert.rejects(submitIngredientVerification(input), error => error instanceof ProviderError && !error.uncertain && error.code === 'AI_INGREDIENT_VERIFICATION_REJECTED');
    assert.equal(posts, 1);
    await assert.rejects(submitIngredientVerification(input, async () => { throw new Error('claim rejected'); }), /claim rejected/);
    assert.equal(posts, 1);
  });
});

test('polling an accepted verification only reads its receipt, validates sources and preserves known search/token cost', async t => {
  await credentials(async () => {
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(method(url, init), 'GET'); reads++;
      const request = url instanceof Request ? url : new Request(url, init);
      assert.deepEqual(new URL(request.url).searchParams.getAll('include[]'), ['web_search_call.action.sources']);
      return Response.json(completed());
    });
    const result = await pollIngredientVerification('resp_saved', input);
    assert.equal(result.done, true);
    if (!result.done) assert.fail('Expected a completed verification.');
    assert.equal(result.result.autoLearnEligible, true);
    assert.equal(result.cost.chargedUsd, '0.01022000');
    assert.equal(result.cost.costBasis, 'usage');
    assert.equal(reads, 1);
  });
});

test('invalid verification evidence retains the accepted receipt cost and cannot trigger a model repair', async t => {
  await credentials(async () => {
    const raw = proposal(); raw.sources[0].url = 'https://www.fao.org/invented';
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(method(url, init), 'GET'); return Response.json(completed(raw));
    });
    await assert.rejects(pollIngredientVerification('resp_saved', input), error => error instanceof ProviderError
      && error.code === 'AI_INGREDIENT_VERIFICATION_SOURCE_INVALID' && error.chargedUsd === '0.01022000' && !error.repairable);
  });
});

test('pending and temporarily unavailable receipt reads never create another verification', async t => {
  await credentials(async () => {
    let unavailable = false, reads = 0;
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(method(url, init), 'GET'); reads++;
      if (unavailable) throw new Error('simulated temporary read failure');
      return Response.json({ id: 'resp_saved', object: 'response', status: 'in_progress', output: [] });
    });
    assert.deepEqual(await pollIngredientVerification('resp_saved', input), { done: false });
    unavailable = true;
    await assert.rejects(pollIngredientVerification('resp_saved', input), error => error instanceof ProviderError && error.uncertain && error.code === 'AI_INGREDIENT_VERIFICATION_READ_UNAVAILABLE');
    assert.equal(reads, 2);
  });
});
