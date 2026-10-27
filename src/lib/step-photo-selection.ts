import type { EditorialContent, RecipePhotos, StepPhotoOmission } from './editorial-types';
import type { Localised, Recipe, RecipeStep } from './recipes';
import { getStepImage } from './recipe-media';
import { stepPhotoPlan } from './step-photo-plan';

/** A review applies only to this exact instruction, never a later replacement. */
export function stepPhotoSignature(step: RecipeStep): string {
  const text = JSON.stringify([step.id, step.title.pl, step.title.en, step.text.pl, step.text.en, step.timerMinutes ?? null]);
  let first = 2166136261, second = 2246822519;
  for (let index = 0; index < text.length; index++) {
    first = Math.imul(first ^ text.charCodeAt(index), 16777619);
    second = Math.imul(second ^ text.charCodeAt(index), 3266489917);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function createStepPhotoOmission(step: RecipeStep, reason: Localised): StepPhotoOmission {
  if (!reason.pl.trim() || !reason.en.trim()) throw new Error('STEP_PHOTO_OMISSION_REASON_REQUIRED');
  return { signature: stepPhotoSignature(step), reason: structuredClone(reason) };
}

export function validStepPhotoOmission(content: Pick<EditorialContent, 'recipe' | 'photos'>, stepId: string): StepPhotoOmission | null {
  const step = content.recipe.steps.find(item => item.id === stepId), omission = content.photos.omittedSteps?.[stepId];
  return step && omission?.signature === stepPhotoSignature(step) && omission.reason.pl.trim() && omission.reason.en.trim() ? omission : null;
}

export function isStepPhotoRequired(content: Pick<EditorialContent, 'recipe' | 'photos'>, stepId: string): boolean {
  return Boolean(stepPhotoPlan(content.recipe, stepId)?.required && !validStepPhotoOmission(content, stepId));
}

/** An explicit published photo selection must never resurrect a removed atlas frame. */
export function presentedStepPhoto(recipe: Pick<Recipe, 'id' | 'steps'> & { photos?: Pick<RecipePhotos, 'steps'> }, stepId: string) {
  if (recipe.photos) return recipe.photos.steps[stepId];
  return stepPhotoPlan(recipe, stepId)?.required ? getStepImage(recipe.id, stepId) : undefined;
}

/** Fence pending packages after a reviewed selection changes, even on an optional step. */
export function sameStepPhotoSelection(first: Pick<EditorialContent, 'recipe' | 'photos'>, second: Pick<EditorialContent, 'recipe' | 'photos'>): boolean {
  const selection = (content: Pick<EditorialContent, 'recipe' | 'photos'>) => content.recipe.steps.flatMap(step => {
    const omission = validStepPhotoOmission(content, step.id);
    return omission ? [[step.id, omission.signature]] : [];
  }).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(selection(first)) === JSON.stringify(selection(second));
}
