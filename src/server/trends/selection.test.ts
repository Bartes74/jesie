import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates, type RawCandidate } from './ranking';
import { seasonalRecipeIdeas, selectRecipeCandidate, warsawSeason } from './selection';
import type { TrendCandidate } from '@/lib/trend-types';

const now = new Date('2026-10-05T08:00:00Z');

function lead(title = 'Crispy rice salad', pl = 'Sałatka z chrupiącym ryżem'): RawCandidate {
    return { dishKey: title.toLowerCase(), title: { pl, en: title }, aliases: [], rationale: 'Potrawa znaleziona w wyszukiwaniu.', sources: [
        { url: 'https://instagram.com/chef_one/reel/rice/', title: 'Rice salad', publisher: 'Chef One', platform: 'instagram', publishedAt: '2026-10-04', excerpt: 'This crispy rice salad is going viral this week.', interestEvidence: '', independentKey: '' },
        { url: 'https://tiktok.com/@chef_two/video/1', title: 'Salad idea', publisher: 'Chef Two', platform: 'tiktok', publishedAt: '2026-10-03', excerpt: 'Everyone is making the crunchy rice salad trend.', interestEvidence: '', independentKey: '' },
        { url: 'https://food.example.com/rice', title: 'Salad', publisher: 'Food', platform: 'web', publishedAt: '2026-10-02', excerpt: 'The latest popular salad uses crispy roasted rice.', interestEvidence: '', independentKey: '' },
    ] };
}

function ranked(raw: RawCandidate, runId = 'run'): TrendCandidate {
    return rankCandidates([raw], raw.sources.map(source => source.url), [], runId, now)[0];
}

test('empty discovery selects one seasonal recipe without invented sources or trend evidence', () => {
    const result = selectRecipeCandidate([], [], 'run', now);
    assert.equal(result.candidates.filter(candidate => candidate.selected).length, 1);
    assert.equal(result.selected.automaticSelection?.basis, 'seasonal');
    assert.equal(result.selected.eligible, false);
    assert.equal(result.selected.duplicateRecipeId, null);
    assert.equal(result.selected.editorChoice, undefined);
    assert.deepEqual(result.selected.sources, []);
    assert.equal(result.selected.score.independentSources, 0);
    assert.ok(result.selected.title.pl.length > 5 && result.selected.title.en.length > 5);
    assert.ok(seasonalRecipeIdeas(now).slice(0, 16).some(idea => idea.title.en === result.selected.title.en));
});

test('sequential empty scheduled and manual searches exclude a draft with only its Polish title', () => {
    const first = selectRecipeCandidate([], [], 'scheduled', now);
    const draft = { id: 'scheduled-draft', title: { pl: first.selected.title.pl, en: '' } };
    const second = selectRecipeCandidate([], [draft], 'manual', now);
    assert.equal(second.selected.automaticSelection?.basis, 'seasonal');
    assert.notEqual(second.selected.title.pl, first.selected.title.pl);
    assert.equal(second.selected.duplicateRecipeId, null);
    const [checked] = rankCandidates([second.selected], [], [draft], 'manual', now);
    assert.equal(checked.duplicateRecipeId, null);
    assert.equal(checked.ambiguous, false);
});

test('a discovered lead survives rejected citations as an honest inspiration', () => {
    const raw = lead();
    const [candidate] = rankCandidates([raw], [], [], 'run', now);
    assert.equal(candidate.sources.length, 0);
    const result = selectRecipeCandidate([candidate], [], 'run', now);
    assert.equal(result.selected.id, candidate.id);
    assert.equal(result.selected.automaticSelection?.basis, 'research');
    assert.match(result.selected.automaticSelection!.reason, /Nie potwierdzono materiałów/);
    assert.equal(result.selected.eligible, false);
    assert.deepEqual(result.selected.sources, []);
    assert.deepEqual(result.selected.research, candidate.research);
});

test('a qualified new trend wins over incomplete research', () => {
    const qualified = ranked(lead(), 'qualified');
    const incompleteRaw = lead('Roasted cauliflower', 'Pieczony kalafior');
    incompleteRaw.sources = incompleteRaw.sources.slice(0, 1);
    const incomplete = ranked(incompleteRaw, 'incomplete');
    const result = selectRecipeCandidate([incomplete, qualified], [], 'run', now);
    assert.equal(result.selected.id, qualified.id);
    assert.equal(result.selected.eligible, true);
    assert.equal(result.selected.automaticSelection, undefined);
    assert.equal(result.candidates.filter(candidate => candidate.selected).length, 1);
});

test('verified materials have priority over an unverified dish lead', () => {
    const raw = lead();
    raw.sources = raw.sources.slice(0, 1);
    const researched = ranked(raw, 'researched');
    const bareRaw = lead('Lemon chickpea bowl', 'Miska ciecierzycy z cytryną');
    bareRaw.sources = [];
    const bare = ranked(bareRaw, 'bare');
    const result = selectRecipeCandidate([bare, researched], [], 'run', now);
    assert.equal(result.selected.id, researched.id);
    assert.equal(result.selected.automaticSelection?.basis, 'research');
    assert.equal(result.selected.sources.length, 1);
    assert.equal(result.selected.eligible, false);
});

test('existing aliases block even a strongly evidenced candidate and select a fresh reserve dish', () => {
    const candidate = ranked(lead());
    const existing = [{ id: 'existing', title: { pl: 'Inna nazwa potrawy', en: 'Existing recipe title' }, aliases: ['Crispy rice salad'] }];
    const result = selectRecipeCandidate([candidate], existing, 'run', now);
    assert.equal(result.selected.automaticSelection?.basis, 'seasonal');
    assert.equal(result.selected.duplicateRecipeId, null);
    assert.equal(result.candidates[0].duplicateRecipeId, 'existing');
    assert.equal(result.candidates[0].selected, false);
    assert.equal(result.candidates[0].eligible, false);
});

test('all qualified duplicates and ambiguous dishes fall back to a new recipe', () => {
    const candidate = ranked(lead(), 'duplicate');
    const similar = ranked({ ...lead('Mushroom pasta', 'Makaron grzybowy'), sources: [] }, 'similar');
    const existing = [
        { id: 'rice', title: candidate.title },
        { id: 'pasta', title: { pl: 'Makaron grzybowy z tymiankiem', en: 'Mushroom pasta with thyme' } },
    ];
    const result = selectRecipeCandidate([candidate, similar], existing, 'run', now);
    assert.equal(result.selected.automaticSelection?.basis, 'seasonal');
    assert.equal(result.selected.duplicateRecipeId, null);
    assert.equal(result.selected.ambiguous, false);
    assert.equal(result.candidates[1].ambiguous, true);
    assert.equal(result.candidates.filter(item => item.selected).length, 1);
});

test('selection is deterministic, follows Warsaw calendar dates and does not mutate inputs', () => {
    const raw = lead();
    raw.sources = raw.sources.slice(0, 1);
    const candidate = ranked(raw);
    candidate.selected = true;
    const original = structuredClone(candidate);
    assert.deepEqual(selectRecipeCandidate([candidate], [], 'run', now), selectRecipeCandidate([candidate], [], 'run', now));
    assert.deepEqual(candidate, original);
    assert.deepEqual(selectRecipeCandidate([], [], 'run', new Date('2026-10-04T23:30:00Z')), selectRecipeCandidate([], [], 'run', new Date('2026-10-05T08:00:00Z')));
    assert.equal(warsawSeason(new Date('2026-08-31T22:30:00Z')), 'autumn');
    assert.equal(warsawSeason(new Date('2026-11-30T23:30:00Z')), 'winter');
    assert.equal(warsawSeason(new Date('2026-02-28T23:30:00Z')), 'spring');
    assert.equal(warsawSeason(new Date('2026-05-31T22:30:00Z')), 'summer');
});

test('selection resets previous flags and leaves exactly one selected candidate', () => {
    const first = ranked(lead(), 'first');
    const raw = lead('Tomato tart', 'Tarta pomidorowa');
    raw.sources = raw.sources.slice(0, 1);
    const second = ranked(raw, 'second');
    first.selected = true;
    second.selected = true;
    const result = selectRecipeCandidate([first, second], [], 'run', now);
    assert.equal(result.candidates.filter(candidate => candidate.selected).length, 1);
    assert.equal(result.selected.id, first.id);
    assert.equal(second.selected, true);
});

test('an exhausted reserve returns a real existing recipe without fabricating a new numbered dish', () => {
    const existing = seasonalRecipeIdeas(now).map((idea, index) => ({ id: `recipe-${index}`, title: idea.title, aliases: idea.aliases }));
    const result = selectRecipeCandidate([], existing, 'run', now);
    assert.equal(result.selected.automaticSelection?.basis, 'catalog');
    const reused = existing.find(recipe => recipe.id === result.selected.duplicateRecipeId);
    assert.ok(reused);
    assert.deepEqual(result.selected.title, reused.title);
    assert.deepEqual(result.selected.sources, []);
    assert.equal(result.selected.eligible, false);
    assert.equal(result.selected.ambiguous, false);
    assert.equal(result.candidates.filter(candidate => candidate.selected).length, 1);
    assert.deepEqual(result, selectRecipeCandidate([], existing.toReversed(), 'run', now));
});

test('an exhausted reserve of drafts with one locale reuses a real draft without creating a duplicate', () => {
    const existing = seasonalRecipeIdeas(now).map((idea, index) => ({ id: `draft-${index}`, title: { pl: idea.title.pl, en: '' } }));
    const result = selectRecipeCandidate([], existing, 'run', now);
    assert.equal(result.selected.automaticSelection?.basis, 'catalog');
    const reused = existing.find(recipe => recipe.id === result.selected.duplicateRecipeId);
    assert.ok(reused);
    assert.deepEqual(result.selected.title, { pl: reused.title.pl, en: reused.title.pl });
    assert.equal(result.selected.eligible, false);
    assert.deepEqual(result.selected.sources, []);
    assert.equal(result.candidates.filter(candidate => candidate.selected).length, 1);
});

test('catalog reuse prefers a recipe with both locales over unfinished drafts', () => {
    const existing = seasonalRecipeIdeas(now).map((idea, index) => ({ id: `draft-${index}`, title: { pl: idea.title.pl, en: '' } }));
    const ready = { id: 'ready', title: { pl: 'Ukończony przepis w książce', en: 'Completed cookbook recipe' } };
    const result = selectRecipeCandidate([], [...existing, ready], 'run', now);
    assert.equal(result.selected.automaticSelection?.basis, 'catalog');
    assert.equal(result.selected.duplicateRecipeId, ready.id);
    assert.deepEqual(result.selected.title, ready.title);
});

test('reserve selection searches beyond the first twenty ideas and checks both names and aliases', () => {
    const reserve = seasonalRecipeIdeas(now);
    const existing = reserve.slice(0, 30).map((idea, index) => ({ id: `recipe-${index}`, title: { pl: `Zapisana potrawa ${index}`, en: `Stored dish ${index}` }, aliases: [idea.title.pl, idea.title.en] }));
    const result = selectRecipeCandidate([], existing, 'run', now);
    assert.equal(result.selected.automaticSelection?.basis, 'seasonal');
    assert.ok(!reserve.slice(0, 30).some(idea => idea.title.en === result.selected.title.en));
    const [checked] = rankCandidates([result.selected], [], existing, 'run', now);
    assert.equal(checked.duplicateRecipeId, null);
    assert.equal(checked.ambiguous, false);
});

test('invalid discovery titles and unnamed catalog rows cannot prevent a recipe selection', () => {
    const invalid = ranked(lead());
    invalid.title = { pl: '???', en: '123' };
    const aliases = seasonalRecipeIdeas(now).map(idea => idea.title.en);
    const result = selectRecipeCandidate([invalid], [{ id: 'bad', title: { pl: '', en: '' }, aliases }], 'run', now);
    assert.equal(result.selected.automaticSelection?.basis, 'seasonal');
    assert.equal(result.selected.duplicateRecipeId, null);
    assert.equal(result.candidates.filter(candidate => candidate.selected).length, 1);
});
