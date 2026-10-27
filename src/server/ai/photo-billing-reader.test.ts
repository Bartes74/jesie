import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPhotoBills } from './photo-billing-reader';

const requests = [{ requestId: 'accepted-receipt', createdAt: new Date('2026-10-10T08:00:00Z') }];
const now = new Date('2026-10-13T14:00:00Z');
function page(events: unknown[], hasMore = false, cursor: string | null = null) {
  return Response.json({ billing_events: events, has_more: hasMore, next_cursor: cursor });
}

test('billing reader uses only exact receipt GETs, an explicit historical window and final costs including confirmed zero', async () => {
  for (const cost of [0, 0.0424]) {
    let calls = 0;
    const result = await readPhotoBills(requests, { credential: 'private-fixture-key', now, fetch: async (input, init) => {
      calls++;
      const url = new URL(String(input));
      assert.equal(url.origin + url.pathname, 'https://api.fal.ai/v1/models/billing-events');
      assert.deepEqual(url.searchParams.getAll('request_id'), ['accepted-receipt']);
      assert.equal(url.searchParams.get('start'), '2026-10-10T07:59:00.000Z');
      assert.equal(url.searchParams.get('end'), now.toISOString());
      assert.equal(init?.method ?? 'GET', 'GET');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.cache, 'no-store');
      return page([{ request_id: 'accepted-receipt', cost_total: cost, cost_estimate_nano_usd: 999999999 }]);
    } });
    assert.equal(calls, 1); assert.equal(result.status, 'verified');
    assert.equal(result.costs['accepted-receipt'], cost.toFixed(8));
    assert(!JSON.stringify(result).includes('private-fixture-key'));
  }
});

test('billing reader never treats missing, pending, malformed, negative or another receipt bill as zero', async () => {
  for (const events of [[], [{ request_id: 'accepted-receipt', cost_total: null }], [{ request_id: 'accepted-receipt', cost_estimate_nano_usd: 0 }], [{ request_id: 'accepted-receipt', cost_total: -1 }], [{ request_id: 'other-receipt', cost_total: 0 }]]) {
    const result = await readPhotoBills(requests, { credential: 'fixture', now, fetch: async () => page(events) });
    assert.equal(Object.keys(result.costs).length, 0);
    assert(['pending', 'invalid'].includes(result.status));
  }
});

test('billing reader waits for all pages and rejects looping or incomplete pagination without partial settlement', async () => {
  let calls = 0;
  const complete = await readPhotoBills(requests, { credential: 'fixture', now, fetch: async () => ++calls === 1
    ? page([{ request_id: 'accepted-receipt', cost_total: 0.02 }], true, 'second')
    : page([{ request_id: 'accepted-receipt', cost_total: 0.03 }]) });
  assert.equal(calls, 2); assert.equal(complete.costs['accepted-receipt'], '0.05000000');
  const invalid = await readPhotoBills(requests, { credential: 'fixture', now, fetch: async () => page([{ request_id: 'accepted-receipt', cost_total: 0.02 }], true, 'same') });
  assert.equal(invalid.status, 'invalid'); assert.deepEqual(invalid.costs, {});
  const missingCursor = await readPhotoBills(requests, { credential: 'fixture', now, fetch: async () => page([{ request_id: 'accepted-receipt', cost_total: 0.02 }], true) });
  assert.equal(missingCursor.status, 'invalid'); assert.deepEqual(missingCursor.costs, {});
});

test('billing permission errors expose only safe HTTP status and preserve every reservation', async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    const result = await readPhotoBills(requests, { credential: 'private-fixture-key', now, fetch: async () => Response.json({ error: 'secret provider diagnostic private-fixture-key' }, { status }) });
    assert.equal(result.httpStatus, status); assert.deepEqual(result.costs, {});
    assert(!JSON.stringify(result).includes('private-fixture-key'));
    assert(!JSON.stringify(result).includes('secret provider diagnostic'));
  }
});
