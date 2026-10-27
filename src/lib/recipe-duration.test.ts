import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRecipeDuration } from './recipe-duration';

test('recipe duration crosses the hour boundary and omits empty minute parts', () => {
  const examples = [
    [0, '0 min', '0 min'],
    [59, '59 min', '59 min'],
    [60, '1 godz.', '1 hr'],
    [61, '1 godz. 1 min', '1 hr 1 min'],
    [90, '1 godz. 30 min', '1 hr 30 min'],
    [120, '2 godz.', '2 hr'],
    [1440, '24 godz.', '24 hr'],
    [1505, '25 godz. 5 min', '25 hr 5 min'],
  ] as const;
  for (const [minutes, pl, en] of examples) {
    assert.equal(formatRecipeDuration(minutes, 'pl'), pl);
    assert.equal(formatRecipeDuration(minutes, 'en'), en);
  }
});

test('fractional recipe minutes retain locale precision without floating-point residue', () => {
  assert.equal(formatRecipeDuration(59.5, 'pl'), '59,5 min');
  assert.equal(formatRecipeDuration(60.5, 'pl'), '1 godz. 0,5 min');
  assert.equal(formatRecipeDuration(60.1, 'en'), '1 hr 0.1 min');
  assert.equal(formatRecipeDuration(119.999, 'en'), '1 hr 59.999 min');
  assert.equal(formatRecipeDuration(120.00000001, 'pl'), '2 godz.');
});

test('invalid durations do not produce misleading human labels', () => {
  for (const value of [-1, NaN, Infinity, -Infinity]) assert.equal(formatRecipeDuration(value), '—');
  assert.equal(formatRecipeDuration(-0), '0 min');
});
