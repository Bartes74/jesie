import { getStepTimerMinutes } from './step-timer-policy';
import type { PublicRecipe } from './recipe-presentation';

export const KITCHEN_MEMORY_KEY = 'jesie:kitchen-memory:v1';
export const MAX_KITCHEN_SESSIONS = 60;
export const MAX_KITCHEN_NOTE = 2000;
export type CookingProgress = { ingredients: string[]; steps: string[] };
export type CookingTimer = { duration: number; remaining: number; endAt: number | null; started: boolean };
export type CookingSession = {
  id: string; recipeId: string; recipeVersion: string; status: 'active' | 'completed' | 'archived';
  startedAt: number; updatedAt: number; completedAt: number | null;
  progress: CookingProgress; timers: Record<string, CookingTimer>;
};
export type KitchenMemory = {
  version: 1; sessions: CookingSession[]; notes: Record<string, string>;
  recent: { recipeId: string; viewedAt: number }[]; migratedRecipeIds: string[];
};
export const EMPTY_KITCHEN_MEMORY: KitchenMemory = { version: 1, sessions: [], notes: {}, recent: [], migratedRecipeIds: [] };
export const EMPTY_COOKING_PROGRESS: CookingProgress = { ingredients: [], steps: [] };

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f]/.test(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 300 && value.every(id) && new Set(value).size === value.length;
export function isCookingProgress(value: unknown): value is CookingProgress {
  return record(value) && ids(value.ingredients) && ids(value.steps);
}
export function isCookingTimer(value: unknown): value is CookingTimer {
  return record(value) && time(value.duration) && value.duration > 0 && value.duration <= 604800
    && time(value.remaining) && value.remaining <= value.duration && (value.endAt === null || time(value.endAt)) && typeof value.started === 'boolean';
}
/** Legacy countdowns remain in storage, but only current, usable timers run. */
export function applicableCookingTimers(recipe: Pick<PublicRecipe, 'steps'>, timers: Record<string, CookingTimer>): Record<string, CookingTimer> {
  return Object.fromEntries(Object.entries(timers).filter(([stepId, timer]) => {
    const step = recipe.steps.find(item => item.id === stepId);
    const minutes = step ? getStepTimerMinutes(step) : null;
    return minutes !== null && isCookingTimer(timer) && timer.duration === minutes * 60;
  }));
}

function isCookingSession(value: unknown): value is CookingSession {
  if (!record(value) || !id(value.id) || !id(value.recipeId) || !id(value.recipeVersion)
    || !['active', 'completed', 'archived'].includes(String(value.status)) || !time(value.startedAt) || !time(value.updatedAt)
    || value.updatedAt < value.startedAt || !isCookingProgress(value.progress) || !record(value.timers)) return false;
  if (value.status === 'completed' ? !time(value.completedAt) || value.completedAt < value.startedAt : value.completedAt !== null) return false;
  return Object.keys(value.timers).length <= 100 && Object.entries(value.timers).every(([key, timer]) => id(key) && isCookingTimer(timer));
}
export function isKitchenMemory(value: unknown): value is KitchenMemory {
  return record(value) && value.version === 1 && Array.isArray(value.sessions) && value.sessions.length <= MAX_KITCHEN_SESSIONS
    && value.sessions.every(isCookingSession) && new Set(value.sessions.map(session => session.id)).size === value.sessions.length
    && record(value.notes) && Object.keys(value.notes).length <= 300 && Object.entries(value.notes).every(([key, note]) => id(key) && typeof note === 'string' && note.length <= MAX_KITCHEN_NOTE)
    && Array.isArray(value.recent) && value.recent.length <= 20 && value.recent.every(item => record(item) && id(item.recipeId) && time(item.viewedAt))
    && ids(value.migratedRecipeIds);
}

/** Includes the cooking content so reused step IDs never inherit a different instruction's checks. */
export function cookingRecipeVersion(recipe: Pick<PublicRecipe, 'ingredients' | 'steps' | 'baseServings' | 'publication'> & { version?: string }): string {
  const content = JSON.stringify([recipe.version ?? recipe.publication?.dateModified ?? '', recipe.baseServings, recipe.ingredients, recipe.steps]);
  let hash = 2166136261;
  for (let index = 0; index < content.length; index++) hash = Math.imul(hash ^ content.charCodeAt(index), 16777619);
  return `cooking-v1-${(hash >>> 0).toString(16)}`;
}
export function activeCookingSession(memory: KitchenMemory, recipeId: string, recipeVersion: string): CookingSession | undefined {
  return memory.sessions.find(session => session.recipeId === recipeId && session.recipeVersion === recipeVersion && session.status === 'active');
}
function retainSessions(sessions: CookingSession[]): CookingSession[] {
  return [...sessions].sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active') || right.updatedAt - left.updatedAt).slice(0, MAX_KITCHEN_SESSIONS);
}
export function startCookingSession(memory: KitchenMemory, recipeId: string, recipeVersion: string, sessionId: string, now: number, repeat = false): { memory: KitchenMemory; session: CookingSession; created: boolean } {
  const active = activeCookingSession(memory, recipeId, recipeVersion);
  if (active && !repeat) return { memory, session: active, created: false };
  const session: CookingSession = { id: sessionId, recipeId, recipeVersion, status: 'active', startedAt: now, updatedAt: now, completedAt: null, progress: { ingredients: [], steps: [] }, timers: {} };
  const previous = memory.sessions.map(item => item.recipeId === recipeId && item.status === 'active' ? { ...item, status: 'archived' as const, timers: {} } : item);
  return { memory: { ...memory, sessions: retainSessions([session, ...previous]) }, session, created: true };
}
export function finishCookingSession(memory: KitchenMemory, sessionId: string, now: number): KitchenMemory {
  const session = memory.sessions.find(item => item.id === sessionId && item.status === 'active');
  if (!session) return memory;
  return { ...memory, sessions: memory.sessions.map(item => item.id === sessionId ? { ...item, status: 'completed', completedAt: Math.max(item.startedAt, now), updatedAt: Math.max(item.updatedAt, now), timers: {} } : item) };
}
export function toggleCookingProgress(memory: KitchenMemory, sessionId: string, kind: keyof CookingProgress, itemId: string, now: number): KitchenMemory {
  return { ...memory, sessions: memory.sessions.map(session => {
    if (session.id !== sessionId || session.status !== 'active') return session;
    const values = session.progress[kind];
    return { ...session, updatedAt: Math.max(session.updatedAt, now), progress: { ...session.progress, [kind]: values.includes(itemId) ? values.filter(value => value !== itemId) : [...values, itemId] } };
  }) };
}
export function updateCookingTimer(memory: KitchenMemory, sessionId: string, stepId: string, timer: CookingTimer, now: number): KitchenMemory {
  if (!isCookingTimer(timer)) return memory;
  return { ...memory, sessions: memory.sessions.map(session => session.id === sessionId && session.status === 'active' ? { ...session, updatedAt: Math.max(session.updatedAt, now), timers: { ...session.timers, [stepId]: timer } } : session) };
}
export function rememberRecipe(memory: KitchenMemory, recipeId: string, now: number): KitchenMemory {
  return { ...memory, recent: [{ recipeId, viewedAt: now }, ...memory.recent.filter(item => item.recipeId !== recipeId)].slice(0, 20) };
}
export function saveKitchenNote(memory: KitchenMemory, recipeId: string, note: string): KitchenMemory {
  const notes = { ...memory.notes };
  if (note.trim()) notes[recipeId] = note.slice(0, MAX_KITCHEN_NOTE); else delete notes[recipeId];
  return { ...memory, notes };
}
export function remainingCookingSeconds(timer: CookingTimer, now: number): number {
  return timer.endAt === null ? timer.remaining : Math.min(timer.duration, Math.max(0, Math.ceil((timer.endAt - now) / 1000)));
}

/** Read legacy data once without deleting it or touching saved servings, units or favourites. */
export function migrateLegacyCooking(memory: KitchenMemory, recipe: PublicRecipe, legacyProgress: unknown, legacyTimers: Record<string, unknown>, now: number): KitchenMemory {
  if (memory.migratedRecipeIds.includes(recipe.id)) return memory;
  let next = { ...memory, migratedRecipeIds: [...memory.migratedRecipeIds, recipe.id].slice(-300) };
  const recipeVersion = cookingRecipeVersion(recipe);
  if (memory.sessions.some(session => session.recipeId === recipe.id)) return next;
  const progress = isCookingProgress(legacyProgress) ? {
    ingredients: legacyProgress.ingredients.filter(value => recipe.ingredients.some(ingredient => ingredient.id === value)),
    steps: legacyProgress.steps.filter(value => recipe.steps.some(step => step.id === value)),
  } : { ingredients: [], steps: [] };
  const timers: Record<string, CookingTimer> = {};
  for (const step of recipe.steps) {
    const legacy = legacyTimers[step.id];
    const minutes = getStepTimerMinutes(step);
    if (minutes === null || !record(legacy) || !time(legacy.remaining) || (legacy.endAt !== null && !time(legacy.endAt))) continue;
    const duration = minutes * 60;
    const timer = { duration, remaining: Math.min(duration, legacy.remaining), endAt: legacy.endAt as number | null, started: legacy.endAt !== null || legacy.remaining < duration };
    if (isCookingTimer(timer) && timer.started) timers[step.id] = timer;
  }
  if (!progress.ingredients.length && !progress.steps.length && !Object.keys(timers).length) return next;
  const result = startCookingSession(next, recipe.id, recipeVersion, `legacy:${recipe.id}:${now}`, now);
  next = { ...result.memory, sessions: result.memory.sessions.map(session => session.id === result.session.id ? { ...session, progress, timers } : session) };
  return next;
}
