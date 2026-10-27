import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTrendSearchAt } from './trend-search-budget';

test('the search deadline remains noon UTC across the Warsaw autumn clock change', () => {
  assert.equal(nextTrendSearchAt(new Date('2026-10-19T06:50:00Z')), '2026-10-19T12:00:00.000Z');
  assert.equal(nextTrendSearchAt(new Date('2026-10-19T12:00:00Z')), '2026-10-20T12:00:00.000Z');
  assert.equal(nextTrendSearchAt(new Date('2026-10-25T01:30:00Z')), '2026-10-25T12:00:00.000Z');
});
