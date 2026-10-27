import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import Decimal from 'decimal.js';
import { Pool } from 'pg';
import type { EditorialActor, EditorialRecord } from '@/lib/editorial-types';
import { closeDb, getDb } from '@/server/db';
import { createRecipe } from '@/server/editorial/store';
import { getAiBudgetSettings } from './budget-settings';
import { AiError } from './errors';
import { aiJobs, aiLedger, aiPhotoBatches } from './schema';
import { reconcilePhotoCosts, reconcileTrendPhotoCosts, reconcileAutomatedTrendPhotoCosts, photoCostReconciliationLimit } from './photo-cost-reconciliation';
import { readPhotoBills, type PhotoBillingRead } from './photo-billing-reader';
import { admitTrendRun, trendBudget } from '../trends/store';

const schema = `photo_cost_test_${randomUUID().replaceAll('-', '')}`;
let adminPool: Pool; let isolatedPool: Pool; let recipe: EditorialRecord;
const previousDatabaseUrl = process.env.DATABASE_URL;
const owner: EditorialActor = { id: 'billing-owner', name: 'Owner', email: 'owner@example.invalid', role: 'owner' };
const admin: EditorialActor = { id: 'billing-admin', name: 'Admin', email: 'admin@example.invalid', role: 'admin' };

before(async () => {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') throw new Error('Billing tests refuse production.');
  const local = parse(await readFile('.env.local', 'utf8'));
  const production = parse(await readFile('.env.production.local', 'utf8'));
  if (local.NODE_ENV === 'production' || local.VERCEL_ENV === 'production') throw new Error('The local test configuration must be development.');
  const explicit = process.env.AI_TEST_DATABASE_URL;
  if (explicit && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(explicit).hostname)) throw new Error('An explicit test endpoint must be loopback.');
  const connection = explicit || local.AI_TEST_DATABASE_URL || local.DATABASE_URL_UNPOOLED || local.POSTGRES_URL_NON_POOLING;
  if (!connection) throw new Error('An explicit development direct Postgres connection is required.');
  const endpoint = (value: string) => new URL(value).hostname.toLowerCase().replace(/-pooler(?=\.)/, '');
  const productionConnections = Object.entries(production).filter(([key, value]) => /^(?:DATABASE_URL|POSTGRES_URL)/.test(key) && /^postgres(?:ql)?:/.test(value)).map(([, value]) => value);
  if (!productionConnections.length || productionConnections.some(value => endpoint(value) === endpoint(connection))) throw new Error('Billing tests refuse the production database branch.');
  if (new URL(connection).hostname.includes('-pooler.')) throw new Error('Billing tests require the development direct endpoint.');
  adminPool = new Pool({ connectionString: connection, max: 1, connectionTimeoutMillis: 10_000, query_timeout: 15_000 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connection); url.searchParams.set('options', `-c search_path=${schema}`); url.searchParams.set('application_name', schema);
  await closeDb();
  process.env.DATABASE_URL = url.toString(); isolatedPool = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 10_000, query_timeout: 15_000 });
  assert.equal((await isolatedPool.query('SELECT current_schema() AS name')).rows[0].name, schema);
  await isolatedPool.query(`CREATE TABLE auth_user(id text PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,image text,role text NOT NULL DEFAULT 'admin',disabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
  await isolatedPool.query(`INSERT INTO auth_user(id,name,email,role) VALUES('billing-owner','Stored owner','owner@example.invalid','owner'),('billing-admin','Stored admin','admin@example.invalid','admin')`);
  for (const name of ['0001-editorial', '0002-ai', '0003-trends', '0004-trend-research', '0005-trend-manual-runs', '0006-ingredient-reuse', '0007-local-photo-corrections', '0008-ai-photo-batches', '0009-ai-budget-settings', '0010-daily-publication', '0011-seo-discovery', '0014-seo-workflows', '0015-recipe-trash', '0018-content-approval','0021-recipe-result-recovery','0026-remove-spending-limits','0027-manual-review-workflow','0028-ingredient-dictionary','0029-ingredient-evidence-recheck']) {
    await isolatedPool.query(await readFile(`migrations/${name}.sql`, 'utf8'));
  }
  process.env.AI_DAILY_LIMIT_USD = '100'; process.env.AI_MONTHLY_LIMIT_USD = '100'; process.env.AI_PILOT_LIMIT_USD = '100';
  recipe = await createRecipe({ title: 'Synthetic billing history', originalText: '' }, owner);
});
beforeEach(async () => {
  await isolatedPool.query(`TRUNCATE ai_cost_ledger,ai_job,ai_photo_batch,trend_candidate,trend_run CASCADE`);
  await isolatedPool.query(`UPDATE auth_user SET disabled=false,role=CASE WHEN id='billing-owner' THEN 'owner' ELSE 'admin' END`);
  await isolatedPool.query(`UPDATE trend_setting SET enabled=false,publication_authorized_by=NULL,auto_pause_reason=NULL,monthly_limit_usd=150 WHERE id='global'`);
  process.env.OPENAI_API_KEY = 'offline-test-no-submissions'; process.env.FAL_KEY = 'offline-test-no-submissions';
  process.env.BLOB_READ_WRITE_TOKEN = 'offline-test-no-storage'; process.env.CRON_SECRET = 'offline-test-no-cron';
});
after(async () => {
  await closeDb(); if (isolatedPool) await isolatedPool.end();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabaseUrl;
  if (adminPool) { await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await adminPool.end(); }
});

type JobInsert = typeof aiJobs.$inferInsert;
function receipt(overrides: Partial<JobInsert> = {}): JobInsert {
  const id = randomUUID();
  return { id, recipeId: recipe.id, baseRevision: recipe.revision, kind: 'hero', targetId: null, status: 'applied', provider: 'fal', model: 'mock-image-model',
    brief: 'Synthetic receipt; never submitted', requestKey: randomUUID(), inputHash: randomUUID(), input: recipe.content,
    createdBy: owner.id, createdByName: owner.name, providerRequestId: `mock_${id}`, providerFinishedAt: new Date(), reservedUsd: '2', chargedUsd: '2', costBasis: 'reservation', ...overrides };
}
async function seed(overrides: Partial<JobInsert> = {}) {
  const job = receipt(overrides); await getDb().insert(aiJobs).values(job);
  await getDb().insert(aiLedger).values([
    { id: randomUUID(), jobId: job.id, entry: 'reserve', amountUsd: job.reservedUsd ?? '0', basis: 'reservation' },
    { id: randomUUID(), jobId: job.id, entry: 'settle', amountUsd: new Decimal(job.chargedUsd ?? job.reservedUsd ?? '0').minus(job.reservedUsd ?? '0').toFixed(8), basis: job.costBasis ?? 'reservation' },
  ]);
  return job;
}
const denied = (error: unknown) => error instanceof AiError && error.code === 'FORBIDDEN';
async function history() {
  return (await isolatedPool.query(`SELECT id,charged_usd,cost_basis,status,provider_request_id FROM ai_job ORDER BY id`)).rows;
}

test('confirmed receipts settle exact actual costs and confirmed zero while legacy job and packet history stays intact', async () => {
  const jobs = await Promise.all([seed(), seed({ kind: 'step', targetId: 'step', status: 'failed' }), seed({ kind: 'ingredient', targetId: 'ingredient', status: 'uncertain' }), seed({ status: 'ready' })]);
  const packetId = randomUUID();
  await getDb().insert(aiPhotoBatches).values({ id: packetId, recipeId: recipe.id, baseRevision: recipe.revision, input: recipe.content, inputHash: randomUUID(), slots: [], status: 'blocked', requestKey: randomUUID(), createdBy: owner.id, createdByName: owner.name, reservedUsd: '14', remainingReservedUsd: '14' });
  const settings = await getAiBudgetSettings(owner);
  const originalLedger = (await isolatedPool.query(`SELECT * FROM ai_cost_ledger ORDER BY id`)).rows;
  const report = await reconcilePhotoCosts(admin, async requests => {
    assert.equal(requests.length, 4);
    // No transaction/budget lock may be held over the provider read.
    const client = await isolatedPool.connect();
    try { await client.query('BEGIN'); assert.equal((await client.query(`SELECT pg_try_advisory_xact_lock(hashtext('jesie-ai-budget')) AS free`)).rows[0].free, true); }
    finally { await client.query('ROLLBACK'); client.release(); }
    return { status: 'pending', httpStatus: 200, costs: { [jobs[0].providerRequestId!]: '0.12', [jobs[1].providerRequestId!]: '0', [jobs[2].providerRequestId!]: '0.2' } };
  });
  assert.equal(report.scannedJobs, 4); assert.equal(report.reconciledJobs, 3); assert.equal(report.pendingJobs, 1);
  assert.equal(report.estimatedCostBeforeUsd, '8.00000000'); assert.equal(report.verifiedCostUsd, '0.32000000');
  assert.deepEqual(report.before, { usedUsd: '0.00000000', reservedUsd: '0.00000000' });
  assert.deepEqual(report.after, { usedUsd: '0.32000000', reservedUsd: '0.00000000' });
  assert.equal(report.remainingJobs, 1);
  const rows = await history();
  assert.equal(rows.find(row => row.id === jobs[1].id).charged_usd, '0.00000000');
  assert.equal(rows.find(row => row.id === jobs[3].id).cost_basis, 'reservation');
  assert.deepEqual((await isolatedPool.query(`SELECT * FROM ai_cost_ledger WHERE entry<>'reconcile' ORDER BY id`)).rows, originalLedger);
  assert.equal((await isolatedPool.query(`SELECT count(*)::int AS n FROM ai_cost_ledger WHERE entry='reconcile'`)).rows[0].n, 3);
  assert.equal((await isolatedPool.query(`SELECT remaining_reserved_usd FROM ai_photo_batch WHERE id=$1`, [packetId])).rows[0].remaining_reserved_usd, '14.00000000');
  const after = await getAiBudgetSettings(owner); assert.deepEqual(after.settings, { ...settings.settings, serverNow: after.settings.serverNow }); assert.deepEqual(after.audit, settings.audit);
});

test('403, absent credentials, failed GETs and invalid bills never erase conservative estimates', async () => {
  const job = await seed(); const initial = await history();
  const outcomes: PhotoBillingRead[] = [
    { status: 'forbidden', httpStatus: 403, costs: { [job.providerRequestId!]: '0' } },
    { status: 'not_configured', httpStatus: null, costs: {} },
    { status: 'verified', httpStatus: 200, costs: { [job.providerRequestId!]: '-1' } },
    { status: 'verified', httpStatus: 200, costs: { unknown_receipt: '0' } },
  ];
  for (const read of outcomes) {
    const report = await reconcilePhotoCosts(owner, async () => read);
    assert.equal(report.reconciledJobs, 0); assert.equal(report.pendingJobs, 1); assert.deepEqual(report.after, report.before);
    assert.deepEqual(await history(), initial);
  }
  const unavailable = await reconcilePhotoCosts(owner, async () => { throw new Error('private provider diagnostic'); });
  assert.equal(unavailable.read.status, 'unavailable'); assert.equal(unavailable.reconciledJobs, 0);
  assert.equal(JSON.stringify(unavailable).includes('private provider diagnostic'), false);
  assert.equal((await isolatedPool.query(`SELECT count(*)::int AS n FROM ai_cost_ledger WHERE entry='reconcile'`)).rows[0].n, 0);
});

test('selection includes only known finished fal photo receipts and makes billing GETs for exact captured IDs', async () => {
  const eligible = await seed({ status: 'cancelled' });
  await seed({ providerRequestId: null }); await seed({ providerRequestId: 'invalid/receipt' });
  await seed({ providerFinishedAt: null }); await seed({ status: 'generating' });
  await seed({ costBasis: 'usage', chargedUsd: '0.1' }); await seed({ kind: 'recipe', provider: 'openai' });
  const trendId = randomUUID();
  await isolatedPool.query(`INSERT INTO trend_run(id,date,mode,sources) VALUES($1,$2,'daily','[]')`, [trendId, randomUUID()]);
  await seed({ trendRunId: trendId });
  let calls = 0;
  const report = await reconcilePhotoCosts(owner, requests => readPhotoBills(requests, { credential: 'fixture-private-key', fetch: async (input, init) => {
    calls++; const url = new URL(String(input));
    assert.equal(init?.method ?? 'GET', 'GET'); assert.equal(url.origin + url.pathname, 'https://api.fal.ai/v1/models/billing-events');
    assert.deepEqual(url.searchParams.getAll('request_id'), [eligible.providerRequestId]);
    return Response.json({ billing_events: [{ request_id: eligible.providerRequestId, cost_total: 0.05 }], has_more: false, next_cursor: null });
  } }));
  assert.equal(calls, 1); assert.equal(report.scannedJobs, 1); assert.equal(report.reconciledJobs, 1);
  assert.equal(JSON.stringify(report).includes('fixture-private-key'), false);
  assert.equal((await isolatedPool.query(`SELECT count(*)::int AS n FROM ai_job WHERE cost_basis='reservation'`)).rows[0].n, 6);
});

test('the billing reader groups captured receipts by 50 and never infers missing bills from an empty response', async () => {
  await getDb().insert(aiJobs).values(Array.from({ length: 51 }, () => receipt()));
  const groupSizes: number[] = [];
  const report = await reconcilePhotoCosts(owner, requests => readPhotoBills(requests, { credential: 'fixture', fetch: async (input, init) => {
    assert.equal(init?.method ?? 'GET', 'GET');
    const ids = new URL(String(input)).searchParams.getAll('request_id'); groupSizes.push(ids.length);
    assert.ok(ids.every(id => requests.some(request => request.requestId === id)));
    return Response.json({ billing_events: [], has_more: false, next_cursor: null });
  } }));
  assert.deepEqual(groupSizes, [50, 1]); assert.equal(report.pendingJobs, 51); assert.equal(report.reconciledJobs, 0);
  assert.deepEqual(report.before, report.after);
});

test('billing requires a current owner/admin account before reading and again before settlement', async () => {
  const job = await seed(); let reads = 0;
  const reader = async (): Promise<PhotoBillingRead> => { reads++; return { status: 'verified', httpStatus: 200, costs: { [job.providerRequestId!]: '0.1' } }; };
  await assert.rejects(reconcilePhotoCosts({ ...owner, id: 'jesie-trend-worker' }, reader), denied);
  await isolatedPool.query(`UPDATE auth_user SET disabled=true WHERE id=$1`, [admin.id]);
  await assert.rejects(reconcilePhotoCosts(admin, reader), denied);
  assert.equal(reads, 0);
  await assert.rejects(reconcilePhotoCosts(owner, async () => {
    await isolatedPool.query(`UPDATE auth_user SET role='reader' WHERE id=$1`, [owner.id]); return reader();
  }), denied);
  assert.equal(reads, 1); assert.equal((await history())[0].cost_basis, 'reservation');
  assert.equal((await isolatedPool.query(`SELECT count(*)::int AS n FROM ai_cost_ledger WHERE entry='reconcile'`)).rows[0].n, 0);
});

test('simultaneous reconciliations verify the same receipt and settle it only once', async () => {
  const job = await seed(); let reads = 0; let release!: () => void;
  const bothReading = new Promise<void>(resolve => { release = resolve; });
  const reader = async (): Promise<PhotoBillingRead> => {
    if (++reads === 2) release(); await bothReading;
    return { status: 'verified', httpStatus: 200, costs: { [job.providerRequestId!]: '0.125' } };
  };
  const reports = await Promise.all([reconcilePhotoCosts(owner, reader), reconcilePhotoCosts(admin, reader)]);
  assert.equal(reports.reduce((total, report) => total + report.reconciledJobs, 0), 1);
  assert.equal(reports.reduce((total, report) => total + report.alreadySettledJobs, 0), 1);
  assert.equal((await isolatedPool.query(`SELECT count(*)::int AS n FROM ai_cost_ledger WHERE entry='reconcile'`)).rows[0].n, 1);
  assert.equal((await history())[0].charged_usd, '0.12500000');
});

test('one request inspects at most 500 historical jobs and reports the remainder without modifying them', async () => {
  await getDb().insert(aiJobs).values(Array.from({ length: photoCostReconciliationLimit + 1 }, () => receipt()));
  const report = await reconcilePhotoCosts(owner, async requests => {
    assert.equal(requests.length, photoCostReconciliationLimit); return { status: 'forbidden', httpStatus: 403, costs: {} };
  });
  assert.equal(report.scannedJobs, 500); assert.equal(report.limited, true); assert.equal(report.remainingJobs, 501);
  assert.equal(report.reconciledJobs, 0); assert.deepEqual(report.after, report.before);
});

async function seedTrend() {
  const id = randomUUID();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await isolatedPool.query(`INSERT INTO trend_run(id,date,mode,status,recipe_id,expected_revision,search_reserved_usd,search_charged_usd,packet_remaining_usd,sources)
    VALUES($1,$2,'daily','awaiting_review',$3,$4,40,1.370781,0,'{}')`, [id, yesterday, recipe.id, recipe.revision]);
  return id;
}
async function enableAutomation() {
  await isolatedPool.query(`UPDATE trend_setting SET enabled=true,publication_authorized_by=$1 WHERE id='global'`, [owner.id]);
}

test('verified trend bills record actual cost while search needs no financial admission and Studio history stays untouched', async () => {
  const trendRunId = await seedTrend(); await enableAutomation();
  const studio = await seed();
  await seed({ trendRunId, provider: 'openai', kind: 'recipe', reservedUsd: '4', chargedUsd: '2.030260', costBasis: 'usage' });
  const applied = await seed({ trendRunId, reservedUsd: '97.4', chargedUsd: '97.4' });
  const failed = await seed({ trendRunId, status: 'failed', reservedUsd: '10', chargedUsd: '10' });
  const initialStudio = (await history()).find(row => row.id === studio.id);
  const settings = await getAiBudgetSettings(owner);
  const runBefore = (await isolatedPool.query(`SELECT * FROM trend_run WHERE id=$1`, [trendRunId])).rows;
  const before = await trendBudget();
  assert.equal(before.usedUsd, '3.40104100'); assert.equal(before.limitUsd, '0.00000000');
  const independentAdmission = await admitTrendRun('daily');
  assert.ok('run' in independentAdmission && independentAdmission.created);
  assert.equal('run' in independentAdmission && independentAdmission.run.reservedUsd, '0.00000000');
  let billingGets = 0;
  const report = await reconcileTrendPhotoCosts(admin, requests => readPhotoBills(requests, { credential: 'offline-billing-only', fetch: async (input, init) => {
    billingGets++;
    const url = new URL(String(input));
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(url.origin + url.pathname, 'https://api.fal.ai/v1/models/billing-events');
    assert.deepEqual(url.searchParams.getAll('request_id').sort(), [applied.providerRequestId!, failed.providerRequestId!].sort());
    assert.ok(url.searchParams.has('start'), 'Historical receipts must not use the provider default 24-hour window.');
    return Response.json({ billing_events: [{ request_id: applied.providerRequestId, cost_total: 0.6 }, { request_id: failed.providerRequestId, cost_total: 0.1 }], has_more: false, next_cursor: null });
  } }));
  assert.equal(billingGets, 1); assert.equal(report.reconciledJobs, 2);
  assert.deepEqual(report.before, { usedUsd: '3.40104100', reservedUsd: '0.00000000' });
  assert.deepEqual(report.after, { usedUsd: '4.10104100', reservedUsd: '0.00000000' });
  assert.deepEqual((await history()).find(row => row.id === studio.id), initialStudio);
  assert.deepEqual((await isolatedPool.query(`SELECT * FROM trend_run WHERE id=$1`, [trendRunId])).rows, runBefore);
  const afterSettings = await getAiBudgetSettings(owner);
  assert.deepEqual(afterSettings.settings, { ...settings.settings, serverNow: afterSettings.settings.serverNow });
  assert.deepEqual(afterSettings.audit, settings.audit);
  assert.equal((await trendBudget()).limitUsd, '0.00000000');
  const jobsBeforeAdmission = await history();
  const admitted = await admitTrendRun('daily');
  assert.ok('run' in admitted && !admitted.created);
  assert.equal('run' in admitted && admitted.run.reservedUsd, '0.00000000');
  assert.equal('run' in admitted && admitted.run.id, 'run' in independentAdmission && independentAdmission.run.id);
  assert.deepEqual(await history(), jobsBeforeAdmission, 'Admission and reconciliation never submit a photo or create a generation job.');
  assert.equal((await isolatedPool.query(`SELECT count(*)::int n FROM ai_cost_ledger WHERE entry='reconcile'`)).rows[0].n, 2);
});

test('trend pending/forbidden bills preserve estimates and never touch Studio or unused packets', async () => {
  const trendRunId = await seedTrend();
  const trend = await seed({ trendRunId }); const studio = await seed();
  await isolatedPool.query(`UPDATE trend_run SET packet_remaining_usd=7 WHERE id=$1`, [trendRunId]);
  const initial = await history();
  for (const read of [
    { status: 'pending', httpStatus: 200, costs: {} },
    { status: 'forbidden', httpStatus: 403, costs: { [trend.providerRequestId!]: '0' } },
    { status: 'verified', httpStatus: 200, costs: { [studio.providerRequestId!]: '0' } },
  ] satisfies PhotoBillingRead[]) {
    const report = await reconcileTrendPhotoCosts(owner, async () => read);
    assert.equal(report.scannedJobs, 1); assert.equal(report.reconciledJobs, 0); assert.equal(report.pendingJobs, 1);
    assert.deepEqual(report.before, { usedUsd: '1.37078100', reservedUsd: '0.00000000' });
    assert.deepEqual(report.after, report.before); assert.deepEqual(await history(), initial);
  }
  assert.equal((await isolatedPool.query(`SELECT packet_remaining_usd FROM trend_run WHERE id=$1`, [trendRunId])).rows[0].packet_remaining_usd, '7.00000000');
  assert.equal((await isolatedPool.query(`SELECT count(*)::int n FROM ai_cost_ledger WHERE entry='reconcile'`)).rows[0].n, 0);
});

test('automated trend reconciliation requires an enabled gate and active authorized owner before any billing GET', async () => {
  const trendRunId = await seedTrend(); await seed({ trendRunId });
  let reads = 0;
  const reader = async (): Promise<PhotoBillingRead> => { reads++; return { status: 'pending', httpStatus: 200, costs: {} }; };
  const gateDenied = (error: unknown) => error instanceof AiError && error.status === 403 && error.code === 'TREND_AUTOMATION_DISABLED';
  await assert.rejects(reconcileAutomatedTrendPhotoCosts(reader), gateDenied);
  await enableAutomation(); await isolatedPool.query(`UPDATE auth_user SET disabled=true WHERE id=$1`, [owner.id]);
  await assert.rejects(reconcileAutomatedTrendPhotoCosts(reader), gateDenied);
  assert.equal(reads, 0);
  assert.equal((await isolatedPool.query(`SELECT count(*)::int n FROM ai_cost_ledger WHERE entry='reconcile'`)).rows[0].n, 0);
});

test('automation rechecks its gate after billing GET and preserves every estimate if authorization changes', async () => {
  const trendRunId = await seedTrend(); const job = await seed({ trendRunId }); await enableAutomation();
  const initial = await history(); let reads = 0;
  await assert.rejects(reconcileAutomatedTrendPhotoCosts(async () => {
    reads++;
    // Provider reads must hold neither the budget lock nor an authorization snapshot.
    await isolatedPool.query(`UPDATE trend_setting SET enabled=false WHERE id='global'`);
    return { status: 'verified', httpStatus: 200, costs: { [job.providerRequestId!]: '0.05' } };
  }), (error: unknown) => error instanceof AiError && error.code === 'TREND_AUTOMATION_DISABLED');
  assert.equal(reads, 1); assert.deepEqual(await history(), initial);
  assert.equal((await isolatedPool.query(`SELECT count(*)::int n FROM ai_cost_ledger WHERE entry='reconcile'`)).rows[0].n, 0);
});

test('enabled automation reconciles existing trend receipts without an impersonated actor or a new run', async () => {
  const trendRunId = await seedTrend(); const job = await seed({ trendRunId }); await enableAutomation();
  const runs = (await isolatedPool.query(`SELECT * FROM trend_run ORDER BY id`)).rows;
  const report = await reconcileAutomatedTrendPhotoCosts(async requests => {
    assert.deepEqual(requests.map(request => request.requestId), [job.providerRequestId]);
    return { status: 'verified', httpStatus: 200, costs: { [job.providerRequestId!]: '0.25' } };
  });
  assert.equal(report.reconciledJobs, 1); assert.equal(report.after.usedUsd, '1.62078100');
  assert.deepEqual((await isolatedPool.query(`SELECT * FROM trend_run ORDER BY id`)).rows, runs);
  assert.equal((await history()).length, 1);
});

test('automation reads at most 50 receipts in one billing group and reports pending backlog without writing costs', async () => {
  const trendRunId = await seedTrend(); await enableAutomation();
  await getDb().insert(aiJobs).values(Array.from({ length: 51 }, () => receipt({ trendRunId })));
  const initial = await history(); let billingGets = 0;
  const report = await reconcileAutomatedTrendPhotoCosts(requests => {
    assert.equal(requests.length, 50);
    return readPhotoBills(requests, { credential: 'offline-billing-only', fetch: async (input, init) => {
      billingGets++;
      assert.equal(init?.method ?? 'GET', 'GET');
      assert.equal(new URL(String(input)).searchParams.getAll('request_id').length, 50);
      return Response.json({ billing_events: [], has_more: false, next_cursor: null });
    } });
  });
  assert.equal(billingGets, 1); assert.equal(report.scannedJobs, 50); assert.equal(report.pendingJobs, 50);
  assert.equal(report.limited, true); assert.equal(report.remainingJobs, 51); assert.equal(report.reconciledJobs, 0);
  assert.equal(report.read.status, 'pending'); assert.deepEqual(report.after, report.before); assert.deepEqual(await history(), initial);
  assert.equal((await isolatedPool.query(`SELECT count(*)::int n FROM ai_cost_ledger WHERE entry='reconcile'`)).rows[0].n, 0);
});
