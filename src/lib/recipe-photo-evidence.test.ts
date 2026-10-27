import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EditorialContent } from './editorial-types';
import { recipes } from './recipes';
import { getStepImage } from './recipe-media';
import { compatibleRecipePhotoSource, isReviewedWrongStepPhoto, recipePhotoAssignmentIssues, recipePhotoCropKey, recipePhotoCulinarySignature, recipePhotoSource } from './recipe-photo-evidence';

const content = (): EditorialContent => ({ recipe: structuredClone(recipes[0]), author: '', originalText: '', sources: [], photos: { ingredients: {}, steps: {} } });
const media = (src: string) => ({ src, columns: 1, rows: 1, index: 0, alt: { pl: 'Detal', en: 'Detail' } });

test('static hero and step crops retain their audited recipe and stage', () => {
  const input = content(), [first, second] = input.recipe.steps;
  input.photos.steps[first.id] = getStepImage(input.recipe.id, first.id);
  assert.deepEqual(recipePhotoAssignmentIssues(input), []);
  input.photos.steps[first.id] = getStepImage(input.recipe.id, second.id);
  assert(recipePhotoAssignmentIssues(input).some(issue => issue.field === `steps.${first.id}.photo`));
  input.photos.steps[first.id] = getStepImage(recipes[1].id, recipes[1].steps[0].id);
  assert(recipePhotoAssignmentIssues(input).length > 0);
  input.photos.steps = {}; input.recipe.image = recipes[1].image;
  assert(recipePhotoAssignmentIssues(input).some(issue => issue.field === 'image'));
});

test('exact culinary clones can share evidence despite renamed recipe, title and ingredient IDs', () => {
  const source = content(), target = content();
  target.recipe.id = 'culinary-clone'; target.recipe.title = { pl: 'Nowy tytuł', en: 'New title' };
  target.recipe.ingredients.forEach(ingredient => {
    const previous = ingredient.id; ingredient.id = `clone-${previous}`;
    for (const step of target.recipe.steps) for (const locale of ['pl', 'en'] as const) step.text[locale] = step.text[locale].replaceAll(`{{${previous}}}`, `{{${ingredient.id}}}`);
  });
  const oldStep = source.recipe.steps[0].id; target.recipe.steps[0].id = 'clone-step';
  assert.equal(recipePhotoCulinarySignature(source.recipe), recipePhotoCulinarySignature(target.recipe));
  const evidence = recipePhotoSource(source.recipe, 'step', oldStep, '/media/source')!;
  assert(compatibleRecipePhotoSource(evidence, target.recipe, 'step', 'clone-step'));
  target.recipe.steps[0].text.en += ' Roast until browned.';
  assert(!compatibleRecipePhotoSource(evidence, target.recipe, 'step', 'clone-step'));
});

test('same-slot edits retain evidence without requiring exact editorial wording', () => {
  const input = content(), step = input.recipe.steps[0];
  const source = recipePhotoSource(input.recipe, 'step', step.id, '/media/source')!;
  input.recipe.title.pl = 'Poprawiony tytuł'; step.title.pl = 'Dokładniejszy tytuł kroku'; step.text.pl += ' Pracuj starannie.';
  assert(compatibleRecipePhotoSource(source, input.recipe, 'step', step.id));
  assert(!compatibleRecipePhotoSource(source, input.recipe, 'step', input.recipe.steps[1].id));
  assert(!compatibleRecipePhotoSource(source, input.recipe, 'hero', null));
});

test('registered hero cannot masquerade as a step and media requires immutable evidence', () => {
  const input = content(), first = input.recipe.steps[0].id;
  const src = '/media/11111111-1111-4111-8111-111111111111';
  input.recipe.image = src; input.photos.steps[first] = media(src);
  const source = recipePhotoSource(input.recipe, 'hero', null, src)!;
  const known = new Map([[recipePhotoCropKey(media(src)), source]]);
  assert(recipePhotoAssignmentIssues(input, known).some(issue => issue.field === `steps.${first}.photo`));
  assert(recipePhotoAssignmentIssues(input, new Map()).some(issue => issue.field === 'image'));
});

test('distinct steps cannot use the same crop but independent atlas crops remain valid', () => {
  const input = content(), [first, second] = input.recipe.steps;
  input.photos.steps[first.id] = getStepImage(input.recipe.id, first.id);
  input.photos.steps[second.id] = getStepImage(input.recipe.id, second.id);
  assert.deepEqual(recipePhotoAssignmentIssues(input), []);
  input.photos.steps[second.id] = structuredClone(input.photos.steps[first.id]);
  const issues = recipePhotoAssignmentIssues(input);
  assert(issues.some(issue => issue.field === `steps.${first.id}.photo`));
  assert(issues.some(issue => issue.field === `steps.${second.id}.photo`));
});

test('reviewed wrong-state source exclusion uses exact crop, leaving useful atlas neighbours intact', () => {
  const bad = { src: '/images/steps-pumpkin-soup.webp', columns: 2, rows: 3, index: 4 };
  assert(isReviewedWrongStepPhoto(bad));
  assert(!isReviewedWrongStepPhoto({ ...bad, index: 3 }));
  assert(isReviewedWrongStepPhoto(media('/media/aa81db26-6a98-41e7-8f2e-b8a98fd0e325')));
  assert(!isReviewedWrongStepPhoto(media('/media/f683c02d-d6d8-48f6-9566-b677ae010644')), 'A redundant serving frame is handled by an omission, not globally denied.');
});
