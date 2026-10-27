import test from 'node:test';
import assert from 'node:assert/strict';
import { recipes } from '@/lib/recipes';
import type { EditorialContent } from '@/lib/editorial-types';
import { publicContentHash, publicationMetadata } from './store';
const content = (): EditorialContent => ({ recipe: structuredClone(recipes[0]), originalText: 'Private source', author: 'Editor', sources: [], photos: { ingredients: {}, steps: {} } });
test('a documented kitchen test changes the public badge hash and modification date', () => {
  const draft = content(); const tested = structuredClone(draft);
  tested.recipe.provenance.kitchenTested = true;
  tested.kitchenTest = { date: '2026-10-18', tester: 'Private tester', notes: 'Private test notes' };
  assert.notEqual(publicContentHash(draft), publicContentHash(tested));
  const privateEdit = structuredClone(tested); privateEdit.kitchenTest!.notes += ' More private notes';
  assert.equal(publicContentHash(tested), publicContentHash(privateEdit));
  assert.equal(publicationMetadata([{ recipeId: 'x', snapshot: draft, publishedAt: new Date('2026-10-17T04:00:00Z'), revision: 1 }, { recipeId: 'x', snapshot: tested, publishedAt: new Date('2026-10-18T04:00:00Z'), revision: 2 }])?.dateModified, '2026-10-18T04:00:00.000Z');
});
test('an unsupported kitchen-tested flag alone grants no public verification', () => {
  const draft = content(); const unsupported = structuredClone(draft); unsupported.recipe.provenance.kitchenTested = true;
  assert.equal(publicContentHash(draft), publicContentHash(unsupported));
});
