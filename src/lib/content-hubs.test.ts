import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipes } from './recipes';
import { toPublicRecipe } from './recipe-presentation';
import { collections, collectionRecipes, getPublishedCollections, getRelatedRecipes } from './content-hubs';

test('quick dinners use the complete elapsed time and dinner category, never just active time', () => {
  const recipe = toPublicRecipe(structuredClone(recipes[0]));
  recipe.primaryCategory = 'main'; recipe.times = { active: 10, cooking: 20, rest: 20, total: 50 };
  assert.equal(collectionRecipes(collections[0], [recipe]).length, 0);
  recipe.times.total = 30;
  assert.equal(collectionRecipes(collections[0], [recipe]).length, 1);
  recipe.primaryCategory = 'dessert';
  assert.equal(collectionRecipes(collections[0], [recipe]).length, 0);
});
test('curated collections stay unpublished below five real published recipes', () => {
  const fixture = Array.from({ length: 5 }, (_, i) => ({ ...toPublicRecipe(recipes[0]), id: `recipe-${i}`, seo: { collectionIds: ['one-pot'] } }));
  assert.equal(getPublishedCollections(fixture.slice(0, 4), 'pl').some(item => item.id === 'one-pot'), false);
  assert.equal(getPublishedCollections(fixture, 'pl').find(item => item.id === 'one-pot')?.path, '/pl/kolekcje/jedna-patelnia-lub-garnek');
});
test('related recipes exclude self, unavailable IDs and duplicate curated/fallback results', () => {
  const fixture = recipes.map(toPublicRecipe);
  fixture[0].seo = { relatedRecipeIds: [fixture[0].id, 'missing', fixture[1].id] };
  const related = getRelatedRecipes(fixture[0], fixture);
  assert.equal(related[0].id, fixture[1].id);
  assert(!related.some(item => item.id === fixture[0].id));
  assert.equal(new Set(related.map(item => item.id)).size, related.length);
});
