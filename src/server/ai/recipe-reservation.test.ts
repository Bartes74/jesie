import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiSettings, recipeGenerationReservationUsd } from './config';

test('legacy spending environment values do not create limits or reservations', () => {
  const prior = process.env.AI_RECIPE_RESERVATION_USD;
  process.env.AI_RECIPE_RESERVATION_USD = 'invalid legacy setting';
  try {
    const settings = aiSettings();
    assert.equal(recipeGenerationReservationUsd(), '0.00000000');
    for (const key of ['recipeReservationUsd', 'imageReservationUsd', 'dailyLimitUsd', 'monthlyLimitUsd', 'pilotLimitUsd'] as const) assert.equal(settings[key], '0.00000000');
    assert.equal(settings.concurrentLimit, 2);
    assert.equal(settings.maxInputBytes, 60_000);
  } finally { if (prior === undefined) delete process.env.AI_RECIPE_RESERVATION_USD; else process.env.AI_RECIPE_RESERVATION_USD = prior; }
});
