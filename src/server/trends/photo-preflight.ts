import { isStepPhotoRequired } from '@/lib/step-photo-selection';
import type { EditorialContent } from '@/lib/editorial-types';
import { heroPresentationProfile, resolveHeroPresentationForBrief } from '@/lib/hero-presentation';
import { trendRunLimits } from '@/lib/trend-polling';
import { AiError } from '@/server/ai/errors';
import { currentIngredientStyleProfile } from '@/server/ai/ingredient-profile';
import { preflightPhotoPrompts, type PhotoPromptSlot } from '@/server/ai/photo-preflight';

export const preparationPhotoBriefs = {
  hero: 'Fotografia gotowej potrawy: premium cookbook editorial photography, natural daylight, warm ivory background, true ingredients and appetising natural texture.',
  ingredient: 'Fotografia pojedynczego składnika w postaci wymaganej przez zaakceptowany przepis, spokojne światło dzienne i spójna estetyka książki kucharskiej.',
  step: 'Fotografia makro najważniejszego detalu tego kroku: prawidłowa konsystencja, stopień obróbki lub technika, zgodnie z pełnym zaakceptowanym przepisem i zdjęciami składników.',
};

export const legacyTrendPhotoBriefs = {
  hero: preparationPhotoBriefs.hero,
  ingredient: 'Fotografia pojedynczego składnika w postaci wymaganej przez przepis, spokojne światło dzienne i styl zgodny ze zdjęciem głównym.',
  step: 'Fotografia makro najważniejszego detalu tego kroku: prawidłowa konsystencja, stopień obróbki lub technika. Styl zgodny ze zdjęciem głównym.',
};

export function preflightTrendPhotos(content: EditorialContent, maxInputBytes: number, additional?: Omit<PhotoPromptSlot, 'brief'> & { brief?: string }, briefs = preparationPhotoBriefs) {
  const steps = content.recipe.steps.filter(item => isStepPhotoRequired(content, item.id));
  const count = 1 + content.recipe.ingredients.length + steps.length;
  if (count > trendRunLimits.photographs)
    throw new AiError(422, 'TREND_PACKET_TOO_LARGE', `Kompletny przepis wymaga ${count} fotografii; limit automatu wynosi ${trendRunLimits.photographs}. Zachowano wszystkie etapy w szkicu. Przygotuj zdjęcia ręcznie lub sprawdź podział przepisu.`);
  const slots: PhotoPromptSlot[] = [
    ...content.recipe.ingredients.filter(item => !content.photos.ingredients[item.id]?.src).map(item => ({ kind: 'ingredient' as const, targetId: item.id, brief: briefs.ingredient })),
    ...steps.filter(item => !content.photos.steps[item.id]?.src).map(item => ({ kind: 'step' as const, targetId: item.id, brief: briefs.step })),
    ...(!content.recipe.image ? [{ kind: 'hero' as const, brief: briefs.hero }] : []),
  ];
  if (additional) slots.push({ ...additional, brief: additional.brief ?? briefs[additional.kind] });
  if (!slots.length) return;
  const heroSlot = slots.find(slot => slot.kind === 'hero');
  const presentation = heroSlot ? resolveHeroPresentationForBrief(content.recipe, heroSlot.brief) : null;
  const input: EditorialContent = { ...content, aiPhotography: { ...content.aiPhotography, ingredientStyleProfile: currentIngredientStyleProfile, heroStyleProfile: heroPresentationProfile,
    ...(presentation ? { heroPresentationOverride: presentation } : {}) } };
  preflightPhotoPrompts(input, slots, maxInputBytes);
}
