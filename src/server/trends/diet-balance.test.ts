import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateDiet, dietBalanceTarget, dietSelection, type TrendDietBalance } from './diet-balance';
import { rankCandidates, type RawCandidate } from './ranking';
import { seasonalRecipeIdeas, selectRecipeCandidate } from './selection';
import type { RecipeDietId } from '@/lib/recipe-diet';

const now = new Date('2026-10-25T10:00:00Z');
const counts = (meat: number, vegetarian: number, vegan: number): RecipeDietId[] => [
    ...Array<RecipeDietId>(meat).fill('meat'), ...Array<RecipeDietId>(vegetarian).fill('vegetarian'), ...Array<RecipeDietId>(vegan).fill('vegan'),
];
function lead(diet: RecipeDietId, title: string): RawCandidate {
    return { dishKey: title, title: { pl: title, en: title }, aliases: [], rationale: 'Praktyczne danie.', diet, sources: [] };
}

test('catalogue balancing counts combined plant categories against meat and seeks the missing plant category', () => {
    assert.equal(dietBalanceTarget({ catalog: counts(3, 25, 13), recent: counts(3, 4, 5) }).target, 'meat');
    assert.equal(dietBalanceTarget({ catalog: counts(20, 8, 2), recent: counts(6, 3, 3) }).target, 'vegan');
    assert.equal(dietBalanceTarget({ catalog: counts(20, 2, 8), recent: counts(6, 3, 3) }).target, 'vegetarian');
});

test('recent guard prevents long catch-up streaks and caps its evidence window at twelve', () => {
    const oldImbalance = counts(3, 25, 13);
    const plan = dietBalanceTarget({ catalog: oldImbalance, recent: [...counts(8, 2, 2), ...counts(0, 99, 0)] });
    assert.equal(plan.target, 'vegan');
    assert.deepEqual(plan.recentCounts, { meat: 8, vegetarian: 2, vegan: 2 });
    assert.equal(plan.recentWindow, 12);
    assert.match(plan.reason, /ostatnie wybory/);
});

test('balanced growth converges to 50% meat and 25% of each plant category without starving a group', () => {
    const balance: TrendDietBalance = { catalog: [], recent: [] };
    const chosen: RecipeDietId[] = [];
    for (let index = 0; index < 40; index++) {
        const target = dietBalanceTarget(balance).target;
        chosen.push(target); balance.catalog.push(target); balance.recent.unshift(target);
    }
    assert.deepEqual(dietBalanceTarget(balance).counts, { meat: 20, vegetarian: 10, vegan: 10 });
    for (let index = 0; index <= 32; index++) {
        const span = chosen.slice(index, index + 8);
        assert.ok(span.includes('meat') && span.includes('vegetarian') && span.includes('vegan'));
    }
});

test('unknown titles never become vegan by default and conflicting animal ingredient claims are skipped', () => {
    assert.equal(candidateDiet({ title: { pl: 'Zupa', en: 'Soup' } }), undefined);
    assert.equal(candidateDiet(lead('vegan', 'Chicken and tomato soup')), undefined);
    assert.equal(candidateDiet(lead('vegan', 'Vegan chicken and tomato soup')), 'vegan');
    assert.equal(candidateDiet(lead('vegan', 'Tomato and peanut butter soup')), 'vegan');
    assert.equal(candidateDiet(lead('vegan', 'Zupa z masłem orzechowym')), 'vegan');
    assert.equal(candidateDiet(lead('vegan', 'Roasted eggplant with butter beans')), 'vegan');
    assert.equal(candidateDiet(lead('vegetarian', 'Mushrooms with Parmesan')), undefined);
    assert.equal(candidateDiet(lead('meat', 'Mushrooms with Parmesan')), 'meat');
});

test('targeted discovery wins within its category, and a seasonal meal fills a missing category honestly', () => {
    const balance = { catalog: counts(1, 15, 4), recent: counts(3, 4, 5) };
    const vegetarian = rankCandidates([lead('vegetarian', 'Ricotta and leek tart')], [], [], 'plant', now)[0];
    const meat = rankCandidates([lead('meat', 'Turkey and bean soup')], [], [], 'meat', now)[0];
    assert.equal(selectRecipeCandidate([vegetarian, meat], [], 'run', now, balance).selected.id, meat.id);
    const reserve = selectRecipeCandidate([vegetarian], [], 'reserve', now, balance).selected;
    assert.equal(reserve.diet, 'meat');
    assert.equal(reserve.automaticSelection?.basis, 'seasonal');
    assert.equal(reserve.eligible, false);
    assert.deepEqual(reserve.sources, []);
    assert.equal(reserve.dietSelection?.fallback, false);
    assert.deepEqual(reserve.dietSelection?.counts, { meat: 1, vegetarian: 15, vegan: 4 });
});

test('exhausted target reserve falls back without relabelling or inventing trend evidence', () => {
    const balance = { catalog: counts(1, 15, 4), recent: counts(3, 4, 5) };
    const existing = seasonalRecipeIdeas(now).filter(idea => idea.diet === 'meat').map((idea, index) => ({ id: `existing-${index}`, title: idea.title }));
    const vegetarian = rankCandidates([lead('vegetarian', 'Ricotta and fennel tart')], [], [], 'plant', now)[0];
    const selected = selectRecipeCandidate([vegetarian], existing, 'run', now, balance).selected;
    assert.equal(selected.id, vegetarian.id);
    assert.equal(selected.diet, 'vegetarian');
    assert.equal(selected.dietSelection?.fallback, true);
    assert.equal(selected.eligible, false);
    assert.match(selected.dietSelection!.reason, /Brak nowej, bezpiecznej inspiracji/);
    assert.equal(dietSelection(balance, undefined).selected, null);
});

test('a contradictory vegan hint cannot displace an actual vegan reserve choice', () => {
    const balance = { catalog: counts(20, 10, 0), recent: counts(6, 3, 3) };
    const contradictory = rankCandidates([lead('vegan', 'Pork and bean stew')], [], [], 'bad', now)[0];
    const result = selectRecipeCandidate([contradictory], [], 'run', now, balance);
    assert.notEqual(result.selected.id, contradictory.id);
    assert.equal(result.selected.diet, 'vegan');
    assert.equal(result.selected.dietSelection?.target, 'vegan');
});
