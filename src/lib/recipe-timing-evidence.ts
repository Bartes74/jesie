import type { RecipeStep } from './recipes';

const normalise = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').replace(/ł/gu, 'l').toLowerCase();
const number = String.raw`\d+(?:[.,]\d+)?`;
const duration = new RegExp(String.raw`(${number})(?:\s*[–—-]\s*${number})?\s*(minut(?:ach|ami|y|e|a)?|minutes?|mins?|min|godzin(?:ach|y|e|a)?|godz\.?|hours?|hrs?|h|dni|dzien|days?)\b`, 'gu');
const wait = /\b(?:chlodz|ostudz|studz|odstaw|marynuj|pozostaw|namaczaj|fermentuj|refrigerate|chill|cool|rest|marinate|soak|prove|proof|mature)\b/gu;
const negative = /\b(?:nie|nigdy|not|never|avoid|without|don't|do not)\b/u;
const deadline = /\b(?:w ciagu|najpozniej|within|no later than|up to|nie dluzej niz)\b/u;
const heat = /\b(?:piecz|gotuj|dus|smaz|bake|cook|braise|simmer|boil|fry|oven|piekarnik\w*)\b/u;

/** Conservative lower bounds from clear waiting instructions, never storage advice.
 * This supplements a reviewed schedule; it does not estimate culinary readiness.
 * Ambiguous prose is deliberately left to the generator/editor instead of being
 * converted into an invented duration or a new timer.
 */
export function explicitStepWaitMinimum(step: Pick<RecipeStep, 'title' | 'text'>): number {
  let minimum = 0;
  for (const locale of ['pl', 'en'] as const) {
    const clauses = normalise(step.text[locale]).split(/[;!?\n]|\.(?:\s|$)/u);
    for (const clause of clauses) {
      if (negative.test(clause) || deadline.test(clause)) continue;
      for (const match of clause.matchAll(wait)) {
        const tail = clause.slice(match.index! + match[0].length);
        const first = [...tail.matchAll(duration)][0];
        if (!first || first.index! > 100 || heat.test(tail.slice(0, first.index))) continue;
        const value = Number(first[1].replace(',', '.'));
        const unit = first[2];
        const minutes = /^(?:godz|hour|hr|h)/u.test(unit) ? value * 60 : /^(?:dni|dzien|day)/u.test(unit) ? value * 1440 : value;
        if (minutes >= 60) minimum = Math.max(minimum, minutes);
      }
    }
  }
  return minimum;
}

export function plannedStepRestMinutes(tasks: readonly { stepId: string; kind: string; startMinute: number; durationMinutes: number }[], stepId: string) {
  const intervals = tasks.filter(task => task.stepId === stepId && task.kind === 'rest').map(task => [task.startMinute, task.startMinute + task.durationMinutes])
    .sort((a, b) => a[0] - b[0]);
  let minutes = 0, end = -Infinity;
  for (const [start, finish] of intervals) { minutes += Math.max(0, finish - Math.max(start, end)); end = Math.max(end, finish); }
  return minutes;
}
