import test from 'node:test';
import assert from 'node:assert/strict';
import { recipes } from '@/lib/recipes';
import type { EditorialContent } from '@/lib/editorial-types';
import { resolveHeroPresentation } from '@/lib/hero-presentation';
import { samePhotoSubject } from './photo-subject';

function content(): EditorialContent {
  return { recipe: structuredClone(recipes[0]), originalText: '', author: 'Editor', sources: [], photos: { ingredients: {}, steps: {} } };
}

test('vessel-only changes invalidate the hero while finished food appearance also invalidates steps', () => {
  const source = content();
  source.recipe.heroPresentation = resolveHeroPresentation(source.recipe)!;
  const current = content();
  assert(samePhotoSubject(source, current, 'hero', null));
  current.recipe.heroPresentation = { ...structuredClone(source.recipe.heroPresentation), container: 'jar' };
  assert.equal(samePhotoSubject(source, current, 'hero', null), false);
  assert(samePhotoSubject(source, current, 'step', source.recipe.steps[0].id));
  assert(samePhotoSubject(source, current, 'ingredient', source.recipe.ingredients[0].id));
  current.recipe.heroPresentation = structuredClone(source.recipe.heroPresentation);
  current.recipe.heroPresentation.finalAppearance.en = 'A different finished texture.';
  assert.equal(samePhotoSubject(source, current, 'hero', null), false);
  assert.equal(samePhotoSubject(source, current, 'step', source.recipe.steps[0].id), false);
  assert(samePhotoSubject(source, current, 'ingredient', source.recipe.ingredients[0].id));
});

test('step compatibility rejects a different base batch, ingredient quantity or approved food colour', () => {
  const source = content();
  source.recipe.heroPresentation = resolveHeroPresentation(source.recipe)!;
  for (const change of [
    (current: EditorialContent) => { current.recipe.baseServings += 1; },
    (current: EditorialContent) => { current.recipe.ingredients[0].amount = { kind: 'exact', value: '99' }; },
    (current: EditorialContent) => { current.recipe.heroPresentation!.finalAppearance.pl += ' Wyraźne sojowe zabarwienie.'; },
  ]) {
    const current = structuredClone(source);
    change(current);
    assert.equal(samePhotoSubject(source, current, 'step', source.recipe.steps[0].id), false);
  }
});

test('storage context affects the hero while photo-only revisions remain compatible', () => {
  const source = content();
  const current = structuredClone(source);
  current.recipe.image = '/media/new-photo';
  assert(samePhotoSubject(source, current, 'hero', null));
  current.recipe.storage.en += ' Bottle the finished product.';
  assert.equal(samePhotoSubject(source, current, 'hero', null), false);
  assert(samePhotoSubject(source, current, 'step', source.recipe.steps[0].id));
});
