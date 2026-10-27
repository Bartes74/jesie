import type { EditorialContent } from './editorial-types';
import type { Ingredient, RecipeStep } from './recipes';

export type RecipeCorrection = { kind: 'ingredient'; item: Ingredient } | { kind: 'step'; item: RecipeStep };
const localised = (value: unknown): value is { pl: string; en: string } => Boolean(value && typeof value === 'object' && 'pl' in value && typeof value.pl === 'string' && 'en' in value && typeof value.en === 'string');
export function readStoredRecipeCorrection(raw: string | null, target: { kind: RecipeCorrection['kind']; id: string }): { revision: number; correction: RecipeCorrection } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw); const correction = value?.correction; const item = correction?.item;
    if (!Number.isSafeInteger(value.revision) || value.revision < 1 || correction?.kind !== target.kind || item?.id !== target.id) return null;
    if (correction.kind === 'step') {
      if (!localised(item.title) || !localised(item.text) || item.timerMinutes !== undefined && (!Number.isSafeInteger(item.timerMinutes) || item.timerMinutes < 1 || item.timerMinutes > 10080)) return null;
    } else {
      if (!localised(item.name) || !localised(item.group) || item.note !== undefined && !localised(item.note) || !['linear', 'fixed'].includes(item.scaling) || ![null, 'g', 'ml', 'count', 'tsp', 'tbsp'].includes(item.unit)) return null;
      const amount = item.amount;
      if (!amount || (amount.kind === 'exact' ? typeof amount.value !== 'string' : amount.kind === 'range' ? typeof amount.min !== 'string' || typeof amount.max !== 'string' : amount.kind === 'qualitative' ? !localised(amount.text) : true)) return null;
    }
    return { revision: value.revision, correction };
  } catch { return null; }
}
export function applyRecipeCorrection(content: EditorialContent, correction: RecipeCorrection): EditorialContent {
  const next = structuredClone(content);
  if (correction.kind === 'ingredient') {
    const index = next.recipe.ingredients.findIndex(item => item.id === correction.item.id);
    if (index < 0) throw new Error('Składnik nie istnieje w bieżącej wersji.');
    next.recipe.ingredients[index] = structuredClone(correction.item);
  } else {
    const index = next.recipe.steps.findIndex(item => item.id === correction.item.id);
    if (index < 0) throw new Error('Krok nie istnieje w bieżącej wersji.');
    next.recipe.steps[index] = structuredClone(correction.item);
  }
  return next;
}
