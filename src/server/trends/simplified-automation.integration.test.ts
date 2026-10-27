import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { config, parse } from 'dotenv';
import { recipes } from '@/lib/recipes';
import type { EditorialContent } from '@/lib/editorial-types';
import type { TrendCandidate } from '@/lib/trend-types';
import { getIngredientImage, getStepImage } from '@/lib/recipe-media';
import { publicationTime, warsawPublicationDate } from '@/lib/daily-publication';
import { closeDb, getDb } from '@/server/db';
import { approveRecipeContent, contentApprovalHash } from '@/server/editorial/content-approval';
import { contentHash, emptyChecks, getRecipe, saveRecipe } from '@/server/editorial/store';
import { approveRadarContent } from './preparation-steps';
import { admitTrendRun, actOnTrendRun, getTrendExecution } from './store';
import { preparePhotoSlot } from './preparation';
import { claimSubmission, createJobAdmission, ensureSubmissionAllowed } from '@/server/ai/store';
import { trendWorker } from './actor';
import { publishVerifiedDailyRecipeInTransaction } from './automated-publication';
import { rankCandidates } from './ranking';

// All writes use one disposable schema. Paid/network transport fails closed.
const schema = `simplified_automation_${randomUUID().replaceAll('-', '')}`;
let adminPool: Pool;
let pool: Pool;
let originalFetch: typeof fetch;
const date = warsawPublicationDate(new Date());
const researchDate = new Date(new Date(`${date}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
const due = publicationTime(date);

before(async () => {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') throw new Error('Tests require development.');
  config({ path: '.env.local', quiet: true });
  const connection = process.env.TREND_TEST_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING;
  if (!connection) throw new Error('An isolated development Postgres connection is required.');
  const endpoint = (value: string) => new URL(value).hostname.toLowerCase().replace(/-pooler(?=\.)/, '');
  if (process.env.TREND_TEST_DATABASE_URL && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname)) throw new Error('Test database overrides must be local loopback endpoints.');
  const production = parse(await readFile('.env.production.local', 'utf8'));
  const productionConnections = Object.entries(production).filter(([key, value]) => /^(?:DATABASE_URL|POSTGRES_URL)/.test(key) && /^postgres(?:ql)?:/.test(value)).map(([, value]) => value);
  if (!productionConnections.length || productionConnections.some(value => endpoint(value) === endpoint(connection)) || new URL(connection).hostname.includes('-pooler.')) throw new Error('Tests refuse production and require a direct development endpoint.');
  adminPool = new Pool({ connectionString: connection, max: 1, connectionTimeoutMillis: 20_000, query_timeout: 30_000 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connection); url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  pool = new Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 20_000, query_timeout: 30_000 });
  await pool.query('CREATE TABLE auth_user(id text PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,image text,role text NOT NULL DEFAULT \'admin\',disabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())');
  await pool.query("INSERT INTO auth_user(id,name,email,role) VALUES('owner','Owner','owner@example.invalid','owner'),('admin','Reviewer','admin@example.invalid','admin')");
  for (const migration of ['0001-editorial', '0002-ai', '0003-trends', '0004-trend-research', '0005-trend-manual-runs', '0006-ingredient-reuse', '0007-local-photo-corrections', '0008-ai-photo-batches', '0009-ai-budget-settings', '0010-daily-publication', '0011-seo-discovery', '0013-reviewed-publication-guard', '0014-seo-workflows', '0015-recipe-trash', '0017-publication-plan', '0018-content-approval'])
    await pool.query(await readFile(`migrations/${migration}.sql`, 'utf8'));
  await pool.query(await readFile('migrations/0019-simplified-daily-automation.sql', 'utf8'));
  await pool.query(await readFile('migrations/0020-manual-automation-takeover.sql', 'utf8'));
  await pool.query(await readFile('migrations/0021-recipe-result-recovery.sql', 'utf8'));
  await pool.query(await readFile('migrations/0026-remove-spending-limits.sql', 'utf8'));
  await pool.query(await readFile('migrations/0027-manual-review-workflow.sql', 'utf8'));
  await pool.query(await readFile('migrations/0028-ingredient-dictionary.sql', 'utf8'));
  await pool.query(await readFile('migrations/0029-ingredient-evidence-recheck.sql', 'utf8'));
  Object.assign(process.env, { OPENAI_API_KEY: 'test-unused', FAL_KEY: 'test-unused', BLOB_READ_WRITE_TOKEN: 'test-unused', CRON_SECRET: 'test-unused', AI_RECIPE_MODEL: 'gpt-6-astra', AI_IMAGE_MODEL: 'openai/gpt-image-2.5/sunburst/text-to-image', AI_TREND_MODEL: 'gpt-6.1-sol' });
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('No HTTP or paid provider calls are permitted in these tests.'); };
});
after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  await closeDb();
  if (pool) await pool.end();
  if (adminPool) { await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await adminPool.end(); }
});
beforeEach(async () => {
  await pool.query('TRUNCATE editorial_publication_plan_audit,editorial_publication_plan,trend_publication_day,trend_setting_audit,trend_candidate,trend_run,editorial_recipe CASCADE');
  await pool.query("UPDATE auth_user SET disabled=false,role=CASE WHEN id='owner' THEN 'owner' ELSE 'admin' END");
  await pool.query("UPDATE trend_setting SET enabled=true,publication_authorized_by='owner',reviewed_publication_enabled=false,auto_pause_reason=NULL,auto_pause_token=NULL");
  await pool.query('INSERT INTO trend_publication_day(date,due_at) VALUES($1,$2)', [date, due]);
});

async function seed(options: { fallback?: boolean; manual?: boolean; missingPhoto?: boolean } = {}) {
  const recipeId = randomUUID(), runId = randomUUID(), candidateId = randomUUID();
  const recipe = structuredClone(recipes[0]); const originalId = recipe.id;
  recipe.id = recipeId; recipe.slug = { pl: `auto-${recipeId}`, en: `auto-${recipeId}` };
  const content: EditorialContent = { recipe, originalText: 'Synthetic private source', author: trendWorker.name, sources: [], photos: {
    ingredients: Object.fromEntries(recipe.ingredients.map(item => [item.id, getIngredientImage(originalId, item.id)])),
    steps: Object.fromEntries(recipe.steps.map(item => [item.id, getStepImage(originalId, item.id)])),
  } };
  if (options.missingPhoto) delete content.photos.ingredients[recipe.ingredients[0].id];
  await pool.query('INSERT INTO editorial_recipe(id,content,content_hash,checks,created_by,updated_by,updated_by_name) VALUES($1,$2,$3,$4,$5,$5,$6)', [recipeId, content, contentHash(content), emptyChecks(), trendWorker.id, trendWorker.name]);
  await pool.query("INSERT INTO editorial_version(recipe_id,revision,content,content_hash,reason,created_by,created_by_name) VALUES($1,1,$2,$3,'Synthetic',$4,$5)", [recipeId, content, contentHash(content), trendWorker.id, trendWorker.name]);
  await pool.query("INSERT INTO trend_run(id,date,mode,manual_request_key,status,recipe_id,expected_revision,candidate_id,search_request_id,search_finished_at,search_charged_usd,sources) VALUES($1,$2,$3,$4,'generating',$5,1,$6,'synthetic-receipt',now(),0.1,'{}')", [runId, researchDate, options.manual ? 'control' : 'daily', options.manual ? randomUUID() : null, recipeId, candidateId]);
  const sources: TrendCandidate['sources'] = [
    { url: 'https://instagram.com/chef_one/reel/one/', title: 'A', publisher: 'One', platform: 'instagram', publishedAt: researchDate, excerpt: 'This pumpkin pasta is going viral this week.', interestEvidence: '', independentKey: '' },
    { url: 'https://tiktok.com/@chef_two/video/two', title: 'B', publisher: 'Two', platform: 'tiktok', publishedAt: researchDate, excerpt: 'Everyone is cooking this creamy pumpkin pasta trend.', interestEvidence: '', independentKey: '' },
    { url: 'https://food.example.org/pumpkin', title: 'C', publisher: 'Three', platform: 'web', publishedAt: researchDate, excerpt: 'The latest popular pasta uses roasted pumpkin and cheese.', interestEvidence: '', independentKey: '' },
  ];
  const [ranked] = rankCandidates([{ dishKey: 'pumpkin-pasta', title: recipe.title, aliases: [], rationale: 'Synthetic verified trend', sources }], sources.map(source => source.url), [], runId, due);
  const candidate: TrendCandidate = { ...ranked, id: candidateId, selected: true, ...(options.fallback ? { eligible: false, automaticSelection: { basis: 'seasonal' as const, reason: 'Fallback' } } : {}) };
  await pool.query('INSERT INTO trend_candidate(id,run_id,dish_key,data,selected) VALUES($1,$2,$3,$4,true)', [candidateId, runId, 'pumpkin-pasta', candidate]);
  return { recipeId, runId, candidateId, content };
}
function publish(now = new Date(due.getTime() + 1), generation = 1, freshClock = async () => now) {
  return getDb().transaction(tx => publishVerifiedDailyRecipeInTransaction(tx, date, now, generation, freshClock));
}

const owner = { id: 'owner', name: 'Owner', email: 'owner@example.invalid', role: 'owner' as const };
const reviewer = { id: 'admin', name: 'Reviewer', email: 'admin@example.invalid', role: 'admin' as const };
const counts = async () => (await pool.query("SELECT (SELECT count(*)::int FROM ai_job WHERE kind<>'recipe') photos,(SELECT count(*)::int FROM editorial_content_approval) approvals,(SELECT count(*)::int FROM editorial_publication) publications")).rows[0];

for (const entry of [{ name: 'qualified daily trend', options: {} }, { name: 'unverified daily inspiration', options: { fallback: true } }, { name: 'new manual research run', options: { manual: true } }]) test(`${entry.name} always stops after cooking text for human review`, async () => {
  const fixture = await seed(entry.options);
  assert.equal(await approveRadarContent(fixture.runId, 1), false);
  const run = await getTrendExecution(fixture.runId);
  assert.equal(run.status, 'awaiting_review'); assert.match(run.error!, /ręczn/);
  assert.deepEqual(await counts(), { photos: 0, approvals: 0, publications: 0 });
});

test('manual content approval alone cannot authorize photos, even for an old ordinary worker', async () => {
  const fixture = await seed({ missingPhoto: true }); await approveRecipeContent(fixture.recipeId, 1, owner);
  assert.equal(await approveRadarContent(fixture.runId, 1), false);
  await pool.query("UPDATE trend_run SET status='generating' WHERE id=$1", [fixture.runId]);
  await assert.rejects(createJobAdmission({ recipeId: fixture.recipeId, expectedRevision: 1, kind: 'step', targetId: fixture.content.recipe.steps[0].id, brief: 'Old automatic photo', requestKey: randomUUID() }, trendWorker, fixture.runId, { generation: 1 }), { code: 'MANUAL_PHOTO_DECISION_REQUIRED' });
  assert.equal((await counts()).photos, 0);
});

test('explicit owner photo request accepts an admin content review and captures its hash', async () => {
  const fixture = await seed({ missingPhoto: true }); await approveRadarContent(fixture.runId, 1);
  const request = { action: 'repair' as const, expectedRevision: 1, requestKey: randomUUID() };
  await assert.rejects(actOnTrendRun(fixture.runId, request, owner), { code: 'CONTENT_APPROVAL_REQUIRED' });
  await approveRecipeContent(fixture.recipeId, 1, reviewer);
  const admitted = await actOnTrendRun(fixture.runId, request, owner);
  assert.equal(admitted.resume, true); assert.equal(admitted.run.preparation!.approvedContentHash, contentApprovalHash(fixture.content));
  assert.equal(admitted.run.preparation!.requestedBy, owner.id);
  const replay = await actOnTrendRun(fixture.runId, request, owner); assert.equal(replay.resume, false); assert.equal(replay.generation, admitted.generation);
  assert.equal(await approveRadarContent(fixture.runId, admitted.generation!), true);
  const operation = await preparePhotoSlot(fixture.runId, admitted.generation!, { kind: 'ingredient', targetId: fixture.content.recipe.ingredients[0].id });
  assert.equal(operation.state, 'job'); assert.ok(operation.jobId);
  assert.equal((await claimSubmission(operation.jobId!)).shouldSubmit, true);
  await ensureSubmissionAllowed(operation.jobId!);
  assert.equal((await counts()).photos, 1); assert.equal((await counts()).publications, 0);
});

test('a content edit after explicit decision blocks both queued claim and the final provider preflight', async () => {
  const fixture = await seed({ missingPhoto: true }); await approveRadarContent(fixture.runId, 1); await approveRecipeContent(fixture.recipeId, 1, owner);
  const request = await actOnTrendRun(fixture.runId, { action: 'repair', expectedRevision: 1, requestKey: randomUUID() }, owner);
  const first = await preparePhotoSlot(fixture.runId, request.generation!, { kind: 'ingredient', targetId: fixture.content.recipe.ingredients[0].id });
  const second = await createJobAdmission({ recipeId: fixture.recipeId, expectedRevision: 1, kind: 'step', targetId: fixture.content.recipe.steps[0].id, brief: 'Explicit step photo', requestKey: randomUUID() }, trendWorker, fixture.runId, { generation: request.generation });
  await claimSubmission(first.jobId!);
  const recipe = await getRecipe(fixture.recipeId); const changed = structuredClone(recipe.content); changed.recipe.steps[0].text.pl += ' Sprawdź ręcznie gotowość.';
  await saveRecipe(recipe.id, { expectedRevision: recipe.revision, content: changed }, owner);
  await assert.rejects(claimSubmission(second.job.id), { code: 'MANUAL_PHOTO_DECISION_REQUIRED' });
  await assert.rejects(ensureSubmissionAllowed(first.jobId!), { code: 'MANUAL_PHOTO_DECISION_REQUIRED' });
});

test('old publisher calls stay disabled for complete verified and manually reviewed drafts', async () => {
  const fixture = await seed(); await approveRecipeContent(fixture.recipeId, 1, owner);
  await pool.query("UPDATE trend_run SET status='awaiting_review' WHERE id=$1", [fixture.runId]);
  assert.equal((await publish()).status, 'disabled'); assert.equal((await publish()).status, 'disabled');
  assert.equal((await counts()).publications, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM editorial_outbox')).rows[0].n, 0);
});

test('repeated daily admission reuses one research run and does not create photos or publication timers', async () => {
  const first = await admitTrendRun('daily'); const second = await admitTrendRun('daily');
  assert.ok('run' in first && 'run' in second); if (!('run' in first && 'run' in second)) return;
  assert.equal(first.created, true); assert.equal(second.created, false); assert.equal(first.run.id, second.run.id);
  assert.equal((await counts()).photos, 0); assert.equal((await counts()).publications, 0);
});

test('research and text schedule does not depend on the optional photography provider', async () => {
  const prior = { fal: process.env.FAL_KEY, storage: process.env.BLOB_READ_WRITE_TOKEN };
  delete process.env.FAL_KEY; delete process.env.BLOB_READ_WRITE_TOKEN;
  try { const admitted = await admitTrendRun('daily'); assert.ok('run' in admitted && admitted.created); }
  finally { process.env.FAL_KEY = prior.fal; process.env.BLOB_READ_WRITE_TOKEN = prior.storage; }
});
