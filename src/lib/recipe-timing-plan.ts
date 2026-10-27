import { z } from 'zod';
import type { Recipe } from './recipes';

export const recipeTimingVersion = 'dependency-timing-v1';

const reference = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const explanation = z.string().min(1).max(500).regex(/\S/);
const minute = z.number().min(0).max(100_000);

/** Plain JSON-schema-compatible shape; cross-field checks belong to inspection. */
export const recipeTimingPlanSchema = z.object({
  resources: z.array(reference).max(100),
  assumptions: z.array(explanation).min(1).max(30),
  excludedSteps: z.array(z.object({ stepId: reference, reason: explanation }).strict()).max(100),
  tasks: z.array(z.object({
    id: reference,
    stepId: reference,
    label: z.string().min(1).max(250).regex(/\S/),
    kind: z.enum(['prep', 'cooking', 'rest']),
    startMinute: minute,
    durationMinutes: z.number().positive().max(100_000),
    dependsOn: z.array(reference).max(300),
    attendsToTaskId: reference.nullable(),
    handsOn: z.boolean(),
    resources: z.array(reference).max(100),
  }).strict()).min(1).max(300),
}).strict();

export type RecipeTimingPlan = z.infer<typeof recipeTimingPlanSchema>;
export type RecipeTimingPlanIssue = { field: string; message: string };
type Interval = { start: number; end: number };
const epsilon = 1e-8;
const interval = (task: RecipeTimingPlan['tasks'][number]): Interval => ({ start: task.startMinute, end: task.startMinute + task.durationMinutes });

function mergedIntervals(input: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const item of [...input].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result.at(-1);
    if (previous && item.start <= previous.end) previous.end = Math.max(previous.end, item.end);
    else result.push({ ...item });
  }
  return result;
}

function unionMinutes(input: readonly Interval[]): number {
  return mergedIntervals(input).reduce((sum, item) => sum + item.end - item.start, 0);
}

function ceilMinutes(value: number): number {
  if (value === 0) return 0;
  const nearest = Math.round(value);
  // Remove only floating-point noise at a whole-minute boundary. A genuine
  // fractional minute still rounds up, and a positive duration never becomes 0.
  return Math.max(1, Math.abs(value - nearest) <= epsilon ? nearest : Math.ceil(value));
}

const normalise = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replaceAll('ł', 'l');
function explicitTimerKind(step: Recipe['steps'][number]): 'cooking' | 'rest' | null {
  const title = normalise(`${step.title.pl} ${step.title.en}`);
  const heat = /\b(?:piecz|upiecz|gotuj|ugotuj|dus|udus|smaz|usmaz|obsmaz|podsmaz|bake|cook|roast|simmer|fry|boil|braise)\b/.test(title);
  const wait = /\b(?:chlodz|schlodz|ostudz|przestudz|odstaw|odpocznij|marynuj|chill|cool|rest|refrigerate)\b/.test(title);
  return heat === wait ? null : heat ? 'cooking' : 'rest';
}

function optionalStep(step: Recipe['steps'][number]): boolean {
  const fields = (['pl', 'en'] as const).map(locale => ({
    title: normalise(step.title[locale]), start: normalise(step.text[locale]).trimStart(),
  }));
  const negative = /\b(?:not\s+(?:(?:an?|the)\s+)?(?:optional|variant)|non[- ]?optional|nie(?:\s+jest)?(?:\s+to)?\s*(?:opcjonal\w*|wariant\w*))\b/;
  const defaultVariant = /\b(?:wariant\w*\s+(?:podstawow\w*|bazow\w*|domysln\w*|glown\w*|obowiazkow\w*)|(?:podstawow\w*|bazow\w*|domysln\w*|glown\w*|obowiazkow\w*)\s+wariant\w*|(?:base|basic|default|main|standard|mandatory|required)\s+variant)\b/;
  if (fields.some(({ title, start }) => negative.test(title) || negative.test(start.slice(0, 180))
    || defaultVariant.test(title) || defaultVariant.test(start.slice(0, 180)))) return false;
  return fields.some(({ title, start }) => /\b(?:wariant\w*|opcjonal\w*|optional|variant)\b/.test(title)
    || /^(?:wariant\w*|opcjonal\w*|optional|variant|wylacznie\s+do\s+wersji|only\s+for\s+the)\b/.test(start));
}

/** Check a declared feasible schedule; this does not optimize it or prove culinary estimates. */
export function inspectRecipeTimingPlan(plan: unknown, recipe: Pick<Recipe, 'steps' | 'times'>): { issues: RecipeTimingPlanIssue[]; times: Recipe['times'] | null } {
  const parsed = recipeTimingPlanSchema.safeParse(plan);
  if (!parsed.success) return {
    issues: parsed.error.issues.map(issue => ({ field: `timingPlan.${issue.path.join('.')}`, message: issue.message })),
    times: null,
  };
  const value = parsed.data;
  const issues: RecipeTimingPlanIssue[] = [];
  const issue = (field: string, message: string) => issues.push({ field: `timingPlan.${field}`, message });
  const steps = new Map(recipe.steps.map(step => [step.id, step]));
  const resources = new Set<string>();
  value.resources.forEach((resource, index) => {
    if (resources.has(resource)) issue(`resources.${index}`, 'Zasób sprzętowy jest zadeklarowany więcej niż raz.');
    resources.add(resource);
  });
  const tasks = new Map<string, RecipeTimingPlan['tasks'][number]>();
  value.tasks.forEach((task, index) => {
    if (tasks.has(task.id)) issue(`tasks.${index}.id`, 'Identyfikator zadania musi być unikalny.');
    else tasks.set(task.id, task);
    if (!steps.has(task.stepId)) issue(`tasks.${index}.stepId`, 'Zadanie musi wskazywać istniejący krok przepisu.');
    if (task.startMinute + task.durationMinutes > 100_000) issue(`tasks.${index}.durationMinutes`, 'Koniec zadania przekracza 100000 minut.');
    if (task.kind === 'rest' && task.handsOn) issue(`tasks.${index}.handsOn`, 'Odpoczynek jest biernym oczekiwaniem; czynność ręczną opisz jako osobne zadanie.');
    const used = new Set<string>();
    task.resources.forEach((resource, resourceIndex) => {
      if (!resources.has(resource)) issue(`tasks.${index}.resources.${resourceIndex}`, 'Zasób musi pochodzić z zadeklarowanego sprzętu.');
      if (used.has(resource)) issue(`tasks.${index}.resources.${resourceIndex}`, 'To samo zadanie nie może wymieniać zasobu wielokrotnie.');
      used.add(resource);
    });
  });
  value.tasks.forEach((task, index) => {
    const dependencies = new Set<string>();
    task.dependsOn.forEach((id, dependencyIndex) => {
      if (dependencies.has(id)) issue(`tasks.${index}.dependsOn.${dependencyIndex}`, 'Zależność jest powtórzona.');
      dependencies.add(id);
      const predecessor = tasks.get(id);
      if (!predecessor) issue(`tasks.${index}.dependsOn.${dependencyIndex}`, 'Zależność musi wskazywać istniejące zadanie.');
      else if (id === task.id) issue(`tasks.${index}.dependsOn.${dependencyIndex}`, 'Zadanie nie może zależeć od samego siebie.');
      else if (task.startMinute + epsilon < predecessor.startMinute + predecessor.durationMinutes) issue(`tasks.${index}.startMinute`, 'Zadanie zaczyna się przed zakończeniem wymaganej czynności.');
    });
  });

  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of tasks.get(id)?.dependsOn ?? []) if (tasks.has(dependency) && !visit(dependency)) return false;
    visiting.delete(id); visited.add(id); return true;
  };
  if ([...tasks.keys()].some(id => !visit(id))) issue('tasks', 'Zależności zadań zawierają cykl.');

  const validAttendanceChildren = new Set<string>();
  value.tasks.forEach((task, index) => {
    if (task.attendsToTaskId === null) return;
    const field = `tasks.${index}.attendsToTaskId`;
    const host = tasks.get(task.attendsToTaskId);
    if (!host) { issue(field, 'Obsługiwana czynność musi wskazywać istniejący proces.'); return; }
    let valid = true;
    const invalid = (message: string) => { issue(field, message); valid = false; };
    if (host.attendsToTaskId !== null || host.handsOn || host.kind === 'prep') invalid('Można obsługiwać tylko bezpośredni, bierny proces gotowania lub odpoczynku.');
    if (!task.handsOn || task.kind === 'rest') invalid('Obsługa procesu musi być osobną czynnością ręczną, a nie kolejnym biernym oczekiwaniem.');
    if (host.stepId !== task.stepId) invalid('Czynność obsługi musi należeć do tego samego kroku co obsługiwany proces.');
    if (task.startMinute + epsilon < host.startMinute || task.startMinute + task.durationMinutes > host.startMinute + host.durationMinutes + epsilon) invalid('Cała czynność obsługi musi mieścić się w czasie obsługiwanego procesu.');
    if (valid) validAttendanceChildren.add(task.id);
  });
  const attendancePair = (first: RecipeTimingPlan['tasks'][number], second: RecipeTimingPlan['tasks'][number]) =>
    validAttendanceChildren.has(first.id) && first.attendsToTaskId === second.id
    || validAttendanceChildren.has(second.id) && second.attendsToTaskId === first.id;

  const covered = new Set(value.tasks.map(task => task.stepId));
  const excluded = new Set<string>();
  value.excludedSteps.forEach((item, index) => {
    const step = steps.get(item.stepId);
    if (!step) issue(`excludedSteps.${index}.stepId`, 'Wykluczenie musi wskazywać istniejący krok.');
    else if (!optionalStep(step)) issue(`excludedSteps.${index}.stepId`, 'Można wykluczyć wyłącznie krok jawnie oznaczony jako opcjonalny lub osobny wariant.');
    if (covered.has(item.stepId)) issue(`excludedSteps.${index}.stepId`, 'Krok nie może być jednocześnie wykluczony i objęty zadaniami.');
    if (excluded.has(item.stepId)) issue(`excludedSteps.${index}.stepId`, 'Krok jest wykluczony więcej niż raz.');
    excluded.add(item.stepId);
  });
  recipe.steps.forEach((step, index) => {
    if (!covered.has(step.id) && !excluded.has(step.id)) issue('tasks', `Plan nie obejmuje kroku ${index + 1} (${step.id}).`);
    if (excluded.has(step.id)) return;
    const timerMinutes = step.timerMinutes;
    const requiredKind = explicitTimerKind(step);
    if (typeof timerMinutes === 'number' && Number.isFinite(timerMinutes) && timerMinutes > 0
      && !value.tasks.some(task => task.stepId === step.id && task.durationMinutes + epsilon >= timerMinutes && (!requiredKind || task.kind === requiredKind))) {
      const category = requiredKind === 'cooking' ? ' Wymagany jest odcinek obróbki cieplnej.' : requiredKind === 'rest' ? ' Wymagany jest odcinek odpoczynku lub chłodzenia.' : '';
      issue('tasks', `Krok ${step.id} ma ciągły minutnik ${timerMinutes} min, ale żadne zgodne zadanie nie obejmuje całego tego przedziału.${category}`);
    }
  });

  const sorted = value.tasks.map((task, index) => ({ task, index, ...interval(task) })).sort((a, b) => a.start - b.start || a.end - b.end);
  const overlaps = (items: typeof sorted, resource?: string) => {
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      for (let previousIndex = index - 1; previousIndex >= 0; previousIndex--) {
        const previous = items[previousIndex];
        if (item.start + epsilon >= previous.end || resource && attendancePair(previous.task, item.task)) continue;
        issue(`tasks.${item.index}.startMinute`, resource ? `Zasób ${resource} jest w tym czasie zajęty przez zadanie ${previous.task.id}.` : `Jedna osoba nie może równocześnie wykonywać zadań ręcznych ${previous.task.id} i ${item.task.id}.`);
        break;
      }
    }
  };
  overlaps(sorted.filter(item => item.task.handsOn));
  for (const resource of resources) overlaps(sorted.filter(item => item.task.resources.includes(resource)), resource);

  let coveredUntil = 0;
  for (const item of sorted) {
    if (item.start > coveredUntil + epsilon) issue(`tasks.${item.index}.startMinute`, 'Plan zawiera niewyjaśnioną lukę. Oczekiwanie musi być opisane zadaniem, także gdy nie wymaga pracy.');
    coveredUntil = Math.max(coveredUntil, item.end);
  }
  if (issues.length) return { issues, times: null };

  const times: Recipe['times'] = {
    active: ceilMinutes(unionMinutes(value.tasks.filter(task => task.handsOn).map(interval))),
    cooking: ceilMinutes(unionMinutes(value.tasks.filter(task => task.kind === 'cooking').map(interval))),
    rest: ceilMinutes(unionMinutes(value.tasks.filter(task => task.kind === 'rest').map(interval))),
    total: ceilMinutes(coveredUntil),
  };
  for (const key of ['active', 'cooking', 'rest', 'total'] as const) if (recipe.times[key] !== times[key]) {
    issues.push({ field: `times.${key}`, message: `Czas z planu wynosi ${times[key]} min; podana wartość musi odpowiadać wyliczonemu harmonogramowi.` });
  }
  return { issues, times };
}
