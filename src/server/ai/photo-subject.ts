import type { EditorialContent } from '@/lib/editorial-types';
import type { AiPhotoKind } from '@/lib/ai-photo-batch-types';
import { ingredientImageIdentity } from './ingredient-profile';
import { resolveHeroPresentation } from '@/lib/hero-presentation';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function photoSubjectSnapshot(content: EditorialContent, kind: 'hero' | 'step' = 'hero'): string {
  const { title, description, baseServings, ingredients, steps, storage } = content.recipe;
  const presentation = resolveHeroPresentation(content.recipe);
  return canonical({ title, description, baseServings, ingredients, steps,
    ...(kind === 'hero' ? { storage, heroPresentation: presentation } : { finalAppearance: presentation?.finalAppearance ?? null }) });
}

/** Photo-only revisions do not change food. Appearance also constrains step continuity; a vessel-only change affects the hero. */
export function samePhotoSubject(source: EditorialContent, current: EditorialContent, kind: AiPhotoKind, targetId: string | null): boolean {
  if (source.recipe.id !== current.recipe.id) return false;
  if (kind === 'ingredient') {
    const original = source.recipe.ingredients.find(item => item.id === targetId);
    const ingredient = current.recipe.ingredients.find(item => item.id === targetId);
    return Boolean(original && ingredient && ingredientImageIdentity(original).key === ingredientImageIdentity(ingredient).key);
  }
  if (kind === 'step' && (!source.recipe.steps.some(item => item.id === targetId) || !current.recipe.steps.some(item => item.id === targetId))) return false;
  return photoSubjectSnapshot(source, kind) === photoSubjectSnapshot(current, kind);
}
