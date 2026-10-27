import test from 'node:test';
import assert from 'node:assert/strict';
import type { RecipeSummary } from './editorial-types';
import { isRecipeDraft, matchesRecipeFilter, recipeListCounts, recipeListStatus } from './editorial-presentation';

const recipe: RecipeSummary = { id: 'one', title: { pl: 'Zupa', en: 'Soup' }, image: '/photo.webp', category: 'main', totalMinutes: 20, editorialStatus: 'draft', publicationStatus: 'never_published', deletedAt: null, revision: 1, publishedRevision: null, updatedAt: '2026-10-16T12:00:00Z', updatedBy: 'Admin', languages: { pl: true, en: true }, hasUnpublishedChanges: true };

test('accepted, never-published recipes remain discoverable among drafts', () => {
  const accepted = { ...recipe, editorialStatus: 'approved' as const };
  assert.equal(isRecipeDraft(accepted), true);
  assert.equal(matchesRecipeFilter(accepted, 'draft'), true);
  assert.equal(recipeListStatus(accepted), 'Gotowy do publikacji');
});

test('dashboard counts and list filters describe the same recipes, including edited publications', () => {
  const rows: RecipeSummary[] = [recipe, { ...recipe, id: 'public', publicationStatus: 'published', hasUnpublishedChanges: false }, { ...recipe, id: 'edited-public', publicationStatus: 'published' }, { ...recipe, id: 'archive', editorialStatus: 'archived' }, { ...recipe, id: 'trash', deletedAt: '2026-10-16T12:00:00Z' }];
  const counts = recipeListCounts(rows);
  assert.deepEqual(counts, { active: 3, drafts: 2, published: 2 });
  assert.equal(rows.filter(item => matchesRecipeFilter(item, 'draft')).length, counts.drafts);
  assert.equal(rows.filter(item => matchesRecipeFilter(item, 'published')).length, counts.published);
  assert.equal(rows.filter(item => matchesRecipeFilter(item, 'all')).length, counts.active);
  assert.equal(recipeListStatus(rows[2]), 'Zmiany w szkicu');
});
