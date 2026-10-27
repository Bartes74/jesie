import assert from 'node:assert/strict';
import test from 'node:test';
import { cookingClockLabel, formatCookingClock } from './cooking-clock';
test('countdown crosses the hour boundary while retaining seconds and readable accessible units', () => {
  assert.equal(formatCookingClock(3599), '59:59');
  assert.equal(formatCookingClock(3600), '1:00:00');
  assert.equal(formatCookingClock(5405), '1:30:05');
  assert.equal(formatCookingClock(10800), '3:00:00');
  assert.equal(formatCookingClock(14400), '4:00:00');
  assert.equal(cookingClockLabel(5405, 'pl'), 'Pozostały czas: 1 godz. 30 min 5 sek.');
  assert.equal(cookingClockLabel(5405, 'en'), 'Time remaining: 1 hr 30 min 5 sec');
});
test('fractional final seconds never announce completion early and invalid values cannot leak NaN', () => {
  assert.equal(formatCookingClock(0.1), '00:01');
  for (const value of [0, -1, Infinity, NaN]) assert.equal(formatCookingClock(value), '00:00');
});
