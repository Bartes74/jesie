import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { config } from 'dotenv';
import { Pool } from 'pg';
import type { EditorialActor, EditorialContent } from '@/lib/editorial-types';
import { recipes } from '@/lib/recipes';
import { closeDb } from '@/server/db';
import { contentHash, createRecipe, emptyChecks, getRecipe, saveRecipe } from '@/server/editorial/store';
import { isRecipeContentApproved } from '@/server/editorial/content-approval';
import { trendWorker } from '@/server/trends/actor';
import { applyTrendBatch, trendBudget } from '@/server/trends/store';
import { applyJob, attachProviderRequest, cancelJob, claimSubmission, createJobAdmission, ensureSubmissionAllowed, failJob, finishRecipe, getJob, getJobForExecution } from './store';
import { admitRecipeRepair, beginRecipeResultRecovery, markRecipeRecoveryDispatchUnconfirmed } from './recipe-recovery';
import { claimRecipeRecoveryWorker, recipeRecoverySubmission } from './recipe-recovery-state';
import { advanceGenerationRecovery, submitGeneration } from './steps';
import type { RecipeDietId } from '@/lib/recipe-diet';

const schema = `recipe_recovery_${randomUUID().replaceAll('-', '')}`;
let adminPool: Pool; let pool: Pool; let originalFetch: typeof fetch;
const actor: EditorialActor = { id: 'owner', name: 'Owner', email: 'owner@example.invalid', role: 'owner' };
const issues = [{ field: 'steps', message: 'Uzupełnij brakujące kroki.' }];

before(async () => {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') throw new Error('Tests require development.');
  config({ path: '.env.local', quiet: true });
  const connection = process.env.AI_TEST_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING;
  if (!connection) throw new Error('An isolated development Postgres connection is required.');
  adminPool = new Pool({ connectionString: connection, max: 1, connectionTimeoutMillis: 20_000, query_timeout: 30_000 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connection); url.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
  pool = new Pool({ connectionString: url.toString(), max: 3, connectionTimeoutMillis: 20_000, query_timeout: 30_000 });
  await pool.query('CREATE TABLE auth_user(id text PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,image text,role text NOT NULL DEFAULT \'admin\',disabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())');
  await pool.query("INSERT INTO auth_user(id,name,email,role) VALUES('owner','Owner','owner@example.invalid','owner'),('disabled','Disabled','disabled@example.invalid','admin')");
  for (const migration of (await readdir('migrations')).filter(file => /^\d{4}-.*\.sql$/.test(file)).sort())
    await pool.query(await readFile(`migrations/${migration}`, 'utf8'));
  Object.assign(process.env, { OPENAI_API_KEY: 'test-unused', FAL_KEY: 'test-unused', BLOB_READ_WRITE_TOKEN: 'test-unused', CRON_SECRET: 'test-unused', AI_RECIPE_MODEL: 'gpt-6.1-sol', AI_IMAGE_MODEL: 'openai/gpt-image-2.5/sunburst/text-to-image', AI_TREND_MODEL: 'gpt-6.1-sol', AI_DAILY_LIMIT_USD: '100', AI_MONTHLY_LIMIT_USD: '100', AI_PILOT_LIMIT_USD: '100' });
  originalFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error('Paid/provider HTTP is forbidden in this test.'); };
});
beforeEach(async () => {
  await pool.query('TRUNCATE editorial_recipe CASCADE');
  await pool.query("UPDATE auth_user SET disabled=(id='disabled')");
  await pool.query("UPDATE trend_setting SET enabled=true,publication_authorized_by='owner',monthly_limit_usd=150,auto_pause_reason=NULL,auto_pause_token=NULL");
  process.env.AI_RECIPE_MODEL = 'gpt-6.1-sol'; process.env.AI_DAILY_LIMIT_USD = '100';
});
after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  await closeDb(); if (pool) await pool.end(); if (adminPool) { await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await adminPool.end(); }
});

function content(id: string): EditorialContent {
  const recipe = structuredClone(recipes[0]); recipe.id = id; recipe.slug = { pl: `recovery-${id}`, en: `recovery-${id}` };
  return { recipe, originalText: 'Private notes', author: 'Author', sources: [{ id: 'human', title: 'Human source', url: 'https://cook.example/human' }], photos: { ingredients: {}, steps: {} } };
}
async function fixture() {
  const draft = await createRecipe({ title: 'Recipe recovery', originalText: 'Private notes' }, actor);
  const recipe = await saveRecipe(draft.id, { expectedRevision: draft.revision, content: content(draft.id) }, actor);
  const { job } = await createJobAdmission({ recipeId: recipe.id, expectedRevision: recipe.revision, kind: 'recipe', requestKey: randomUUID(), brief: 'Opracuj przepis.' }, actor);
  return { recipe, job };
}
async function invalid(id: string, feedback = true, chargedUsd = '0.71123') {
  await claimSubmission(id); await attachProviderRequest(id, `resp_${id.replaceAll('-', '')}`);
  return failJob(id, { code: 'AI_RESULT_INVALID', message: 'Invalid structured result', uncertain: false, chargedUsd, providerFinished: true,
    ...(feedback ? { validation: { issues, repairable: true } } : {}) });
}
async function ledger(id: string) { return (await pool.query('SELECT entry,amount_usd,basis FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry', [id])).rows; }

async function dailyFixture(dietTarget?: RecipeDietId) {
  const id = randomUUID(), runId = randomUUID(); const input = content(id);
  if (dietTarget) input.aiPhotography = { recipeDietTarget: dietTarget };
  await pool.query('INSERT INTO editorial_recipe(id,content,content_hash,checks,created_by,updated_by,updated_by_name) VALUES($1,$2,$3,$4,$5,$5,$6)', [id, input, contentHash(input), emptyChecks(), trendWorker.id, trendWorker.name]);
  await pool.query("INSERT INTO editorial_version(recipe_id,revision,content,content_hash,reason,created_by,created_by_name) VALUES($1,1,$2,$3,'fixture',$4,$5)", [id, input, contentHash(input), trendWorker.id, trendWorker.name]);
  await pool.query("INSERT INTO trend_run(id,date,mode,status,recipe_id,expected_revision,packet_remaining_usd,search_charged_usd,search_finished_at,sources) VALUES($1,to_char(now() AT TIME ZONE 'Europe/Warsaw','YYYY-MM-DD'),'daily','generating',$2,1,2,.1,now(),'{}')", [runId, id]);
  const { job } = await createJobAdmission({ recipeId: id, expectedRevision: 1, kind: 'recipe', requestKey: randomUUID(), brief: 'Opracuj potrawę.' }, trendWorker, runId, { generation: 1 });
  return { id, runId, input, job };
}

test('legacy invalid first re-reads its existing receipt and can finish without another job or charge', async () => {
  const { recipe, job } = await fixture(); await invalid(job.id, false);
  const bill = await ledger(job.id); const recovered = await beginRecipeResultRecovery(job.id, actor);
  assert.equal(recovered.dispatch, true); assert.equal(recovered.job.providerRequestId, (await getJobForExecution(job.id)).providerRequestId);
  assert.equal((await claimSubmission(job.id)).shouldSubmit, false);
  const finished = await finishRecipe(job.id, recipe.content, {});
  assert.equal(finished.status, 'ready'); assert.equal(finished.chargedUsd, '0.71123000'); assert.equal(finished.costBasis, 'usage');
  assert.deepEqual(await ledger(job.id), bill); assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job')).rows[0].n, 1);
  assert.equal((await getRecipe(recipe.id)).publicationStatus, 'never_published');
});

test('existing-only recovery rejects an unsent repair child without consuming its attempt or lease', async () => {
  const { job } = await fixture(); await invalid(job.id);
  const child = await admitRecipeRepair(job.id, 1, 'original-worker');
  assert.equal(child.attempt, 1);
  const before = await getJobForExecution(child.jobId), bill = await ledger(child.jobId);
  const entry = (await pool.query('SELECT attempt,generation,workflow_run_id,dispatch_claimed_at FROM ai_recipe_recovery WHERE job_id=$1', [child.jobId])).rows[0];
  await assert.rejects(beginRecipeResultRecovery(job.id, actor, undefined, { existingOnly: true }),
    error => error instanceof Error && 'code' in error && error.code === 'RECIPE_RECOVERY_RECEIPT_REQUIRED');
  const unchanged = await getJobForExecution(child.jobId);
  assert.equal(unchanged.status, 'queued'); assert.equal(unchanged.providerRequestId, null);
  assert.equal(unchanged.chargedUsd, before.chargedUsd);
  assert.deepEqual((await pool.query('SELECT attempt,generation,workflow_run_id,dispatch_claimed_at FROM ai_recipe_recovery WHERE job_id=$1', [child.jobId])).rows[0], entry);
  assert.deepEqual(await ledger(child.jobId), bill);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job')).rows[0].n, 2);
});

test('existing-only recovery rechecks the same receipt once per lease with unchanged job, charge and repair count', async () => {
  const { recipe, job } = await fixture(); await invalid(job.id);
  const before = await getJobForExecution(job.id), bill = await ledger(job.id);
  const resumed = await beginRecipeResultRecovery(job.id, actor, undefined, { existingOnly: true });
  assert.equal(resumed.dispatch, true); assert.equal(resumed.job.id, job.id);
  assert.equal(resumed.job.providerRequestId, before.providerRequestId);
  const duplicate = await beginRecipeResultRecovery(job.id, actor, undefined, { existingOnly: true });
  assert.equal(duplicate.dispatch, false); assert.equal(duplicate.generation, resumed.generation);
  assert.equal((await claimSubmission(job.id)).shouldSubmit, false);
  const ready = await finishRecipe(job.id, recipe.content, {});
  assert.equal(ready.status, 'ready'); assert.equal(ready.chargedUsd, before.chargedUsd);
  assert.deepEqual(await ledger(job.id), bill);
  const entry = (await pool.query('SELECT attempt,generation FROM ai_recipe_recovery WHERE job_id=$1', [job.id])).rows[0];
  assert.equal(entry.attempt, 0); assert.equal(entry.generation, resumed.generation);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job')).rows[0].n, 1);
  assert.equal((await getRecipe(recipe.id)).publicationStatus, 'never_published');
});

test('a local dictionary gap stops paid repair admission for new and legacy validation failures', async () => {
  for (const legacy of [false, true]) {
    const { job } = await fixture();
    await claimSubmission(job.id); await attachProviderRequest(job.id, `resp_dictionary_${job.id}`);
    const dictionaryIssues = [{ field: 'ingredients.aubergine.name',
      message: legacy ? 'Doprecyzuj skład produktu. Unrecognised ingredient: its dietary suitability needs an explicit review or a more precise ingredient name.' : 'Brak wpisu w lokalnym słowniku.',
      ...(legacy ? {} : { code: 'DIET_INGREDIENT_UNRECOGNISED' }) }];
    await failJob(job.id, { code: 'AI_RESULT_INVALID', message: 'Invalid structured result', uncertain: false,
      chargedUsd: '0.25', providerFinished: true, validation: { issues: dictionaryIssues, repairable: true } });
    const entry = (await pool.query('SELECT repairable,failure_issues FROM ai_recipe_recovery WHERE job_id=$1', [job.id])).rows[0];
    assert.equal(entry.repairable, false);
    assert.deepEqual(entry.failure_issues, dictionaryIssues);
    // Simulate an old persisted row admitted before this guard existed.
    if (legacy) await pool.query('UPDATE ai_recipe_recovery SET repairable=true,blocked_code=NULL,blocked_message=NULL WHERE job_id=$1', [job.id]);
    const bill = await ledger(job.id), count = (await pool.query('SELECT count(*)::int n FROM ai_job')).rows[0].n;
    const operation = await admitRecipeRepair(job.id, 1, 'dictionary-worker');
    assert.equal(operation.continue, false); assert.equal(operation.created, false);
    assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job')).rows[0].n, count);
    assert.deepEqual(await ledger(job.id), bill);
    const recovery = (await getJob(job.id)).recovery!;
    assert.equal(recovery.status, 'blocked'); assert.equal(recovery.code, 'RECIPE_DIET_VOCABULARY_UNSUPPORTED');
    assert.equal(recovery.canResume, true); assert.match(recovery.reason!, /Aplikacja nie rozpoznaje/);
    assert.doesNotMatch(recovery.reason!, /popraw wskazówki/);
    const resumed = await beginRecipeResultRecovery(job.id, actor);
    assert.equal(resumed.dispatch, true);
    assert.equal((await claimSubmission(job.id)).shouldSubmit, false, 'An accepted receipt remains readable without another paid POST.');
    assert.deepEqual(await ledger(job.id), bill);
  }
});

test('a queued repair from an older build cannot submit for an unsupported local ingredient', async () => {
  const { recipe, job } = await fixture(); await invalid(job.id);
  const dictionaryIssues = [{ field: 'ingredients.marigold.name', message: 'Brak lokalnej klasyfikacji.', code: 'DIET_INGREDIENT_UNRECOGNISED' }];
  const childId = randomUUID();
  // Insert the immutable historical capture directly; current admission correctly
  // refuses to create this ineffective child in the first place.
  await pool.query("INSERT INTO ai_job(id,recipe_id,base_revision,kind,status,provider,model,brief,request_key,input_hash,input,created_by,created_by_name,reserved_usd) SELECT $1,recipe_id,base_revision,'recipe','queued',provider,model,brief,$1,$1,input,created_by,created_by_name,0 FROM ai_job WHERE id=$2", [childId, job.id]);
  await pool.query('INSERT INTO ai_recipe_recovery(job_id,root_job_id,parent_job_id,attempt,repair_issues,workflow_run_id,dispatch_claimed_at) VALUES($1,$2,$2,1,$3,$4,now())', [childId, job.id, JSON.stringify(dictionaryIssues), 'old-worker']);
  assert.equal(await submitGeneration(childId), false);
  const stopped = await getJobForExecution(childId);
  assert.equal(stopped.status, 'failed'); assert.equal(stopped.errorCode, 'RECIPE_DIET_VOCABULARY_UNSUPPORTED');
  assert.equal(stopped.providerRequestId, null); assert.equal(stopped.chargedUsd, '0.00000000');
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job')).rows[0].n, 2);
  // If the provider had already accepted this child, ancestor lookup for its GET
  // remains available and does not mistake reading a receipt for a new repair.
  const read = await recipeRecoverySubmission(childId);
  assert.deepEqual(read.ancestorRequestIds, [`resp_${job.id.replaceAll('-', '')}`]);
  const before = await ledger(job.id), childBill = await ledger(childId);
  const dto = (await getJob(childId)).recovery!;
  assert.equal(dto.jobId, job.id); assert.equal(dto.canResume, true);
  const resumed = await beginRecipeResultRecovery(childId, actor);
  assert.equal(resumed.job.id, job.id); assert.equal(resumed.dispatch, true);
  assert.equal((await claimSubmission(job.id)).shouldSubmit, false);
  const finished = await finishRecipe(job.id, recipe.content, {});
  assert.equal(finished.status, 'ready');
  const ready = (await getJob(childId)).recovery!;
  assert.equal(ready.status, 'ready'); assert.equal(ready.jobId, job.id);
  assert.equal((await admitRecipeRepair(job.id, resumed.generation, 'replacement-worker')).continue, false);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job')).rows[0].n, 2);
  assert.deepEqual(await ledger(job.id), before); assert.deepEqual(await ledger(childId), childBill);
});

test('dictionary uncertainty beyond the displayed issue bound still prevents paid repair', async () => {
  const { job } = await fixture(); await claimSubmission(job.id); await attachProviderRequest(job.id, 'resp_many_issues');
  const feedback = [...Array.from({ length: 20 }, (_, index) => ({ field: `steps.step-${index}.text`, message: 'Add a completion cue.' })),
    { field: 'ingredients.marigold.name', message: 'Brak lokalnej klasyfikacji.', code: 'DIET_INGREDIENT_UNRECOGNISED' }];
  await failJob(job.id, { code: 'AI_RESULT_INVALID', message: 'Invalid structured result', uncertain: false,
    chargedUsd: '0.25', providerFinished: true, validation: { issues: feedback, repairable: true } });
  const entry = (await pool.query('SELECT repairable,failure_issues,blocked_code FROM ai_recipe_recovery WHERE job_id=$1', [job.id])).rows[0];
  assert.equal(entry.failure_issues.length, 20); assert.equal(entry.repairable, false);
  assert.equal(entry.blocked_code, 'RECIPE_DIET_VOCABULARY_UNSUPPORTED');
  assert.equal((await admitRecipeRepair(job.id, 1, 'many-issues-worker')).continue, false);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job')).rows[0].n, 1);
});

test('five verified research references survive finish and apply while raw forged references remain excluded', async () => {
  const { recipe, job } = await fixture(); await claimSubmission(job.id); await attachProviderRequest(job.id, 'resp_sources');
  const proposal = structuredClone(recipe.content);
  proposal.sources = Array.from({ length: 5 }, (_, index) => ({ id: index === 0 ? 'human' : `research${index}`, title: `Verified ${index}`, url: `https://cook.example/research/${index}` }));
  const finished = await finishRecipe(job.id, proposal, { chargedUsd: '0.2', costBasis: 'usage' }, [], { verifiedResearchSources: true });
  assert.equal(finished.result!.content!.sources.length, 6); assert.equal(new Set(finished.result!.content!.sources.map(source => source.id)).size, 6);
  const edited = structuredClone(recipe.content); edited.sources.push({ id: 'added', title: 'Added later', url: 'https://cook.example/later' });
  const current = await saveRecipe(recipe.id, { expectedRevision: recipe.revision, content: edited }, actor);
  const applied = await applyJob(job.id, { expectedRevision: current.revision, acknowledgeStale: true }, actor);
  assert.equal(applied.recipe.content.sources.length, 7); assert.equal(applied.recipe.content.sources[0].title, 'Human source');
  assert.ok(applied.recipe.content.sources.some(source => source.url.endsWith('/later')));
  assert.equal(await isRecipeContentApproved(applied.recipe), false); assert.equal(applied.recipe.publicationStatus, 'never_published');
  const next = await fixture(); await claimSubmission(next.job.id); await attachProviderRequest(next.job.id, 'resp_forged');
  const forged = structuredClone(next.recipe.content); forged.sources = [{ id: 'fake', title: 'Invented source', url: 'https://fake.example/' }];
  const strict = await finishRecipe(next.job.id, forged, { chargedUsd: '0', costBasis: 'usage' });
  assert.deepEqual(strict.result!.content!.sources, next.recipe.content.sources);
});

test('concurrent repair admission creates one child and at most two separately billed attempts', async () => {
  const { job } = await fixture(); await invalid(job.id);
  const [first, duplicate] = await Promise.all([admitRecipeRepair(job.id, 1, 'workflow'), admitRecipeRepair(job.id, 1, 'workflow')]);
  const parentContract=(await getJobForExecution(job.id)).input.aiPhotography;
  assert.equal(parentContract?.recipeTimingVersion,'dependency-timing-v1');
  assert.equal(parentContract?.recipeDietVersion,'ingredient-diet-v1');
  assert.deepEqual((await getJobForExecution(first.jobId)).input.aiPhotography,parentContract,'A repair inherits the exact captured timing/research/diet schema.');
  assert.equal(first.jobId, duplicate.jobId); assert.equal(first.attempt, 1); assert.notEqual(first.jobId, job.id);
  assert.equal((await getJobForExecution(first.jobId)).reservedUsd, '0.00000000');
  assert.equal((await recipeRecoverySubmission(first.jobId)).ancestorRequestIds.length, 1);
  await invalid(first.jobId, true, '0.12');
  const second = await admitRecipeRepair(first.jobId, 1, 'workflow'); assert.equal(second.attempt, 2);
  assert.equal((await recipeRecoverySubmission(second.jobId)).ancestorRequestIds.length, 2);
  await invalid(second.jobId, true, '0.1');
  assert.equal((await admitRecipeRepair(second.jobId, 1, 'workflow')).continue, false);
  assert.equal((await getJob(job.id)).recovery!.status, 'exhausted');
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job')).rows[0].n, 3);
  assert.equal((await pool.query("SELECT count(*)::int n FROM ai_cost_ledger WHERE entry='reserve'")).rows[0].n, 0);
  await assert.rejects(pool.query('UPDATE ai_recipe_recovery SET attempt=0 WHERE job_id=$1', [second.jobId]));
});

async function exhaustedFixture() {
  const { recipe, job } = await fixture(); await invalid(job.id);
  const first = await admitRecipeRepair(job.id, 1, 'exhausted-worker');
  await invalid(first.jobId, true, '0.12');
  const second = await admitRecipeRepair(first.jobId, 1, 'exhausted-worker');
  await invalid(second.jobId, true, '0.1');
  await admitRecipeRepair(second.jobId, 1, 'exhausted-worker');
  const dto = (await getJob(job.id)).recovery!;
  assert.equal(dto.status, 'exhausted'); assert.equal(dto.canResume, true);
  assert.match(dto.reason!, /bez kolejnej generacji/);
  return { recipe, job, second };
}

test('an exhausted lineage can revalidate its same receipt after a local validation fix without another job or charge', async () => {
  const { recipe, job, second } = await exhaustedFixture();
  const before = await getJobForExecution(second.jobId), bill = await ledger(second.jobId);
  // A recorded workflow still owns the read until its terminal state is proven.
  assert.equal((await beginRecipeResultRecovery(job.id, actor)).dispatch, false);
  const resumed = await beginRecipeResultRecovery(job.id, actor,
    { generation: 1, workflowRunId: 'exhausted-worker', status: 'terminated' });
  assert.equal(resumed.job.id, second.jobId); assert.equal(resumed.dispatch, true); assert.equal(resumed.generation, 2);
  assert.equal((await claimSubmission(second.jobId)).shouldSubmit, false, 'The accepted receipt can only be read, never submitted again.');
  const accepted = await getJobForExecution(second.jobId);
  assert.equal(accepted.providerRequestId, before.providerRequestId); assert.deepEqual(accepted.input, before.input);
  assert.equal(await claimRecipeRecoveryWorker(second.jobId, 1, 'exhausted-worker'), false);
  assert.equal(await claimRecipeRecoveryWorker(second.jobId, 2, 'read-only-worker'), true);
  const finished = await finishRecipe(second.jobId, recipe.content, {});
  assert.equal(finished.status, 'ready'); assert.equal(finished.chargedUsd, '0.10000000');
  assert.deepEqual(await ledger(second.jobId), bill);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job')).rows[0].n, 3);
  assert.equal((await pool.query('SELECT attempt FROM ai_recipe_recovery WHERE job_id=$1', [second.jobId])).rows[0].attempt, 2);
  assert.equal((await getJob(job.id)).recovery!.status, 'ready');
  assert.equal((await getRecipe(recipe.id)).publicationStatus, 'never_published');
});

test('an exhausted receipt that remains invalid still cannot admit a third paid repair', async () => {
  const { job, second } = await exhaustedFixture(); const bill = await ledger(second.jobId);
  const resumed = await beginRecipeResultRecovery(job.id, actor,
    { generation: 1, workflowRunId: 'exhausted-worker', status: 'terminated' });
  assert.equal(resumed.dispatch, true); assert.equal((await claimSubmission(second.jobId)).shouldSubmit, false);
  assert.equal(await claimRecipeRecoveryWorker(second.jobId, resumed.generation, 'read-only-worker'), true);
  await failJob(second.jobId, { code: 'AI_RESULT_INVALID', message: 'Still invalid after revalidation', uncertain: false,
    chargedUsd: '0.1', providerFinished: true, validation: { issues, repairable: true } });
  const stopped = await admitRecipeRepair(second.jobId, resumed.generation, 'read-only-worker');
  assert.equal(stopped.continue, false); assert.match(stopped.reason!, /dwie próby/);
  assert.equal((await getJob(job.id)).recovery!.status, 'exhausted');
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job')).rows[0].n, 3);
  assert.deepEqual(await ledger(second.jobId), bill);
});

test('recovery dispatch is idempotent and a late accepted worker resumes the same free GET', async () => {
  const { job } = await fixture(); await invalid(job.id, false);
  const [first, duplicate] = await Promise.all([beginRecipeResultRecovery(job.id, actor), beginRecipeResultRecovery(job.id, actor)]);
  assert.equal([first, duplicate].filter(item => item.dispatch).length, 1);
  await markRecipeRecoveryDispatchUnconfirmed(job.id, 1);
  assert.equal((await getJobForExecution(job.id)).status, 'uncertain');
  assert.equal(await claimRecipeRecoveryWorker(job.id, 1, 'late-worker'), true);
  assert.equal((await getJobForExecution(job.id)).status, 'generating');
  assert.equal((await claimSubmission(job.id)).shouldSubmit, false);
  assert.equal(await claimRecipeRecoveryWorker(job.id, 1, 'other-worker'), false);
  await markRecipeRecoveryDispatchUnconfirmed(job.id, 1); // The response-loss catch cannot stop an already claimed worker.
  assert.equal((await getJobForExecution(job.id)).status, 'generating');
  const restarted = await beginRecipeResultRecovery(job.id, actor, { generation: 1, workflowRunId: 'late-worker', status: 'terminated' });
  assert.equal(restarted.generation, 2); assert.equal(await claimRecipeRecoveryWorker(job.id, 1, 'late-worker'), false);
  assert.equal(await claimRecipeRecoveryWorker(job.id, 2, 'replacement'), true);
});

test('known usage and immutable ledger survive recovery cancellation and an operational GET failure', async () => {
  for (const cancel of [true, false]) {
    const { job } = await fixture(); await invalid(job.id, false); const bill = await ledger(job.id);
    await beginRecipeResultRecovery(job.id, actor);
    const stopped = cancel ? await cancelJob(job.id, actor) : await failJob(job.id, { code: 'AI_PROVIDER_QUOTA', message: 'Restore quota', uncertain: true });
    assert.equal(stopped.chargedUsd, '0.71123000'); assert.equal(stopped.costBasis, 'usage'); assert.deepEqual(await ledger(job.id), bill);
  }
});

test('manual edit or archive between repair admission and POST fails the final preflight', async () => {
  for (const archive of [false, true]) {
    const { recipe, job } = await fixture(); await invalid(job.id); const repair = await admitRecipeRepair(job.id, 1, 'worker');
    if (archive) await pool.query("UPDATE editorial_recipe SET editorial_status='archived' WHERE id=$1", [recipe.id]);
    else { const changed = structuredClone(recipe.content); changed.recipe.title.pl = 'Edited title'; await saveRecipe(recipe.id, { expectedRevision: recipe.revision, content: changed }, actor); }
    assert.equal((await claimSubmission(repair.jobId)).shouldSubmit, true);
    await assert.rejects(ensureSubmissionAllowed(repair.jobId), { code: 'RECIPE_REPAIR_STALE' });
    await failJob(repair.jobId, { code: 'AI_SUBMISSION_BLOCKED', message: 'No POST', uncertain: false, chargedUsd: '0', providerFinished: true });
    assert.equal((await getJobForExecution(repair.jobId)).providerRequestId, null);
  }
});

test('removed budget caps cannot block a repair while model changes still persist a clear blocked reason', async () => {
  const { job } = await fixture(); await invalid(job.id);
  process.env.AI_DAILY_LIMIT_USD = '0';
  const admitted = await advanceGenerationRecovery(job.id, 1, 'worker'); assert.equal(admitted.continue, true);
  assert.notEqual(admitted.jobId, job.id); assert.equal((await getJobForExecution(admitted.jobId)).reservedUsd, '0.00000000');
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job')).rows[0].n, 2);
  const next = await fixture(); await invalid(next.job.id);
  process.env.AI_RECIPE_MODEL = 'gpt-6-astra';
  assert.equal((await admitRecipeRepair(next.job.id, 1, 'worker')).continue, false);
  assert.equal((await getJob(next.job.id)).recovery!.code, 'RECIPE_MODEL_CHANGED');
  assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job')).rows[0].n, 3);
});

test('unknown acceptance and stale/manual unauthorized requests cannot buy repair attempts', async () => {
  const { recipe, job } = await fixture(); await claimSubmission(job.id); await failJob(job.id, { code: 'AI_SUBMISSION_UNCERTAIN', message: 'Unknown acceptance', uncertain: true });
  assert.equal((await admitRecipeRepair(job.id, 1, 'worker')).continue, false);
  await assert.rejects(beginRecipeResultRecovery(job.id, actor), { code: 'RECIPE_RECOVERY_RECEIPT_REQUIRED' });
  await assert.rejects(beginRecipeResultRecovery(job.id, { ...actor, id: 'disabled' }), { code: 'FORBIDDEN' });
  const next = await fixture(); await invalid(next.job.id, false);
  const changed = structuredClone(next.recipe.content); changed.recipe.title.pl = 'Changed'; await saveRecipe(next.recipe.id, { expectedRevision: next.recipe.revision, content: changed }, actor);
  await assert.rejects(beginRecipeResultRecovery(next.job.id, actor), { code: 'STALE_RESULT' });
  assert.equal((await getRecipe(recipe.id)).publicationStatus, 'never_published');
});

test('daily repair preserves its seeded dietary target and legacy packet history, admits without reserves and applies only through the original run', async () => {
  const { id, runId, input, job } = await dailyFixture('vegan');
  const captured=(await getJobForExecution(job.id)).input.aiPhotography;
  assert.deepEqual(captured,{recipeProposalVersion:'finished-dish-v2',recipePresentationVersion:'required-finished-dish-v1',recipeResearchVersion:'web-recipe-v1',recipeTimingVersion:'dependency-timing-v1',recipeDietVersion:'ingredient-diet-v1',recipeDietTarget:'vegan'});
  assert.deepEqual((await getRecipe(id)).content.aiPhotography,{recipeDietTarget:'vegan'},'Capturing a new contract never rewrites the seeded editorial draft.');
  await invalid(job.id, true, '0.25');
  const child = await admitRecipeRepair(job.id, 1, 'daily-worker', 1);
  assert.deepEqual((await getJobForExecution(child.jobId)).input.aiPhotography,captured);
  const reserved = await trendBudget(); await admitRecipeRepair(job.id, 1, 'daily-worker', 1); assert.deepEqual(await trendBudget(), reserved);
  assert.equal((await pool.query('SELECT packet_remaining_usd FROM trend_run WHERE id=$1', [runId])).rows[0].packet_remaining_usd, '2.00000000');
  assert.equal((await getJobForExecution(child.jobId)).trendRunId, runId);
  await claimSubmission(child.jobId); await attachProviderRequest(child.jobId, 'resp_daily_child');
  await finishRecipe(child.jobId, input, { chargedUsd: '0.12', costBasis: 'usage' });
  await applyTrendBatch(runId, [child.jobId], 1);
  assert.equal((await getRecipe(id)).revision, 2); assert.equal((await getRecipe(id)).publicationStatus, 'never_published');
  assert.equal((await pool.query('SELECT count(*)::int n FROM editorial_content_approval')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM editorial_publication')).rows[0].n, 0);
  assert.equal((await getJob(job.id)).recovery!.jobId, child.jobId);
});

test('a queued repair survives a crashed workflow without another admission or reservation', async () => {
  const { job } = await fixture(); await invalid(job.id); const child = await admitRecipeRepair(job.id, 1, 'crashed-worker');
  const before = await ledger(child.jobId);
  const resumed = await beginRecipeResultRecovery(job.id, actor, { generation: 1, workflowRunId: 'crashed-worker', status: 'terminated' });
  assert.equal(resumed.job.id, child.jobId); assert.equal(resumed.job.status, 'queued'); assert.equal(resumed.generation, 2);
  assert.equal(await claimRecipeRecoveryWorker(child.jobId, 1, 'crashed-worker'), false);
  assert.equal(await claimRecipeRecoveryWorker(child.jobId, 2, 'replacement'), true);
  assert.equal((await claimSubmission(child.jobId)).shouldSubmit, true); await ensureSubmissionAllowed(child.jobId);
  assert.deepEqual(await ledger(child.jobId), before); assert.equal((await pool.query('SELECT count(*)::int n FROM ai_job')).rows[0].n, 2);
});

test('legacy repair preserves pre-research, pre-timing and pre-diet contracts without upgrading any of them', async () => {
  for (const contract of [undefined,{recipeProposalVersion:'finished-dish-v2',recipeResearchVersion:'web-recipe-v1'},
    {recipeProposalVersion:'finished-dish-v2',recipeResearchVersion:'web-recipe-v1',recipeTimingVersion:'dependency-timing-v1'}]) {
    const { job } = await fixture(); await cancelJob(job.id, actor);
    const parentId = randomUUID(); const captured = structuredClone((await getJobForExecution(job.id)).input);
    if (contract) captured.aiPhotography=structuredClone(contract); else delete captured.aiPhotography;
    await pool.query("INSERT INTO ai_job(id,recipe_id,base_revision,kind,status,provider,model,brief,request_key,input_hash,input,created_by,created_by_name,reserved_usd) SELECT $1,recipe_id,base_revision,'recipe','queued',provider,model,brief,$1,$1,$2,created_by,created_by_name,2 FROM ai_job WHERE id=$3", [parentId, captured, job.id]);
    await pool.query("INSERT INTO ai_cost_ledger(id,job_id,entry,amount_usd,basis) VALUES($1,$2,'reserve',2,'reservation')", [randomUUID(), parentId]);
    await invalid(parentId); const child = await admitRecipeRepair(parentId, 1, 'legacy-worker');
    const childInput=(await getJobForExecution(child.jobId)).input;
    assert.equal(childInput.aiPhotography?.recipeTimingVersion,contract?.recipeTimingVersion);
    assert.equal(childInput.aiPhotography?.recipeDietVersion,undefined);
    assert.equal(childInput.aiPhotography?.recipeDietTarget,undefined);
    assert.deepEqual(childInput.aiPhotography,contract);
    assert.deepEqual((await getJobForExecution(parentId)).input,captured,'Reading and repairing never rewrite the historical parent input.');
    assert.equal((await recipeRecoverySubmission(child.jobId)).ancestorRequestIds.length, 1);
    await cancelJob(child.jobId,actor);
  }
});

test('a replaced daily generation cannot submit a repair that was admitted before its backoff', async () => {
  const { runId, job } = await dailyFixture(); await invalid(job.id); const child = await admitRecipeRepair(job.id, 1, 'old-daily', 1);
  await pool.query('UPDATE trend_run SET generation=generation+1 WHERE id=$1', [runId]);
  assert.equal((await claimSubmission(child.jobId)).shouldSubmit, true);
  await assert.rejects(ensureSubmissionAllowed(child.jobId), { code: 'TREND_SUPERSEDED' });
  assert.equal((await getJobForExecution(child.jobId)).providerRequestId, null);
});
