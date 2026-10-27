import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createUsageMetricsStore } from './metrics';

// Opt in only to a named test database. Never fall back to the application's database.
const connection = process.env.EDITORIAL_TEST_DATABASE_URL;
const schema = `metrics_test_${randomUUID().replaceAll('-', '')}`;
let adminPool: Pool;
let isolatedPool: Pool;
const dialect = new PgDialect();
const store = createUsageMetricsStore({ production: () => true, now: () => new Date('2026-07-01T22:00:00Z'),
  query: async statement => {
    const query = dialect.sqlToQuery(statement);
    return isolatedPool.query(query.sql, query.params);
  } });

before(async () => {
  if (!connection) return;
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') throw new Error('Tests require a development environment.');
  adminPool = new Pool({ connectionString: connection, max: 1, connectionTimeoutMillis: 10_000, query_timeout: 15_000 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connection);
  url.searchParams.set('options', `-c search_path=${schema}`);
  isolatedPool = new Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 10_000, query_timeout: 15_000 });
  await isolatedPool.query(await readFile('migrations/0012-seo-metrics.sql', 'utf8'));
});
beforeEach(async () => { if (isolatedPool) await isolatedPool.query('TRUNCATE seo_usage_daily'); });
after(async () => {
  if (isolatedPool) await isolatedPool.end();
  if (adminPool) { await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await adminPool.end(); }
});

test('concurrent anonymous events increment one aggregate row without losing counts', { skip: !connection }, async () => {
  await Promise.all(Array.from({ length: 30 }, () => store.record({ name: 'page_view', path: '/pl/recipes/pasta', source: 'google' })));
  const rows = (await isolatedPool.query('SELECT day::text,event,path,source,count::text FROM seo_usage_daily')).rows;
  assert.deepEqual(rows, [{ day: '2026-07-02', event: 'page_view', path: '/pl/recipes/pasta', source: 'google', count: '30' }]);
  const summary = await store.summary(2);
  assert.equal(summary.total, 30);
  assert.equal(summary.events.find(item => item.name === 'page_view')?.count, 30);
});

test('schema stores only aggregate dimensions and independently rejects private or arbitrary values', { skip: !connection }, async () => {
  const columns = (await isolatedPool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='seo_usage_daily' ORDER BY ordinal_position`, [schema])).rows.map(row => row.column_name);
  assert.deepEqual(columns, ['day', 'event', 'path', 'source', 'count']);
  for (const [event, path, source] of [['page_view', '/pl/admin', 'direct'], ['page_view', '/pl?email=private', 'direct'], ['page_view', '/pl', 'user@example.test'], ['arbitrary', '/pl', 'direct'], ['recipe_save', '/pl', 'direct']]) {
    await assert.rejects(isolatedPool.query('INSERT INTO seo_usage_daily(day,event,path,source) VALUES($1,$2,$3,$4)', ['2026-07-02', event, path, source]), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23514'));
  }
  assert.equal((await isolatedPool.query('SELECT count(*)::int AS count FROM seo_usage_daily')).rows[0].count, 0);
});
