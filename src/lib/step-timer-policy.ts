import type { RecipeStep } from './recipes';

/** A browser cooking timer is for a kitchen session, not overnight maturation. */
export const maxStepTimerMinutes = 360;
const normalise = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').replace(/ł/gu, 'l').toLowerCase();
const overnight = /\b(?:overnight|over night|all night|through the night|przez noc|na noc|cala noc|calej nocy)\b/u;
const negative = /\b(?:not|never|avoid|without|nie|nigdy|unikaj|bez)\b|\bdon['’]t\b/u;
const activeCookingTitle = /\b(?:bake|cook|braise|roast|simmer|boil|fry|reduce|piecz|upiecz|gotuj|ugotuj|dus|smaz|podsmaz|redukuj|praz)\b/u;

export function getStepTimerMinutes(step: Pick<RecipeStep, 'title' | 'text' | 'timerMinutes'>): number | null {
  const minutes = step.timerMinutes;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || minutes > maxStepTimerMinutes) return null;
  const title = normalise(`${step.title.pl} ${step.title.en}`);
  const text = normalise(`${step.text.pl}. ${step.text.en}`);
  const overnightWait = text.split(/[.!?;\n]/u).some(clause => overnight.test(clause) && !negative.test(clause));
  // Short checkpoints in a mixed instruction can remain useful. Do not infer
  // timing from unrelated tips, storage advice, or another step in the recipe.
  if (minutes >= 120 && overnightWait && !activeCookingTitle.test(title)) return null;
  return minutes;
}

export function stepTimerIssue(step: Pick<RecipeStep, 'title' | 'text' | 'timerMinutes'>): string | null {
  return step.timerMinutes === undefined || getStepTimerMinutes(step) !== null ? null
    : 'Minutnik służy do bieżącego gotowania, maksymalnie 6 godzin. Całą noc lub dobę oczekiwania zapisz w instrukcji i podziale czasu, bez minutnika.';
}
