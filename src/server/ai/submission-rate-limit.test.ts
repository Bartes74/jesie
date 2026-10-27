import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { recipes } from '@/lib/recipes';
import type { EditorialContent } from '@/lib/editorial-types';
import { ProviderError } from './provider-error';
import { ConfirmedRateLimitError, confirmedFalRateLimit, isConfirmedRateLimit, retryConfirmedRateLimit } from './submission-rate-limit';
import { submitText, submitTextRepair } from './text-provider';
import { submitImage } from './image-provider';
import { approvedImageModel } from './image-actions';

const limited = () => new ConfirmedRateLimitError(null);
const input = (): EditorialContent => ({ recipe: structuredClone(recipes[0]), originalText: 'Fixture', author: 'Test', sources: [], photos: { ingredients: {}, steps: {} } });
const matches = (code: string, uncertain = false) => (error: unknown) => error instanceof ProviderError && error.code === code && error.uncertain === uncertain;

test('only explicit HTTP 429 rate-limit codes grant a retry, never quota, billing, unknown or other HTTP errors', () => {
  for (const code of ['rate_limit_exceeded', 'rate_limited', 'slow_down', 'rate_limit_error']) assert.equal(isConfirmedRateLimit(429, code), true);
  assert.equal(isConfirmedRateLimit(429, null, 'rate_limit_error'), true);
  for (const code of ['insufficient_quota', 'billing_limit_reached', 'credits_exhausted', 'payment_required', 'unknown']) assert.equal(isConfirmedRateLimit(429, code, 'rate_limit_error'), false);
  for (const status of [undefined, 401, 402, 403, 408, 500, 503]) assert.equal(isConfirmedRateLimit(status, 'rate_limit_exceeded'), false);
  assert.equal(isConfirmedRateLimit(429, undefined), false);
});

test('the same admitted submission gets at most two extra attempts with growing backoff and preflight every time', async () => {
  const events: string[] = []; let posts = 0;
  const result = await retryConfirmedRateLimit(async () => { events.push('post'); if (++posts < 3) throw limited(); return 'accepted'; },
    async () => { events.push('preflight'); }, { wait: async ms => { events.push(`wait:${ms}`); }, random: () => 0 });
  assert.equal(result, 'accepted'); assert.equal(posts, 3);
  assert.deepEqual(events, ['preflight', 'post', 'wait:1000', 'preflight', 'post', 'wait:2000', 'preflight', 'post']);
  let failures = 0; const waits: number[] = [];
  await assert.rejects(retryConfirmedRateLimit(async () => { failures++; throw limited(); }, undefined, { wait: async ms => { waits.push(ms); }, random: () => 0 }), matches('AI_PROVIDER_RATE_LIMITED'));
  assert.equal(failures, 3); assert.deepEqual(waits, [1000, 2000]);
});

test('Retry-After is a minimum; long server hints stop instead of being shortened', async () => {
  const now = Date.parse('2026-10-17T00:00:00Z');
  for (const hint of [new ConfirmedRateLimitError('5'), new ConfirmedRateLimitError('Sat, 17 Oct 2026 00:00:05 GMT'), new ConfirmedRateLimitError(null, '5000')]) {
    let posts = 0; const waits: number[] = [];
    await retryConfirmedRateLimit(async () => { if (++posts === 1) throw hint; return 'accepted'; }, undefined, { wait: async ms => { waits.push(ms); }, now: () => now, random: () => 0 });
    assert.deepEqual(waits, [5000]);
  }
  for (const hint of ['11', 'Sat, 17 Oct 2026 00:01:00 GMT', '9'.repeat(500)]) {
    let posts = 0;
    await assert.rejects(retryConfirmedRateLimit(async () => { posts++; throw new ConfirmedRateLimitError(hint); }, undefined,
      { wait: async () => assert.fail('A long server minimum cannot be shortened'), now: () => now }), matches('AI_PROVIDER_RATE_LIMITED'));
    assert.equal(posts, 1);
  }
});

test('cancellation before the next attempt and unknown transport failure never make another POST', async () => {
  let posts = 0; let checks = 0;
  await assert.rejects(retryConfirmedRateLimit(async () => { posts++; throw limited(); }, async () => {
    if (++checks === 2) throw new ProviderError('AI_SUBMISSION_BLOCKED', 'Cancelled');
  }, { wait: async () => {}, random: () => 0 }), matches('AI_SUBMISSION_BLOCKED'));
  assert.equal(posts, 1); assert.equal(checks, 2);
  for (const error of [new Error('transport'), new ProviderError('AI_SUBMISSION_UNCERTAIN', 'Unknown', true), new ProviderError('AI_PROVIDER_QUOTA', 'Quota')]) {
    posts = 0;
    await assert.rejects(retryConfirmedRateLimit(async () => { posts++; throw error; }, undefined, { wait: async () => assert.fail('No backoff expected') }), value => value === error);
    assert.equal(posts, 1);
    posts = 0;
    await assert.rejects(retryConfirmedRateLimit(async () => { if (++posts === 1) throw limited(); throw error; }, undefined,
      { wait: async () => {}, random: () => 0 }), value => value === error);
    assert.equal(posts, 2, 'One prior confirmed rejection never authorizes retrying a later uncertain request.');
  }
});

test('Fal classification reads only a bounded explicit rejection envelope', async () => {
  const confirmed = await confirmedFalRateLimit(Response.json({ detail: { code: 'rate_limit_exceeded' } }, { status: 429, headers: { 'Retry-After': '5' } }));
  assert.ok(confirmed instanceof ConfirmedRateLimitError); assert.equal(confirmed.retryAfter, '5');
  for (const body of [{ error: { code: 'insufficient_quota' } }, { detail: 'Too many requests' }, { code: 'unknown' }, { code: 'rate_limit_exceeded', padding: 'x'.repeat(9000) }]) {
    assert.equal(await confirmedFalRateLimit(Response.json(body, { status: 429 })), null);
  }
});

async function fixtureCredentials(run: () => Promise<void>) {
  const values = { OPENAI_API_KEY: 'test-unused', FAL_KEY: 'test-unused', BLOB_READ_WRITE_TOKEN: 'test-unused' };
  const saved = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  try { Object.assign(process.env, values); await run(); }
  finally { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
}

async function advanceShortRetries<T>(t: TestContext, operation: () => Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = operation();
  // Mocked HTTP resolves before each fake clock tick; no provider timeout fires.
  await flush(); t.mock.timers.tick(10_000); await flush(); t.mock.timers.tick(10_000);
  return result;
}

test('OpenAI text and repair submissions retry only confirmed 429 and stop at the first accepted receipt', async t => {
  await fixtureCredentials(async () => {
    for (const repair of [false, true]) {
      let posts = 0; let checks = 0;
      const mock = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
        assert.match(String(url), /^https:\/\/api\.openai\.com\/v1\/responses$/); assert.equal(init?.method, 'POST');
        posts++;
        return posts < 3 ? Response.json({ error: { code: 'rate_limit_exceeded', type: 'rate_limit_error' } }, { status: 429 })
          : Response.json({ id: 'resp_accepted', object: 'response', status: 'queued', output: [] });
      });
      try {
        const receipt = await advanceShortRetries(t, () => repair
          ? submitTextRepair('gpt-6-astra', input(), 'Fixture', 'resp_parent', [{ field: 'slug.pl', message: 'Popraw adres.' }], async () => { checks++; }, 'same-durable-repair-job')
          : submitText('gpt-6-astra', input(), 'Fixture', async () => { checks++; }));
        assert.equal(receipt, 'resp_accepted'); assert.equal(posts, 3); assert.equal(checks, 3);
      } finally { mock.mock.restore(); t.mock.timers.reset(); }
    }
  });
});

test('Fal image submission retries a confirmed rate limit with the same body and no nested queue retries', async t => {
  await fixtureCredentials(async () => {
    let posts = 0; let checks = 0; const bodies: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(url), `https://queue.fal.run/${approvedImageModel}`); assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('X-Fal-No-Retry'), '1'); bodies.push(String(init?.body));
      return ++posts < 3 ? Response.json({ detail: { code: 'rate_limit_exceeded' } }, { status: 429 }) : Response.json({ request_id: 'accepted-image' });
    });
    const receipt = await advanceShortRetries(t, () => submitImage(approvedImageModel, 'hero', input(), null, 'Fixture', async () => { checks++; }));
    assert.equal(receipt, 'accepted-image'); assert.equal(posts, 3); assert.equal(checks, 3); assert.equal(new Set(bodies).size, 1);
  });
});

test('provider quota, long Retry-After and unknown HTTP 429 make one attempt only', async t => {
  await fixtureCredentials(async () => {
    for (const provider of ['text', 'image']) for (const scenario of ['quota', 'long', 'unknown']) {
      let posts = 0;
      const mock = t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(init?.method, 'POST'); posts++;
        return Response.json({ error: { code: scenario === 'quota' ? 'insufficient_quota' : scenario === 'long' ? 'rate_limit_exceeded' : 'unknown' } },
          { status: 429, headers: scenario === 'long' ? { 'Retry-After': '60' } : {} });
      });
      try { await assert.rejects(provider === 'text' ? submitText('gpt-6-astra', input(), 'Fixture') : submitImage(approvedImageModel, 'hero', input(), null, 'Fixture'), error => error instanceof ProviderError && !error.uncertain); }
      finally { mock.mock.restore(); }
      assert.equal(posts, 1);
    }
  });
});
