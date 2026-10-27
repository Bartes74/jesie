import assert from 'node:assert/strict';
import test from 'node:test';
import type { RecipeStep } from './recipes';
import { getStepTimerMinutes, maxStepTimerMinutes, stepTimerIssue } from './step-timer-policy';
const step = (timerMinutes: number | undefined, title: string, text: string): RecipeStep => ({ id: 'stage', title: { pl: title, en: title }, text: { pl: text, en: text }, timerMinutes });

test('overnight and day-long waits have no browser countdown; cooking durations remain intact', () => {
  const mature = step(1440, 'Cool and refrigerate', 'Chill for at least 24 hours.');
  assert.equal(getStepTimerMinutes(mature), null);
  assert.equal(mature.timerMinutes, 1440);
  assert(stepTimerIssue(mature));
  assert.equal(getStepTimerMinutes(step(480, 'Chill', 'Leave overnight.')), null);
  assert.equal(getStepTimerMinutes(step(120, 'Odstaw', 'Odstaw na całą noc.')), null);
  assert.equal(getStepTimerMinutes(step(120, 'Chill', 'Refrigerate overnight.')), null);
});

test('ordinary long cooking, chilling and short resting checkpoints retain useful timers', () => {
  assert.equal(getStepTimerMinutes(step(180, 'Cool and chill', 'Refrigerate for 3 hours. Do not leave the pan on the counter overnight.')), 180);
  assert.equal(getStepTimerMinutes(step(180, 'Braise', 'Braise for 180–240 minutes.')), 180);
  assert.equal(getStepTimerMinutes(step(240, 'Cool and chill', 'Refrigerate for at least 240 minutes.')), 240);
  assert.equal(getStepTimerMinutes(step(60, 'Bake', 'Bake for 60 minutes.')), 60);
  assert.equal(getStepTimerMinutes(step(20, 'Rest', 'Rest the dough for 20 minutes.')), 20);
  assert.equal(getStepTimerMinutes(step(30, 'Cool then chill', 'Cool for 30 minutes, then refrigerate overnight.')), 30);
  assert.equal(getStepTimerMinutes(step(180, 'Braise', 'Braise until tender. You can refrigerate it overnight afterwards.')), 180);
});

test('timer boundaries reject invalid values without removing unknown cooking methods', () => {
  for (const value of [undefined, 0, -1, NaN, Infinity, maxStepTimerMinutes + 1]) assert.equal(getStepTimerMinutes(step(value, 'Stage', 'Follow the method.')), null);
  assert.equal(getStepTimerMinutes(step(maxStepTimerMinutes, 'Cook slowly', 'Cook until tender.')), maxStepTimerMinutes);
  assert.equal(getStepTimerMinutes(step(0.5, 'Stir', 'Stir for 30 seconds.')), 0.5);
  assert.equal(stepTimerIssue(step(undefined, 'Wait', 'Leave overnight.')), null);
});
