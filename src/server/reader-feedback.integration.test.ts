import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import type { ReaderFeedbackInput } from '@/lib/reader-feedback';
import { closeDb } from './db';
import { getReaderFeedback, handleReaderFeedback, resolveReaderFeedback } from './reader-feedback';

// All writes belong to a random, disposable schema on the explicit development
// direct endpoint. Neither application tables nor the production branch are used.
const schema = `reader_feedback_test_${randomUUID().replaceAll('-', '')}`;
const previousDatabaseUrl = process.env.DATABASE_URL;
let adminPool: Pool | undefined;
let isolatedPool: Pool | undefined;
let schemaCreated = false;

function endpointIdentity(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('A configured database URL is invalid; connection details are withheld.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected a development Postgres connection.');
  // A Neon pooled hostname and its direct hostname are the same branch endpoint.
  return url.hostname.toLowerCase().replace(/-pooler(?=\.)/, '');
}

before(async () => {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') throw new Error('Feedback integration tests refuse production.');
  const local = parse(await readFile('.env.local', 'utf8'));
  const production = parse(await readFile('.env.production.local', 'utf8'));
  if (local.NODE_ENV === 'production' || local.VERCEL_ENV === 'production') throw new Error('The local test configuration must be development.');
  const connection = local.DATABASE_URL_UNPOOLED;
  if (!connection) throw new Error('The local development direct DATABASE_URL_UNPOOLED is required.');
  const developmentEndpoint = endpointIdentity(connection);
  if (new URL(connection).hostname.includes('-pooler.')) throw new Error('Tests require the direct development endpoint.');
  const productionConnections = Object.entries(production).filter(([key, value]) => /^(?:DATABASE_URL|POSTGRES_URL)/.test(key) && /^postgres(?:ql)?:/.test(value)).map(([, value]) => value);
  if (!productionConnections.length) throw new Error('The production endpoint must be identifiable before integration tests run.');
  if (productionConnections.some(value => endpointIdentity(value) === developmentEndpoint)) throw new Error('Tests refuse the production database branch, including its direct endpoint.');

  adminPool = new Pool({ connectionString: connection, max: 1, connectionTimeoutMillis: 10_000, query_timeout: 15_000 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  const isolatedUrl = new URL(connection);
  isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
  isolatedPool = new Pool({ connectionString: isolatedUrl.toString(), max: 2, connectionTimeoutMillis: 10_000, query_timeout: 15_000 });
  const current = await isolatedPool.query('SELECT current_schema() AS name');
  assert.equal(current.rows[0].name, schema);
  await isolatedPool.query(await readFile('migrations/0001-editorial.sql', 'utf8'));
  await isolatedPool.query(await readFile('migrations/0015-recipe-trash.sql', 'utf8'));
  await isolatedPool.query(await readFile('migrations/0012-seo-metrics.sql', 'utf8'));
  // Migration must preserve existing aggregates while changing their constraints.
  await isolatedPool.query("INSERT INTO seo_usage_daily(day,event,path,source,count) VALUES('2026-10-18','page_view','/pl','direct',7)");
  await isolatedPool.query(await readFile('migrations/0024-kitchen-experience.sql', 'utf8'));
  await closeDb();
  process.env.DATABASE_URL = isolatedUrl.toString();
});

after(async () => {
  await closeDb();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (isolatedPool) await isolatedPool.end();
  if (adminPool) {
    try { if (schemaCreated) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await adminPool.end(); }
  }
});

function pool(): Pool {
  assert.ok(isolatedPool, 'The disposable schema must be ready.');
  return isolatedPool;
}

async function fixture() {
  const id = `feedback-${randomUUID()}`;
  const oldPublication = randomUUID();
  const currentPublication = randomUUID();
  const snapshot = (revision: number) => ({ recipe: { id, title: { pl: `Przepis testowy ${revision}`, en: `Test recipe ${revision}` }, steps: [{ id: revision === 1 ? 'old-step' : 'current-step', title: { pl: 'Krok', en: 'Step' } }] } });
  await pool().query(`INSERT INTO editorial_recipe(id,revision,content,content_hash,checks,created_by,updated_by,updated_by_name)
    VALUES($1,2,$2::jsonb,'test-current-hash','{}'::jsonb,'test-owner','test-owner','Test owner')`, [id, JSON.stringify(snapshot(2))]);
  for (const [revision, publication] of [[1, oldPublication], [2, currentPublication]] as const) {
    await pool().query(`INSERT INTO editorial_publication(id,recipe_id,revision,snapshot,content_hash,checks,approval_origin,published_by,published_by_name)
      VALUES($1,$2,$3,$4::jsonb,$5,'{}'::jsonb,'manual','test-owner','Test owner')`, [publication, id, revision, JSON.stringify(snapshot(revision)), `test-hash-${revision}`]);
  }
  await pool().query("UPDATE editorial_recipe SET publication_status='published',published_id=$2,published_revision=2 WHERE id=$1", [id, currentPublication]);
  return { id, input: { requestKey: randomUUID(), recipeId: id, version: '1', kind: 'problem' as const, stepId: 'old-step', message: 'Opis problemu z poprzednią wersją przepisu.' } };
}

function request(input: unknown, headers: Record<string, string> = {}) {
  return new Request('https://www.jesie.pl/api/feedback', { method: 'POST', headers: { origin: 'https://www.jesie.pl', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers }, body: JSON.stringify(input) });
}

test('real feedback handler accepts an older immutable publication and deduplicates concurrent retries', async () => {
  const { id, input } = await fixture();
  const results = await Promise.all(Array.from({ length: 6 }, () => handleReaderFeedback(request(input))));
  assert.deepEqual(results.map(result => result.status), Array(6).fill(202));
  const rows = (await pool().query('SELECT recipe_id,publication_revision,kind,step_id,message FROM reader_feedback WHERE recipe_id=$1', [id])).rows;
  assert.deepEqual(rows, [{ recipe_id: id, publication_revision: 1, kind: 'problem', step_id: 'old-step', message: input.message }]);
  assert.equal(results[0].headers.get('cache-control'), 'no-store');
  assert.equal(results[0].headers.get('x-robots-tag'), 'noindex');
});

test('a reused key with different feedback returns 409 and cannot overwrite the original payload', async () => {
  const { input } = await fixture();
  assert.equal((await handleReaderFeedback(request(input))).status, 202);
  for (const change of [{ message: 'Inny opis problemu.' }, { kind: 'changed' }, { version: '2', stepId: 'current-step' }]) {
    assert.equal((await handleReaderFeedback(request({ ...input, ...change }))).status, 409);
  }
  const rows = (await pool().query('SELECT publication_revision,kind,step_id,message FROM reader_feedback WHERE request_key=$1', [input.requestKey])).rows;
  assert.deepEqual(rows, [{ publication_revision: 1, kind: 'problem', step_id: 'old-step', message: input.message }]);
});

test('a request-key race across different recipe locks accepts one form and conflicts the other', async () => {
  const first = await fixture();
  const second = await fixture();
  const sharedKey = randomUUID();
  const results = await Promise.all([first, second].map(({ input }) => handleReaderFeedback(request({ ...input, requestKey: sharedKey }))));
  assert.deepEqual(results.map(result => result.status).sort(), [202, 409]);
  assert.equal((await pool().query('SELECT count(*)::int AS count FROM reader_feedback WHERE request_key=$1', [sharedKey])).rows[0].count, 1);
});

test('the submitted snapshot governs step validation rather than the currently published version', async () => {
  const { id, input } = await fixture();
  assert.equal((await handleReaderFeedback(request(input))).status, 202);
  const current: ReaderFeedbackInput = { ...input, requestKey: randomUUID(), version: '2', stepId: 'current-step' };
  assert.equal((await handleReaderFeedback(request(current))).status, 202);
  for (const invalid of [
    { ...input, requestKey: randomUUID(), stepId: 'current-step' },
    { ...current, requestKey: randomUUID(), stepId: 'old-step' },
    { ...input, requestKey: randomUUID(), version: '3' },
  ]) assert.equal((await handleReaderFeedback(request(invalid))).status, 404);
  const revisions = (await pool().query('SELECT publication_revision FROM reader_feedback WHERE recipe_id=$1 ORDER BY publication_revision', [id])).rows;
  assert.deepEqual(revisions, [{ publication_revision: 1 }, { publication_revision: 2 }]);
});

test('withdrawing the recipe rejects both older and current feedback without resurrecting its history', async () => {
  const { id, input } = await fixture();
  await pool().query("UPDATE editorial_recipe SET publication_status='unpublished' WHERE id=$1", [id]);
  for (const body of [input, { ...input, requestKey: randomUUID(), version: '2', stepId: 'current-step' }]) assert.equal((await handleReaderFeedback(request(body))).status, 404);
  assert.equal((await pool().query('SELECT count(*)::int AS count FROM reader_feedback WHERE recipe_id=$1', [id])).rows[0].count, 0);
  assert.equal((await pool().query('SELECT count(*)::int AS count FROM editorial_publication WHERE recipe_id=$1', [id])).rows[0].count, 2);
});

test('administrative reads preserve the submitted revision and resolution removes an open report', async () => {
  const { id, input } = await fixture();
  assert.equal((await handleReaderFeedback(request(input))).status, 202);
  const open = await getReaderFeedback();
  assert.equal(open.available, true);
  const report = open.items.find(item => item.recipeId === id);
  assert.ok(report);
  assert.equal(report.revision, 1);
  assert.equal(report.stepId, 'old-step');
  assert.equal(report.title, 'Przepis testowy 2');
  assert.equal('requestKey' in report, false);
  await resolveReaderFeedback(report.id, 'test-owner');
  assert.equal((await getReaderFeedback()).items.some(item => item.id === report.id), false);
  const resolved = (await pool().query('SELECT status,resolved_at,resolved_by FROM reader_feedback WHERE id=$1', [report.id])).rows[0];
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolved_by, 'test-owner');
  assert.ok(resolved.resolved_at instanceof Date);
});

test('private notes, cooking sessions and request metadata never become feedback dimensions', async () => {
  const { id, input } = await fixture();
  for (const extra of [{ sessionId: 'private-session-do-not-store' }, { note: 'private-note-do-not-store' }, { email: 'private@example.invalid' }]) {
    assert.equal((await handleReaderFeedback(request({ ...input, ...extra }))).status, 400);
  }
  assert.equal((await handleReaderFeedback(request(input, { cookie: 'jesie.session=private-cookie-do-not-store', 'x-forwarded-for': '192.0.2.9', 'user-agent': 'private-agent-do-not-store' }))).status, 202);
  const columns = (await pool().query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='reader_feedback' ORDER BY ordinal_position`, [schema])).rows.map(row => row.column_name);
  assert.deepEqual(columns, ['id', 'request_key', 'recipe_id', 'publication_revision', 'kind', 'step_id', 'message', 'status', 'created_at', 'resolved_at', 'resolved_by']);
  const stored = (await pool().query('SELECT * FROM reader_feedback WHERE recipe_id=$1', [id])).rows;
  assert.equal(stored.length, 1);
  assert.doesNotMatch(JSON.stringify(stored), /private-session|private-note|private-cookie|private-agent|192\.0\.2\.9|private@example/);
});

test('the metrics migration preserves counts and SQL independently permits the new public dimensions', async () => {
  assert.equal((await pool().query("SELECT count::text AS count FROM seo_usage_daily WHERE day='2026-10-18' AND event='page_view' AND path='/pl' AND source='direct'")).rows[0].count, '7');
  const accepted = [
    ['pantry_use', '/pl'], ['search', '/en'], ['no_results', '/pl'], ['shopping_copy', '/en'], ['plan_remove', '/pl'],
    ['page_view', '/pl/kolekcje'], ['page_view', '/en/poradniki'], ['page_view', '/pl/kolekcje/szybkie-obiady'],
    ...['cooking_start', 'cooking_complete', 'repeat_cook', 'cooking_step_undo', 'ingredient_uncheck', 'plan_add', 'feedback_submit'].map(event => [event, '/pl/recipes/test-recipe']),
  ];
  for (const [event, path] of accepted) await pool().query('INSERT INTO seo_usage_daily(day,event,path,source) VALUES($1,$2,$3,$4)', ['2026-10-19', event, path, 'direct']);
  assert.equal((await pool().query("SELECT count(*)::int AS count FROM seo_usage_daily WHERE day='2026-10-19'")).rows[0].count, accepted.length);
  for (const [event, path, source] of [
    ['page_view', '/admin', 'direct'], ['page_view', '/pl/preview/private-recipe', 'direct'], ['page_view', '/pl?email=private', 'direct'],
    ['pantry_use', '/pl/o-serwisie', 'direct'], ['recipe_save', '/pl', 'direct'], ['cooking_complete', '/pl/kolekcje', 'direct'],
    ['arbitrary-event', '/pl', 'direct'], ['page_view', '/pl', 'private@example.invalid'],
  ]) await assert.rejects(pool().query('INSERT INTO seo_usage_daily(day,event,path,source) VALUES($1,$2,$3,$4)', ['2026-10-20', event, path, source]), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23514'));
  assert.equal((await pool().query("SELECT count(*)::int AS count FROM seo_usage_daily WHERE day='2026-10-20'")).rows[0].count, 0);
  const columns = (await pool().query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='seo_usage_daily' ORDER BY ordinal_position`, [schema])).rows.map(row => row.column_name);
  assert.deepEqual(columns, ['day', 'event', 'path', 'source', 'count']);
});
