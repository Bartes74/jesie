import assert from 'node:assert/strict';
import test from 'node:test';
import { recipes } from './recipes';
import { getRecipeImageVariants, recipeImageVersion } from './recipe-image-variants';

test('finished-dish variants use stable descriptive URLs and all five publication sizes', () => {
  const recipe = recipes[0];
  const variants = getRecipeImageVariants(recipe);
  assert.deepEqual(Object.keys(variants), ['classic', 'landscape', 'square', 'social', 'pinterest']);
  assert.deepEqual([variants.classic.width, variants.classic.height], [1600, 1200]);
  assert.deepEqual([variants.landscape.width, variants.landscape.height], [1600, 900]);
  assert.deepEqual([variants.square.width, variants.square.height], [1200, 1200]);
  assert.deepEqual([variants.social.width, variants.social.height], [1200, 630]);
  assert.deepEqual([variants.pinterest.width, variants.pinterest.height], [1000, 1500]);
  assert.match(variants.classic.url, /\/cytrynowe-tagliatelle-gotowe-1600x1200\.webp$/);
  assert.deepEqual(getRecipeImageVariants(structuredClone(recipe)), variants);
  assert.notEqual(getRecipeImageVariants({ ...recipe, image: '/images/another-dish.webp' }).classic.url, variants.classic.url);
});

test('filenames normalize Polish names and cannot escape the media route', () => {
  const variants = getRecipeImageVariants({ id: 'safe-id', image: '/images/safe.webp', slug: { pl: '../Żółć & łosoś?', en: 'salmon' } });
  assert.match(variants.social.url, /\/zolc-losos-gotowe-1200x630\.webp$/);
  assert.match(recipeImageVersion('/images/safe.webp'), /^v1-[a-f0-9]{32}$/);
  assert.notEqual(recipeImageVersion('/media/a'), recipeImageVersion('/media/b'));
});
