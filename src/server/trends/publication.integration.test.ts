import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { parse } from 'dotenv';
import type { EditorialActor, EditorialContent } from '@/lib/editorial-types';
import type { TrendCandidate, TrendPlatform } from '@/lib/trend-types';
import { recipes } from '@/lib/recipes';
import { getIngredientImage, getStepImage } from '@/lib/recipe-media';
import { nextCalendarDate, publicationTime } from '@/lib/daily-publication';
import { closeDb, getDb } from '@/server/db';
import { contentHash, emptyChecks, EditorialError, publishAutomatedTrendInTransaction, getPublishedRecipeById, performRecipeAction } from '@/server/editorial/store';
import { trendWorker } from './actor';
import { admitTrendRun } from './store';
import { attachPublicationWorkflow, ensurePublicationDay, getTrendAutomation, publicationState, publishDueRecipeInTransaction, resetPublicationWorkflow, getReviewedSchedule, updateReviewedSchedule, publicationAutomationGate } from './publication';
import { getPublicationPlan, removePublicationPlan, savePublicationPlan } from './publication-plan';

// Every write below is confined to a disposable schema. HTTP/provider calls fail closed.
const schema = `publication_test_${randomUUID().replaceAll('-', '')}`;
const actor: EditorialActor = { id: 'test-owner', name: 'Forged client name', email: 'owner@example.invalid', role: 'owner' };
const platforms: TrendPlatform[] = ['instagram', 'tiktok', 'pinterest', 'youtube', 'web'];
const sources = Object.fromEntries(platforms.map(platform => [platform, { status: 'no_evidence', count: 0 }]));
const date = '2026-07-15';
const due = publicationTime(date);
let adminPool: Pool;
let isolatedPool: Pool;
let fingerprint: string;
let sequence = 0;
let originalFetch: typeof fetch;


async function developmentConnection() {
    const local = parse(await readFile('.env.local', 'utf8'));
    const production = parse(await readFile('.env.production.local', 'utf8'));
    const override = process.env.TREND_TEST_DATABASE_URL;
    const connection = override || local.TREND_TEST_DATABASE_URL || local.DATABASE_URL_UNPOOLED || local.POSTGRES_URL_NON_POOLING;
    if (!connection || local.NODE_ENV === 'production' || local.VERCEL_ENV === 'production') throw new Error('Tests require an explicit development database.');
    const endpoint = (value: string) => new URL(value).hostname.toLowerCase().replace(/-pooler(?=\.)/, '');
    if (override && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(override).hostname)) throw new Error('Test database overrides must be local loopback endpoints.');
    const productionConnections = Object.entries(production).filter(([key, value]) => /^(?:DATABASE_URL|POSTGRES_URL)/.test(key) && /^postgres(?:ql)?:/.test(value)).map(([, value]) => value);
    if (!productionConnections.length || productionConnections.some(value => endpoint(value) === endpoint(connection))) throw new Error('Tests refuse the production database branch.');
    if (new URL(connection).hostname.includes('-pooler.')) throw new Error('Tests require a direct development endpoint.');
    return connection;
}

before(async () => {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') throw new Error('Tests require development.');
  const connection = await developmentConnection();
  if (!connection) throw new Error('An isolated development Postgres connection is required.');
  adminPool = new Pool({ connectionString: connection, max: 1, connectionTimeoutMillis: 20_000, query_timeout: 30_000 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connection); url.searchParams.set('options', `-c search_path=${schema}`);
  await closeDb();
    process.env.DATABASE_URL = url.toString();
  isolatedPool = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 20_000, query_timeout: 30_000 });
  assert.equal((await isolatedPool.query('SELECT current_schema() AS name')).rows[0].name, schema);
  await isolatedPool.query(`CREATE TABLE auth_user(id text PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,image text,role text NOT NULL DEFAULT 'admin',disabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
  await isolatedPool.query(`INSERT INTO auth_user(id,name,email,role) VALUES('test-owner','Stored owner','owner@example.invalid','owner'),('test-admin','Stored admin','admin@example.invalid','admin')`);
  for (const migration of ['0001-editorial','0002-ai','0003-trends','0004-trend-research','0005-trend-manual-runs','0006-ingredient-reuse','0007-local-photo-corrections','0008-ai-photo-batches','0009-ai-budget-settings','0010-daily-publication','0011-seo-discovery','0014-seo-workflows', '0015-recipe-trash','0017-publication-plan','0018-content-approval','0019-simplified-daily-automation','0020-manual-automation-takeover','0021-recipe-result-recovery','0026-remove-spending-limits','0027-manual-review-workflow','0028-ingredient-dictionary','0029-ingredient-evidence-recheck'])
    await isolatedPool.query(await readFile(`migrations/${migration}.sql`, 'utf8'));
  Object.assign(process.env, { OPENAI_API_KEY: 'test-unused', FAL_KEY: 'test-unused', FAL_API_KEY: '', BLOB_READ_WRITE_TOKEN: 'test-unused', CRON_SECRET: 'test-unused', AI_DAILY_LIMIT_USD: '100', AI_MONTHLY_LIMIT_USD: '100', AI_PILOT_LIMIT_USD: '100', AI_RECIPE_MODEL: 'gpt-6-astra', AI_IMAGE_MODEL: 'openai/gpt-image-2.5/sunburst/text-to-image', AI_TREND_MODEL: 'gpt-6.1-sol' });
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('This test must not call any HTTP/provider API.'); };
  const control = await admitTrendRun('control', actor);
  assert.ok('run' in control);
  fingerprint = (await isolatedPool.query('SELECT configuration_fingerprint FROM trend_run WHERE id=$1', [control.run.id])).rows[0].configuration_fingerprint;
});
after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  await closeDb();
  if (isolatedPool) await isolatedPool.end();
  if (adminPool) { await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await adminPool.end(); }
});
beforeEach(async () => {
  await isolatedPool.query('TRUNCATE editorial_publication_plan_audit,editorial_publication_plan,trend_publication_day,trend_setting_audit,trend_candidate,trend_run,editorial_recipe CASCADE');
  await isolatedPool.query(`UPDATE auth_user SET role=CASE WHEN id='test-owner' THEN 'owner' ELSE 'admin' END,disabled=false`);
  await isolatedPool.query(`UPDATE trend_setting SET enabled=true,reviewed_publication_enabled=true,reviewed_publication_authorized_by='test-owner',monthly_limit_usd=150,last_control_at=now(),control_fingerprint=$1,publication_authorized_by='test-owner',auto_pause_reason=NULL,auto_pause_token=NULL`, [fingerprint]);
});

function fullContent(id: string): EditorialContent {
  const recipe = structuredClone(recipes[0]); const originalId = recipe.id;
  recipe.id = id; recipe.slug = { pl: `publication-${id}`, en: `publication-${id}` };
  return { recipe, originalText: 'Private source stays private.', author: trendWorker.name, sources: [], photos: {
    ingredients: Object.fromEntries(recipe.ingredients.map(item => [item.id, getIngredientImage(originalId, item.id)])),
    steps: Object.fromEntries(recipe.steps.map(item => [item.id, getStepImage(originalId, item.id)])),
  } };
}
async function seed(options: { approved?: boolean; manual?: boolean; mode?: 'daily' | 'control'; candidate?: Partial<TrendCandidate>; content?: (content: EditorialContent) => void } = {}) {
  const recipeId = randomUUID(), runId = randomUUID(), candidateId = randomUUID();
  const content = fullContent(recipeId); options.content?.(content);
  const hash = contentHash(content);
  const approved = options.approved ?? true;
  const checks = approved ? { pl:true,en:true,quantities:true,method:true,photos:true,sources:true } : emptyChecks();
  await isolatedPool.query(`INSERT INTO editorial_recipe(id,content,content_hash,checks,created_by,updated_by,updated_by_name) VALUES($1,$2,$3,$4,$5,$5,$6)`, [recipeId, content, hash, checks, trendWorker.id, trendWorker.name]);
  await isolatedPool.query(`INSERT INTO editorial_version(recipe_id,revision,content,content_hash,reason,created_by,created_by_name) VALUES($1,1,$2,$3,'Synthetic worker draft',$4,$5)`, [recipeId, content, hash, trendWorker.id, trendWorker.name]);
  if (approved) {
    await isolatedPool.query("UPDATE editorial_recipe SET editorial_status='approved',approved_revision=revision WHERE id=$1",[recipeId]);
    await isolatedPool.query("INSERT INTO editorial_audit(id,recipe_id,revision,action,actor_id,actor_name) VALUES($1,$2,1,'approve',$3,'Stored owner')",[randomUUID(),recipeId,actor.id]);
  }
  const runDate = nextCalendarDate(`2028-01-${String(1 + sequence++ % 27).padStart(2, '0')}`);
  await isolatedPool.query(`INSERT INTO trend_run(id,date,mode,manual_request_key,status,recipe_id,expected_revision,candidate_id,search_finished_at,search_charged_usd,search_reserved_usd,configuration_fingerprint,sources) VALUES($1,$2,$3,$4,'awaiting_review',$5,1,$6,now(),0.1,2,$7,$8)`, [runId, runDate, options.mode ?? 'daily', options.manual ? randomUUID() : null, recipeId, candidateId, fingerprint, sources]);
  const candidate: TrendCandidate = { id: candidateId, runId, dishKey: candidateId, title: content.recipe.title, aliases: [], rationale: 'Current seasonal inspiration.', sources: [], eligible: false, rejectionReason: null, duplicateRecipeId: null, ambiguous: false, score: { independentSources: 0, newestAt: '', platforms: 0 }, selected: true, automaticSelection: { basis: 'seasonal', reason: 'Selected seasonal dish.' }, ...options.candidate };
  await isolatedPool.query(`INSERT INTO trend_candidate(id,run_id,dish_key,data,selected) VALUES($1,$2,$3,$4,true)`, [candidateId, runId, candidateId, candidate]);
  return { recipeId, runId, candidateId, content, hash };
}
async function day(dayDate = date) { await isolatedPool.query('INSERT INTO trend_publication_day(date,due_at) VALUES($1,$2) ON CONFLICT DO NOTHING', [dayDate, publicationTime(dayDate)]); }
async function publish(now = new Date(due.getTime() + 1), dayDate = date, generation?: number) {
  return getDb().transaction(tx => publishDueRecipeInTransaction(tx, dayDate, now, generation));
}
async function counts() {
  return (await isolatedPool.query(`SELECT (SELECT count(*)::int FROM editorial_publication) publications,(SELECT count(*)::int FROM editorial_outbox) outbox,(SELECT count(*)::int FROM editorial_audit WHERE action='scheduled_publish') audit,(SELECT count(*)::int FROM ai_cost_ledger) ledger`)).rows[0];
}
test('legacy publication settings cannot enable a scheduler even with a ready reviewed recipe and active owner', async () => {
  await seed(); await day();
  const gate = await publicationAutomationGate();
  assert.equal(gate.enabled, false); assert.equal(gate.canEnable, false);
  assert.equal((await publicationState(date)).canPublish, false);
  const schedule = await getReviewedSchedule();
  assert.equal(schedule.enabled, false); assert.equal(schedule.nextPublicationAt, null);
  assert.deepEqual(schedule.readyRecipes, []);
  const dashboard = await getTrendAutomation();
  assert.equal(dashboard.enabled, false); assert.equal(dashboard.canEnable, false);
});

test('early, due, late and replayed deliveries cannot publish or mutate costs, audit, outbox or recipe', async () => {
  const f = await seed(); await day(); const original = await counts();
  for (const offset of [-60_000, 0, 1, 3_599_999, 3_600_000, 86_400_000]) {
    const result = await publish(new Date(due.getTime() + offset));
    assert.equal(result.status, 'disabled'); assert.equal(result.state.canPublish, false);
  }
  assert.deepEqual(await counts(), original);
  const row = (await isolatedPool.query('SELECT revision,publication_status FROM editorial_recipe WHERE id=$1', [f.recipeId])).rows[0];
  assert.equal(row.revision, 1); assert.equal(row.publication_status, 'never_published');
});

test('concurrent legacy publishers both stay disabled with no publication', async () => {
  await seed(); await day(); const original = await counts();
  const results = await Promise.all([publish(), publish()]);
  assert.ok(results.every(result => result.status === 'disabled'));
  assert.deepEqual(await counts(), original);
});

test('generation checks and historical expired results remain readable without granting release', async () => {
  await day();
  await assert.rejects(publish(undefined, date, 999), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'PUBLICATION_SUPERSEDED');
  await isolatedPool.query("UPDATE trend_publication_day SET status='expired' WHERE date=$1", [date]);
  assert.equal((await publish()).status, 'expired'); assert.equal((await publicationState(date)).canPublish, false);
});

test('legacy reviewed schedule writes check fresh owner authorization before returning 410 and preserve settings', async () => {
  const original = (await isolatedPool.query('SELECT * FROM trend_setting')).rows;
  for (const enabled of [true, false]) await assert.rejects(updateReviewedSchedule(enabled, actor), (error: unknown) => error instanceof EditorialError && error.status === 410);
  await assert.rejects(updateReviewedSchedule(true, { ...actor, id: 'test-admin' }), (error: unknown) => error instanceof EditorialError && error.status === 403);
  await isolatedPool.query("UPDATE auth_user SET disabled=true WHERE id='test-owner'");
  await assert.rejects(updateReviewedSchedule(true, actor), (error: unknown) => error instanceof EditorialError && error.status === 403);
  assert.deepEqual((await isolatedPool.query('SELECT * FROM trend_setting')).rows, original);
});

async function historicalPlan() {
  const f = await seed(); const future = '2030-01-01'; await day(future);
  await isolatedPool.query('INSERT INTO editorial_publication_plan(date,recipe_id,expected_content_hash,planned_by) VALUES($1,$2,$3,$4)', [future, f.recipeId, f.hash, actor.id]);
  await isolatedPool.query(`INSERT INTO editorial_publication_plan_audit(id,date,action,actor_id,actor_name,after_state) VALUES($1,$2,'save',$3,'Stored owner',$4)`, [randomUUID(), future, actor.id, { recipeId: f.recipeId, expectedContentHash: f.hash, plannedBy: actor.id }]);
  return { ...f, future };
}
async function historicalPlanRows() {
  return {
    plan: (await isolatedPool.query('SELECT * FROM editorial_publication_plan ORDER BY date')).rows,
    audit: (await isolatedPool.query('SELECT * FROM editorial_publication_plan_audit ORDER BY id')).rows,
    days: (await isolatedPool.query('SELECT * FROM trend_publication_day ORDER BY date')).rows,
  };
}
for (const operation of ['save', 'remove'] as const) test(`retired publication plan ${operation} preserves historical rows and checks fresh owner authorization`, async () => {
  const f = await historicalPlan(); const original = await historicalPlanRows();
  assert.equal((await getPublicationPlan()).length, 1);
  const mutate = (current: EditorialActor) => operation === 'save'
    ? savePublicationPlan([{ date: '2030-01-02', recipeId: f.recipeId, expectedRevision: 1 }], current)
    : removePublicationPlan(f.future, current);
  await assert.rejects(mutate(actor), (error: unknown) => error instanceof EditorialError && error.status === 410 && error.code === 'MANUAL_PUBLICATION_REQUIRED');
  await assert.rejects(mutate({ ...actor, id: 'test-admin' }), (error: unknown) => error instanceof EditorialError && error.status === 403);
  await isolatedPool.query("UPDATE auth_user SET disabled=true WHERE id='test-owner'");
  await assert.rejects(mutate(actor), (error: unknown) => error instanceof EditorialError && error.status === 403);
  await isolatedPool.query("UPDATE auth_user SET disabled=false,role='admin' WHERE id='test-owner'");
  await assert.rejects(mutate(actor), (error: unknown) => error instanceof EditorialError && error.status === 403);
  assert.deepEqual(await historicalPlanRows(), original);
});

test('an old direct scheduled release kernel cannot bypass the manual publication gate', async () => {
  const f = await seed(); await day(); const original = await counts();
  await assert.rejects(getDb().transaction(tx => publishAutomatedTrendInTransaction(tx, f.runId, f.recipeId, 1, f.hash, actor.id, date, due)), (error: unknown) => error instanceof EditorialError);
  assert.deepEqual(await counts(), original);
});

test('a human still publishes the exact reviewed version through the editor', async () => {
  const f = await seed(); const original = await counts();
  const published = await performRecipeAction(f.recipeId, { action: 'publish', expectedRevision: 1 }, actor);
  assert.equal(published.publicationStatus, 'published');
  const rows = (await isolatedPool.query('SELECT approval_origin,published_by FROM editorial_publication WHERE recipe_id=$1', [f.recipeId])).rows;
  assert.deepEqual(rows, [{ approval_origin: 'manual', published_by: actor.id }]);
  const visible = await getPublishedRecipeById(f.recipeId);
  assert.ok(visible); assert.equal((await counts()).publications, original.publications + 1);
});

test('an unreviewed draft cannot bypass editor publication checks', async () => {
  const f = await seed({ approved: false }); const original = await counts();
  await assert.rejects(performRecipeAction(f.recipeId, { action: 'publish', expectedRevision: 1 }, actor), (error: unknown) => error instanceof EditorialError && error.code === 'PUBLICATION_BLOCKED');
  assert.deepEqual(await counts(), original);
});

test('legacy timer lease bookkeeping stays idempotent without starting or publishing a workflow', async () => {
  const future = '2030-01-01'; const rows = await Promise.all([ensurePublicationDay(future), ensurePublicationDay(future)]);
  assert.equal(rows[0].generation, rows[1].generation);
  const attached = await Promise.all([attachPublicationWorkflow(future, 'old-timer-one', rows[0].generation), attachPublicationWorkflow(future, 'old-timer-two', rows[0].generation)]);
  assert.equal(attached.filter(Boolean).length, 1);
  const owner = (await isolatedPool.query('SELECT workflow_id FROM trend_publication_day WHERE date=$1', [future])).rows[0].workflow_id;
  assert.equal(await resetPublicationWorkflow(future, 'different-timer', rows[0].generation), null);
  const reset = await resetPublicationWorkflow(future, owner, rows[0].generation);
  assert.ok(reset); assert.equal(reset.generation, rows[0].generation + 1);
  assert.equal((await publicationState(future)).canPublish, false);
});
