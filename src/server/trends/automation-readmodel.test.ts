import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticRecipeForDay, projectLatestResearch } from './automated-publication';

test('automatic eligibility is disabled even when a caller requests publication locks', async () => {
  let locks = 0;
  const query = {
    from: () => query, innerJoin: () => query, where: () => query,
    for: () => { locks++; return Promise.resolve([]); },
    then: (resolve: (rows: []) => unknown) => resolve([]),
  };
  const tx = { select: () => query } as unknown as Parameters<typeof automaticRecipeForDay>[0];
  assert.equal(await automaticRecipeForDay(tx, '2026-10-19', new Date('2026-10-18T12:00:00Z'), false), null);
  assert.equal(locks, 0);
  assert.equal(await automaticRecipeForDay(tx, '2026-10-19', new Date('2026-10-18T12:00:00Z')), null);
  assert.equal(locks, 0);
});

const researchRun = { id: 'run', date: '2026-10-20', recipeId: 'recipe', status: 'awaiting_review' as const, error: 'Treść jest gotowa do ręcznej oceny.' };
const researchCandidate = { title: { pl: 'Dawna nazwa z researchu', en: 'Old research title' }, eligible: true };
const currentRecipe = { title: { pl: 'Aktualna zupa', en: 'Current soup' }, publicationStatus: 'never_published' as const, editorialStatus: 'draft' as const, deleted: false };

test('published current recipe overrides stale research review status and error without claiming an actor', () => {
  const projected = projectLatestResearch(researchRun, researchCandidate, { ...currentRecipe, publicationStatus: 'published' }, true);
  assert.equal(projected.status, 'published');
  assert.equal(projected.title, 'Aktualna zupa');
  assert.equal(projected.reason, 'Przepis został już opublikowany.');
  assert.equal(projected.confirmedTrend, true);
});

test('a current draft still reports its research review state and reason', () => {
  const projected = projectLatestResearch(researchRun, researchCandidate, currentRecipe, false);
  assert.equal(projected.status, 'awaiting_review');
  assert.equal(projected.reason, researchRun.error);
  assert.equal(projected.title, currentRecipe.title.pl);
  assert.equal(projectLatestResearch(researchRun, researchCandidate, null, false).title, researchCandidate.title.pl);
});

test('deleted and archived recipes no longer appear to await research review', () => {
  const deleted = projectLatestResearch(researchRun, researchCandidate, { ...currentRecipe, deleted: true }, false);
  assert.equal(deleted.status, 'deleted');
  assert.match(deleted.reason!, /Koszu/);
  const archived = projectLatestResearch(researchRun, researchCandidate, { ...currentRecipe, editorialStatus: 'archived' }, false);
  assert.equal(archived.status, 'archived');
  assert.match(archived.reason!, /archiwum/);
});
