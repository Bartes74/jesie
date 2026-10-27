import type { EditorialContent } from '@/lib/editorial-types';
import { AiError } from './errors';
import { imageBrief, imagePromptMaxCharacters } from './image-prompt';
import { ProviderError } from './provider-error';

export type PhotoPromptSlot = { kind: 'hero' | 'ingredient' | 'step'; targetId?: string | null; brief: string; withoutHeroReference?: boolean };

/** Validate the complete planned package before reserving or admitting a paid photograph. */
export function preflightPhotoPrompts(input: EditorialContent, slots: readonly PhotoPromptSlot[], maxInputBytes = 60_000): void {
  if (!slots.length) return;
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > maxInputBytes)
    throw new AiError(422, 'PHOTO_INPUT_TOO_LARGE', `Zachowano kompletny szkic. Treść przekracza limit ${maxInputBytes} bajtów wejścia fotografii. Nie rozpoczęto nowych zdjęć; sprawdź treść lub przygotuj fotografie ręcznie.`);
  for (const slot of slots) {
    const index = slot.kind === 'step' ? input.recipe.steps.findIndex(step => step.id === slot.targetId) : -1;
    const label = slot.kind === 'hero' ? 'Zdjęcie gotowej potrawy' : slot.kind === 'step' ? `Zdjęcie kroku ${index + 1}` : `Zdjęcie składnika ${input.recipe.ingredients.findIndex(item => item.id === slot.targetId) + 1}`;
    const captured = slot.withoutHeroReference ? { ...input, recipe: { ...input.recipe, image: '' } } : input;
    try { imageBrief(slot.kind, captured, slot.targetId ?? null, slot.brief); }
    catch (error) {
      const missingIngredient = error instanceof Error ? /^Unknown ingredient token ([a-zA-Z0-9_-]{1,100}) in step ([a-zA-Z0-9_-]{1,100})$/.exec(error.message) : null;
      let reason: string;
      if (missingIngredient) {
        const sourceIndex = input.recipe.steps.findIndex(step => step.id === missingIngredient[2]);
        reason = `${sourceIndex >= 0 ? `krok ${sourceIndex + 1}` : 'instrukcja kroku'} odwołuje się do brakującego składnika „${missingIngredient[1]}”; popraw listę składników lub odwołanie w instrukcji`;
      } else if (error instanceof ProviderError) {
        reason = error.code === 'AI_INPUT_TOO_LARGE' ? `pełny prompt przekracza limit ${imagePromptMaxCharacters} znaków` : error.message;
      } else throw error;
      throw new AiError(422, 'PHOTO_PROMPT_INVALID', `${label}: ${reason}. Zachowano kompletny szkic i dotychczasowe zdjęcia. Nie rozpoczęto nowych fotografii; popraw ustawienia lub przygotuj zdjęcia ręcznie.`);
    }
  }
}
