import test from 'node:test';
import assert from 'node:assert/strict';
import type { EditorialContent } from '@/lib/editorial-types';
import { recipes } from '@/lib/recipes';
import { recipeResearchSources } from './recipe-research';
import { responseRepairRequest, responseRequest } from './text-provider';
import { normalizeRecipeProposal, recipeResearchVersion, recipeProposalVersion } from './recipe-proposal';
import { ProviderError } from './provider-error';

const source = { title: 'Technika gotowania', url: 'https://www.bbcgoodfood.com/recipes/lemon-pasta' };
const receipt = [{ id: 'search', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'lemon pasta technique', sources: [{ type: 'url', url: source.url }] } }] as Parameters<typeof recipeResearchSources>[0];

test('title-only, short notes and full recipes all request real research with a bounded search budget', () => {
  for (const originalText of ['', 'Makaron cytrynowy, lekki sos.', 'Składniki: 400 g makaronu, 40 g masła. Ugotuj makaron i połącz z sosem.']) {
    const input: EditorialContent = { recipe: structuredClone(recipes[0]), originalText, author: 'Redakcja', sources: [], photos: { ingredients: {}, steps: {} }, aiPhotography: { recipeResearchVersion, recipeProposalVersion } };
    const request = responseRequest('gpt-6-astra', input, 'Uzupełnij przepis.');
    assert.deepEqual(request.tools, [{ type: 'web_search', search_context_size: 'low' }]);
    assert.equal(request.max_tool_calls, 2);
    assert.equal(request.tool_choice, 'required');
    assert.deepEqual(request.include, ['web_search_call.action.sources']);
    assert(request.text.format.schema.required?.includes('researchSources'));
    assert.equal(JSON.parse(request.input).originalText, originalText);
    assert.match(request.instructions, /without copying source wording/);
  }
});

test('manual, researched and repair prompts keep all public text free of source references', () => {
  for (const aiPhotography of [undefined, { recipeResearchVersion, recipeProposalVersion }]) {
    const input: EditorialContent = { recipe: structuredClone(recipes[0]), originalText: 'W przepisie AGFG polecono krótkie podsmażenie.', author: 'Redakcja', sources: [], photos: { ingredients: {}, steps: {} }, aiPhotography };
    const requests = [
      responseRequest('gpt-6-astra', input, 'Uzupełnij opis, wskazówki i przechowywanie.'),
      responseRepairRequest('gpt-6-astra', input, 'Uzupełnij przepis.', 'resp_existing', [{ field: 'storage.en', message: 'Usuń link do źródła.' }]),
    ];
    for (const request of requests) {
      assert.match(request.instructions, /including title, description, ingredient notes, method, equipment, tips, storage, substitutions and scaling advice/);
      assert.match(request.instructions, /no URLs, bare domains, Markdown or HTML links, citation markers, website or service names, source attributions/);
      assert.match(request.instructions, /references already present in the supplied recipe and brief/);
      assert.match(request.instructions, /Whole Foods Market/);
      assert.match(request.instructions, /Preserve the meaning, necessary technique and food-safety conditions/);
      assert.match(request.instructions, /only in the private researchSources field/);
      assert.match(request.instructions, /never copy them into the recipe or editorial notes/);
    }
  }
});

test('research retains author references and adds only URLs in actual provider receipts', () => {
  const existing = [{ id: 'author-source', title: 'Notatki autora', url: 'https://example.com/original' }];
  const result = recipeResearchSources(receipt, [source], existing);
  assert.deepEqual(result[0], existing[0]);
  assert.equal(result[1].url, source.url);
  assert.equal(recipeResearchSources(receipt, [source], result).length, 2);
  assert.throws(() => recipeResearchSources(receipt, [{ title: 'Zmyślone', url: 'https://invented.example/recipe' }], existing), (error: unknown) => error instanceof ProviderError && error.code === 'AI_RESEARCH_SOURCE_INVALID');
});

test('a structured source list never substitutes for a completed search receipt', () => {
  assert.throws(() => recipeResearchSources([], [source], []), (error: unknown) => error instanceof ProviderError && error.code === 'AI_RESEARCH_REQUIRED');
  const inProgress = structuredClone(receipt);
  if (inProgress[0].type === 'web_search_call') inProgress[0].status = 'in_progress';
  assert.throws(() => recipeResearchSources(inProgress, [source], []), (error: unknown) => error instanceof ProviderError && error.code === 'AI_RESEARCH_REQUIRED');
});

test('a draft keeps only corroborated bibliography and ignores provider tracking parameters', () => {
  const unverified = { title: 'Zmyślone źródło', url: 'https://invented.example/recipe' };
  const sources = recipeResearchSources(receipt, [{ ...source, url: source.url + '?utm_source=openai' }, unverified], [], { draft: true });
  assert.deepEqual(sources.map(item => item.url), [source.url]);
  assert.throws(() => recipeResearchSources(receipt, [unverified], [], { draft: true }), ProviderError);
});

test('citation cleanup preserves temperature, timing, prose and meaningful links', () => {
  const raw = {
    steps: [{ id: 'roast', text: {
      pl: 'Piecz 12–18 min, do 63°C. ([fda.gov](https://www.fda.gov/food/cooking?utm_source=openai))',
      en: 'Bake for 12–18 min, until 63°C. citeturn1search0',
    } }],
    storage: { pl: 'Porównaj [instrukcję chłodzenia](https://food.gov.uk/cooling).', en: 'Cool promptly.' },
    researchSources: [source],
  };
  const cleaned = normalizeRecipeProposal(raw) as typeof raw;
  assert.deepEqual(cleaned.steps[0].text, { pl: 'Piecz 12–18 min, do 63°C.', en: 'Bake for 12–18 min, until 63°C.' });
  assert.deepEqual(cleaned.storage, raw.storage);
  assert.deepEqual(cleaned.researchSources, raw.researchSources);
});
