import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditorialContent } from './editorial-types';
import { recipes } from './recipes';
import { createStepPhotoOmission, isStepPhotoRequired, presentedStepPhoto, sameStepPhotoSelection } from './step-photo-selection';

function fixture(): EditorialContent {
  const recipe = structuredClone(recipes[0]);
  recipe.steps = [{ id: 'cook', title: { pl: 'Gotuj', en: 'Cook' }, text: { pl: 'Gotuj do miękkości.', en: 'Cook until tender.' } },
    { id: 'serve', title: { pl: 'Podaj', en: 'Serve' }, text: { pl: 'Podaj od razu.', en: 'Serve immediately.' } }];
  return { recipe, author: 'Editor', originalText: '', sources: [], photos: { ingredients: {}, steps: {} } };
}
const reason = { pl: 'Ten sam stan pokazuje poprzednie zdjęcie.', en: 'The preceding photograph shows the same state.' };

test('reviewed omissions apply to exact bilingual instructions and expire after a method edit', () => {
  const content = fixture();
  assert.equal(isStepPhotoRequired(content, 'cook'), true);
  content.photos.omittedSteps = { cook: createStepPhotoOmission(content.recipe.steps[0], reason) };
  assert.equal(isStepPhotoRequired(content, 'cook'), false);
  content.recipe.steps[0].text.pl += ' Sprawdź widelcem.';
  assert.equal(isStepPhotoRequired(content, 'cook'), true);
  assert.throws(() => createStepPhotoOmission(content.recipe.steps[0], { pl: 'Powód', en: '' }));
});

test('review changes fence captured packages even for a naturally optional serving step', () => {
  const captured = fixture(), current = structuredClone(captured);
  assert.equal(isStepPhotoRequired(current, 'serve'), false);
  current.photos.omittedSteps = { serve: createStepPhotoOmission(current.recipe.steps[1], reason) };
  assert.equal(sameStepPhotoSelection(captured, current), false);
  const reviewed = structuredClone(current);
  reviewed.photos.omittedSteps!.serve.reason.pl = 'Zmienione uzasadnienie, bez zmiany decyzji.';
  assert.equal(sameStepPhotoSelection(current, reviewed), true);
  current.photos.omittedSteps = {};
  assert.equal(sameStepPhotoSelection(captured, current), true);
});

test('explicit photo selection never restores a removed static atlas crop, while existing optional photos remain visible', () => {
  const recipe = structuredClone(recipes[0]);
  const stepId = recipe.steps[0].id;
  assert(presentedStepPhoto(recipe, stepId));
  assert.equal(presentedStepPhoto({ ...recipe, photos: { steps: {} } }, stepId), undefined);
  const content = fixture();
  const photo = { src: '/images/step-review.webp', columns: 1, rows: 1, index: 0, alt: reason };
  assert.equal(presentedStepPhoto({ ...content.recipe, photos: { steps: { serve: photo } } }, 'serve'), photo);
});
