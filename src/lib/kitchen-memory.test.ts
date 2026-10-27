import assert from 'node:assert/strict';
import test from 'node:test';
import { recipes } from './recipes';
import { toPublicRecipe } from './recipe-presentation';
import {
  activeCookingSession, applicableCookingTimers, cookingRecipeVersion, EMPTY_KITCHEN_MEMORY, finishCookingSession, isKitchenMemory,
  migrateLegacyCooking, remainingCookingSeconds, rememberRecipe, saveKitchenNote, startCookingSession,
  toggleCookingProgress, updateCookingTimer,
} from './kitchen-memory';

const recipe = toPublicRecipe(recipes[0]);
const version = cookingRecipeVersion(recipe);
test('starts and finishes once, with a new empty session for repeat cooking and preserved notes', () => {
  const noted = saveKitchenNote(EMPTY_KITCHEN_MEMORY, recipe.id, 'Less lemon next time');
  const first = startCookingSession(noted, recipe.id, version, 'first', 100);
  const second = startCookingSession(first.memory, recipe.id, version, 'second', 101);
  assert.equal(second.created, false);
  assert.equal(second.session.id, 'first');
  let memory = toggleCookingProgress(second.memory, 'first', 'steps', recipe.steps[0].id, 102);
  memory = updateCookingTimer(memory, 'first', 'sauce', { duration: 60, remaining: 60, endAt: 60102, started: true }, 102);
  memory = finishCookingSession(memory, 'first', 103);
  assert.equal(memory.sessions[0].status, 'completed');
  assert.deepEqual(memory.sessions[0].timers, {});
  assert.equal(finishCookingSession(memory, 'first', 104), memory);
  const repeat = startCookingSession(memory, recipe.id, version, 'repeat', 105, true);
  assert.deepEqual(repeat.session.progress, { ingredients: [], steps: [] });
  assert.deepEqual(repeat.session.timers, {});
  assert.equal(repeat.memory.notes[recipe.id], 'Less lemon next time');
  assert.equal(repeat.memory.sessions.filter(item => item.status === 'completed').length, 1);
  assert.equal(isKitchenMemory(repeat.memory), true);
});
test('versioned content never inherits checks, even if step IDs are reused', () => {
  const changed = structuredClone(recipe);
  changed.steps[0].text.pl += ' Nowa instrukcja.';
  const changedVersion = cookingRecipeVersion(changed);
  assert.notEqual(changedVersion, version);
  const old = startCookingSession(EMPTY_KITCHEN_MEMORY, recipe.id, version, 'old', 100);
  const checked = toggleCookingProgress(old.memory, 'old', 'steps', recipe.steps[0].id, 101);
  assert.equal(activeCookingSession(checked, recipe.id, changedVersion), undefined);
  const next = startCookingSession(checked, recipe.id, changedVersion, 'new', 102);
  assert.deepEqual(next.session.progress.steps, []);
  assert.equal(next.memory.sessions.find(item => item.id === 'old')?.status, 'archived');
  assert.equal(isKitchenMemory(next.memory), true);
});
test('migration preserves existing valid legacy progress and timers exactly once without completing a dish', () => {
  const step = recipe.steps.find(item => item.timerMinutes)!;
  const legacy = { ingredients: [recipe.ingredients[0].id, 'deleted-ingredient'], steps: [recipe.steps[0].id, 'deleted-step'] };
  const migrated = migrateLegacyCooking(EMPTY_KITCHEN_MEMORY, recipe, legacy, { [step.id]: { remaining: 12, endAt: null } }, 100);
  const active = activeCookingSession(migrated, recipe.id, version)!;
  assert.deepEqual(active.progress, { ingredients: [recipe.ingredients[0].id], steps: [recipe.steps[0].id] });
  assert.equal(active.timers[step.id].remaining, 12);
  assert.equal(active.status, 'active');
  assert.equal(active.completedAt, null);
  assert.equal(migrateLegacyCooking(migrated, recipe, legacy, {}, 200), migrated);
  assert.equal(isKitchenMemory(migrated), true);
  assert.deepEqual(legacy.steps, [recipe.steps[0].id, 'deleted-step']);
});
test('corrupt legacy progress is ignored, an empty legacy state creates no session', () => {
  const migrated = migrateLegacyCooking(EMPTY_KITCHEN_MEMORY, recipe, { ingredients: [12], steps: null }, {}, 100);
  assert.equal(migrated.sessions.length, 0);
  assert.equal(isKitchenMemory(migrated), true);
});
test('timers count using their deadline across pauses, reloads and elapsed time', () => {
  const timer = { duration: 60, remaining: 60, endAt: 61000, started: true };
  assert.equal(remainingCookingSeconds(timer, 1000), 60);
  assert.equal(remainingCookingSeconds(timer, 60500), 1);
  assert.equal(remainingCookingSeconds(timer, 80000), 0);
  assert.equal(remainingCookingSeconds({ ...timer, endAt: null, remaining: 12 }, 80000), 12);
});
test('validated storage rejects malformed sessions, timestamps, duplicate IDs and oversized notes', () => {
  const memory = startCookingSession(EMPTY_KITCHEN_MEMORY, recipe.id, version, 'first', 100).memory;
  assert.equal(isKitchenMemory(memory), true);
  assert.equal(isKitchenMemory({ ...memory, version: 2 }), false);
  assert.equal(isKitchenMemory({ ...memory, sessions: [memory.sessions[0], memory.sessions[0]] }), false);
  assert.equal(isKitchenMemory({ ...memory, sessions: [{ ...memory.sessions[0], progress: { steps: [null], ingredients: [] } }] }), false);
  assert.equal(isKitchenMemory({ ...memory, sessions: [{ ...memory.sessions[0], updatedAt: 99 }] }), false);
  assert.equal(isKitchenMemory({ ...memory, notes: { [recipe.id]: 'x'.repeat(2001) } }), false);
  assert.equal(isKitchenMemory({ ...memory, sessions: [{ ...memory.sessions[0], timers: { step: { duration: 10, remaining: -1, endAt: null, started: true } } }] }), false);
});
test('recent recipes deduplicate and private note limits are independent of sessions', () => {
  let memory = EMPTY_KITCHEN_MEMORY;
  for (let index = 0; index < 25; index++) memory = rememberRecipe(memory, `recipe-${index}`, index);
  memory = rememberRecipe(memory, 'recipe-23', 100);
  assert.equal(memory.recent.length, 20);
  assert.equal(memory.recent[0].recipeId, 'recipe-23');
  assert.equal(memory.recent.filter(item => item.recipeId === 'recipe-23').length, 1);
  memory = saveKitchenNote(memory, recipe.id, 'x'.repeat(2100));
  assert.equal(memory.notes[recipe.id].length, 2000);
  assert.equal(saveKitchenNote(memory, recipe.id, '   ').notes[recipe.id], undefined);
});


test('previously stored overnight timers never reactivate, without erasing progress or notes', () => {
  const long = structuredClone(recipe);
  long.steps = [
    { id: 'mature', title: { pl: 'Chłodź', en: 'Chill' }, text: { pl: 'Chłodź przez 24 godziny.', en: 'Chill for 24 hours.' }, timerMinutes: 1440 },
    { id: 'braise', title: { pl: 'Duś', en: 'Braise' }, text: { pl: 'Duś przez 3 godziny.', en: 'Braise for 3 hours.' }, timerMinutes: 180 },
  ];
  const state = toggleCookingProgress(startCookingSession(saveKitchenNote(EMPTY_KITCHEN_MEMORY, long.id, 'Remember this'), long.id, cookingRecipeVersion(long), 'session', 100).memory, 'session', 'steps', 'mature', 101);
  const withOldTimers = updateCookingTimer(updateCookingTimer(state, 'session', 'mature', { duration: 86400, remaining: 86400, endAt: 86400100, started: true }, 102), 'session', 'braise', { duration: 10800, remaining: 10800, endAt: 10800100, started: true }, 103);
  const before = structuredClone(withOldTimers);
  const usable = applicableCookingTimers(long, withOldTimers.sessions[0].timers);
  assert.deepEqual(Object.keys(usable), ['braise']);
  assert.deepEqual(withOldTimers, before);
  assert.deepEqual(withOldTimers.sessions[0].progress.steps, ['mature']);
  assert.equal(withOldTimers.notes[long.id], 'Remember this');
  const migrated = migrateLegacyCooking(EMPTY_KITCHEN_MEMORY, long, { ingredients: [], steps: ['mature'] }, { mature: { remaining: 86400, endAt: 86400100 }, braise: { remaining: 10700, endAt: null } }, 100);
  assert.deepEqual(Object.keys(migrated.sessions[0].timers), ['braise']);
  assert.deepEqual(migrated.sessions[0].progress.steps, ['mature']);
});

test('removed steps and changed timer lengths cannot resume an unrelated stored countdown', () => {
  const step = recipe.steps.find(item => item.timerMinutes)!;
  const duration = step.timerMinutes! * 60;
  const timer = { duration, remaining: duration, endAt: null, started: true };
  assert.deepEqual(Object.keys(applicableCookingTimers(recipe, { [step.id]: timer, removed: timer })), [step.id]);
  assert.deepEqual(applicableCookingTimers(recipe, { [step.id]: { ...timer, duration: duration + 1 } }), {});
});
