'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { useLocalStorage } from '@/lib/browser-storage';
import { getStepTimerMinutes } from '@/lib/step-timer-policy';
import type { PublicRecipe } from '@/lib/recipe-presentation';
import {
  activeCookingSession, applicableCookingTimers, cookingRecipeVersion, EMPTY_KITCHEN_MEMORY, finishCookingSession, isKitchenMemory,
  KITCHEN_MEMORY_KEY, migrateLegacyCooking, rememberRecipe, saveKitchenNote, startCookingSession,
  toggleCookingProgress, updateCookingTimer, type CookingProgress, type CookingSession, type CookingTimer,
} from '@/lib/kitchen-memory';
import { recordUsage } from './UsageMetrics';

export function useKitchenMemory() {
  return useLocalStorage(KITCHEN_MEMORY_KEY, EMPTY_KITCHEN_MEMORY, isKitchenMemory);
}
function readLegacy(key: string): unknown {
  try { const raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function newSessionId() { return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `cook:${Date.now()}:${Math.random().toString(36).slice(2)}`; }

export function useRecipeCooking(recipe: PublicRecipe) {
  const [memory, setMemory] = useKitchenMemory();
  const recipeVersion = useMemo(() => cookingRecipeVersion(recipe), [recipe]);
  const current = activeCookingSession(memory, recipe.id, recipeVersion);
  const session = useMemo(() => {
    if (!current) return undefined;
    const timers = applicableCookingTimers(recipe, current.timers);
    return Object.keys(timers).length === Object.keys(current.timers).length ? current : { ...current, timers };
  }, [current, recipe]);
  const latest = memory.sessions.filter(item => item.recipeId === recipe.id).sort((left, right) => right.updatedAt - left.updatedAt)[0];
  const outdated = memory.sessions.some(item => item.recipeId === recipe.id && item.status === 'active' && item.recipeVersion !== recipeVersion);
  useEffect(() => {
    const progress = readLegacy(`zgotuj:recipe-progress:demo-v1:${recipe.id}`);
    const timers = Object.fromEntries(recipe.steps.filter(step => getStepTimerMinutes(step) !== null).map(step => [step.id, readLegacy(`zgotuj:timer:v1:${recipe.id}:${step.id}`)]));
    setMemory(previous => rememberRecipe(migrateLegacyCooking(previous, recipe, progress, timers, Date.now()), recipe.id, Date.now()));
  }, [recipe, setMemory]);

  const start = useCallback((repeat = false): CookingSession => {
    let resultSession: CookingSession | undefined;
    let created = false;
    setMemory(previous => {
      const result = startCookingSession(previous, recipe.id, recipeVersion, newSessionId(), Date.now(), repeat);
      resultSession = result.session; created = result.created;
      return result.memory;
    });
    if (created) recordUsage(repeat ? 'repeat_cook' : 'cooking_start');
    return resultSession!;
  }, [recipe.id, recipeVersion, setMemory]);
  const finish = useCallback(() => {
    let completed = false;
    setMemory(previous => {
      const active = activeCookingSession(previous, recipe.id, recipeVersion);
      if (!active) return previous;
      completed = true;
      return finishCookingSession(previous, active.id, Date.now());
    });
    if (completed) recordUsage('cooking_complete');
  }, [recipe.id, recipeVersion, setMemory]);
  const toggle = useCallback((kind: keyof CookingProgress, itemId: string) => {
    let checked = false;
    let changed = false;
    setMemory(previous => {
      const active = activeCookingSession(previous, recipe.id, recipeVersion);
      if (!active) return previous;
      checked = active.progress[kind].includes(itemId); changed = true;
      return toggleCookingProgress(previous, active.id, kind, itemId, Date.now());
    });
    if (changed) recordUsage(kind === 'steps' ? checked ? 'cooking_step_undo' : 'cooking_step' : checked ? 'ingredient_uncheck' : 'ingredient_check');
  }, [recipe.id, recipeVersion, setMemory]);
  const setTimer = useCallback((stepId: string, timer: CookingTimer) => {
    const step = recipe.steps.find(item => item.id === stepId);
    const minutes = step ? getStepTimerMinutes(step) : null;
    if (minutes === null || timer.duration !== minutes * 60) return;
    setMemory(previous => {
      const active = activeCookingSession(previous, recipe.id, recipeVersion);
      return active ? updateCookingTimer(previous, active.id, stepId, timer, Date.now()) : previous;
    });
  }, [recipe, recipeVersion, setMemory]);
  const setNote = useCallback((note: string) => setMemory(previous => saveKitchenNote(previous, recipe.id, note)), [recipe.id, setMemory]);
  return { session, latest, outdated, start, finish, toggle, setTimer, note: memory.notes[recipe.id] ?? '', setNote };
}
