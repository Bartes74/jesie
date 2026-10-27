import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { Pool } from 'pg';
import type { EditorialActor, EditorialContent, EditorialRecord } from '@/lib/editorial-types';
import { recipes } from '@/lib/recipes';
import { getIngredientImage, getStepImage } from '@/lib/recipe-media';
import { closeDb, getDb } from '@/server/db';
import { aiJobs } from './schema';
import { createRecipe, saveRecipe } from '@/server/editorial/store';
import { approveRecipeContent } from '@/server/editorial/content-approval';
import { getAiBudgetSettings, updateAiBudgetSettings } from './budget-settings';
import { AiError } from './errors';
import { createPhotoBatch } from './photo-batch';
import { attachProviderRequest, cancelJob, claimSubmission, createJobAdmission, ensureSubmissionAllowed, failJob, finishRecipe, getJobForExecution } from './store';

const schema = `ai_budget_test_${randomUUID().replaceAll('-', '')}`;
let adminPool: Pool; let isolatedPool: Pool;
const owner: EditorialActor = { id: 'budget-owner', name: 'Forged owner', email: 'owner@example.invalid', role: 'owner' };
const admin: EditorialActor = { id: 'budget-admin', name: 'Forged admin', email: 'admin@example.invalid', role: 'admin' };
before(async () => {
  if (process.env.NODE_ENV === 'production') throw new Error('Budget tests require development.');
  config({ path: '.env.local', quiet: true });
  const connection = process.env.AI_TEST_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING;
  if (!connection) throw new Error('A development Postgres connection is required.');
  adminPool = new Pool({ connectionString: connection, max: 1 }); await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connection); url.searchParams.set('options', `-c search_path=${schema}`); url.searchParams.set('application_name', schema); process.env.DATABASE_URL = url.toString();
  isolatedPool = new Pool({ connectionString: url.toString(), max: 2 });
  await isolatedPool.query(`CREATE TABLE auth_user(id text PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,image text,role text NOT NULL DEFAULT 'admin',disabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
  await isolatedPool.query(`INSERT INTO auth_user(id,name,email,role) VALUES('budget-owner','Stored owner','owner@example.invalid','owner'),('budget-admin','Stored admin','admin@example.invalid','admin')`);
  for (const name of ['0001-editorial','0002-ai','0003-trends','0004-trend-research','0005-trend-manual-runs','0006-ingredient-reuse','0007-local-photo-corrections','0008-ai-photo-batches','0009-ai-budget-settings', '0010-daily-publication','0011-seo-discovery','0014-seo-workflows', '0015-recipe-trash','0018-content-approval','0021-recipe-result-recovery','0026-remove-spending-limits','0027-manual-review-workflow','0028-ingredient-dictionary','0029-ingredient-evidence-recheck']) await isolatedPool.query(await readFile(`migrations/${name}.sql`, 'utf8'));
  process.env.OPENAI_API_KEY = 'test-unused'; process.env.FAL_KEY = 'test-unused'; process.env.BLOB_READ_WRITE_TOKEN = 'test-unused'; process.env.AI_RECIPE_MODEL = 'gpt-6.1-sol';
  process.env.AI_DAILY_LIMIT_USD = '100'; process.env.AI_MONTHLY_LIMIT_USD = '100'; process.env.AI_PILOT_LIMIT_USD = '100';
});
beforeEach(async () => {
  // All jobs are synthetic and never call a provider. Reset their accounting
  // between independent cases, preserving captures, receipts and audit history.
  await isolatedPool.query(`UPDATE auth_user SET role=CASE WHEN id='budget-owner' THEN 'owner' ELSE 'admin' END,disabled=false`);
  await isolatedPool.query(`UPDATE ai_job SET status='failed',provider_finished_at=clock_timestamp(),ingredient_resolved_at=clock_timestamp(),charged_usd=0,cost_basis='usage'`);
  await isolatedPool.query(`UPDATE ai_photo_batch SET status='failed',remaining_reserved_usd=0`);
  await isolatedPool.query(`UPDATE ai_budget_settings SET revision=revision+1,daily_limit_usd=NULL,monthly_limit_usd=NULL,pilot_limit_usd=NULL,bypass_started_at=NULL,bypass_until=NULL WHERE id='studio'`);
});
after(async () => { await closeDb(); if (isolatedPool) await isolatedPool.end(); if (adminPool) { await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await adminPool.end(); } });
const code = (expected: string) => (error: unknown) => error instanceof AiError && error.code === expected;
async function fixture(missing: 'none' | 'hero' | 'step' | 'hero-step' | 'ingredient' | 'flour' = 'none') {
  const draft = await createRecipe({ title: 'Budget test', originalText: 'Private recipe' }, owner);
  const recipe = structuredClone(recipes[0]); const originalId = recipe.id;
  recipe.id = draft.id; recipe.slug = { pl: `test-${draft.id}`, en: `test-${draft.id}` };
  recipe.ingredients = [{ ...recipe.ingredients[0], id: 'ingredient', name: missing === 'flour' ? { pl: 'Mąka pszenna', en: 'Plain flour' } : { pl: `Produkt ${randomUUID()}`, en: `Product ${randomUUID()}` }, note: undefined }];
  recipe.steps = [{ id: 'step', title: { pl: 'Wymieszaj', en: 'Mix' }, text: { pl: 'Wymieszaj {{ingredient}}.', en: 'Mix {{ingredient}}.' } }]; recipe.substitutions = [];
  const content: EditorialContent = { recipe, originalText: 'Private recipe', author: 'Owner', sources: [], photos: {
    ingredients: { ingredient: getIngredientImage(originalId, recipes[0].ingredients[0].id) }, steps: { step: getStepImage(originalId, recipes[0].steps[0].id) },
  } };
  if (missing === 'hero' || missing === 'hero-step') recipe.image = '';
  if (missing === 'step' || missing === 'hero-step') delete content.photos.steps.step;
  if (missing === 'ingredient' || missing === 'flour') delete content.photos.ingredients.ingredient;
  const saved = await saveRecipe(draft.id, { expectedRevision: draft.revision, content }, owner);
  await approveRecipeContent(saved.id, saved.revision, owner);
  return saved;
}
const jobInput = (recipe: EditorialRecord) => ({ recipeId: recipe.id, expectedRevision: recipe.revision, kind: 'recipe' as const, brief: `Budget ${randomUUID()}`, requestKey: randomUUID() });

test('cost-only compatibility settings never enforce spending caps or enable bypass', async () => {
  const result = await getAiBudgetSettings(owner);
  assert.equal(result.settings.limitsEnforced, false); assert.equal(result.settings.bypassUntil, null);
  assert.equal(result.budget.dailyUsedUsd, '0.00000000'); assert.equal(result.budget.reservedUsd, '0.00000000');
  assert.equal(result.budget.concurrentLimit, 2);
  const tables = await isolatedPool.query(`SELECT relrowsecurity FROM pg_class WHERE relnamespace=$1::regnamespace AND relname IN ('ai_budget_settings','ai_budget_settings_audit')`, [schema]);
  assert.equal(tables.rowCount, 2); assert.ok(tables.rows.every(row => row.relrowsecurity));
});

test('all legacy budget writes return 410 after fresh authorization and preserve settings and immutable audit', async () => {
  const before = (await isolatedPool.query('SELECT * FROM ai_budget_settings')).rows;
  const audit = (await isolatedPool.query('SELECT * FROM ai_budget_settings_audit')).rows;
  const current = await getAiBudgetSettings(owner);
  for (const action of [
    { action: 'limits' as const, expectedRevision: current.settings.revision, dailyLimitUsd: '0', monthlyLimitUsd: '0', pilotLimitUsd: '0' },
    { action: 'suspend' as const, expectedRevision: current.settings.revision, durationMinutes: 60 as const },
    { action: 'resume' as const, expectedRevision: current.settings.revision },
  ]) await assert.rejects(updateAiBudgetSettings(action, owner), (error: unknown) => error instanceof AiError && error.status === 410 && error.code === 'BUDGETS_REMOVED');
  assert.deepEqual((await isolatedPool.query('SELECT * FROM ai_budget_settings')).rows, before);
  assert.deepEqual((await isolatedPool.query('SELECT * FROM ai_budget_settings_audit')).rows, audit);
  await isolatedPool.query(`UPDATE auth_user SET disabled=true WHERE id=$1`, [admin.id]);
  await assert.rejects(updateAiBudgetSettings({ action: 'resume', expectedRevision: current.settings.revision }, admin), code('FORBIDDEN'));
  await assert.rejects(getAiBudgetSettings(admin), code('FORBIDDEN'));
});

test('zero historical caps do not block new jobs or packets and no positive reservation ledger is added', async () => {
  await isolatedPool.query(`UPDATE ai_budget_settings SET revision=revision+1,daily_limit_usd=0,monthly_limit_usd=0,pilot_limit_usd=0 WHERE id='studio'`);
  const recipe = await fixture(); const missing = await fixture('hero');
  const first = await createJobAdmission(jobInput(recipe), owner); const second = await createJobAdmission(jobInput(recipe), owner);
  assert.equal(first.job.reservedUsd, '0.00000000'); assert.equal(first.job.chargedUsd, null);
  assert.equal(second.job.reservedUsd, '0.00000000');
  await assert.rejects(createJobAdmission(jobInput(recipe), owner), code('CONCURRENCY_LIMIT'));
  const packet = await createPhotoBatch({ recipeId: missing.id, expectedRevision: missing.revision, requestKey: randomUUID() }, owner);
  assert.equal(packet.batch.reservedUsd, '0.00000000'); assert.equal(packet.batch.remainingReservedUsd, '0.00000000');
  assert.equal((await isolatedPool.query(`SELECT count(*)::int n FROM ai_cost_ledger WHERE entry='reserve' AND amount_usd>0`)).rows[0].n, 0);
  const snapshot = await getAiBudgetSettings(owner);
  assert.equal(snapshot.budget.dailyUsedUsd, '0.00000000'); assert.equal(snapshot.budget.activeJobs, 2);
  await cancelJob(first.job.id, owner); await cancelJob(second.job.id, owner);
});

test('unknown accepted bills stay null and pending while verified usage alone contributes to actual spending', async () => {
  const recipe = await fixture();
  const unknown = await createJobAdmission(jobInput(recipe), owner);
  await claimSubmission(unknown.job.id); await attachProviderRequest(unknown.job.id, `accepted-${unknown.job.id}`);
  await failJob(unknown.job.id, { code: 'READ_ERROR', message: 'Unknown bill', uncertain: false, providerFinished: true });
  const captured = await getJobForExecution(unknown.job.id);
  assert.equal(captured.chargedUsd, null); assert.equal(captured.costBasis, 'reservation');
  let snapshot = await getAiBudgetSettings(owner);
  assert.equal(snapshot.budget.pilotUsedUsd, '0.00000000'); assert.equal(snapshot.budget.pendingCostCount, 1);
  const paid = await createJobAdmission(jobInput(recipe), owner);
  await claimSubmission(paid.job.id); await attachProviderRequest(paid.job.id, `billed-${paid.job.id}`);
  await finishRecipe(paid.job.id, recipe.content, { chargedUsd: '0.125', costBasis: 'usage' });
  snapshot = await getAiBudgetSettings(owner);
  assert.equal(snapshot.budget.pilotUsedUsd, '0.12500000'); assert.equal(snapshot.budget.reservedUsd, '0.00000000'); assert.equal(snapshot.budget.pendingCostCount, 1);
});

test('legacy estimates and ledger remain immutable history but are excluded from actual cost totals', async () => {
  const recipe = await fixture(); const admitted = await createJobAdmission(jobInput(recipe), owner);
  await cancelJob(admitted.job.id, owner); const source = await getJobForExecution(admitted.job.id);
  const id = randomUUID();
  await getDb().insert(aiJobs).values({ ...source, id, requestKey: randomUUID(), inputHash: randomUUID(), status: 'failed', providerRequestId: `legacy-${id}`, reservedUsd: '50', chargedUsd: '50', costBasis: 'reservation' });
  await isolatedPool.query(`INSERT INTO ai_cost_ledger(id,job_id,entry,amount_usd,basis) VALUES($1,$2,'reserve',50,'reservation')`, [randomUUID(), id]);
  const history = await getJobForExecution(id); const ledger = (await isolatedPool.query('SELECT * FROM ai_cost_ledger WHERE job_id=$1', [id])).rows;
  const snapshot = await getAiBudgetSettings(owner);
  assert.equal(snapshot.budget.pilotUsedUsd, '0.00000000'); assert.equal(snapshot.budget.pendingCostCount, 1);
  assert.deepEqual(await getJobForExecution(id), history);
  assert.deepEqual((await isolatedPool.query('SELECT * FROM ai_cost_ledger WHERE job_id=$1', [id])).rows, ledger);
});

test('zero-reserved photographs still require current content approval immediately before provider submission', async () => {
  const recipe = await fixture(); const input = { recipeId: recipe.id, expectedRevision: recipe.revision, kind: 'hero' as const, brief: 'Approved photo', requestKey: randomUUID() };
  const admitted = await createJobAdmission(input, owner); assert.equal(admitted.job.reservedUsd, '0.00000000');
  await claimSubmission(admitted.job.id);
  const changed = structuredClone(recipe.content); changed.recipe.steps[0].text.pl += ' Poczekaj na gotowość.';
  await saveRecipe(recipe.id, { expectedRevision: recipe.revision, content: changed }, owner);
  await assert.rejects(ensureSubmissionAllowed(admitted.job.id), (error: unknown) => error instanceof Error && 'code' in error && ['CONTENT_APPROVAL_REQUIRED', 'PHOTO_CONTENT_CHANGED'].includes(String(error.code)));
});
