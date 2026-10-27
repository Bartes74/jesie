import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pollWithBackoff, trendJobPollDelays, trendSearchPollDelays, trendRunLimits, type TrendPollDelay } from './trend-polling';

function seconds(delay: TrendPollDelay) {
  return Number(delay.slice(0, -1)) * (delay.endsWith('m') ? 60 : 1);
}

test('a long provider queue exhausts a bounded number of reads without shortening the waiting window', async () => {
  for (const [delays, previousWindow] of [[trendJobPollDelays, 3600], [trendSearchPollDelays, 1800]] as const) {
    let waited = 0;
    let reads = 0;
    const done = await pollWithBackoff(delays, async delay => { waited += seconds(delay); }, async () => { reads++; return false; });
    assert.equal(done, false);
    assert.equal(reads, delays.length);
    assert.ok(reads <= 20);
    assert.ok(waited >= previousWindow);
    assert.ok(delays.every((delay, index) => seconds(delay) >= (index ? seconds(delays[index - 1]) : 0)));
    assert.ok(delays.every(delay => seconds(delay) <= 300));
  }
});

test('a completed receipt stops both polling and subsequent sleeps immediately', async () => {
  const pauses: TrendPollDelay[] = [];
  let reads = 0;
  const done = await pollWithBackoff(trendJobPollDelays, async delay => { pauses.push(delay); }, async () => ++reads === 3);
  assert.equal(done, true);
  assert.equal(reads, 3);
  assert.deepEqual(pauses, ['10s', '10s', '20s']);
});

test('the largest admitted packet stays below the Workflow event and step ceilings even with read retries', () => {
  // A normal step has 3 events; each allowed retry adds started + retrying.
  // Durable sleep has 2 events. The installed SDK's default retry limit is 3.
  const step = (retries = 3) => 3 + 2 * retries;
  const sleep = 2;
  const jobs = 1 + trendRunLimits.photographs; // text + hero/ingredients/steps
  const jobEvents = jobs * (
    step(trendRunLimits.admissionRetries) + step(0)
    + trendJobPollDelays.length * (sleep + step(trendRunLimits.statusRetries))
    + 2 * step() + step() + step() // state reads, receipt reconciliation, expiry
  );
  const searchEvents = step(0) + trendSearchPollDelays.length * (sleep + step());
  const finalBills = trendRunLimits.billingAttempts * (step() + trendRunLimits.photographs * step())
    + (trendRunLimits.billingAttempts - 1) * sleep;
  const otherEvents = 3 + 3 * step() + 4 * step() + 3 * step(); // run, state, apply, reserve/complete/stop
  assert.ok(jobEvents + searchEvents + finalBills + otherEvents < 20_000);
  const steps = jobs * (1 + 1 + trendJobPollDelays.length + 2 + 1 + 1)
    + 1 + trendSearchPollDelays.length + 10
    + trendRunLimits.billingAttempts * (1 + trendRunLimits.photographs);
  assert.ok(steps < 10_000);
});
