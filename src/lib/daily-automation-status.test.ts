import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyAutomationStatus } from './daily-automation-status';

test('requested automation with a broken operational gate never claims to be running', () => {
  const value = { enabled: true, operational: false, reason: 'Brak konfiguracji.', reviewQueue: [], latestResearch: null };
  assert.equal(dailyAutomationStatus(value).state, 'blocked');
  assert.equal(dailyAutomationStatus({ ...value, enabled: false }).state, 'disabled');
  assert.equal(dailyAutomationStatus({ ...value, operational: true, reason: null }).state, 'running');
  assert.equal(dailyAutomationStatus({ ...value, operational: true, latestResearch: { status: 'uncertain' } }).state, 'attention');
});

test('daily research reports its real progress and leaves a completed draft for human review', () => {
  const value = { enabled: true, operational: true, reason: null, reviewQueue: [], latestResearch: null };
  for (const status of ['queued', 'searching', 'generating']) {
    assert.equal(dailyAutomationStatus({ ...value, latestResearch: { status } }).state, 'working');
  }
  const completed = dailyAutomationStatus({ ...value, latestResearch: { status: 'awaiting_review' } });
  assert.equal(completed.state, 'review');
  assert.equal(completed.label, 'Szkic czeka na Twoją ocenę.');
  assert.equal(dailyAutomationStatus({ ...value, reviewQueue: [{ recipeId: 'draft' }] }).state, 'review');
  assert.equal(dailyAutomationStatus({ ...value, enabled: false, reviewQueue: [{ recipeId: 'draft' }] }).state, 'disabled');
});
