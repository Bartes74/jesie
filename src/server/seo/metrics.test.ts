import assert from 'node:assert/strict';
import test from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { UsageEvent } from '@/lib/usage-metrics';
import { createUsageMetricsStore, handleUsageRequest, resolveUsagePath } from './metrics';

const event: UsageEvent = { name: 'page_view', path: '/pl/recipes/pasta', source: 'chatgpt' };
function request(body: unknown = event, headers: Record<string, string> = {}, url = 'https://www.jesie.pl/api/analytics') {
  return new Request(url, { method: 'POST', headers: { origin: 'https://www.jesie.pl', 'sec-fetch-site': 'same-origin', 'user-agent': 'Mozilla/5.0 Safari/604', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
function harness(production = true) {
  const recorded: UsageEvent[] = [];
  const resolved: string[] = [];
  return { recorded, resolved, dependencies: { production: () => production,
    resolvePath: async (path: string) => { resolved.push(path); return path.replace('/old-pasta', '/pasta'); },
    record: async (value: UsageEvent) => { recorded.push(value); return true; } } };
}

test('same-origin requests store only canonical event dimensions and emit no cookies', async () => {
  const test = harness();
  const response = await handleUsageRequest(request({ ...event, path: '/pl/recipes/old-pasta?email=private@example.test#step-1' }), test.dependencies);
  assert.equal(response.status, 204);
  assert.deepEqual(test.recorded, [event]);
  assert.deepEqual(test.resolved, ['/pl/recipes/old-pasta']);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), '');
});

test('both plan routes resolve through the real resolver and retain only aggregate dimensions', async () => {
  for (const locale of ['pl', 'en']) {
    const path = `/${locale}/plan`;
    assert.equal(await resolveUsagePath(path), path);
    for (const name of ['page_view', 'shopping_copy', 'plan_remove', 'pantry_use', 'search', 'no_results'] as const) {
      const recorded: UsageEvent[] = [];
      const response = await handleUsageRequest(request({ name, path: `${path}?q=private&meal=private#shopping`, source: 'direct' }), {
        production: () => true, resolvePath: resolveUsagePath, record: async value => { recorded.push(value); return true; },
      });
      assert.equal(response.status, 204);
      assert.deepEqual(recorded, [{ name, path, source: 'direct' }]);
    }
  }
  for (const path of ['/pl', '/en', '/pl/o-serwisie', '/en/o-serwisie', '/pl/kolekcje', '/en/poradniki']) assert.equal(await resolveUsagePath(path), path);
  for (const path of ['/pl/plan/private', '/en/plan/recipe', '/admin', '/pl/preview/private', '/de/plan']) assert.equal(await resolveUsagePath(path), null);
});

test('preview, DNT, global privacy control and bots never resolve pages or persist counts', async () => {
  for (const [production, headers] of [[false, {}], [true, { dnt: '1' }], [true, { 'sec-gpc': '1' }], [true, { 'user-agent': 'OAI-SearchBot/1.0' }], [true, { 'user-agent': 'ChatGPT-User/1.0' }]] as Array<[boolean, Record<string, string>]>) {
    const test = harness(production);
    assert.equal((await handleUsageRequest(request(event, headers), test.dependencies)).status, 204);
    assert.equal(test.recorded.length, 0);
    assert.equal(test.resolved.length, 0);
  }
});

test('cross-origin and same-site sibling requests are rejected before reading event data', async () => {
  for (const headers of [{ origin: '' }, { origin: 'https://attacker.test' }, { origin: 'https://jesie.pl' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }] as Array<Record<string, string>>) {
    const test = harness();
    assert.equal((await handleUsageRequest(request(event, headers), test.dependencies)).status, 403);
    assert.equal(test.recorded.length, 0);
    assert.equal(test.resolved.length, 0);
  }
  assert.equal((await handleUsageRequest(request(event, {}, 'https://preview.vercel.app/api/analytics'), harness().dependencies)).status, 403);
});

test('extra data, private paths, non-recipe actions and unsupported content types are rejected', async () => {
  for (const payload of [{ ...event, referrer: 'https://google.com?q=private' }, { ...event, userId: 'user-1' }, { ...event, path: '/pl/admin/recipes/preview' }, { ...event, name: 'ingredient_check', path: '/pl' }, { ...event, source: 'private-value' }]) {
    const test = harness();
    assert.equal((await handleUsageRequest(request(payload), test.dependencies)).status, 400);
    assert.equal(test.recorded.length, 0);
  }
  assert.equal((await handleUsageRequest(request(event, { 'content-type': 'text/plain' }), harness().dependencies)).status, 415);
});

test('actual streamed bytes are capped even when Content-Length lies or is absent', async () => {
  for (const headers of [{}, { 'content-length': '1' }, { 'content-length': '99999' }] as Array<Record<string, string>>) {
    const test = harness();
    assert.equal((await handleUsageRequest(request({ ...event, extra: 'x'.repeat(2048) }, headers), test.dependencies)).status, 413);
    assert.equal(test.resolved.length, 0);
  }
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(2000)); }, cancel() { cancelled = true; } });
  const streamed = new Request('https://www.jesie.pl/api/analytics', { method: 'POST', body, duplex: 'half', headers: { origin: 'https://www.jesie.pl', 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' } } as RequestInit & { duplex: 'half' });
  assert.equal((await handleUsageRequest(streamed, harness().dependencies)).status, 413);
  assert.equal(cancelled, true);
});

test('missing publications and unavailable database return inert responses without leaking payloads', async () => {
  const test = harness();
  assert.equal((await handleUsageRequest(request(), { ...test.dependencies, resolvePath: async () => null })).status, 404);
  assert.equal(test.recorded.length, 0);
  const failure = await handleUsageRequest(request(), { ...test.dependencies, record: async () => { throw new Error('sensitive database details'); } });
  assert.equal(failure.status, 503);
  assert.equal(await failure.text(), '');
});

test('store uses a parameterized atomic counter in the Warsaw bucket and skips development', async () => {
  const statements: SQL[] = [];
  const store = createUsageMetricsStore({ production: () => true, now: () => new Date('2026-07-01T22:00:00Z'), query: async query => { statements.push(query); return { rows: [] }; } });
  assert.equal(await store.record({ ...event, path: '/pl/recipes/pasta?servings=8' }), true);
  const query = new PgDialect().sqlToQuery(statements[0]);
  assert.deepEqual(query.params, ['2026-07-02', 'page_view', '/pl/recipes/pasta', 'chatgpt']);
  assert.match(query.sql, /ON CONFLICT\(day,event,path,source\) DO UPDATE SET count=seo_usage_daily.count\+1/);
  const disabled = createUsageMetricsStore({ production: () => false, query: async () => { throw new Error('Development must never touch the database'); } });
  assert.equal(await disabled.record(event), false);
  assert.equal((await disabled.summary()).total, 0);
  assert.equal((await disabled.summary()).enabled, false);
});

test('summary combines event, source and canonical-path counts for a bounded calendar period', async () => {
  const statements: SQL[] = [];
  const store = createUsageMetricsStore({ production: () => true, now: () => new Date('2026-10-26T12:00:00Z'), query: async query => {
    statements.push(query);
    return { rows: [
      { event: 'page_view', path: '/pl/recipes/pasta', source: 'google', count: '3' },
      { event: 'servings_change', path: '/pl/recipes/pasta', source: 'google', count: '2' },
      { event: 'page_view', path: '/en', source: 'chatgpt', count: '7' },
    ] };
  } });
  const result = await store.summary(3);
  assert.equal(result.total, 12);
  assert.deepEqual(result.period, { from: '2026-10-24', to: '2026-10-26', days: 3, timeZone: 'Europe/Warsaw' });
  assert.deepEqual(result.events.find(value => value.name === 'page_view'), { name: 'page_view', count: 10 });
  assert.deepEqual(result.sources.find(value => value.source === 'google'), { source: 'google', count: 5 });
  assert.deepEqual(result.paths, [{ path: '/en', count: 7 }, { path: '/pl/recipes/pasta', count: 5 }]);
  assert.deepEqual(result.pageViews, [{ path: '/en', count: 7 }, { path: '/pl/recipes/pasta', count: 3 }]);
  assert.deepEqual(result.interactions, [{ path: '/pl/recipes/pasta', count: 2 }]);
  assert.deepEqual(new PgDialect().sqlToQuery(statements[0]).params, ['2026-10-24', '2026-10-26']);
});
