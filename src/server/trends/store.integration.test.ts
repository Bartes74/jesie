import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { parse } from 'dotenv';
import Decimal from 'decimal.js';
import type { EditorialActor, EditorialContent } from '@/lib/editorial-types';
import type { AiJob } from '@/lib/ai-types';
import type { TrendRunAction, TrendSearchDiagnostics } from '@/lib/trend-types';
import { recipes } from '@/lib/recipes';
import { closeDb } from '@/server/db';
import { contentHash, createRecipe, emptyChecks, getRecipe, getPublishedRecipe, performRecipeAction, saveRecipe } from '@/server/editorial/store';
import { getConfiguration, claimSubmission, attachProviderRequest, finishRecipe, finishAsset, ensureSubmissionAllowed, failJob, resumeJob, getJob, getJobForExecution, markProviderTerminal, createJobAdmission } from '@/server/ai/store';
import { admitTrendRun, claimTrendSearch, beforeTrendSearch, finishTrendSearch, finishTrendSearchFailure, getTrendRun, getTrendExecution, getTrendDashboard, getTrendResearchHints, searchModelForRun, refreshTrendDiagnostics, reverifyTrendSearch, prepareTrendInspiration, trendBudget, trendJob as storedTrendJob, applyTrendBatch, reserveTrendPhotos as storedReserveTrendPhotos, completeTrendRun, updateTrendSettings, actOnTrendRun as storedActOnTrendRun, settleSearchFailure, attachSearchRequest, attachTrendWorkflow, failTrendRun } from './store';
import { pollRadar, stopRadar, submitRadar } from './steps';
import { capturedIngredientStyleProfile, currentIngredientStyleProfile, isOpaqueStudioIngredientProfile } from '../ai/ingredient-profile';
import { resolveIngredientReuse } from '../ai/store';
import { rankCandidates, warsawDate, type RawCandidate } from './ranking';
import { pollTrendSearch } from './search';
import { seasonalRecipeIdeas } from './selection';
import { getTrendDietBalance } from './store';
import { dietBalanceTarget } from './diet-balance';
import type { RecipeDietId } from '@/lib/recipe-diet';
import { isStepPhotoRequired } from '@/lib/step-photo-selection';
import { trendWorker } from './actor';
import { recipeGenerationReservationUsd } from '@/server/ai/config';
import { approveRecipeContent, contentApprovalHash } from '@/server/editorial/content-approval';
import { getPreparationPlan, prepareRecipeText, advancePreparedText, preparePhotoSlot as storedPreparePhotoSlot, advancePreparedPhoto } from './preparation';
import { heroCutoutModel, failedHeroSourcePrefix } from '../ai/image-actions';
import { attachReceipt, failVerification, startOrClaimVerification } from '../ai/ingredient-dictionary-store';
import { getPublicationCosts } from '../admin/publication-costs';
const schema = `trend_test_${randomUUID().replaceAll('-', '')}`;
let adminPool: Pool;
let isolatedPool: Pool;
let dateOffset = 0;
let fixtureDiet: RecipeDietId = 'meat';
const actor: EditorialActor = { id: 'test-owner', name: 'Forged owner', email: 'owner@example.invalid', role: 'owner' };
const checks = { pl: true, en: true, quantities: true, method: true, photos: true, sources: true };

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
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production')
        throw new Error('Tests require development.');
    const connection = await developmentConnection();
    if (!connection)
        throw new Error('An isolated development Postgres connection is required.');
    adminPool = new Pool({ connectionString: connection, max: 1, connectionTimeoutMillis: 20_000, query_timeout: 30_000 });
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(connection);
    url.searchParams.set('options', `-c search_path=${schema}`);
    await closeDb();
    process.env.DATABASE_URL = url.toString();
    isolatedPool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 20_000, query_timeout: 30_000 });
    assert.equal((await isolatedPool.query('SELECT current_schema() AS name')).rows[0].name, schema);
  await isolatedPool.query(`CREATE TABLE auth_user(id text PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,image text,role text NOT NULL DEFAULT 'admin',disabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
    await isolatedPool.query(`INSERT INTO auth_user(id,name,email,role) VALUES('test-owner','Stored owner','owner@example.invalid','owner'),('test-admin','Admin','admin@example.invalid','admin')`);
    for (const migration of ['0001-editorial', '0002-ai', '0003-trends', '0004-trend-research', '0005-trend-manual-runs', '0006-ingredient-reuse', '0007-local-photo-corrections', '0008-ai-photo-batches', '0009-ai-budget-settings', '0010-daily-publication','0011-seo-discovery','0014-seo-workflows', '0015-recipe-trash','0018-content-approval','0020-manual-automation-takeover','0021-recipe-result-recovery','0026-remove-spending-limits','0027-manual-review-workflow','0028-ingredient-dictionary','0029-ingredient-evidence-recheck'])
        await isolatedPool.query(await readFile(`migrations/${migration}.sql`, 'utf8'));
    // Presence guards only. Providers and blob APIs are never called by this suite.
    process.env.OPENAI_API_KEY = 'test-unused';
    process.env.FAL_KEY = 'test-unused';
    process.env.BLOB_READ_WRITE_TOKEN = 'test-unused';
    process.env.CRON_SECRET = 'test-unused';
    process.env.AI_DAILY_LIMIT_USD = '2';
    process.env.AI_MONTHLY_LIMIT_USD = '2';
    process.env.AI_PILOT_LIMIT_USD = '2';
    process.env.AI_TREND_MODEL = 'gpt-6.1-sol';
});
after(async () => { await closeDb(); if (isolatedPool)
    await isolatedPool.end(); if (adminPool) {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
} });
// Anchor synthetic dates at noon so Warsaw's autumn DST shift cannot cause
// two consecutive 24-hour offsets near midnight to reuse the same local day.
function day() { const date = new Date(); date.setUTCHours(12, 0, 0, 0); return new Date(date.getTime() + (++dateOffset) * 86400000); }
function evidence(): RawCandidate {
    const key = randomUUID();
    const handleSuffix = key.replaceAll('-', '').slice(0, 12);
    const date = new Date().toISOString();
    return { dishKey: key, title: { pl: `Potrawa ${key}`, en: `Dish ${key}` }, aliases: [key], rationale: 'Fresh independent discussion.', diet: fixtureDiet, sources: [
            { url: `https://www.instagram.com/creator_one_${handleSuffix}/reel/post/`, title: 'Social recipe', publisher: 'Unverified display name', platform: 'instagram', publishedAt: date, excerpt: 'This recipe is going viral across social cooking channels today.', interestEvidence: 'Fresh viral discussion.', independentKey: 'forged1' },
            { url: `https://www.tiktok.com/@creator_${handleSuffix}/video/1`, title: 'Creator post', publisher: 'Fake publisher ignored', platform: 'tiktok', publishedAt: date, excerpt: 'A popular new cooking trend with a fresh variation on dinner.', interestEvidence: 'Current popularity claim.', independentKey: 'forged2' },
            { url: `https://foodandwine.com/${key}`, title: 'Editorial coverage', publisher: 'Same display name', platform: 'web', publishedAt: date, excerpt: 'The newest viral recipe trend is reaching home kitchens this week.', interestEvidence: 'Current coverage.', independentKey: 'forged3' },
        ] };
}
/** Media lifecycle fixtures explicitly capture a human photo decision; the separate
 * manual-policy suite exercises ordinary runs and the actual request boundary. */
async function consentToFixturePhotos(runId: string) {
    const run = await getTrendExecution(runId); if (!run.recipeId) return;
    const recipe = await getRecipe(run.recipeId);
    await approveRecipeContent(recipe.id, recipe.revision, actor);
    const approvedContentHash = contentApprovalHash(recipe.content);
    if (run.searchDiagnostics?.preparation?.generation === run.generation && run.searchDiagnostics.preparation.approvedContentHash === approvedContentHash) return;
    const preparation = { requestKey: randomUUID(), expectedRevision: recipe.revision, generation: run.generation, startedAt: new Date().toISOString(), approvedContentHash, requestedBy: actor.id };
    await isolatedPool.query("UPDATE trend_run SET search_diagnostics=coalesce(search_diagnostics,'{}'::jsonb)||jsonb_build_object('preparation',$2::jsonb) WHERE id=$1", [runId, JSON.stringify(preparation)]);
}
async function trendJob(...args: Parameters<typeof storedTrendJob>) {
    if (args[1] !== 'recipe') await consentToFixturePhotos(args[0]);
    return storedTrendJob(...args);
}
async function reserveTrendPhotos(...args: Parameters<typeof storedReserveTrendPhotos>) {
    await consentToFixturePhotos(args[0]); return storedReserveTrendPhotos(...args);
}
async function preparePhotoSlot(...args: Parameters<typeof storedPreparePhotoSlot>) {
    await consentToFixturePhotos(args[0]); return storedPreparePhotoSlot(...args);
}
async function actOnTrendRun(id: string, input: TrendRunAction, requestActor: EditorialActor) {
    if (['repair', 'regenerate_photo'].includes(input.action)) {
        const run = await getTrendExecution(id);
        if (run.recipeId) { const recipe = await getRecipe(run.recipeId); if (!recipe.deletedAt && recipe.editorialStatus !== 'archived') await approveRecipeContent(recipe.id, recipe.revision, actor); }
    }
    return storedActOnTrendRun(id, input, requestActor);
}
async function newRun() { const result = await admitTrendRun('control', actor, day()); assert.ok('run' in result); fixtureDiet = dietBalanceTarget(await getTrendDietBalance()).target; return result.run; }
async function drafted() { const run = await newRun(); await claimTrendSearch(run.id); const candidate = evidence(); await finishTrendSearch(run.id, [candidate], candidate.sources.map(s => s.url), '0.1'); const execution = await getTrendExecution(run.id); assert.ok(execution.recipeId); return execution; }
function proposal(id: string): EditorialContent { const recipe = structuredClone(recipes[0]); recipe.id = id; recipe.title = { pl: `Potrawa ${id}`, en: `Dish ${id}` }; recipe.slug = { pl: `potrawa-${id}`, en: `dish-${id}` }; recipe.substitutions = [{ id: 'alternative', ingredientId: recipe.ingredients[0].id, name: { pl: 'Inny makaron', en: 'Other pasta' }, amount: { kind: 'exact', value: '320' }, unit: 'g', scaling: 'linear', note: { pl: 'Podobny czas gotowania; sprawdź opakowanie.', en: 'Similar cooking time; check the packet.' }, status: 'to_review' }]; return { recipe, originalText: 'Proposal cannot replace private source', author: 'Proposal author ignored', sources: [], photos: { ingredients: {}, steps: {} } }; }
async function readyText(runId: string) { const admission = await trendJob(runId, 'recipe'); const job = admission.job; await claimSubmission(job.id); await attachProviderRequest(job.id, `mock-text-${job.id}`); await finishRecipe(job.id, proposal(job.recipeId), { chargedUsd: '0.2', costBasis: 'usage', usage: { inputTokens: 100, outputTokens: 100 } }); return job; }
async function textApplied() { const run = await drafted(); const job = await readyText(run.id); await applyTrendBatch(run.id, [job.id]); return getTrendExecution(run.id); }
async function readyPhoto(runId: string, kind: 'hero' | 'ingredient' | 'step', targetId?: string): Promise<AiJob> { const { job } = await trendJob(runId, kind, targetId); if (job.status === 'ready') return job; await claimSubmission(job.id); await attachProviderRequest(job.id, `mock-photo-${job.id}`); return finishAsset(job.id, { blobPathname: `test/${job.id}.webp`, width: 1024, height: 1024, contentType: 'image/webp', alt: { pl: 'Prawidłowy detal', en: 'Correct cooking detail' }, caption: { pl: 'Detal', en: 'Detail' }, hasTransparency: false, styleProfile: kind === 'ingredient' ? currentIngredientStyleProfile : 'jesie-culinary-editorial-v1' }, { chargedUsd: '0.1', costBasis: 'usage' }); }
async function complete(beforeCompletion?: () => void, selectedRunId?: string) { let run; if (selectedRunId) { const text = await readyText(selectedRunId); await applyTrendBatch(selectedRunId, [text.id]); run = await getTrendExecution(selectedRunId); } else run = await textApplied(); const targets = await reserveTrendPhotos(run.id); const hero = await readyPhoto(run.id, 'hero'); await applyTrendBatch(run.id, [hero.id]); const ids: string[] = []; for (const ingredient of targets.ingredients)
    ids.push((await readyPhoto(run.id, 'ingredient', ingredient)).id); for (const step of targets.steps)
    ids.push((await readyPhoto(run.id, 'step', step)).id); await applyTrendBatch(run.id, ids); beforeCompletion?.(); await completeTrendRun(run.id); return getTrendRun(run.id); }
async function cleanupRun(id: string) { const run = await getTrendExecution(id); if (!['published', 'rejected', 'no_candidate'].includes(run.status))
    await actOnTrendRun(id, { action: 'reject' }, actor); await isolatedPool.query(`UPDATE ai_job SET status='failed',provider_finished_at=now(),charged_usd=coalesce(charged_usd,0),cost_basis='usage' WHERE trend_run_id=$1 AND status IN('queued','submitting','generating','uncertain')`, [id]);
    // Dispose of intentionally unresolved mock receipts after each assertion. No provider was called.
    await isolatedPool.query('UPDATE trend_run SET search_charged_usd=coalesce(search_charged_usd,0),search_finished_at=coalesce(search_finished_at,now()) WHERE id=$1', [id]); }
/** Seed pre-policy history for receipt recovery tests; new searches use finishTrendSearch. */
async function finishLegacyEmptySearch(id: string, raw: RawCandidate[], urls: string[], chargedUsd: string, diagnostics?: TrendSearchDiagnostics, generation = 1) {
    const candidates = rankCandidates(raw, urls, [], id).map((candidate, index) => generation === 1 ? candidate : { ...candidate, id: `${id}-reverify-${generation}-${index}`, verificationGeneration: generation });
    assert(candidates.every(candidate => !candidate.eligible));
    const state = await getTrendExecution(id);
    const sources = structuredClone(state.sources);
    for (const candidate of candidates) for (const source of candidate.sources) {
        sources[source.platform].status = 'available';
        sources[source.platform].count++;
    }
    const snapshot = diagnostics ? { ...diagnostics, model: state.searchModel!, outcome: diagnostics.discoveredCandidates === 0 ? 'empty_discovery' : candidates.every(candidate => candidate.sources.length === 0) ? 'unverified_sources' : 'insufficient_evidence' } : null;
    const connection = await isolatedPool.connect();
    try {
        await connection.query('BEGIN');
        await connection.query("UPDATE trend_run SET status='no_candidate',generation=$2,search_charged_usd=$3,search_finished_at=coalesce(search_finished_at,now()),search_diagnostics=$4,sources=$5,packet_remaining_usd=0 WHERE id=$1", [id, generation, chargedUsd, snapshot, sources]);
        for (const candidate of candidates) await connection.query('INSERT INTO trend_candidate(id,run_id,dish_key,data,selected) VALUES($1,$2,$3,$4,false)', [candidate.id, id, candidate.dishKey, candidate]);
        await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
}
test('ingredient verification costs and unresolved receipts appear once in trend and publication reports', async () => {
    const run = await drafted();
    const { job } = await trendJob(run.id, 'recipe');
    const beforeRun = (await getTrendRun(run.id)).run;
    const beforeBudget = await trendBudget();
    const beforePublication = (await getPublicationCosts()).find(item => item.id === run.recipeId)!;
    const input = { name: { pl: `nieznany składnik ${randomUUID()}`, en: '' } };
    const claim = await startOrClaimVerification(input, { originJobId: job.id, originRecipeId: run.recipeId }); assert(claim.claimToken);
    await attachReceipt(claim.verification.key, claim.claimToken, 'resp_report_cost');
    await failVerification(claim.verification.key, claim.claimToken, { code: 'MOCK_TERMINAL_FAILURE', message: 'Test fixture receipt.' }, { chargedUsd: '0.02', costBasis: 'usage' });
    const pending = await startOrClaimVerification({ name: { pl: `inny składnik ${randomUUID()}`, en: '' } }, { originJobId: job.id, originRecipeId: run.recipeId });
    assert(pending.claimToken);
    const shared = await startOrClaimVerification(input, { originRecipeId: 'another-recipe' }); assert.equal(shared.claimed, false);
    const afterRun = (await getTrendRun(run.id)).run;
    const afterBudget = await trendBudget();
    const afterPublication = (await getPublicationCosts()).find(item => item.id === run.recipeId)!;
    assert.equal(new Decimal(afterRun.chargedUsd).minus(beforeRun.chargedUsd).toFixed(8), '0.02000000');
    assert.equal(afterRun.pendingCostCount, (beforeRun.pendingCostCount ?? 0) + 1);
    assert.equal(new Decimal(afterBudget.usedUsd).minus(beforeBudget.usedUsd).toFixed(8), '0.02000000');
    assert.equal(afterBudget.pendingCostCount, (beforeBudget.pendingCostCount ?? 0) + 1);
    assert.equal(new Decimal(afterPublication.costUsd).minus(beforePublication.costUsd).toFixed(8), '0.02000000');
    assert.equal(afterPublication.pendingCostCount, beforePublication.pendingCostCount + 1);
    assert.equal(afterPublication.correctionsUsd, beforePublication.correctionsUsd);
    const unassigned = await startOrClaimVerification({ name: { pl: `bez przepisu ${randomUUID()}`, en: '' } }); assert(unassigned.claimToken);
    const unassignedReport = (await getPublicationCosts()).find(item => item.id === ''); assert.equal(unassignedReport?.pendingCostCount, 1);
    await failVerification(pending.verification.key, pending.claimToken, { code: 'MOCK_CONFIRMED_REJECTION', message: 'Test cleanup.' }, { chargedUsd: '0' });
    await failVerification(unassigned.verification.key, unassigned.claimToken, { code: 'MOCK_CONFIRMED_REJECTION', message: 'Test cleanup.' }, { chargedUsd: '0' });
    await cleanupRun(run.id);
});
test('disabled default, missing configuration and owner-only enable cannot dispatch', async () => {
    const dashboard = await getTrendDashboard();
    assert.equal(dashboard.settings.enabled, false);
    assert.equal(dashboard.budget.limitUsd, '0.00000000');
    assert.equal(dashboard.configuration.controlRequired, true);
    assert.deepEqual(await admitTrendRun('daily'), { skipped: true });
    assert.equal((await updateTrendSettings(true, actor)).enabled, true);
    await updateTrendSettings(false, actor);
    delete process.env.OPENAI_API_KEY;
    try {
        await assert.rejects(admitTrendRun('control', actor, day()), { code: 'TREND_NOT_CONFIGURED' });
    }
    finally {
        process.env.OPENAI_API_KEY = 'test-unused';
    }
    await assert.rejects(updateTrendSettings(false, { ...actor, id: 'test-admin', role: 'admin' }), { code: 'OWNER_REQUIRED' });
});
test('same Warsaw day atomically admits one run across concurrent calls and modes', async () => {
    const date = day();
    const results = await Promise.all([admitTrendRun('control', actor, date), admitTrendRun('control', actor, date)]);
    assert.ok(results.every(result => 'run' in result));
    const accepted = results.filter(result => 'run' in result && result.created);
    assert.equal(accepted.length, 1);
    const ids = results.map(result => 'run' in result ? result.run.id : '');
    assert.equal(new Set(ids).size, 1);
    await cleanupRun(ids[0]);
});
test('lost search acceptance never repeats a paid submission or releases uncertainty', async () => {
    const run = await newRun();
    assert.equal((await claimTrendSearch(run.id)).submit, true);
    assert.equal((await claimTrendSearch(run.id)).submit, false);
    assert.equal((await getTrendExecution(run.id)).status, 'uncertain');
    await settleSearchFailure(run.id, null, true);
    const state = await getTrendExecution(run.id);
    assert.equal(state.searchChargedUsd, null);
    assert.equal(state.searchReservedUsd, '0.00000000');
    await cleanupRun(run.id);
});
test('empty discovery selects a seasonal recipe and stores its confirmed bill without reserving the draft', async () => {
    const run = await newRun();
    await claimTrendSearch(run.id);
    await finishTrendSearch(run.id, [], [], '0.1');
    const state = await getTrendRun(run.id);
    assert.equal(state.run.status, 'generating');
    assert.ok(state.run.recipeId);
    assert.equal(state.run.selectionBasis, 'seasonal');
    assert.equal(state.run.settledUsd, '0.10000000');
    assert.equal(state.run.reservedUsd, recipeGenerationReservationUsd());
    assert.equal(state.run.chargedUsd, '0.10000000');
    assert.equal(state.candidates.filter(candidate => candidate.selected).length, 1);
    assert.deepEqual(state.candidates[0].sources, []);
    assert.equal(state.recipe?.content.recipe.trendConfirmedAt, undefined);
    await cleanupRun(run.id);
});
test('text and photo preflight create no reservation and report only confirmed costs', async () => {
    const run = await drafted();
    const before = await trendBudget();
    const text = await trendJob(run.id, 'recipe');
    const after = await trendBudget();
    assert.equal(after.usedUsd, before.usedUsd);
    assert.equal((await getConfiguration()).budget.pilotUsedUsd, '0.00000000');
    await claimSubmission(text.job.id);
    await attachProviderRequest(text.job.id, `mock-${text.job.id}`);
    await finishRecipe(text.job.id, proposal(text.job.recipeId), { chargedUsd: '0.2', costBasis: 'usage' });
    await applyTrendBatch(run.id, [text.job.id]);
    const targets = await reserveTrendPhotos(run.id);
    assert.ok(targets.ingredients.length > 0 && targets.steps.length > 0);
    assert.equal((await getTrendExecution(run.id)).packetRemainingUsd, '0.00000000');
    const packetBefore = await trendBudget();
    await trendJob(run.id, 'hero');
    const packetAfter = await trendBudget();
    assert.equal(packetBefore.usedUsd, packetAfter.usedUsd);
    assert.equal(packetAfter.reservedUsd, '0.00000000');
    await cleanupRun(run.id);
});
test('obsolete monthly caps cannot block photo preflight or allocate any photograph', async () => {
    const run = await textApplied();
    await isolatedPool.query("UPDATE trend_setting SET monthly_limit_usd=0 WHERE id='global'");
    try {
        const targets = await reserveTrendPhotos(run.id);
        assert.ok(targets.ingredients.length && targets.steps.length);
        assert.equal((await getTrendExecution(run.id)).packetRemainingUsd, '0.00000000');
        const jobs = await isolatedPool.query('SELECT kind FROM ai_job WHERE trend_run_id=$1', [run.id]);
        assert.deepEqual(jobs.rows.map(row => row.kind), ['recipe']);
    } finally { await isolatedPool.query("UPDATE trend_setting SET monthly_limit_usd=150 WHERE id='global'"); await cleanupRun(run.id); }
});
test('sibling photographs apply in one revision, replay safely, and stale manual edits cannot be overwritten', async () => {
    const run = await textApplied();
    await reserveTrendPhotos(run.id);
    const recipe = await getRecipe(run.recipeId!);
    const ingredient = await readyPhoto(run.id, 'ingredient', recipe.content.recipe.ingredients[0].id);
    const step = await readyPhoto(run.id, 'step', recipe.content.recipe.steps[0].id);
    const applied = await applyTrendBatch(run.id, [ingredient.id, step.id]);
    assert.equal(applied.revision, recipe.revision + 1);
    assert.ok(applied.content.photos.ingredients[ingredient.targetId!]);
    assert.ok(applied.content.photos.steps[step.targetId!]);
    const replay = await applyTrendBatch(run.id, [ingredient.id, step.id]);
    assert.equal(replay.revision, applied.revision);
    const hero = await readyPhoto(run.id, 'hero');
    const changed = structuredClone(applied.content);
    changed.recipe.description.pl += ' Ręczna poprawka.';
    const saved = await saveRecipe(run.recipeId!, { expectedRevision: applied.revision, content: changed }, actor);
    await assert.rejects(applyTrendBatch(run.id, [hero.id]), { code: 'REVISION_CONFLICT' });
    assert.equal((await getRecipe(run.recipeId!)).revision, saved.revision);
    await cleanupRun(run.id);
});
test('pause prevents submission; a confirmed search can resume without another POST', async () => {
    const run = await newRun();
    await claimTrendSearch(run.id);
    await attachSearchRequest(run.id, 'existing-provider-request');
    await actOnTrendRun(run.id, { action: 'pause' }, actor);
    const result = await actOnTrendRun(run.id, { action: 'resume' }, actor);
    assert.equal(result.resume, true);
    const continued = await getTrendExecution(run.id);
    assert.equal(continued.generation, 2);
    assert.equal((await claimTrendSearch(run.id)).submit, false);
    assert.equal(continued.searchRequestId, 'existing-provider-request');
    await cleanupRun(run.id);
});
test('a search paused after retrieval resumes its existing selection and creates exactly one draft', async () => {
    const run = await newRun();
    await claimTrendSearch(run.id);
    await actOnTrendRun(run.id, { action: 'pause' }, actor);
    const c = evidence();
    await finishTrendSearch(run.id, [c], c.sources.map(s => s.url), '0.1');
    assert.equal((await getTrendExecution(run.id)).recipeId, null);
    const result = await actOnTrendRun(run.id, { action: 'resume' }, actor);
    assert.equal(result.run.status, 'generating');
    assert.ok(result.run.recipeId);
    const counts = await isolatedPool.query('SELECT count(*)::int AS count FROM editorial_recipe WHERE id=$1', [result.run.recipeId]);
    assert.equal(counts.rows[0].count, 1);
    await cleanupRun(run.id);
});
test('a late search result settles its bill without reviving a rejected run', async () => {
    const run = await newRun();
    await claimTrendSearch(run.id);
    await attachSearchRequest(run.id, 'late-provider-request');
    await actOnTrendRun(run.id, { action: 'reject' }, actor);
    const c = evidence();
    await finishTrendSearch(run.id, [c], c.sources.map(source => source.url), '0.1');
    const latest = await getTrendExecution(run.id);
    assert.equal(latest.status, 'rejected');
    assert.equal(latest.recipeId, null);
    assert.equal(latest.searchChargedUsd, '0.10000000');
});
test('manual editing pauses automation before the provider preflight', async () => {
    const run = await drafted();
    const { job } = await trendJob(run.id, 'recipe');
    await claimSubmission(job.id);
    const recipe = await getRecipe(run.recipeId!);
    const changed = structuredClone(recipe.content);
    changed.recipe.description.pl = 'Manual context';
    await saveRecipe(recipe.id, { expectedRevision: recipe.revision, content: changed }, actor);
    await assert.rejects(ensureSubmissionAllowed(job.id), { code: 'REVISION_CONFLICT' });
    await cleanupRun(run.id);
});
test('incomplete control metadata never grants a worker manual publication rights', async () => {
    const run = await textApplied();
    await completeTrendRun(run.id); assert.equal((await getTrendExecution(run.id)).status, 'awaiting_review');
    assert.equal((await getTrendDashboard()).configuration.controlRequired, true);
    await assert.rejects(performRecipeAction(run.recipeId!, { action: 'approve_and_publish', expectedRevision: run.expectedRevision!, checks }, trendWorker), { code: 'FORBIDDEN' });
    await cleanupRun(run.id);
});
test('explicit human approval atomically publishes both languages while automation uses its own owner switch', async () => {
    const state = await complete();
    assert.equal(state.run.status, 'awaiting_review');
    assert.ok(state.recipe);
    assert.equal(state.recipe.content.recipe.substitutions?.[0].status, 'to_review');
    await updateTrendSettings(true, actor);
    await assert.rejects(actOnTrendRun(state.run.id, { action: 'approve_and_publish', expectedRevision: state.recipe.revision, checks: { ...checks, en: false } }, actor), { code: 'REVIEW_REQUIRED' });
    assert.equal((await getTrendRun(state.run.id)).run.status, 'awaiting_review');
    await assert.rejects(actOnTrendRun(state.run.id, { action: 'approve_and_publish', expectedRevision: state.recipe.revision - 1, checks }, actor), { code: 'REVISION_CONFLICT' });
    const published = await actOnTrendRun(state.run.id, { action: 'approve_and_publish', expectedRevision: state.recipe.revision, checks }, actor);
    assert.equal(published.run.status, 'published');
    assert.equal(published.recipe?.publicationStatus, 'published');
    assert.equal(published.recipe?.content.recipe.substitutions?.[0].status, 'approved');
    const publicPl = await getPublishedRecipe(published.recipe!.content.recipe.slug.pl, 'pl');
    const publicEn = await getPublishedRecipe(published.recipe!.content.recipe.slug.en, 'en');
    assert.equal(publicPl?.id, state.recipe.id);
    assert.equal(publicEn?.id, state.recipe.id);
    const count = await isolatedPool.query('SELECT count(*)::int AS count FROM editorial_publication WHERE recipe_id=$1', [state.recipe.id]);
    assert.equal(count.rows[0].count, 1);
    await updateTrendSettings(false, actor);
    process.env.OPENAI_API_KEY = 'different-test-key';
    try {
        assert.equal((await updateTrendSettings(true, actor)).enabled, true);
        await updateTrendSettings(false, actor);
    }
    finally {
        process.env.OPENAI_API_KEY = 'test-unused';
    }
});

test('a confirmed uncertain trend request can be read through Studio while the run is paused',async()=>{
 const run=await drafted();const {job}=await trendJob(run.id,'recipe');
 assert.equal((await claimSubmission(job.id)).shouldSubmit,true);
 await attachProviderRequest(job.id,'mock-confirmed-existing-request');
 await failJob(job.id,{code:'RESULT_UNCONFIRMED',message:'Mock retrieval timeout',uncertain:true});
 await actOnTrendRun(run.id,{action:'pause'},actor);
 const reading=await resumeJob(job.id,actor);assert.equal(reading.status,'generating');
 const claim=await claimSubmission(job.id);assert.equal(claim.shouldSubmit,false);assert.equal(claim.job.providerRequestId,'mock-confirmed-existing-request');
 // Registered receipt-only completion uses the original request. No provider POST exists in this test.
 await finishRecipe(job.id,proposal(job.recipeId),{chargedUsd:'0.2',costBasis:'usage'});
 const resumed=await actOnTrendRun(run.id,{action:'resume'},actor);assert.equal(resumed.resume,true);assert.equal(resumed.run.status,'generating');
 await cleanupRun(run.id);
});


test('rejecting an unclaimed search releases its complete reservation and late claims preserve terminal state', async () => {
    const run = await newRun();
    await actOnTrendRun(run.id, { action: 'reject' }, actor);
    const state = await getTrendExecution(run.id);
    assert.equal(state.searchChargedUsd, '0.00000000');
    assert.ok(state.searchFinishedAt);
    const late = await claimTrendSearch(run.id);
    assert.equal(late.submit, false);
    assert.equal(late.run.status, 'rejected');
    const dto = await getTrendRun(run.id);
    assert.equal(dto.run.reservedUsd, '0.00000000');
    assert.equal(dto.run.chargedUsd, '0.00000000');
    const paused = await newRun();
    await claimTrendSearch(paused.id);
    await actOnTrendRun(paused.id, { action: 'pause' }, actor);
    assert.equal((await claimTrendSearch(paused.id)).run.status, 'paused');
    await cleanupRun(paused.id);
});

test('rejecting queued children releases only proven unsubmitted cost and prevents a new POST', async () => {
    const run = await drafted();
    const { job } = await trendJob(run.id, 'recipe');
    assert.equal(job.status, 'queued');
    await actOnTrendRun(run.id, { action: 'reject' }, actor);
    const rejected = await getJob(job.id);
    assert.equal(rejected.status, 'cancelled');
    assert.equal(rejected.chargedUsd, '0.00000000');
    assert.equal((await getTrendRun(run.id)).run.reservedUsd, '0.00000000');
    await assert.rejects(ensureSubmissionAllowed(job.id));
    const submittedRun = await drafted();
    const submitted = (await trendJob(submittedRun.id, 'recipe')).job;
    await claimSubmission(submitted.id);
    await actOnTrendRun(submittedRun.id, { action: 'reject' }, actor);
    const pending = await getJob(submitted.id);
    assert.equal(pending.status, 'submitting');
    assert.equal(pending.chargedUsd, null);
    assert.equal(pending.reservedUsd, recipeGenerationReservationUsd());
    await assert.rejects(ensureSubmissionAllowed(submitted.id));
    await cleanupRun(submittedRun.id);
});

async function confirmedRejectedSearch() {
    const date = day();
    const admitted = await admitTrendRun('control', actor, date);
    assert.ok('run' in admitted);
    await claimTrendSearch(admitted.run.id);
    await settleSearchFailure(admitted.run.id, '0', false);
    await failTrendRun(admitted.run.id, 'Mock confirmed HTTP 400 schema rejection');
    return { date, run: await getTrendExecution(admitted.run.id) };
}

test('same-day control retry is explicit, authenticated, and admits exactly one new generation', async () => {
    const { date, run } = await confirmedRejectedSearch();
    await isolatedPool.query('UPDATE trend_run SET workflow_id=$1 WHERE id=$2', ['old-finished-workflow', run.id]);
    const unchanged = await admitTrendRun('control', actor, date);
    assert.ok('run' in unchanged);
    assert.equal(unchanged.restarted, false);
    assert.equal(unchanged.run.status, 'failed');
    await assert.rejects(admitTrendRun('control', undefined, date, true), { code: 'FORBIDDEN' });
    await assert.rejects(admitTrendRun('control', { ...actor, id: 'unknown-user' }, date, true), { code: 'FORBIDDEN' });
    const budget = await trendBudget();
    const results = await Promise.all([admitTrendRun('control', actor, date, true), admitTrendRun('control', actor, date, true)]);
    assert.ok(results.every(result => 'run' in result));
    assert.equal(results.filter(result => 'run' in result && result.restarted).length, 1);
    assert.equal(results.filter(result => 'run' in result && result.created).length, 0);
    const restarted = await getTrendExecution(run.id);
    assert.equal(restarted.id, run.id);
    assert.equal(restarted.date, run.date);
    assert.equal(restarted.createdAt.toISOString(), run.createdAt.toISOString());
    assert.equal(restarted.generation, run.generation + 1);
    assert.equal(restarted.status, 'queued');
    assert.equal(restarted.workflowId, null);
    assert.equal(restarted.error, null);
    assert.equal(restarted.searchClaimedAt, null);
    assert.equal(restarted.searchFinishedAt, null);
    assert.equal(restarted.searchRequestId, null);
    assert.equal(restarted.searchChargedUsd, null);
    assert.equal(restarted.searchReservedUsd, '0.00000000');
    await assert.rejects(claimTrendSearch(run.id, run.generation), { code: 'TREND_SUPERSEDED' });
    await assert.rejects(beforeTrendSearch(run.id, run.generation), { code: 'TREND_SUPERSEDED' });
    await settleSearchFailure(run.id, '0', false, run.generation);
    await failTrendRun(run.id, 'Obsolete worker failure', true, run.generation);
    await attachTrendWorkflow(run.id, 'Obsolete workflow', run.generation);
    await attachSearchRequest(run.id, 'Obsolete receipt', run.generation);
    await finishTrendSearch(run.id, [], [], '0.1', [], run.generation);
    assert.equal((await getTrendExecution(run.id)).searchClaimedAt, null);
    assert.equal((await getTrendExecution(run.id)).status, 'queued');
    assert.equal((await getTrendExecution(run.id)).searchChargedUsd, null);
    assert.equal((await getTrendExecution(run.id)).workflowId, null);
    assert.equal((await getTrendExecution(run.id)).searchRequestId, null);
    assert.equal((await getTrendExecution(run.id)).searchFinishedAt, null);
    assert.equal(new Decimal((await trendBudget()).usedUsd).minus(budget.usedUsd).toFixed(8), '0.00000000');
    const count = await isolatedPool.query('SELECT count(*)::int AS count FROM trend_run WHERE date=$1', [run.date]);
    assert.equal(count.rows[0].count, 1);
    await cleanupRun(run.id);
});

test('same-day control retry refuses receipts, unknown bills, incomplete rejection, daily mode and existing material', async () => {
    const cases = [
        { name: 'receipt', mutation: "search_request_id='confirmed-receipt'" },
        { name: 'unknown cost', mutation: 'search_charged_usd=NULL' },
        { name: 'positive cost', mutation: 'search_charged_usd=0.01' },
        { name: 'unfinished rejection', mutation: 'search_finished_at=NULL' },
        { name: 'unclaimed search', mutation: 'search_claimed_at=NULL' },
        { name: 'daily mode', mutation: "mode='daily'" },
        { name: 'draft revision', mutation: 'expected_revision=1' },
        { name: 'candidate pointer', mutation: "candidate_id='existing-candidate'" },
    ];
    for (const scenario of cases) {
        const { date, run } = await confirmedRejectedSearch();
        await isolatedPool.query(`UPDATE trend_run SET ${scenario.mutation} WHERE id=$1`, [run.id]);
        await assert.rejects(admitTrendRun('control', actor, date, true), { code: 'TREND_RETRY_UNSAFE' }, scenario.name);
        const unchanged = await getTrendExecution(run.id);
        assert.equal(unchanged.generation, 1, scenario.name);
        assert.equal(unchanged.status, 'failed', scenario.name);
        await cleanupRun(run.id);
    }
    const { date, run } = await confirmedRejectedSearch();
    await isolatedPool.query("UPDATE trend_run SET status='uncertain',search_charged_usd=NULL,search_finished_at=NULL WHERE id=$1", [run.id]);
    const uncertain = await admitTrendRun('control', actor, date, true);
    assert.ok('run' in uncertain);
    assert.equal(uncertain.restarted, false);
    assert.equal(uncertain.run.status, 'uncertain');
    await cleanupRun(run.id);
    // Cron cannot take the explicit control retry path, even when scheduling is enabled.
    const rejected = await confirmedRejectedSearch();
    await isolatedPool.query("UPDATE trend_setting SET enabled=true,last_control_at=now(),control_fingerprint=NULL,publication_authorized_by=$1 WHERE id='global'", [actor.id]);
    const config = await getTrendDashboard();
    assert.equal(config.configuration.controlRequired, true);
    const beforeRun = await getTrendExecution(rejected.run.id);
    const beforeBudget = await trendBudget();
    const beforeLedger = (await isolatedPool.query('SELECT * FROM ai_cost_ledger ORDER BY id')).rows;
    const cronReplay = await admitTrendRun('daily', undefined, rejected.date, true);
    assert.ok('run' in cronReplay);
    assert.equal(cronReplay.created, false);
    assert.equal(cronReplay.restarted, false);
    assert.equal(cronReplay.run.id, rejected.run.id);
    assert.deepEqual(await getTrendExecution(rejected.run.id), beforeRun, 'A failed control cannot be restarted by cron or change its generation, receipts or reservations.');
    assert.deepEqual(await trendBudget(), beforeBudget);
    assert.deepEqual((await isolatedPool.query('SELECT * FROM ai_cost_ledger ORDER BY id')).rows, beforeLedger);
    await isolatedPool.query("UPDATE trend_setting SET enabled=false,last_control_at=NULL WHERE id='global'");
    await cleanupRun(rejected.run.id);
});

test('same-day control retry rejects any draft, orphaned candidate and child-job records', async () => {
    const draft = await drafted();
    await isolatedPool.query('DELETE FROM trend_candidate WHERE run_id=$1', [draft.id]);
    await isolatedPool.query("UPDATE trend_run SET status='failed',expected_revision=NULL,candidate_id=NULL,packet_remaining_usd=0,search_finished_at=now(),search_charged_usd=0 WHERE id=$1", [draft.id]);
    await assert.rejects(admitTrendRun('control', actor, new Date(`${draft.date}T12:00:00Z`), true), { code: 'TREND_RETRY_UNSAFE' });
    await cleanupRun(draft.id);
    for (const withJob of [false, true]) {
        const run = await drafted();
        if (withJob) {
            await trendJob(run.id, 'recipe');
            await isolatedPool.query('DELETE FROM trend_candidate WHERE run_id=$1', [run.id]);
        }
        await isolatedPool.query("UPDATE trend_run SET status='failed',recipe_id=NULL,expected_revision=NULL,candidate_id=NULL,packet_remaining_usd=0,search_finished_at=now(),search_charged_usd=0 WHERE id=$1", [run.id]);
        await assert.rejects(admitTrendRun('control', actor, new Date(`${run.date}T12:00:00Z`), true), { code: 'TREND_RETRY_UNSAFE' });
        assert.equal((await getTrendExecution(run.id)).generation, 1);
        await cleanupRun(run.id);
    }
});

test('same-day control retry rechecks active work but ignores obsolete monetary caps', async () => {
    const rejected = await confirmedRejectedSearch();
    const active = await newRun();
    await assert.rejects(admitTrendRun('control', actor, rejected.date, true), { code: 'TREND_ACTIVE' });
    assert.equal((await getTrendExecution(rejected.run.id)).generation, 1);
    await cleanupRun(active.id);
    await isolatedPool.query("UPDATE trend_setting SET monthly_limit_usd=0 WHERE id='global'");
    try {
        const result = await admitTrendRun('control', actor, rejected.date, true);
        assert.ok('run' in result && result.restarted);
        const current = await getTrendExecution(rejected.run.id);
        assert.equal(current.generation, 2); assert.equal(current.searchReservedUsd, '0.00000000');
        assert.equal(current.packetRemainingUsd, '0.00000000');
    } finally { await isolatedPool.query("UPDATE trend_setting SET monthly_limit_usd=150 WHERE id='global'"); await cleanupRun(rejected.run.id); }
});

function searchDiagnostics(overrides: Partial<TrendSearchDiagnostics> = {}): TrendSearchDiagnostics {
    return { version: 1, model: 'gpt-6.1-sol', toolCalls: 3, queries: ['current viral dinner recipes'], retrievedUrls: 0, discoveredCandidates: 0, submittedSources: 0, verifiedSources: 0, issueCounts: {}, ...overrides };
}
async function emptyReceipt(mode: 'daily' | 'control' = 'control') {
    const admitted = await admitTrendRun(mode, mode === 'control' ? actor : undefined, day());
    assert.ok('run' in admitted);
    await claimTrendSearch(admitted.run.id);
    await attachSearchRequest(admitted.run.id, `mock-empty-${admitted.run.id}`);
    await finishLegacyEmptySearch(admitted.run.id, [], [], '0.25', searchDiagnostics());
    return admitted.run.id;
}
test('empty scheduled and manual searches choose different recipes without pausing the scheduler', async () => {
    await isolatedPool.query("UPDATE trend_setting SET auto_pause_reason=NULL,auto_pause_token=NULL,auto_pause_reviewed_at=now() WHERE id='global'");
    await complete();
    await updateTrendSettings(true, actor);
    const titles: string[] = [];
    try {
        for (const mode of ['daily', 'control'] as const) {
            const admitted = await admitTrendRun(mode, mode === 'control' ? actor : undefined, day(), false, mode === 'control' ? randomUUID() : undefined);
            assert.ok('run' in admitted);
            await claimTrendSearch(admitted.run.id);
            await attachSearchRequest(admitted.run.id, `mock-empty-new-${admitted.run.id}`);
            await finishTrendSearch(admitted.run.id, [], [], '0.25', [], admitted.generation, searchDiagnostics());
            const state = await getTrendRun(admitted.run.id);
            assert.equal(state.run.status, 'generating');
            assert.ok(state.run.recipeId);
            assert.equal(state.run.selectionBasis, 'seasonal');
            assert.equal(state.run.manual, mode === 'control');
            assert.equal(state.run.diagnostics?.outcome, 'selected');
            assert.equal(state.run.diagnostics?.discoveryOutcome, 'empty_discovery');
            assert.equal(state.candidates.filter(candidate => candidate.selected).length, 1);
            titles.push(state.run.selectedTitle!.en);
            assert.equal((await getTrendDashboard()).settings.enabled, true);
            assert.equal((await getTrendDashboard()).settings.autoPauseReason, null);
            // A rejected suggestion still exists in the editorial queue for deduplication.
            await cleanupRun(admitted.run.id);
        }
        assert.equal(new Set(titles).size, 2);
    } finally { await updateTrendSettings(false, actor); }
});

test('a selected dish breaks the empty streak and never automatically enables the scheduler', async () => {
    await isolatedPool.query("UPDATE trend_setting SET enabled=false,auto_pause_reason=NULL,auto_pause_token=NULL,auto_pause_reviewed_at=now() WHERE id='global'");
    await emptyReceipt();
    const selected = await drafted();
    await attachSearchRequest(selected.id, 'mock-selected-existing-receipt');
    await actOnTrendRun(selected.id, { action: 'pause' }, actor);
    await emptyReceipt();
    const dashboard = await getTrendDashboard();
    assert.equal(dashboard.settings.autoPauseReason, null);
    assert.equal(dashboard.settings.enabled, false);
    await cleanupRun(selected.id);
});

test('search diagnostics persist the final evidence outcome and the admitted model', async () => {
    const cases: Array<{ sources: number; expected: string }> = [{ sources: 0, expected: 'unverified_sources' }, { sources: 1, expected: 'insufficient_evidence' }];
    for (const scenario of cases) {
        const run = await newRun();
        await claimTrendSearch(run.id);
        const candidate = evidence();
        candidate.sources = candidate.sources.slice(0, scenario.sources);
        await finishTrendSearch(run.id, [candidate], candidate.sources.map(source => source.url), '0.25', [], 1, searchDiagnostics({ model: 'untrusted-model', discoveredCandidates: 1, submittedSources: 3, verifiedSources: scenario.sources, issueCounts: { publication_date_missing: 2 } }));
        const state = await getTrendRun(run.id);
        assert.equal(state.run.diagnostics?.outcome, 'selected');
        assert.equal(state.run.diagnostics?.discoveryOutcome, scenario.expected);
        assert.equal(state.run.diagnostics?.model, 'gpt-6.1-sol');
        assert.equal(state.run.diagnostics?.submittedSources, 3);
        assert.deepEqual(state.run.diagnostics?.issueCounts, { publication_date_missing: 2 });
        assert.equal(state.run.selectionBasis, 'inspiration');
        assert.equal(state.recipe?.content.recipe.trendConfirmedAt, undefined);
        await cleanupRun(run.id);
    }
    const staleRun = await newRun();
    await claimTrendSearch(staleRun.id);
    const stale = evidence();
    stale.sources = stale.sources.map(source => ({ ...source, publishedAt: '2000-01-01T00:00:00Z' }));
    await finishTrendSearch(staleRun.id, [stale], stale.sources.map(source => source.url), '0.25', [], 1, searchDiagnostics({ discoveredCandidates: 1, submittedSources: 3, verifiedSources: 3 }));
    const staleState = await getTrendRun(staleRun.id);
    assert.equal(staleState.run.diagnostics?.verifiedSources, 0);
    assert.equal(staleState.run.diagnostics?.outcome, 'selected');
    assert.equal(staleState.run.diagnostics?.discoveryOutcome, 'unverified_sources');
    assert.deepEqual(staleState.run.diagnostics?.issueCounts, { date_stale: 3 });
    assert.equal(staleState.candidates[0].research?.issues.length, 3);
    await cleanupRun(staleRun.id);
});

function mockReceipt(model: string) {
    return { id: 'mock-read-only-receipt', object: 'response', status: 'completed', model, output: [
        { id: 'mock-call', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'viral dinner recipes', sources: [] } },
        { id: 'mock-message', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '{"candidates":[]}', annotations: [] }] },
    ], usage: { input_tokens: 1000, output_tokens: 100 } };
}
test('saved search models determine receipt accounting after config changes and legacy rows retain Astra pricing', async () => {
    const originalFetch = globalThis.fetch;
    const run = await newRun();
    await claimTrendSearch(run.id);
    await attachSearchRequest(run.id, 'mock-admitted-sol');
    process.env.AI_TREND_MODEL = 'gpt-6-astra';
    let gets = 0;
    globalThis.fetch = async (input, init) => {
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        assert.equal(method, 'GET');
        const url = String(input instanceof Request ? input.url : input);
        const endpoint = new URL(url);
        assert.equal(endpoint.origin, 'https://api.openai.com');
        assert.equal(endpoint.pathname, '/v1/responses/mock-admitted-sol');
        assert.equal(endpoint.searchParams.get('include[]'), 'web_search_call.action.sources');
        gets++;
        return new Response(JSON.stringify(mockReceipt('gpt-6.1-sol')), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
        await pollRadar(run.id, 1);
        const state = await getTrendExecution(run.id);
        assert.equal(state.searchModel, 'gpt-6.1-sol');
        assert.equal(state.searchChargedUsd, '0.01300000');
        assert.equal(state.searchDiagnostics?.model, 'gpt-6.1-sol');
        assert.equal(gets, 1);
        await actOnTrendRun(run.id, { action: 'pause' }, actor);
        const beforeBudget = await trendBudget();
        const beforeCount = (await isolatedPool.query('SELECT count(*)::int AS count FROM trend_run')).rows[0].count;
        const next = await newRun();
        assert.deepEqual(await trendBudget(), beforeBudget);
        assert.equal((await isolatedPool.query('SELECT count(*)::int AS count FROM trend_run')).rows[0].count, beforeCount + 1);
        assert.equal(next.reservedUsd, '0.00000000');
        await cleanupRun(next.id);
        assert.equal(searchModelForRun({ searchModel: null }), 'gpt-6-astra');
    } finally {
        globalThis.fetch = originalFetch;
        process.env.AI_TREND_MODEL = 'gpt-6.1-sol';
        await isolatedPool.query("UPDATE trend_setting SET monthly_limit_usd=150 WHERE id='global'");
        await cleanupRun(run.id);
    }
});

test('diagnostic refresh uses only an existing GET and leaves historical status, cost and selection intact', async () => {
    const originalFetch = globalThis.fetch;
    const runId = await emptyReceipt();
    await isolatedPool.query('UPDATE trend_run SET search_model=NULL,search_diagnostics=NULL WHERE id=$1', [runId]);
    const before = await getTrendExecution(runId);
    let gets = 0;
    let mutate = false;
    globalThis.fetch = async (input, init) => {
        assert.equal(init?.method ?? (input instanceof Request ? input.method : 'GET'), 'GET');
        assert.match(String(input instanceof Request ? input.url : input), /^https:\/\/api\.openai\.com\/v1\/responses\/mock-empty-/);
        gets++;
        if (mutate) await isolatedPool.query('UPDATE trend_run SET generation=generation+1 WHERE id=$1', [runId]);
        return new Response(JSON.stringify(mockReceipt('gpt-6-astra')), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
        await assert.rejects(refreshTrendDiagnostics(runId, { ...actor, id: 'missing-user' }), { code: 'FORBIDDEN' });
        assert.equal(gets, 0);
        const refreshed = await refreshTrendDiagnostics(runId, actor);
        const after = await getTrendExecution(runId);
        assert.equal(refreshed.diagnostics?.model, 'gpt-6-astra');
        assert.equal(refreshed.diagnostics?.toolCalls, 1);
        assert.equal(refreshed.diagnostics?.outcome, 'empty_discovery');
        assert.deepEqual({ ...after, searchDiagnostics: null }, before);
        mutate = true;
        await assert.rejects(refreshTrendDiagnostics(runId, actor), { code: 'TREND_SUPERSEDED' });
        assert.equal((await getTrendExecution(runId)).searchChargedUsd, before.searchChargedUsd);
        assert.equal(gets, 2);
    } finally { globalThis.fetch = originalFetch; }
});

test('old control cannot certify changed configuration; a fresh owner can explicitly enable the new validated pipeline', async () => {
    await isolatedPool.query("UPDATE trend_setting SET enabled=false,last_control_at=NULL,control_fingerprint=NULL WHERE id='global'");
    try {
        const finished = await complete(() => { process.env.AI_TREND_MODEL = 'gpt-6-astra'; });
        assert.equal(finished.run.status, 'awaiting_review');
        assert.equal(finished.run.searchModel, 'gpt-6.1-sol');
        assert.equal((await getTrendDashboard()).configuration.controlRequired, true);
        assert.equal((await updateTrendSettings(true, actor, true)).enabled, true);
        await updateTrendSettings(false, actor);
        assert.equal((await isolatedPool.query("SELECT last_control_at FROM trend_setting WHERE id='global'")).rows[0].last_control_at, null);
    } finally { process.env.AI_TREND_MODEL = 'gpt-6.1-sol'; }
});

test('recent incomplete research hints are bounded, skip known duplicates and reject unsafe URLs', async () => {
    const run = await newRun();
    await claimTrendSearch(run.id);
    const candidates = Array.from({ length: 13 }, (_, index) => {
        const candidate = evidence();
        candidate.dishKey = `hint_${index}_${run.id}`;
        candidate.sources = [{ ...candidate.sources[2], url: `https://food52.com/recipes/hint-${index}` }];
        candidate.research = { foundSources: 3, verifiedSources: 1, issues: [{ url: 'http://127.0.0.1/private', platform: 'web', reason: 'source_not_allowed' }, ...Array.from({ length: 20 }, (_, source) => ({ url: `https://delish.com/hint-${index}-${source}`, platform: 'web' as const, reason: 'publication_date_missing' }))] };
        return candidate;
    });
    await finishTrendSearch(run.id, candidates, candidates.flatMap(candidate => candidate.sources.map(source => source.url)), '0.25');
    const now = new Date(`${run.date}T12:00:00Z`);
    const hints = await getTrendResearchHints(now);
    assert.equal(hints.length, 12);
    assert.ok(hints.reduce((count, hint) => count + hint.sourceUrls.length, 0) <= 12);
    assert.ok(hints.every(hint => hint.sourceUrls.every(url => url.startsWith('https://'))));
    await isolatedPool.query('UPDATE trend_run SET date=$1 WHERE id=$2', ['2000-01-01', run.id]);
    assert.ok((await getTrendResearchHints(now)).every(hint => !hint.dishKey.includes(run.id)));
    await cleanupRun(run.id);
});

test('unknown photo bills and legacy positive estimates stay pending without becoming actual cost or a spending reservation', async () => {
    const run = await textApplied();
    try {
        const before = await trendBudget(); await reserveTrendPhotos(run.id);
        const hero = (await trendJob(run.id, 'hero')).job;
        await claimSubmission(hero.id); await attachProviderRequest(hero.id, `mock-pending-cost-${hero.id}`);
        await finishAsset(hero.id, { blobPathname: `test/${hero.id}.webp`, width: 1024, height: 1024, contentType: 'image/webp', alt: { pl: 'Potrawa', en: 'Dish' }, caption: { pl: '', en: '' } }, {});
        const pending = await getTrendRun(run.id);
        assert.equal(pending.run.settledUsd, '0.30000000'); assert.equal(pending.run.chargedUsd, '0.30000000');
        assert.equal(pending.run.reservedUsd, '0.00000000'); assert.equal(pending.run.pendingCostCount, 1);
        assert.equal((await getJobForExecution(hero.id)).chargedUsd, null, 'An unknown new bill is not confirmed zero.');
        // Preserve old captured estimates without including them in actual totals.
        await isolatedPool.query("UPDATE ai_job SET charged_usd=2,cost_basis='reservation' WHERE id=$1", [hero.id]);
        await isolatedPool.query('UPDATE trend_run SET search_reserved_usd=200,packet_remaining_usd=123 WHERE id=$1', [run.id]);
        const legacy = await getTrendRun(run.id); const totals = await trendBudget();
        assert.equal(legacy.run.chargedUsd, '0.30000000'); assert.equal(legacy.run.pendingCostCount, 1);
        assert.equal(legacy.run.reservedUsd, '0.00000000'); assert.equal(totals.usedUsd, before.usedUsd);
        assert.equal(totals.reservedUsd, '0.00000000'); assert.equal(totals.pendingCostCount, (before.pendingCostCount ?? 0) + 1);
        assert.equal((await getJobForExecution(hero.id)).chargedUsd, '2.00000000', 'Read models cannot rewrite old estimates.');
        assert.equal((await getTrendExecution(run.id)).packetRemainingUsd, '123.00000000');
    } finally { await cleanupRun(run.id); }
});

test('owner manual runs require a stored owner, a UUID and an explicit control request', async () => {
    const requestKey = randomUUID();
    const now = new Date();
    const before = await trendBudget();
    await assert.rejects(admitTrendRun('control', undefined, now, false, requestKey), { code: 'FORBIDDEN' });
    await assert.rejects(admitTrendRun('control', { ...actor, id: 'test-admin' }, now, false, requestKey), { code: 'OWNER_REQUIRED' });
    await assert.rejects(admitTrendRun('control', { ...actor, id: 'trend_worker' }, now, false, requestKey), { code: 'FORBIDDEN' });
    await assert.rejects(admitTrendRun('daily', actor, now, false, requestKey), { code: 'TREND_MANUAL_INVALID' });
    await assert.rejects(admitTrendRun('control', actor, now, true, requestKey), { code: 'TREND_MANUAL_INVALID' });
    await assert.rejects(admitTrendRun('control', actor, now, false, 'invalid-uuid'), { code: 'TREND_MANUAL_INVALID' });
    assert.deepEqual(await trendBudget(), before);
    assert.equal((await isolatedPool.query('SELECT count(*)::int AS count FROM trend_run WHERE manual_request_key=$1', [requestKey])).rows[0].count, 0);
    const admitted = await admitTrendRun('control', actor, now, false, requestKey);
    assert.ok('run' in admitted);
    assert.equal(admitted.created, true);
    assert.equal(admitted.run.date, warsawDate(now));
    assert.equal(admitted.run.manual, true);
    assert.equal((await getTrendExecution(admitted.run.id)).searchModel, 'gpt-6.1-sol');
    await cleanupRun(admitted.run.id);
});

test('owner manual runs replay one request across races without altering the historical same-day bill or evidence', async () => {
    const now = day();
    const base = await admitTrendRun('control', actor, now);
    assert.ok('run' in base);
    await claimTrendSearch(base.run.id);
    await attachSearchRequest(base.run.id, 'mock-historical-accepted-receipt');
    const candidate = evidence();
    candidate.sources = candidate.sources.slice(0, 1);
    await finishLegacyEmptySearch(base.run.id, [candidate], candidate.sources.map(source => source.url), '0.25', searchDiagnostics({ discoveredCandidates: 1, submittedSources: 1, verifiedSources: 1 }));
    const historical = await getTrendExecution(base.run.id);
    const historicalEvidence = (await getTrendRun(base.run.id)).candidates;
    const before = await trendBudget();
    const requestKey = randomUUID();
    const concurrent = await Promise.all([admitTrendRun('control', actor, now, false, requestKey), admitTrendRun('control', actor, now, false, requestKey)]);
    assert.ok(concurrent.every(result => 'run' in result));
    assert.equal(concurrent.filter(result => 'run' in result && result.created).length, 1);
    const ids = concurrent.map(result => 'run' in result ? result.run.id : '');
    assert.equal(new Set(ids).size, 1);
    assert.notEqual(ids[0], historical.id);
    const run = await getTrendExecution(ids[0]);
    assert.equal(run.date, historical.date);
    assert.equal(run.manualRequestKey, requestKey);
    assert.equal(run.searchReservedUsd, '0.00000000');
    assert.equal(new Decimal((await trendBudget()).usedUsd).minus(before.usedUsd).toFixed(8), '0.00000000');
    delete process.env.OPENAI_API_KEY;
    try {
        const replay = await admitTrendRun('control', actor, new Date(now.getTime() + 86400000), false, requestKey.toUpperCase());
        assert.ok('run' in replay);
        assert.equal(replay.created, false);
        assert.equal(replay.restarted, false);
        assert.equal(replay.run.id, run.id);
        assert.equal(replay.run.date, historical.date);
    } finally { process.env.OPENAI_API_KEY = 'test-unused'; }
    assert.deepEqual(await getTrendExecution(historical.id), historical);
    assert.deepEqual((await getTrendRun(historical.id)).candidates, historicalEvidence);
    await cleanupRun(run.id);
});

test('owner manual runs cannot bypass active or uncertain receipts even without monetary limits', async () => {
    const requestKey = randomUUID();
    const admitted = await admitTrendRun('control', actor, new Date(), false, requestKey);
    assert.ok('run' in admitted);
    const before = await trendBudget();
    await assert.rejects(admitTrendRun('control', actor, new Date(), false, randomUUID()), { code: 'TREND_ACTIVE' });
    await claimTrendSearch(admitted.run.id);
    await claimTrendSearch(admitted.run.id);
    assert.equal((await getTrendExecution(admitted.run.id)).status, 'uncertain');
    await assert.rejects(admitTrendRun('control', actor, new Date(), false, randomUUID()), { code: 'TREND_ACTIVE' });
    const replay = await admitTrendRun('control', actor, new Date(), false, requestKey);
    assert.ok('run' in replay);
    assert.equal(replay.created, false);
    assert.equal(replay.run.status, 'uncertain');
    assert.deepEqual(await trendBudget(), { ...before, pendingCostCount: (before.pendingCostCount ?? 0) + 1 });
    await cleanupRun(admitted.run.id);
    const settled = await trendBudget();
    await isolatedPool.query("UPDATE trend_setting SET monthly_limit_usd=$1 WHERE id='global'", [new Decimal(settled.usedUsd).plus('39.99').toFixed(8)]);
    const freshKey = randomUUID();
    try {
        const next = await admitTrendRun('control', actor, new Date(), false, freshKey);
        assert.ok('run' in next && next.created);
        assert.equal((await isolatedPool.query('SELECT count(*)::int AS count FROM trend_run WHERE manual_request_key=$1', [freshKey])).rows[0].count, 1);
        if ('run' in next) await cleanupRun(next.run.id);
        assert.equal((await trendBudget()).usedUsd, settled.usedUsd);
    } finally { await isolatedPool.query("UPDATE trend_setting SET monthly_limit_usd=150 WHERE id='global'"); }
});

test('owner manual runs use a separate namespace while the daily cron keeps one base run per Warsaw date', async () => {
    const now = day();
    const manual = await admitTrendRun('control', actor, now, false, randomUUID());
    assert.ok('run' in manual);
    const privateState = await getTrendExecution(manual.run.id);
    await cleanupRun(manual.run.id);
    // Seed a certified scheduler for this admission-only test; full control gating is tested separately.
    await isolatedPool.query("UPDATE trend_setting SET enabled=true,last_control_at=now(),control_fingerprint=$1,auto_pause_reason=NULL,auto_pause_token=NULL,auto_pause_reviewed_at=now(),publication_authorized_by=$2 WHERE id='global'", [privateState.configurationFingerprint, actor.id]);
    try {
        const daily = await admitTrendRun('daily', undefined, now);
        assert.ok('run' in daily);
        assert.equal(daily.created, true);
        assert.equal(daily.run.manual, false);
        assert.notEqual(daily.run.id, manual.run.id);
        const repeat = await admitTrendRun('daily', undefined, now);
        assert.ok('run' in repeat);
        assert.equal(repeat.created, false);
        assert.equal(repeat.run.id, daily.run.id);
        const ordinaryControl = await admitTrendRun('control', actor, now);
        assert.ok('run' in ordinaryControl);
        assert.equal(ordinaryControl.run.id, daily.run.id);
        await assert.rejects(admitTrendRun('control', actor, now, false, randomUUID()), { code: 'TREND_ACTIVE' });
        await cleanupRun(daily.run.id);
        const additional = await admitTrendRun('control', actor, now, false, randomUUID());
        assert.ok('run' in additional);
        const lastCron = await admitTrendRun('daily', undefined, now);
        assert.ok('run' in lastCron);
        assert.equal(lastCron.created, false);
        assert.equal(lastCron.run.id, daily.run.id);
        await assert.rejects(isolatedPool.query('UPDATE trend_run SET manual_request_key=NULL WHERE id=$1', [additional.run.id]), { code: '23505' });
        await assert.rejects(isolatedPool.query("UPDATE trend_run SET mode='daily' WHERE id=$1", [additional.run.id]), { code: '23514' });
        await cleanupRun(additional.run.id);
        assert.equal((await isolatedPool.query('SELECT count(*)::int AS count FROM trend_run WHERE date=$1 AND manual_request_key IS NULL', [warsawDate(now)])).rows[0].count, 1);
    } finally { await updateTrendSettings(false, actor); }
});

async function uncitedReceipt(sourceCount = 3) {
    const admitted = await admitTrendRun('control', actor, day(), false, randomUUID());
    assert.ok('run' in admitted);
    const raw = evidence();
    raw.sources = raw.sources.slice(0, sourceCount);
    await claimTrendSearch(admitted.run.id);
    await attachSearchRequest(admitted.run.id, 'mock-reverify-existing-receipt');
    await finishLegacyEmptySearch(admitted.run.id, [raw], [], '0.25', searchDiagnostics({ discoveredCandidates: 1, submittedSources: sourceCount, issueCounts: { uncited_url: sourceCount } }));
    return { run: await getTrendExecution(admitted.run.id), raw };
}
function receiptResearchFetch(raw: RawCandidate, onReceipt?: () => Promise<void>) {
    let receipts = 0;
    let pages = 0;
    const fetcher: typeof fetch = async (input, init) => {
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        assert.equal(method, 'GET', 'Reverification may never create a paid provider request.');
        const url = new URL(String(input instanceof Request ? input.url : input));
        if (url.origin === 'https://api.openai.com') {
            assert.equal(url.pathname, '/v1/responses/mock-reverify-existing-receipt');
            assert.equal(url.searchParams.get('include[]'), 'web_search_call.action.sources');
            receipts++;
            await onReceipt?.();
            const receipt = { ...mockReceipt('gpt-6.1-sol'), output: [
                { id: 'mock-reverify-call', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'fresh cooking leads', sources: raw.sources.map(source => ({ url: source.url })) } },
                { id: 'mock-reverify-message', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ candidates: [raw] }), annotations: [] }] },
            ] };
            return Response.json(receipt);
        }
        const source = raw.sources.find(source => source.url === url.href);
        assert.ok(source);
        assert.equal(init?.credentials, 'omit');
        assert.equal(new Headers(init?.headers).has('authorization'), false);
        pages++;
        return new Response(`<html><head><meta property="article:published_time" content="${source.publishedAt}"></head><main><p>${source.excerpt}</p><p>${source.interestEvidence}</p></main></html>`, { headers: { 'content-type': 'text/html' } });
    };
    return { fetcher, counts: () => ({ receipts, pages }) };
}

test('reverify recovers genuine evidence through GET and preserves settled cost, receipt and append-only history', async () => {
    const { run, raw } = await uncitedReceipt();
    const originalRows = (await isolatedPool.query('SELECT * FROM trend_candidate WHERE run_id=$1', [run.id])).rows;
    const originalSettings = (await getTrendDashboard()).settings;
    const before = await trendBudget();
    const originalFetch = globalThis.fetch;
    const mock = receiptResearchFetch(raw);
    globalThis.fetch = mock.fetcher;
    try {
        const recovered = await reverifyTrendSearch(run.id, actor);
        assert.equal(recovered.resume, true);
        assert.equal(recovered.generation, run.generation + 1);
        assert.equal(recovered.run.status, 'generating');
        assert.equal(recovered.run.manual, true);
        const current = await getTrendExecution(run.id);
        for (const field of ['searchChargedUsd', 'searchReservedUsd', 'searchRequestId', 'searchFinishedAt', 'searchModel', 'date', 'mode', 'manualRequestKey', 'createdAt'] as const) assert.deepEqual(current[field], run[field]);
        assert.ok(current.recipeId);
        assert.equal(new Decimal((await trendBudget()).usedUsd).minus(before.usedUsd).toFixed(8), recipeGenerationReservationUsd());
        const state = await getTrendRun(run.id);
        assert.equal(state.candidates.length, 1);
        assert.equal(state.candidates[0].eligible, true);
        assert.equal(state.candidates[0].selected, true);
        assert.equal(state.candidates[0].sources.length, 3);
        assert.equal(state.run.diagnostics?.reverification?.original?.retrievedUrls, 0);
        assert.equal(state.run.diagnostics?.outcome, 'selected');
        assert.equal(state.run.diagnostics?.discoveryOutcome, 'qualified');
        assert.equal((await isolatedPool.query('SELECT count(*)::int AS count FROM ai_job WHERE trend_run_id=$1', [run.id])).rows[0].count, 0);
        assert.deepEqual((await isolatedPool.query('SELECT * FROM trend_candidate WHERE id=$1', [originalRows[0].id])).rows[0], originalRows[0]);
        assert.equal((await isolatedPool.query('SELECT count(*)::int AS count FROM trend_candidate WHERE run_id=$1', [run.id])).rows[0].count, 2);
        assert.deepEqual((await getTrendDashboard()).settings, originalSettings);
        await assert.rejects(claimTrendSearch(run.id, run.generation), { code: 'TREND_SUPERSEDED' });
        assert.equal((await claimTrendSearch(run.id, recovered.generation)).submit, false);
        const hints = await getTrendResearchHints(new Date(`${run.date}T12:00:00Z`));
        assert.ok(!hints.some(hint => hint.dishKey === raw.dishKey));
        await refreshTrendDiagnostics(run.id, actor);
        assert.equal((await getTrendRun(run.id)).candidates.length, 1);
        assert.equal((await getTrendRun(run.id)).run.diagnostics?.discoveryOutcome, 'qualified');
        assert.equal((await getTrendRun(run.id)).run.diagnostics?.reverification?.generation, recovered.generation);
        assert.equal((await getTrendDashboard()).candidates.filter(candidate => candidate.runId === run.id).length, 1);
        assert.deepEqual(mock.counts(), { receipts: 2, pages: 6 });
    } finally { globalThis.fetch = originalFetch; await cleanupRun(run.id); }
});

test('reverify incomplete evidence selects an honest inspiration once and preserves the original diagnostics', async () => {
    const { run, raw } = await uncitedReceipt(1);
    const before = await trendBudget();
    const settings = (await getTrendDashboard()).settings;
    const originalFetch = globalThis.fetch;
    const mock = receiptResearchFetch(raw);
    globalThis.fetch = mock.fetcher;
    try {
        const recovered = await reverifyTrendSearch(run.id, actor);
        assert.equal(recovered.resume, true);
        assert.equal(recovered.run.status, 'generating');
        assert.ok(recovered.run.recipeId);
        assert.equal(recovered.generation, run.generation + 1);
        const state = await getTrendRun(run.id);
        assert.equal(state.candidates.length, 1);
        assert.equal(state.candidates[0].eligible, false);
        assert.equal(state.candidates[0].selected, true);
        assert.equal(state.run.selectionBasis, 'inspiration');
        assert.equal(state.recipe?.content.recipe.trendConfirmedAt, undefined);
        assert.equal(state.run.diagnostics?.outcome, 'selected');
        assert.equal(state.run.diagnostics?.discoveryOutcome, 'insufficient_evidence');
        assert.deepEqual(state.run.diagnostics?.reverification?.original, run.searchDiagnostics);
        assert.equal(state.run.diagnostics?.reverification?.original?.reverification, undefined);
        await assert.rejects(reverifyTrendSearch(run.id, actor), { code: 'TREND_REVERIFY_UNAVAILABLE' });
        assert.equal(new Decimal((await trendBudget()).usedUsd).minus(before.usedUsd).toFixed(8), recipeGenerationReservationUsd());
        assert.deepEqual((await getTrendDashboard()).settings, settings);
        assert.equal((await isolatedPool.query('SELECT count(*)::int AS count FROM trend_candidate WHERE run_id=$1', [run.id])).rows[0].count, 2);
        assert.deepEqual(mock.counts(), { receipts: 1, pages: 1 });
    } finally { globalThis.fetch = originalFetch; await cleanupRun(run.id); }
});

test('reverify requires a stored owner, a settled terminal receipt and an unchanged generation after GET', async () => {
    const { run, raw } = await uncitedReceipt();
    const originalFetch = globalThis.fetch;
    let gets = 0;
    globalThis.fetch = async () => { gets++; throw new Error('Unauthorized or unsettled recovery must never fetch.'); };
    try {
        await assert.rejects(reverifyTrendSearch(run.id, { ...actor, id: 'test-admin' }), { code: 'OWNER_REQUIRED' });
        await assert.rejects(reverifyTrendSearch(run.id, trendWorker), { code: 'FORBIDDEN' });
        for (const change of ["status='uncertain'", 'search_charged_usd=NULL', 'search_request_id=NULL']) {
            await isolatedPool.query(`UPDATE trend_run SET ${change} WHERE id=$1`, [run.id]);
            await assert.rejects(reverifyTrendSearch(run.id, actor), { code: 'TREND_REVERIFY_UNAVAILABLE' });
            await isolatedPool.query("UPDATE trend_run SET status='no_candidate',search_charged_usd=0.25,search_request_id='mock-reverify-existing-receipt',packet_remaining_usd=0 WHERE id=$1", [run.id]);
        }
        const active = await newRun();
        await assert.rejects(reverifyTrendSearch(run.id, actor), { code: 'TREND_ACTIVE' });
        await cleanupRun(active.id);
        assert.equal(gets, 0);
        const mock = receiptResearchFetch(raw, async () => { await isolatedPool.query('UPDATE trend_run SET generation=generation+1 WHERE id=$1', [run.id]); });
        globalThis.fetch = mock.fetcher;
        await assert.rejects(reverifyTrendSearch(run.id, actor), { code: 'TREND_SUPERSEDED' });
        assert.equal((await getTrendExecution(run.id)).recipeId, null);
        assert.equal((await getTrendExecution(run.id)).searchChargedUsd, run.searchChargedUsd);
        assert.equal((await isolatedPool.query('SELECT count(*)::int AS count FROM trend_candidate WHERE run_id=$1', [run.id])).rows[0].count, 1);
    } finally { globalThis.fetch = originalFetch; }
});

test('reverify prepares qualified text while optional photo storage is unavailable', async () => {
    const originalFetch = globalThis.fetch;
    try {
        for (const unavailable of ['storage']) {
            const { run, raw } = await uncitedReceipt();
            const before = await trendBudget();
            const mock = receiptResearchFetch(raw);
            globalThis.fetch = mock.fetcher;
            if (unavailable === 'storage') delete process.env.BLOB_READ_WRITE_TOKEN;
            else await isolatedPool.query("UPDATE trend_setting SET monthly_limit_usd=$1 WHERE id='global'", [new Decimal(before.usedUsd).plus(1).toFixed(8)]);
            const recovered = await reverifyTrendSearch(run.id, actor);
            assert.equal(recovered.resume, true);
            assert.equal(recovered.run.status, 'generating');
            assert.ok(recovered.run.recipeId);
            assert.equal((await trendBudget()).usedUsd, before.usedUsd);
            assert.equal((await getTrendRun(run.id)).candidates[0].eligible, true);
            process.env.BLOB_READ_WRITE_TOKEN = 'test-unused';
            await isolatedPool.query("UPDATE trend_setting SET monthly_limit_usd=150 WHERE id='global'");
            assert.deepEqual(mock.counts(), { receipts: 1, pages: 3 });
            await cleanupRun(run.id);
        }
    } finally { globalThis.fetch = originalFetch; process.env.BLOB_READ_WRITE_TOKEN = 'test-unused'; await isolatedPool.query("UPDATE trend_setting SET monthly_limit_usd=150 WHERE id='global'"); }
});

test('historical completed search receipts remain recoverable without a monetary month boundary', async () => {
    const { run, raw } = await uncitedReceipt(1);
    await isolatedPool.query("UPDATE trend_run SET created_at='2000-01-01T00:00:00Z' WHERE id=$1", [run.id]);
    const original = await getTrendExecution(run.id); const originalFetch = globalThis.fetch;
    const mock = receiptResearchFetch(raw); globalThis.fetch = mock.fetcher;
    try {
        const recovered = await reverifyTrendSearch(run.id, actor);
        assert.equal(recovered.resume, true); assert.ok(recovered.run.recipeId);
        const current = await getTrendExecution(run.id);
        assert.equal(current.generation, original.generation + 1);
        assert.equal(current.searchChargedUsd, original.searchChargedUsd);
        assert.equal(current.searchRequestId, original.searchRequestId);
        assert.equal(current.createdAt.toISOString(), original.createdAt.toISOString());
        assert.equal(current.packetRemainingUsd, '0.00000000');
        assert.deepEqual(mock.counts(), { receipts: 1, pages: 1 });
    } finally { globalThis.fetch = originalFetch; await cleanupRun(run.id); }
});

async function inspirationLead() {
    const { run, raw } = await uncitedReceipt(1);
    const originalFetch = globalThis.fetch;
    const mock = receiptResearchFetch(raw);
    globalThis.fetch = mock.fetcher;
    try {
        const result = await pollTrendSearch(searchModelForRun(run), run.searchRequestId!);
        assert(result.done);
        await finishLegacyEmptySearch(run.id, result.candidates, result.allowedUrls, run.searchChargedUsd!, { ...result.diagnostics, reverification: { generation: 2, at: new Date().toISOString(), original: run.searchDiagnostics } }, 2);
    } finally { globalThis.fetch = originalFetch; }
    const state = await getTrendRun(run.id);
    assert.equal(state.run.status, 'no_candidate');
    assert.equal(state.candidates.length, 1);
    assert.equal(state.candidates[0].eligible, false);
    assert.equal(state.candidates[0].sources.length, 1);
    return { execution: await getTrendExecution(run.id), candidate: state.candidates[0] };
}

test('inspiration owner choice is atomic, replayable and preserves failed trend evidence, search bill and history', async () => {
    const { execution, candidate } = await inspirationLead();
    const before = await trendBudget();
    const rows = (await isolatedPool.query('SELECT * FROM trend_candidate WHERE run_id=$1', [execution.id])).rows;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('Inspiration admission may not call providers.'); };
    try {
        const admitted = await Promise.all([prepareTrendInspiration(execution.id, candidate.id, actor), prepareTrendInspiration(execution.id, candidate.id, actor)]);
        assert.equal(admitted.filter(result => result.resume).length, 1);
        assert.equal(admitted.filter(result => !result.resume).length, 1);
        assert.equal(admitted[0].generation, execution.generation + 1);
        assert.equal(admitted[1].generation, admitted[0].generation);
        const current = await getTrendExecution(execution.id);
        for (const field of ['searchChargedUsd', 'searchReservedUsd', 'searchRequestId', 'searchFinishedAt', 'searchModel', 'date', 'mode', 'manualRequestKey', 'createdAt', 'searchDiagnostics', 'sources'] as const) assert.deepEqual(current[field], execution[field]);
        assert.equal(new Decimal((await trendBudget()).usedUsd).minus(before.usedUsd).toFixed(8), recipeGenerationReservationUsd());
        const state = await getTrendRun(execution.id);
        assert.equal(state.run.selectionBasis, 'editor');
        assert.equal(state.candidates.length, 1);
        const chosen = state.candidates[0];
        assert.deepEqual({ ...chosen, selected: candidate.selected, editorChoice: undefined }, { ...candidate, editorChoice: undefined });
        assert.equal(chosen.editorChoice?.by, actor.id);
        assert.ok(Number.isFinite(Date.parse(chosen.editorChoice!.at)));
        assert.equal(chosen.eligible, false);
        assert.equal(state.recipe?.content.recipe.collection, 'trends');
        assert.equal(state.recipe?.content.recipe.trendConfirmedAt, undefined);
        assert.equal(state.recipe?.publicationStatus, 'never_published');
        assert.ok(state.recipe?.content.originalText.includes('nie spełnia kryteriów potwierdzonego trendu'));
        assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM editorial_recipe WHERE id=$1', [current.recipeId])).rows[0].count, 1);
        assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM ai_job WHERE trend_run_id=$1', [execution.id])).rows[0].count, 0);
        const old = rows.find(row => row.id !== candidate.id)!;
        assert.deepEqual((await isolatedPool.query('SELECT * FROM trend_candidate WHERE id=$1', [old.id])).rows[0], old);
        await assert.rejects(claimTrendSearch(execution.id, execution.generation), { code: 'TREND_SUPERSEDED' });
        assert.equal((await claimTrendSearch(execution.id, current.generation)).submit, false);
        const replayed = await actOnTrendRun(execution.id, { action: 'prepare_inspiration', candidateId: candidate.id }, actor);
        assert.equal(replayed.resume, false);
        assert.equal(replayed.run.recipeId, current.recipeId);
    } finally { globalThis.fetch = originalFetch; await cleanupRun(execution.id); }
});

test('inspiration rejects unauthorized, empty, stale, unsettled, duplicate, busy and unconfigured selections without paid calls', async () => {
    const { execution, candidate } = await inspirationLead();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('Denied inspiration may not call providers.'); };
    try {
        await assert.rejects(prepareTrendInspiration(execution.id, candidate.id, { ...actor, id: 'test-admin', role: 'owner' }), { code: 'OWNER_REQUIRED' });
        await assert.rejects(prepareTrendInspiration(execution.id, candidate.id, trendWorker), { code: 'FORBIDDEN' });
        await assert.rejects(actOnTrendRun(execution.id, { action: 'prepare_inspiration' }, actor), { code: 'TREND_CANDIDATE_REQUIRED' });
        await assert.rejects(prepareTrendInspiration(execution.id, `${execution.id}-0`, actor), { code: 'TREND_INSPIRATION_UNAVAILABLE' });
        const candidateCases = [
            { change: { sources: [] }, code: 'TREND_INSPIRATION_SOURCE_REQUIRED' },
            { change: { sources: [{ ...candidate.sources[0], url: 'http://localhost/test' }] }, code: 'TREND_INSPIRATION_SOURCE_REQUIRED' },
            { change: { ambiguous: true }, code: 'TREND_INSPIRATION_UNAVAILABLE' },
            { change: { duplicateRecipeId: 'other-recipe' }, code: 'TREND_INSPIRATION_UNAVAILABLE' },
            { change: { eligible: true }, code: 'TREND_INSPIRATION_UNAVAILABLE' },
        ];
        for (const { change, code } of candidateCases) {
            await isolatedPool.query('UPDATE trend_candidate SET data=$1 WHERE id=$2', [{ ...candidate, ...change }, candidate.id]);
            await assert.rejects(prepareTrendInspiration(execution.id, candidate.id, actor), { code });
        }
        await isolatedPool.query('UPDATE trend_candidate SET data=$1 WHERE id=$2', [candidate, candidate.id]);
        for (const [change, code] of [
            ['manual_request_key=NULL', 'TREND_INSPIRATION_UNAVAILABLE'],
            ["status='uncertain'", 'TREND_REVERIFY_UNAVAILABLE'],
            ['search_charged_usd=NULL', 'TREND_REVERIFY_UNAVAILABLE'],
            ['search_request_id=NULL', 'TREND_REVERIFY_UNAVAILABLE'],
            ['search_finished_at=NULL', 'TREND_REVERIFY_UNAVAILABLE'],
            ]) {
            await isolatedPool.query(`UPDATE trend_run SET ${change} WHERE id=$1`, [execution.id]);
            await assert.rejects(prepareTrendInspiration(execution.id, candidate.id, actor), { code });
            await isolatedPool.query("UPDATE trend_run SET manual_request_key=$2,status='no_candidate',search_charged_usd=$3,search_request_id=$4,search_finished_at=$5,created_at=$6 WHERE id=$1", [execution.id, execution.manualRequestKey, execution.searchChargedUsd, execution.searchRequestId, execution.searchFinishedAt, execution.createdAt]);
        }
        delete process.env.OPENAI_API_KEY;
        await assert.rejects(prepareTrendInspiration(execution.id, candidate.id, actor), { code: 'TREND_NOT_CONFIGURED' });
        process.env.OPENAI_API_KEY = 'test-unused';
        assert.equal((await getTrendRun(execution.id)).candidates[0].editorChoice, undefined);
        assert.equal((await getTrendExecution(execution.id)).recipeId, null);
        const busy = await newRun();
        await assert.rejects(prepareTrendInspiration(execution.id, candidate.id, actor), { code: 'TREND_ACTIVE' });
        await claimTrendSearch(busy.id);
        await actOnTrendRun(busy.id, { action: 'pause' }, actor);
        await assert.rejects(prepareTrendInspiration(execution.id, candidate.id, actor), { code: 'TREND_UNCERTAIN' });
        await cleanupRun(busy.id);
        const duplicate = await createRecipe({ title: candidate.title.pl, originalText: 'Owner draft' }, actor);
        await assert.rejects(prepareTrendInspiration(execution.id, candidate.id, actor), { code: 'TREND_DUPLICATE' });
        await isolatedPool.query("UPDATE editorial_recipe SET editorial_status='archived' WHERE id=$1", [duplicate.id]);
        assert.deepEqual(await getTrendExecution(execution.id), execution);
        assert.deepEqual((await getTrendRun(execution.id)).candidates[0], candidate);
    } finally { globalThis.fetch = originalFetch; process.env.OPENAI_API_KEY = 'test-unused'; await isolatedPool.query("UPDATE trend_setting SET monthly_limit_usd=150 WHERE id='global'"); }
});

test('inspiration resumes with honest metadata, reports completed photos before batch apply and never certifies radar control', async () => {
    const { execution, candidate } = await inspirationLead();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('Mocked inspiration completion must never call providers.'); };
    const settingsBefore = (await isolatedPool.query("SELECT * FROM trend_setting WHERE id='global'")).rows[0];
    try {
        const admitted = await prepareTrendInspiration(execution.id, candidate.id, actor);
        await actOnTrendRun(execution.id, { action: 'pause' }, actor);
        assert.equal((await prepareTrendInspiration(execution.id, candidate.id, actor)).resume, false);
        const resumed = await actOnTrendRun(execution.id, { action: 'resume' }, actor);
        assert.equal(resumed.resume, true);
        assert.equal((await getTrendExecution(execution.id)).generation, admitted.generation + 1);
        const text = await readyText(execution.id);
        await applyTrendBatch(execution.id, [text.id]);
        const recipe = (await getTrendRun(execution.id)).recipe!;
        assert.equal(recipe.content.recipe.collection, 'trends');
        assert.equal(recipe.content.recipe.trendConfirmedAt, undefined);
        const targets = await reserveTrendPhotos(execution.id);
        const hero = await readyPhoto(execution.id, 'hero');
        assert.equal((await getTrendRun(execution.id)).run.photos.ready, 0);
        assert.equal((await getTrendRun(execution.id)).run.photos.generated, 1);
        await applyTrendBatch(execution.id, [hero.id]);
        const ids: string[] = [];
        for (const ingredient of targets.ingredients) ids.push((await readyPhoto(execution.id, 'ingredient', ingredient)).id);
        for (const step of targets.steps) ids.push((await readyPhoto(execution.id, 'step', step)).id);
        const pending = (await getTrendRun(execution.id)).run.photos;
        assert.equal(pending.ready, 1);
        assert.equal(pending.generated, pending.total);
        assert.equal(pending.total, 1 + ids.length);
        // Receipt-only replay and already applied hero cannot double count photographic slots.
        await trendJob(execution.id, 'hero');
        assert.deepEqual((await getTrendRun(execution.id)).run.photos, pending);
        await applyTrendBatch(execution.id, ids);
        await isolatedPool.query("UPDATE trend_setting SET enabled=false,last_control_at=NULL,control_fingerprint=NULL WHERE id='global'");
        // The explicit editor choice must prevent certification even if eligibility is later malformed.
        await isolatedPool.query("UPDATE trend_candidate SET data=jsonb_set(data,'{eligible}','true'::jsonb) WHERE id=$1", [candidate.id]);
        const beforeCompletion = (await isolatedPool.query("SELECT * FROM trend_setting WHERE id='global'")).rows[0];
        await completeTrendRun(execution.id);
        assert.deepEqual((await isolatedPool.query("SELECT * FROM trend_setting WHERE id='global'")).rows[0], beforeCompletion);
        await isolatedPool.query("UPDATE trend_candidate SET data=jsonb_set(data,'{eligible}','false'::jsonb) WHERE id=$1", [candidate.id]);
        const state = await getTrendRun(execution.id);
        assert.equal(state.run.status, 'awaiting_review');
        assert.equal(state.run.selectionBasis, 'editor');
        assert.equal(state.candidates[0].eligible, false);
        assert.equal(state.candidates[0].rejectionReason, candidate.rejectionReason);
        assert.equal(state.run.photos.ready, state.run.photos.total);
        assert.equal(state.run.photos.generated, state.run.photos.total);
        assert.equal(state.recipe?.content.recipe.trendConfirmedAt, undefined);
        assert.equal(state.recipe?.content.recipe.substitutions?.[0].status, 'to_review');
        assert.equal((await updateTrendSettings(true, actor)).enabled, true);
        await updateTrendSettings(false, actor);
        await assert.rejects(actOnTrendRun(execution.id, { action: 'approve_and_publish', expectedRevision: state.recipe!.revision, checks: { ...checks, en: false } }, actor), { code: 'REVIEW_REQUIRED' });
        const published = await actOnTrendRun(execution.id, { action: 'approve_and_publish', expectedRevision: state.recipe!.revision, checks }, actor);
        assert.equal(published.run.status, 'published');
        for (const locale of ['pl', 'en'] as const) {
            const publicRecipe = await getPublishedRecipe(published.recipe!.content.recipe.slug[locale], locale);
            assert.equal(publicRecipe?.collection, 'trends');
            assert.equal(publicRecipe?.trendConfirmedAt, undefined);
            assert.equal(publicRecipe?.substitutions?.[0].status, 'approved');
        }
        assert.equal((await prepareTrendInspiration(execution.id, candidate.id, actor)).resume, false);
        assert.equal((await getTrendExecution(execution.id)).searchChargedUsd, execution.searchChargedUsd);
    } finally {
        globalThis.fetch = originalFetch;
        await isolatedPool.query("UPDATE trend_setting SET enabled=$1,last_control_at=$2,control_fingerprint=$3 WHERE id='global'", [settingsBefore.enabled, settingsBefore.last_control_at, settingsBefore.control_fingerprint]);
        await cleanupRun(execution.id);
    }
});

test('zero-reservation trend photo jobs share an existing product producer and reusable photographs', async () => {
    // Seed an already verified paper catalogue image, preserving the free-reuse scenario.
    const catalogueDraft = await createRecipe({ title: `Catalogue flour ${randomUUID()}`, originalText: 'Offline catalogue fixture.' }, actor);
    const catalogueContent = proposal(catalogueDraft.id);
    catalogueContent.recipe.ingredients = [{ ...catalogueContent.recipe.ingredients[0], name: { pl: 'Mąka pszenna', en: 'All-purpose flour' }, note: undefined }];
    catalogueContent.recipe.substitutions = [];
    catalogueContent.recipe.title = { pl: `Mąka ${catalogueDraft.id}`, en: `Flour ${catalogueDraft.id}` };
    const catalogueIngredient = catalogueContent.recipe.ingredients[0];
    catalogueContent.recipe.steps = [{ id: 'catalogue-step', title: { pl: 'Odmierz składnik', en: 'Measure the ingredient' }, text: { pl: `Odmierz {{${catalogueIngredient.id}}} składnika.`, en: `Measure {{${catalogueIngredient.id}}} of the ingredient.` } }];
    catalogueContent.recipe.image = ''; // This product catalogue fixture has no finished-dish photograph.
    delete catalogueContent.recipe.heroPresentation;
    const catalogueRecipe = await saveRecipe(catalogueDraft.id, { expectedRevision: catalogueDraft.revision, content: catalogueContent }, actor);
    await approveRecipeContent(catalogueRecipe.id, catalogueRecipe.revision, actor);
    const catalogueJob = (await createJobAdmission({ recipeId: catalogueRecipe.id, expectedRevision: catalogueRecipe.revision, kind: 'ingredient', targetId: catalogueContent.recipe.ingredients[0].id, brief: 'Offline opaque paper product photograph.', requestKey: randomUUID() }, actor)).job;
    if (catalogueJob.status !== 'ready') {
        await claimSubmission(catalogueJob.id);
        await attachProviderRequest(catalogueJob.id, `mock-flour-${catalogueJob.id}`);
        await finishAsset(catalogueJob.id, { blobPathname: `test/${catalogueJob.id}.webp`, width: 1024, height: 1024, contentType: 'image/webp', alt: { pl: 'Mąka pszenna', en: 'All-purpose flour' }, caption: { pl: '', en: '' }, hasTransparency: false, styleProfile: currentIngredientStyleProfile }, { chargedUsd: '0.1', costBasis: 'usage' });
    }
    const run = await drafted();
    try {
        const { job } = await trendJob(run.id, 'recipe');
        const content = proposal(job.recipeId);
        const original = content.recipe.ingredients[0];
        content.recipe.ingredients = [
            { ...original, name: { pl: 'Brokuł', en: 'Broccoli' }, note: undefined },
            { ...original, id: `${original.id}-second`, name: { pl: 'Świeży brokuł', en: 'Fresh broccoli' }, note: undefined },
            { ...original, id: `${original.id}-flour`, name: { pl: 'Mąka pszenna', en: 'All-purpose flour' }, note: undefined },
        ];
        // This fixture changes the ingredient inventory to exercise image reuse.
        // Keep its method coherent too: the original pasta steps reference butter.
        content.recipe.steps = [{ id: 'measure-products', title: { pl: 'Odmierz produkty', en: 'Measure the ingredients' }, text: {
            pl: `Odmierz {{${original.id}}} pierwszej porcji brokułu, {{${original.id}-second}} drugiej porcji brokułu i {{${original.id}-flour}} mąki do osobnych miseczek. Produkty są gotowe do dalszej pracy po odmierzeniu wszystkich trzech porcji.`,
            en: `Measure {{${original.id}}} of the first broccoli portion, {{${original.id}-second}} of the second broccoli portion and {{${original.id}-flour}} of flour into separate bowls. The ingredients are ready for the next task when all three portions have been measured.`,
        } }];
        await claimSubmission(job.id);
        await attachProviderRequest(job.id, `mock-text-${job.id}`);
        await finishRecipe(job.id, content, { chargedUsd: '0.2', costBasis: 'usage' });
        await applyTrendBatch(run.id, [job.id]);
        await reserveTrendPhotos(run.id);
        assert.equal((await getTrendExecution(run.id)).packetRemainingUsd, '0.00000000');
        const producer = (await trendJob(run.id, 'ingredient', original.id)).job;
        const follower = (await trendJob(run.id, 'ingredient', `${original.id}-second`)).job;
        const available = (await trendJob(run.id, 'ingredient', `${original.id}-flour`)).job;
        assert.equal(producer.reservedUsd, '0.00000000');
        assert.equal(follower.reservedUsd, '0.00000000');
        assert.equal(follower.reuseSourceJobId, producer.id);
        assert.equal(available.status, 'ready');
        assert.equal(available.reservedUsd, '0.00000000');
        assert.equal((await claimSubmission(follower.id)).shouldSubmit, false);
        await reserveTrendPhotos(run.id);
        assert.equal((await getTrendExecution(run.id)).packetRemainingUsd, '0.00000000');
        await claimSubmission(producer.id);
        await attachProviderRequest(producer.id, `mock-broccoli-${producer.id}`);
        await finishAsset(producer.id, { blobPathname: `test/${producer.id}.webp`, width: 1024, height: 1024, contentType: 'image/webp', alt: { pl: 'Brokuł', en: 'Broccoli' }, caption: { pl: '', en: '' }, hasTransparency: false, styleProfile: currentIngredientStyleProfile }, { chargedUsd: '0.1', costBasis: 'usage' });
        assert.equal(await resolveIngredientReuse(follower.id), true);
        assert.equal((await getJob(follower.id)).chargedUsd, '0.00000000');
        await applyTrendBatch(run.id, [producer.id, follower.id, available.id]);
        const applied = await getRecipe(job.recipeId);
        assert.equal(applied.content.photos.ingredients[original.id].src, applied.content.photos.ingredients[`${original.id}-second`].src);
    } finally { await cleanupRun(run.id); }
});

test('duplicate search leads select a distinct seasonal recipe instead of regenerating the existing dish', async () => {
    const original = await createRecipe({ title: `Istniejąca potrawa ${randomUUID()}`, originalText: 'Existing owner recipe.' }, actor);
    const run = await newRun();
    try {
        await claimTrendSearch(run.id);
        const raw = evidence();
        raw.title = original.content.recipe.title;
        await finishTrendSearch(run.id, [raw], raw.sources.map(source => source.url), '0.25', [], 1, searchDiagnostics({ discoveredCandidates: 1, submittedSources: 3, verifiedSources: 3 }));
        const state = await getTrendRun(run.id);
        assert.equal(state.run.selectionBasis, 'seasonal');
        assert.ok(state.run.recipeId);
        assert.notEqual(state.run.recipeId, original.id);
        assert.notDeepEqual(state.run.selectedTitle, original.content.recipe.title);
        assert.equal(state.candidates.filter(candidate => candidate.selected).length, 1);
        assert.equal(state.candidates.find(candidate => candidate.dishKey === raw.dishKey.replaceAll('-', ' '))?.duplicateRecipeId, original.id);
        assert.equal(state.recipe?.content.recipe.trendConfirmedAt, undefined);
    } finally { await cleanupRun(run.id); }
});

test('blocked source pages still produce an honest recipe inspiration with no verified popularity claim', async () => {
    const run = await newRun();
    try {
        await claimTrendSearch(run.id);
        const raw = evidence();
        raw.research = { foundSources: 1, verifiedSources: 0, issues: [{ url: raw.sources[0].url, platform: 'instagram', reason: 'unavailable' }] };
        raw.sources = [];
        await finishTrendSearch(run.id, [raw], [], '0.25', ['instagram'], 1, searchDiagnostics({ discoveredCandidates: 1, submittedSources: 1, issueCounts: { unavailable: 1 } }));
        const state = await getTrendRun(run.id);
        assert.equal(state.run.status, 'generating');
        assert.equal(state.run.selectionBasis, 'inspiration');
        assert.deepEqual(state.run.selectedTitle, raw.title);
        assert.equal(state.run.sources.instagram.status, 'unavailable');
        assert.equal(state.run.sources.instagram.count, 0);
        assert.equal(state.run.diagnostics?.discoveryOutcome, 'unverified_sources');
        assert.equal(state.candidates[0].eligible, false);
        assert.deepEqual(state.candidates[0].sources, []);
        assert.deepEqual(state.recipe?.content.sources, []);
        assert.equal(state.recipe?.content.recipe.trendConfirmedAt, undefined);
        assert(state.recipe?.content.originalText.includes('nie potwierdzono aktualnej popularności'));
    } finally { await cleanupRun(run.id); }
});

test('racing empty search completions and replay persist exactly one selected candidate and one draft', async () => {
    const run = await newRun();
    try {
        await claimTrendSearch(run.id);
        const completed = await Promise.all([finishTrendSearch(run.id, [], [], '0.25', [], 1, searchDiagnostics()), finishTrendSearch(run.id, [], [], '0.25', [], 1, searchDiagnostics())]);
        assert.ok(completed[0]);
        assert.equal(completed[0], completed[1]);
        const state = await getTrendRun(run.id);
        const budget = await trendBudget();
        assert.equal(state.candidates.filter(candidate => candidate.selected).length, 1);
        assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM trend_candidate WHERE run_id=$1', [run.id])).rows[0].count, 1);
        assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM editorial_recipe WHERE id=$1', [state.run.recipeId])).rows[0].count, 1);
        assert.equal(await finishTrendSearch(run.id, [], [], '0.25'), completed[0]);
        assert.deepEqual(await trendBudget(), budget);
        assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM ai_job WHERE trend_run_id=$1', [run.id])).rows[0].count, 0);
    } finally { await cleanupRun(run.id); }
});

test('complete automatic research and seasonal inspirations certify control without claiming current popularity', async () => {
    for (const basis of ['research', 'seasonal'] as const) {
        await isolatedPool.query("UPDATE trend_setting SET enabled=false,last_control_at=NULL,control_fingerprint=NULL WHERE id='global'");
        const run = await newRun();
        try {
            await claimTrendSearch(run.id);
            const raw = evidence();
            raw.sources = raw.sources.slice(0, 1);
            await finishTrendSearch(run.id, basis === 'research' ? [raw] : [], raw.sources.map(source => source.url), '0.25');
            const finished = await complete(undefined, run.id);
            assert.equal(finished.run.status, 'awaiting_review');
            assert.equal(finished.run.selectionBasis, basis === 'research' ? 'inspiration' : 'seasonal');
            assert.equal(finished.candidates.find(candidate => candidate.selected)?.automaticSelection?.basis, basis);
            assert.equal(finished.recipe?.content.recipe.trendConfirmedAt, undefined);
            assert.equal((await getTrendDashboard()).configuration.controlRequired, false);
            await updateTrendSettings(true, actor);
            await updateTrendSettings(false, actor);
        } finally { await cleanupRun(run.id); }
    }
});

test('known search failure selects a seasonal recipe once while preserving the settled bill', async () => {
    const run = await newRun();
    try {
        await claimTrendSearch(run.id);
        await attachSearchRequest(run.id, 'mock-known-terminal');
        assert.equal(await finishTrendSearchFailure(run.id, '0.013', false, 1), true);
        const state = await getTrendRun(run.id);
        assert.equal(state.run.status, 'generating');
        assert.equal(state.run.selectionBasis, 'seasonal');
        assert.ok(state.run.recipeId);
        assert.equal(state.run.settledUsd, '0.01300000');
        assert.equal(state.run.reservedUsd, recipeGenerationReservationUsd());
        assert.equal(state.candidates.filter(candidate => candidate.selected).length, 1);
        assert.equal(state.recipe?.content.recipe.trendConfirmedAt, undefined);
        const snapshot = await getTrendExecution(run.id);
        const budget = await trendBudget();
        assert.equal(await finishTrendSearchFailure(run.id, '9', false, 1), true);
        assert.deepEqual(await getTrendExecution(run.id), snapshot);
        assert.deepEqual(await trendBudget(), budget);
        assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM ai_job WHERE trend_run_id=$1', [run.id])).rows[0].count, 0);
    } finally { await cleanupRun(run.id); }
});

test('unknown search acceptance saves a selected recipe draft but reports its unknown search bill and admits no generation', async () => {
    const run = await newRun();
    try {
        await claimTrendSearch(run.id);
        assert.equal(await finishTrendSearchFailure(run.id, null, true, 1), false);
        const execution = await getTrendExecution(run.id);
        assert.equal(execution.status, 'uncertain');
        assert.ok(execution.recipeId);
        assert.ok(execution.candidateId);
        assert.equal(execution.searchChargedUsd, null);
        assert.equal(execution.searchFinishedAt, null);
        assert.equal(execution.searchReservedUsd, '0.00000000');
        assert.equal(execution.packetRemainingUsd, '0.00000000');
        const state = await getTrendRun(run.id);
        assert.equal(state.candidates.filter(candidate => candidate.selected).length, 1);
        assert.equal(state.recipe?.content.recipe.trendConfirmedAt, undefined);
        await assert.rejects(trendJob(run.id, 'recipe'), { code: 'TREND_PAUSED' });
        assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM ai_job WHERE trend_run_id=$1', [run.id])).rows[0].count, 0);
        assert.equal(await finishTrendSearchFailure(run.id, '0', false, 1), false);
        assert.deepEqual(await getTrendExecution(run.id), execution);
    } finally { await cleanupRun(run.id); }
});

test('search failure fallback fences obsolete generations and cannot revive a rejected run', async () => {
    const run = await newRun();
    try {
        await claimTrendSearch(run.id);
        const snapshot = await getTrendExecution(run.id);
        assert.equal(await finishTrendSearchFailure(run.id, '0.013', false, 2), false);
        assert.deepEqual(await getTrendExecution(run.id), snapshot);
        await actOnTrendRun(run.id, { action: 'reject' }, actor);
        assert.equal(await finishTrendSearchFailure(run.id, '0.013', false, 1), false);
        const rejected = await getTrendRun(run.id);
        assert.equal(rejected.run.status, 'rejected');
        assert.equal(rejected.run.recipeId, null);
        assert.equal(rejected.run.settledUsd, '0.01300000');
        assert.deepEqual(rejected.candidates, []);
    } finally { await cleanupRun(run.id); }
});

test('polling refusals and malformed search receipts select a seasonal recipe through GET without another paid request', async () => {
    const originalFetch = globalThis.fetch;
    try {
        for (const scenario of ['refusal', 'invalid'] as const) {
            const run = await newRun();
            try {
                await claimTrendSearch(run.id);
                await attachSearchRequest(run.id, 'mock-terminal-receipt');
                let gets = 0;
                globalThis.fetch = async (input, init) => {
                    assert.equal(init?.method ?? (input instanceof Request ? input.method : 'GET'), 'GET');
                    assert.equal(new URL(String(input instanceof Request ? input.url : input)).pathname, '/v1/responses/mock-terminal-receipt');
                    gets++;
                    const receipt = mockReceipt('gpt-6.1-sol');
                    const content = scenario === 'refusal' ? [{ type: 'refusal', refusal: 'No usable result.' }] : [{ type: 'output_text', text: 'invalid json', annotations: [] }];
                    return Response.json({ ...receipt, output: [receipt.output[0], { ...receipt.output[1], content }] });
                };
                assert.equal(await pollRadar(run.id, 1), true);
                const state = await getTrendRun(run.id);
                assert.equal(state.run.status, 'generating');
                assert.equal(state.run.selectionBasis, 'seasonal');
                assert.ok(state.run.recipeId);
                assert.equal(state.run.settledUsd, '0.01300000');
                assert.equal(state.candidates.filter(candidate => candidate.selected).length, 1);
                assert.equal(await pollRadar(run.id, 1), true);
                assert.equal(gets, 1);
                assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM ai_job WHERE trend_run_id=$1', [run.id])).rows[0].count, 0);
            } finally { await cleanupRun(run.id); }
        }
    } finally { globalThis.fetch = originalFetch; }
});

test('submission replay after a lost acceptance picks an uncertain recipe without repeating the paid POST', async () => {
    const run = await newRun();
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => { requests++; throw new Error('Replayed submission must never contact a provider.'); };
    try {
        assert.equal((await claimTrendSearch(run.id, 1)).submit, true);
        assert.equal(await submitRadar(run.id, 1), false);
        const execution = await getTrendExecution(run.id);
        assert.equal(execution.status, 'uncertain');
        assert.ok(execution.recipeId);
        assert.ok(execution.candidateId);
        assert.equal(execution.searchRequestId, null);
        assert.equal(execution.searchChargedUsd, null);
        assert.equal(execution.searchReservedUsd, '0.00000000');
        assert.equal((await getTrendRun(run.id)).candidates.filter(candidate => candidate.selected).length, 1);
        assert.equal(await submitRadar(run.id, 1), false);
        assert.deepEqual(await getTrendExecution(run.id), execution);
        assert.equal(requests, 0);
        assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM ai_job WHERE trend_run_id=$1', [run.id])).rows[0].count, 0);
    } finally { globalThis.fetch = originalFetch; await cleanupRun(run.id); }
});

test('a late search receipt settles uncertainty without replacing its chosen recipe or selecting a second dish', async () => {
    const run = await newRun();
    try {
        await claimTrendSearch(run.id, 1);
        await finishTrendSearchFailure(run.id, null, true, 1);
        const original = await getTrendRun(run.id);
        await attachSearchRequest(run.id, 'mock-late-confirmed-receipt', 1);
        const raw = evidence();
        assert.equal(await finishTrendSearch(run.id, [raw], raw.sources.map(source => source.url), '0.013', [], 1, searchDiagnostics({ discoveredCandidates: 1, submittedSources: 3, verifiedSources: 3 })), original.run.recipeId);
        const execution = await getTrendExecution(run.id);
        const current = await getTrendRun(run.id);
        assert.equal(execution.status, 'uncertain');
        assert.equal(execution.recipeId, original.run.recipeId);
        assert.equal(execution.candidateId, original.run.candidateId);
        assert.equal(execution.searchRequestId, 'mock-late-confirmed-receipt');
        assert.equal(execution.searchChargedUsd, '0.01300000');
        assert.ok(execution.searchFinishedAt);
        assert.equal(current.candidates.filter(candidate => candidate.selected).length, 1);
        assert.equal(current.candidates.length, 2);
        assert.equal(current.candidates.find(candidate => candidate.id === original.run.candidateId)?.selected, true);
        assert.equal(current.candidates.find(candidate => candidate.id !== original.run.candidateId)?.selected, false);
        assert.deepEqual(current.recipe, original.recipe);
        const budget = await trendBudget();
        assert.equal(await finishTrendSearch(run.id, [raw], raw.sources.map(source => source.url), '0.013', [], 1), original.run.recipeId);
        assert.deepEqual(await trendBudget(), budget);
        assert.equal((await getTrendRun(run.id)).candidates.length, 2);
        assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM ai_job WHERE trend_run_id=$1', [run.id])).rows[0].count, 0);
    } finally { await cleanupRun(run.id); }
});

test('a late confirmed search failure settles its existing bill while preserving the uncertain selected draft', async () => {
    const run = await newRun();
    try {
        await claimTrendSearch(run.id, 1);
        await finishTrendSearchFailure(run.id, null, true, 1);
        await attachSearchRequest(run.id, 'mock-late-terminal', 1);
        const original = await getTrendRun(run.id);
        assert.equal(await finishTrendSearchFailure(run.id, '0.013', false, 1), false);
        const current = await getTrendRun(run.id);
        const execution = await getTrendExecution(run.id);
        assert.equal(current.run.status, 'uncertain');
        assert.equal(current.run.recipeId, original.run.recipeId);
        assert.equal(current.run.candidateId, original.run.candidateId);
        assert.equal(execution.searchChargedUsd, '0.01300000');
        assert.ok(execution.searchFinishedAt);
        assert.deepEqual(current.recipe, original.recipe);
        assert.deepEqual(current.candidates, original.candidates);
        assert.equal(current.run.reservedUsd, '0.00000000');
        assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM ai_job WHERE trend_run_id=$1', [run.id])).rows[0].count, 0);
    } finally { await cleanupRun(run.id); }
});

test('an exhausted seasonal reserve reuses one catalogue recipe and cannot dispatch text after pause and resume', async () => {
    const ids: string[] = [];
    let runId: string | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('Catalogue selection may not contact providers.'); };
    try {
        const fixture = seasonalRecipeIdeas().map(idea => {
            const id = randomUUID();
            const content = proposal(id);
            content.recipe.title = idea.title;
            content.originalText = 'Existing recipe fixture for exhausted reserve.';
            ids.push(id);
            return { id, content, content_hash: contentHash(content) };
        });
        await isolatedPool.query('INSERT INTO editorial_recipe(id,content,content_hash,checks,created_by,updated_by,updated_by_name) SELECT id,content,content_hash,$2::jsonb,$3,$3,$4 FROM jsonb_to_recordset($1::jsonb) AS fixture(id text,content jsonb,content_hash text)', [JSON.stringify(fixture), emptyChecks(), actor.id, 'Stored owner']);
        const run = await newRun();
        runId = run.id;
        await claimTrendSearch(run.id);
        const before = await trendBudget();
        await finishTrendSearch(run.id, [], [], '0.25', [], 1, searchDiagnostics());
        const state = await getTrendRun(run.id);
        assert.equal(state.run.selectionBasis, 'catalog');
        assert.equal(state.run.status, 'awaiting_review');
        assert.ok(state.run.recipeId);
        assert.equal(state.candidates.filter(candidate => candidate.selected).length, 1);
        assert.equal(state.candidates.find(candidate => candidate.selected)?.duplicateRecipeId, state.run.recipeId);
        assert.equal(state.run.reservedUsd, '0.00000000');
        assert.equal(new Decimal((await trendBudget()).usedUsd).minus(before.usedUsd).toFixed(8), '0.25000000');
        await actOnTrendRun(run.id, { action: 'pause' }, actor);
        const resumed = await actOnTrendRun(run.id, { action: 'resume' }, actor);
        assert.equal(resumed.resume, false);
        assert.equal(resumed.run.status, 'awaiting_review');
        assert.equal(resumed.run.recipeId, state.run.recipeId);
        await isolatedPool.query("UPDATE trend_run SET status='generating' WHERE id=$1", [run.id]);
        await assert.rejects(trendJob(run.id, 'recipe'), { code: 'TREND_CATALOG_REUSE' });
        assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM ai_job WHERE trend_run_id=$1', [run.id])).rows[0].count, 0);
    } finally {
        globalThis.fetch = originalFetch;
        if (runId) await cleanupRun(runId);
        if (ids.length) await isolatedPool.query("UPDATE editorial_recipe SET editorial_status='archived' WHERE id=ANY($1::text[])", [ids]);
    }
});

test('stopping before or after the search claim retains a recipe while preserving whether any search could be billed', async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => { requests++; throw new Error('Stopping a workflow must not create a provider request.'); };
    try {
        for (const claimed of [false, true]) {
            const run = await newRun();
            try {
                if (claimed) await claimTrendSearch(run.id, 1);
                await stopRadar(run.id, 'Mock workflow stopped before search completion.', false, 1);
                const execution = await getTrendExecution(run.id);
                const state = await getTrendRun(run.id);
                assert.equal(execution.status, claimed ? 'uncertain' : 'failed');
                assert.ok(execution.recipeId);
                assert.ok(execution.candidateId);
                assert.equal(execution.searchChargedUsd, claimed ? null : '0.00000000');
                assert.equal(execution.searchFinishedAt === null, claimed);
                assert.equal(state.run.reservedUsd, '0.00000000');
                assert.equal(state.run.pendingCostCount, claimed ? 1 : 0);
                assert.equal(state.candidates.filter(candidate => candidate.selected).length, 1);
                assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM ai_job WHERE trend_run_id=$1', [run.id])).rows[0].count, 0);
            } finally { await cleanupRun(run.id); }
        }
        assert.equal(requests, 0);
    } finally { globalThis.fetch = originalFetch; }
});

test('repair replays one owner request across races and keeps the selected draft, search bill and completed text', async () => {
    const run = await textApplied();
    try {
        await failTrendRun(run.id, 'Mock stopped before photos', false, run.generation);
        const before = await getTrendExecution(run.id);
        const recipe = await getRecipe(run.recipeId!);
        const request = { action: 'repair' as const, expectedRevision: recipe.revision, requestKey: randomUUID() };
        const results = await Promise.all([actOnTrendRun(run.id, request, actor), actOnTrendRun(run.id, request, actor)]);
        assert.equal(results.filter(result => result.resume).length, 1);
        assert.equal(results[0].run.id, results[1].run.id);
        const after = await getTrendExecution(run.id);
        assert.equal(after.generation, before.generation + 1);
        assert.equal(after.status, 'generating');
        assert.equal(after.recipeId, before.recipeId);
        assert.equal(after.candidateId, before.candidateId);
        assert.equal(after.expectedRevision, recipe.revision);
        assert.equal(after.searchChargedUsd, before.searchChargedUsd);
        assert.equal(after.searchRequestId, before.searchRequestId);
        assert.deepEqual((await getRecipe(recipe.id)).content, recipe.content);
        assert.equal((await getPreparationPlan(run.id, after.generation)).textRequired, false);
        assert.equal((await isolatedPool.query("SELECT count(*)::int count FROM ai_job WHERE trend_run_id=$1 AND kind='recipe'", [run.id])).rows[0].count, 1);
        const budget = await trendBudget();
        assert.equal((await actOnTrendRun(run.id, request, actor)).resume, false);
        assert.deepEqual(await trendBudget(), budget);
        await assert.rejects(actOnTrendRun(run.id, { ...request, requestKey: randomUUID() }, actor));
    } finally { await cleanupRun(run.id); }
});

test('repair requires the stored owner, a UUID and the latest saved recipe revision', async () => {
    const run = await textApplied();
    try {
        await failTrendRun(run.id, 'Mock stopped preparation', false, run.generation);
        const recipe = await getRecipe(run.recipeId!);
        const request = { action: 'repair' as const, expectedRevision: recipe.revision, requestKey: randomUUID() };
        const before = await getTrendExecution(run.id);
        await assert.rejects(actOnTrendRun(run.id, request, { ...actor, id: 'test-admin' }), { code: 'OWNER_REQUIRED' });
        await assert.rejects(actOnTrendRun(run.id, request, trendWorker), { code: 'FORBIDDEN' });
        await assert.rejects(actOnTrendRun(run.id, { ...request, requestKey: 'invalid-request' }, actor));
        await assert.rejects(actOnTrendRun(run.id, { ...request, expectedRevision: recipe.revision - 1 }, actor), { code: 'REVISION_CONFLICT' });
        assert.deepEqual(await getTrendExecution(run.id), before);
    } finally { await cleanupRun(run.id); }
});

test('repair binds the latest edited texts without buying another recipe or applying stale photos over changed food', async () => {
    const run = await textApplied();
    try {
        await reserveTrendPhotos(run.id);
        const hero = await readyPhoto(run.id, 'hero');
        const before = await getRecipe(run.recipeId!);
        const changed = structuredClone(before.content);
        changed.recipe.description.pl += ' Poprawka właściciela zachowana podczas naprawy.';
        changed.recipe.steps[0].text.en += ' Owner correction is preserved.';
        const saved = await saveRecipe(before.id, { expectedRevision: before.revision, content: changed }, actor);
        await failTrendRun(run.id, 'Mock edit interrupted preparation', false, run.generation);
        const repaired = await actOnTrendRun(run.id, { action: 'repair', expectedRevision: saved.revision, requestKey: randomUUID() }, actor);
        assert.equal(repaired.resume, true);
        const execution = await getTrendExecution(run.id);
        assert.equal(execution.expectedRevision, saved.revision);
        assert.equal((await getPreparationPlan(run.id, execution.generation)).textRequired, false);
        await assert.rejects(applyTrendBatch(run.id, [hero.id], run.generation), { code: 'TREND_SUPERSEDED' });
        await assert.rejects(applyTrendBatch(run.id, [hero.id], execution.generation), { code: 'STALE_BATCH' });
        assert.deepEqual((await getRecipe(before.id)).content, saved.content);
        assert.equal((await isolatedPool.query("SELECT count(*)::int count FROM ai_job WHERE trend_run_id=$1 AND kind='recipe'", [run.id])).rows[0].count, 1);
    } finally { await cleanupRun(run.id); }
});

test('photographs captured before a sibling photo revision apply safely when the food still matches', async () => {
    const run = await textApplied();
    try {
        await reserveTrendPhotos(run.id);
        const before = await getRecipe(run.recipeId!);
        const hero = await readyPhoto(run.id, 'hero');
        const step = await readyPhoto(run.id, 'step', before.content.recipe.steps[0].id);
        await applyTrendBatch(run.id, [hero.id], run.generation);
        const applied = await applyTrendBatch(run.id, [step.id], run.generation);
        assert.equal(applied.revision, before.revision + 2);
        assert.equal(applied.content.recipe.image, `/media/${hero.result!.asset!.id}`);
        assert.equal(applied.content.photos.steps[step.targetId!].src, `/media/${step.result!.asset!.id}`);
        assert.deepEqual(applied.content.recipe.steps, before.content.recipe.steps);
    } finally { await cleanupRun(run.id); }
});

test('repair cannot turn an unknown receiptless search submission into another paid request', async () => {
    const run = await newRun();
    try {
        const execution = await getTrendExecution(run.id);
        await claimTrendSearch(run.id, execution.generation);
        await finishTrendSearchFailure(run.id, null, true, execution.generation);
        const before = await getTrendExecution(run.id);
        const recipe = await getRecipe(before.recipeId!);
        await assert.rejects(actOnTrendRun(run.id, { action: 'repair', expectedRevision: recipe.revision, requestKey: randomUUID() }, actor));
        assert.deepEqual(await getTrendExecution(run.id), before);
        assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM ai_job WHERE trend_run_id=$1', [run.id])).rows[0].count, 0);
    } finally { await cleanupRun(run.id); }
});

test('repair resumes an existing uncertain photo receipt without admitting or submitting a replacement', async () => {
    const run = await textApplied();
    try {
        await reserveTrendPhotos(run.id);
        const source = (await trendJob(run.id, 'hero')).job;
        await claimSubmission(source.id);
        await attachProviderRequest(source.id, `mock-existing-photo-${source.id}`);
        await failJob(source.id, { code: 'RESULT_UNCONFIRMED', message: 'Mock receipt GET timeout', uncertain: true });
        await failTrendRun(run.id, 'Mock photo receipt is temporarily unavailable', true, run.generation);
        const recipe = await getRecipe(run.recipeId!);
        await actOnTrendRun(run.id, { action: 'repair', expectedRevision: recipe.revision, requestKey: randomUUID() }, actor);
        const execution = await getTrendExecution(run.id);
        const prepared = await preparePhotoSlot(run.id, execution.generation, { kind: 'hero' });
        assert.equal(prepared.state, 'job');
        assert.equal(prepared.jobId, source.id);
        assert.equal(prepared.submit, false);
        assert.equal((await claimSubmission(source.id)).shouldSubmit, false);
        assert.equal((await getJob(source.id)).providerRequestId, `mock-existing-photo-${source.id}`);
        assert.equal((await isolatedPool.query("SELECT count(*)::int count FROM ai_job WHERE trend_run_id=$1 AND kind='hero'", [run.id])).rows[0].count, 1);
        await finishAsset(source.id, { blobPathname: `test/${source.id}.webp`, width: 1024, height: 1024, contentType: 'image/webp', alt: recipe.content.recipe.title, caption: { pl: '', en: '' }, styleProfile: 'jesie-culinary-editorial-v1' }, { chargedUsd: '0.1', costBasis: 'usage' });
        assert.equal((await advancePreparedPhoto(run.id, execution.generation, { kind: 'hero' }, source.id)).state, 'complete');
        assert.equal((await getJob(source.id)).status, 'applied');
    } finally { await cleanupRun(run.id); }
});

test('repair keeps a receiptless uncertain photo blocked and preserves its captured receipt state', async () => {
    const run = await textApplied();
    try {
        await reserveTrendPhotos(run.id);
        const source = (await trendJob(run.id, 'hero')).job;
        await claimSubmission(source.id);
        await failJob(source.id, { code: 'SUBMISSION_UNCERTAIN', message: 'Mock lost acceptance', uncertain: true });
        await failTrendRun(run.id, 'Mock lost acceptance', true, run.generation);
        const recipe = await getRecipe(run.recipeId!);
        await actOnTrendRun(run.id, { action: 'repair', expectedRevision: recipe.revision, requestKey: randomUUID() }, actor);
        const execution = await getTrendExecution(run.id);
        const prepared = await preparePhotoSlot(run.id, execution.generation, { kind: 'hero' });
        assert.equal(prepared.state, 'blocked');
        assert.equal((await getJob(source.id)).providerRequestId, null);
        assert.equal((await getJob(source.id)).reservedUsd, source.reservedUsd);
        assert.equal((await isolatedPool.query("SELECT count(*)::int count FROM ai_job WHERE trend_run_id=$1 AND kind='hero'", [run.id])).rows[0].count, 1);
    } finally { await cleanupRun(run.id); }
});

test('repair cuts out a completed opaque hero once instead of regenerating the dish photograph', async () => {
    const run = await textApplied();
    try {
        await reserveTrendPhotos(run.id);
        const source = (await trendJob(run.id, 'hero')).job;
        await claimSubmission(source.id);
        await attachProviderRequest(source.id, `mock-opaque-photo-${source.id}`);
        await markProviderTerminal(source.id);
        await failJob(source.id, { code: 'AI_TRANSPARENCY_MISSING', message: 'Opaque mock hero', uncertain: false, providerFinished: true });
        const oldSource = await getJobForExecution(source.id);
        await failTrendRun(run.id, 'Mock missing transparency', false, run.generation);
        const recipe = await getRecipe(run.recipeId!);
        await actOnTrendRun(run.id, { action: 'repair', expectedRevision: recipe.revision, requestKey: randomUUID() }, actor);
        const execution = await getTrendExecution(run.id);
        const prepared = await preparePhotoSlot(run.id, execution.generation, { kind: 'hero' });
        assert.equal(prepared.state, 'job');
        assert.ok(prepared.jobId);
        assert.notEqual(prepared.jobId, source.id);
        const correction = await getJobForExecution(prepared.jobId);
        assert.equal(correction.model, heroCutoutModel);
        assert.equal(correction.reservedUsd, '0.00000000');
        assert.equal(correction.providerRequestId, null);
        assert.equal(correction.input.recipe.image, `${failedHeroSourcePrefix}${source.id}`);
        assert.equal((await preparePhotoSlot(run.id, execution.generation, { kind: 'hero' })).jobId, correction.id);
        assert.deepEqual(await getJobForExecution(source.id), oldSource);
        await claimSubmission(correction.id);
        await attachProviderRequest(correction.id, `mock-cutout-${correction.id}`);
        await finishAsset(correction.id, { blobPathname: `test/${correction.id}.webp`, originalBlobPathname: `test/${correction.id}/original.png`, width: 1024, height: 1024, contentType: 'image/webp', alt: recipe.content.recipe.title, caption: { pl: '', en: '' }, hasTransparency: true, styleProfile: 'jesie-culinary-editorial-v1' }, { chargedUsd: '0.05', costBasis: 'usage' });
        assert.equal((await advancePreparedPhoto(run.id, execution.generation, { kind: 'hero' }, correction.id)).state, 'complete');
        assert.equal((await getRecipe(recipe.id)).content.recipe.image, `/media/${(await getJob(correction.id)).result!.asset!.id}`);
        assert.equal((await isolatedPool.query("SELECT count(*)::int count FROM ai_job WHERE trend_run_id=$1 AND kind='hero'", [run.id])).rows[0].count, 2);
    } finally { await cleanupRun(run.id); }
});

test('a requested ingredient replacement bypasses the image library and leaves its current photo until the new result applies', async () => {
    const state = await complete();
    try {
        const recipe = state.recipe!;
        const target = recipe.content.recipe.ingredients[0].id;
        const originalPhoto = structuredClone(recipe.content.photos.ingredients[target]);
        const request = { action: 'regenerate_photo' as const, kind: 'ingredient' as const, targetId: target, expectedRevision: recipe.revision, requestKey: randomUUID() };
        const admitted = await Promise.all([actOnTrendRun(state.run.id, request, actor), actOnTrendRun(state.run.id, request, actor)]);
        assert.equal(admitted.filter(result => result.resume).length, 1);
        const execution = await getTrendExecution(state.run.id);
        const plan = await getPreparationPlan(state.run.id, execution.generation);
        assert.equal(plan.textRequired, false);
        assert.deepEqual(plan.slots, [{ kind: 'ingredient', targetId: target }]);
        assert.deepEqual((await getRecipe(recipe.id)).content.photos.ingredients[target], originalPhoto);
        const prepared = await preparePhotoSlot(state.run.id, execution.generation, plan.slots[0]);
        assert.equal(prepared.state, 'job');
        assert.ok(prepared.jobId);
        const replacement = await getJob(prepared.jobId);
        assert.equal(replacement.status, 'queued');
        assert.equal(replacement.reuseSourceJobId, null);
        assert.equal(replacement.reservedUsd, '0.00000000');
        assert.equal((await claimSubmission(replacement.id)).shouldSubmit, true);
        assert.deepEqual((await getRecipe(recipe.id)).content.photos.ingredients[target], originalPhoto);
        await attachProviderRequest(replacement.id, `mock-new-ingredient-${replacement.id}`);
        await finishAsset(replacement.id, { blobPathname: `test/${replacement.id}.webp`, width: 1024, height: 1024, contentType: 'image/webp', alt: recipe.content.recipe.ingredients[0].name, caption: { pl: '', en: '' }, hasTransparency: false, styleProfile: currentIngredientStyleProfile }, { chargedUsd: '0.1', costBasis: 'usage' });
        assert.equal((await advancePreparedPhoto(state.run.id, execution.generation, plan.slots[0], replacement.id)).state, 'complete');
        const applied = await getRecipe(recipe.id);
        assert.notEqual(applied.content.photos.ingredients[target].src, originalPhoto.src);
        assert.deepEqual(applied.content.recipe, recipe.content.recipe);
        await completeTrendRun(state.run.id);
        assert.equal((await getTrendRun(state.run.id)).run.status, 'awaiting_review');
    } finally { await cleanupRun(state.run.id); }
});

test('single-slot regeneration validates a current photographic target and the saved revision', async () => {
    const state = await complete();
    try {
        const recipe = state.recipe!;
        const request = { action: 'regenerate_photo' as const, kind: 'ingredient' as const, targetId: recipe.content.recipe.ingredients[0].id, expectedRevision: recipe.revision, requestKey: randomUUID() };
        await assert.rejects(actOnTrendRun(state.run.id, { ...request, targetId: 'missing-ingredient' }, actor));
        await assert.rejects(actOnTrendRun(state.run.id, { ...request, kind: 'step', targetId: 'missing-step' }, actor));
        await assert.rejects(actOnTrendRun(state.run.id, { ...request, kind: 'hero', targetId: 'unexpected-target' }, actor));
        await assert.rejects(actOnTrendRun(state.run.id, { ...request, expectedRevision: recipe.revision - 1 }, actor), { code: 'REVISION_CONFLICT' });
        assert.equal((await getTrendRun(state.run.id)).run.status, 'awaiting_review');
        assert.deepEqual((await getRecipe(recipe.id)).content, recipe.content);
    } finally { await cleanupRun(state.run.id); }
});

test('publishing accepts the newest complete edited texts in one transaction and never publishes an old revision', async () => {
    const state = await complete();
    const recipe = state.recipe!;
    const content = structuredClone(recipe.content);
    content.recipe.description.pl += ' Ostateczny tekst właściciela.';
    content.recipe.description.en += ' Final owner text.';
    const saved = await saveRecipe(recipe.id, { expectedRevision: recipe.revision, content }, actor);
    await assert.rejects(actOnTrendRun(state.run.id, { action: 'approve_and_publish', expectedRevision: recipe.revision, checks }, actor), { code: 'REVISION_CONFLICT' });
    const published = await actOnTrendRun(state.run.id, { action: 'approve_and_publish', expectedRevision: saved.revision, checks }, actor);
    assert.equal(published.run.status, 'published');
    assert.equal(published.recipe?.content.recipe.description.pl, saved.content.recipe.description.pl);
    assert.equal(published.recipe?.content.recipe.description.en, saved.content.recipe.description.en);
    for (const locale of ['pl', 'en'] as const) {
        const publicRecipe = await getPublishedRecipe(saved.content.recipe.slug[locale], locale);
        assert.equal(publicRecipe?.description[locale], saved.content.recipe.description[locale]);
    }
    assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM editorial_publication WHERE recipe_id=$1', [recipe.id])).rows[0].count, 1);
});

test('publication blocks an in-progress photo replacement even when every previous photo is still complete', async () => {
    const state = await complete();
    try {
        const recipe = state.recipe!;
        await actOnTrendRun(state.run.id, { action: 'regenerate_photo', kind: 'hero', expectedRevision: recipe.revision, requestKey: randomUUID() }, actor);
        const execution = await getTrendExecution(state.run.id);
        const prepared = await preparePhotoSlot(state.run.id, execution.generation, { kind: 'hero' });
        assert.equal(prepared.state, 'job');
        assert.ok(prepared.jobId);
        await assert.rejects(actOnTrendRun(state.run.id, { action: 'approve_and_publish', expectedRevision: recipe.revision, checks }, actor), { code: 'TREND_REVIEW_REQUIRED' });
        assert.equal((await getRecipe(recipe.id)).publicationStatus, 'never_published');
        assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM editorial_publication WHERE recipe_id=$1', [recipe.id])).rows[0].count, 0);
        await claimSubmission(prepared.jobId);
        await attachProviderRequest(prepared.jobId, 'mock-unfinished-photo-replacement');
        await failJob(prepared.jobId, { code: 'RESULT_UNCONFIRMED', message: 'Mock uncertain replacement', uncertain: true });
        await failTrendRun(state.run.id, 'Mock uncertain replacement', true, execution.generation);
        await assert.rejects(actOnTrendRun(state.run.id, { action: 'approve_and_publish', expectedRevision: recipe.revision, checks }, actor));
        assert.equal((await getRecipe(recipe.id)).publicationStatus, 'never_published');
    } finally { await cleanupRun(state.run.id); }
});

test('explicit human photo preparation builds the complete packet through reusable engine steps', async () => {
    // A verified current-profile catalogue entry makes reuse independent of previous tests.
    const catalogueDraft = await createRecipe({ title: `Preparation catalogue ${randomUUID()}`, originalText: 'Offline catalogue fixture.' }, actor);
    const catalogueContent = proposal(catalogueDraft.id);
    catalogueContent.recipe.ingredients = [catalogueContent.recipe.ingredients[0]];
    catalogueContent.recipe.steps = [];
    catalogueContent.recipe.substitutions = [];
    const catalogueIngredient = catalogueContent.recipe.ingredients[0];
    catalogueContent.recipe.steps = [{ id: 'catalogue-step', title: { pl: 'Odmierz składnik', en: 'Measure the ingredient' }, text: { pl: `Odmierz {{${catalogueIngredient.id}}} składnika.`, en: `Measure {{${catalogueIngredient.id}}} of the ingredient.` } }];
    catalogueContent.recipe.image = ''; // The original pasta hero does not depict this single-product fixture.
    delete catalogueContent.recipe.heroPresentation;
    const catalogueRecipe = await saveRecipe(catalogueDraft.id, { expectedRevision: catalogueDraft.revision, content: catalogueContent }, actor);
    await approveRecipeContent(catalogueRecipe.id, catalogueRecipe.revision, actor);
    const catalogueJob = (await createJobAdmission({ recipeId: catalogueRecipe.id, expectedRevision: catalogueRecipe.revision, kind: 'ingredient', targetId: catalogueContent.recipe.ingredients[0].id, brief: 'Offline verified catalogue photo.', requestKey: randomUUID() }, actor)).job;
    if (catalogueJob.status !== 'ready') {
        await claimSubmission(catalogueJob.id);
        await attachProviderRequest(catalogueJob.id, `mock-preparation-catalogue-${catalogueJob.id}`);
        await finishAsset(catalogueJob.id, { blobPathname: `test/${catalogueJob.id}.webp`, width: 1024, height: 1024, contentType: 'image/webp', alt: catalogueContent.recipe.ingredients[0].name, caption: { pl: '', en: '' }, hasTransparency: false, styleProfile: currentIngredientStyleProfile }, { chargedUsd: '0.1', costBasis: 'usage' });
    }
    const run = await drafted();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('Mocked preparation must not call a provider or blob service.'); };
    try {
        const text = await prepareRecipeText(run.id, run.generation);
        assert.equal(text.state, 'job');
        assert.ok(text.jobId);
        assert.equal((await claimSubmission(text.jobId)).shouldSubmit, true);
        await attachProviderRequest(text.jobId, `mock-automatic-text-${text.jobId}`);
        await finishRecipe(text.jobId, proposal(run.recipeId!), { chargedUsd: '0.2', costBasis: 'usage' });
        assert.equal((await advancePreparedText(run.id, run.generation, text.jobId)).state, 'complete');
        await consentToFixturePhotos(run.id);
        const plan = await getPreparationPlan(run.id, run.generation);
        assert.equal(plan.textRequired, false);
        const before = await getRecipe(run.recipeId!);
        assert.equal(plan.slots.length, 1 + before.content.recipe.ingredients.length + before.content.recipe.steps.filter(step => isStepPhotoRequired(before.content, step.id)).length);
        let reused = 0;
        let generated = 0;
        for (const slot of plan.slots) {
            const prepared = await preparePhotoSlot(run.id, run.generation, slot);
            if (prepared.state === 'complete') continue;
            assert.equal(prepared.state, 'job');
            assert.ok(prepared.jobId);
            const job = await getJob(prepared.jobId);
            if (job.status === 'ready') {
                reused++;
            } else {
                generated++;
                assert.equal((await claimSubmission(job.id)).shouldSubmit, true);
                await attachProviderRequest(job.id, `mock-automatic-photo-${job.id}`);
                const name = slot.kind === 'ingredient' ? before.content.recipe.ingredients.find(item => item.id === slot.targetId)!.name : before.content.recipe.title;
                const captured = await getJobForExecution(job.id);
                const profile = slot.kind === 'ingredient' ? capturedIngredientStyleProfile(captured.input) : captured.input.aiPhotography?.heroStyleProfile ?? 'jesie-culinary-editorial-v1';
                if (slot.kind === 'ingredient') {
                    assert.equal(profile, currentIngredientStyleProfile);
                    assert.equal(job.reservedUsd, '0.00000000');
                }
                await finishAsset(job.id, { blobPathname: `test/${job.id}.webp`, width: 1024, height: 1024, contentType: 'image/webp', alt: name, caption: { pl: 'Właściwa konsystencja.', en: 'Correct consistency.' }, hasTransparency: slot.kind === 'hero' || slot.kind === 'ingredient' && !isOpaqueStudioIngredientProfile(profile), styleProfile: profile }, { chargedUsd: '0.1', costBasis: 'usage' });
            }
            assert.equal((await advancePreparedPhoto(run.id, run.generation, slot, job.id)).state, 'complete');
        }
        assert.ok(reused > 0, 'Existing ingredient photographs are reused.');
        assert.ok(generated > 0, 'Missing dish and step photographs are generated.');
        await completeTrendRun(run.id);
        const finished = await getTrendRun(run.id);
        assert.equal(finished.run.status, 'awaiting_review');
        assert.equal(finished.run.photos.ready, finished.run.photos.total);
        assert.equal(finished.recipe?.issues.filter(issue => !issue.field.startsWith('substitutions.')).length, 0);
        assert.equal(finished.recipe?.publicationStatus, 'never_published');
    } finally { globalThis.fetch = originalFetch; await cleanupRun(run.id); }
});

test('regeneration reads an older accepted photo receipt before buying the explicitly requested new photo', async () => {
    const run = await textApplied();
    try {
        await reserveTrendPhotos(run.id);
        const source = (await trendJob(run.id, 'hero')).job;
        await claimSubmission(source.id);
        await attachProviderRequest(source.id, `mock-prior-accepted-${source.id}`);
        await failJob(source.id, { code: 'RESULT_UNCONFIRMED', message: 'Mock old receipt needs GET', uncertain: true });
        await failTrendRun(run.id, 'Mock stopped on old receipt', true, run.generation);
        const recipe = await getRecipe(run.recipeId!);
        await actOnTrendRun(run.id, { action: 'regenerate_photo', kind: 'hero', expectedRevision: recipe.revision, requestKey: randomUUID() }, actor);
        const current = await getTrendExecution(run.id);
        const waiting = await preparePhotoSlot(run.id, current.generation, { kind: 'hero' });
        assert.equal(waiting.state, 'job');
        assert.equal(waiting.jobId, source.id);
        assert.equal(waiting.submit, false);
        assert.equal(waiting.observe, true);
        await finishAsset(source.id, { blobPathname: `test/${source.id}.webp`, width: 1024, height: 1024, contentType: 'image/webp', alt: recipe.content.recipe.title, caption: { pl: '', en: '' }, styleProfile: 'jesie-culinary-editorial-v1' }, { chargedUsd: '0.1', costBasis: 'usage' });
        const replacement = await advancePreparedPhoto(run.id, current.generation, { kind: 'hero' }, source.id, waiting.observe);
        assert.equal(replacement.state, 'job', 'An old result is not the requested regeneration.');
        assert.ok(replacement.jobId);
        assert.notEqual(replacement.jobId, source.id);
        assert.equal((await getJob(replacement.jobId)).providerRequestId, null);
        assert.equal((await getJob(replacement.jobId)).reservedUsd, '0.00000000');
    } finally { await cleanupRun(run.id); }
});

test('diet balance reads the active publication once and ignores its edited draft, old versions and withdrawn recipes', async () => {
    const before = await getTrendDietBalance();
    const baseCounts = (values: RecipeDietId[]) => values.reduce((counts, value) => { counts[value]++; return counts; }, { meat: 0, vegetarian: 0, vegan: 0 });
    const current = await createRecipe({ title: 'Diet balance current fixture', originalText: '' }, actor);
    const fresh = await createRecipe({ title: 'Diet balance fresh fixture', originalText: '' }, actor);
    const archived = await createRecipe({ title: 'Diet balance archived fixture', originalText: '' }, actor);
    const withdrawn = await createRecipe({ title: 'Diet balance withdrawn fixture', originalText: '' }, actor);
    const content = (id: string, diet: RecipeDietId): EditorialContent => {
        const result = proposal(id);
        result.recipe.ingredients = [{ ...result.recipe.ingredients[0], name: diet === 'meat' ? { pl: 'Kurczak', en: 'Chicken' } : diet === 'vegetarian' ? { pl: 'Mleko', en: 'Milk' } : { pl: 'Tofu', en: 'Tofu' } }];
        delete result.recipe.diet;
        return result;
    };
    const publishedId = randomUUID();
    for (const [recipe, id, revision, diet, at] of [
        [current, randomUUID(), 1, 'meat', '1900-01-01T00:00:00Z'], // First publication determines age, not a later metadata correction.
        [current, publishedId, 2, 'vegan', '2100-01-01T00:00:00Z'],
        [fresh, randomUUID(), 1, 'vegetarian', '2099-01-01T00:00:00Z'],
        [archived, randomUUID(), 1, 'meat', '2099-01-01T00:00:00Z'],
        [withdrawn, randomUUID(), 1, 'meat', '2099-01-01T00:00:00Z'],
    ] as const) {
        const snapshot = content(recipe.id, diet);
        await isolatedPool.query(`INSERT INTO editorial_publication(id,recipe_id,revision,snapshot,content_hash,checks,approval_origin,published_by,published_by_name,published_at) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,'manual',$7,'Owner',$8)`, [id, recipe.id, revision, JSON.stringify(snapshot), contentHash(snapshot), JSON.stringify(checks), actor.id, at]);
        if (recipe.id !== current.id || revision === 2) await isolatedPool.query(`UPDATE editorial_recipe SET publication_status=$2,published_id=$3,editorial_status=$4,content=$5::jsonb WHERE id=$1`, [recipe.id, recipe.id === withdrawn.id ? 'unpublished' : 'published', id, recipe.id === archived.id ? 'archived' : 'draft', JSON.stringify(content(recipe.id, 'meat'))]);
    }
    const after = await getTrendDietBalance();
    const expected = baseCounts(before.catalog); expected.vegan++; expected.vegetarian++;
    assert.deepEqual(baseCounts(after.catalog), expected);
    assert.equal(after.recent[0], 'vegetarian', 'A corrected old recipe does not become the newest dietary choice.');
    assert.equal(after.catalog.length, before.catalog.length + 2);
});

test('automatic recipe selection records its balance decision and captures the category before a text request', async () => {
    const run = await newRun();
    try {
        await claimTrendSearch(run.id);
        const raw = evidence();
        await finishTrendSearch(run.id, [raw], raw.sources.map(source => source.url), '0.1');
        const state = await getTrendRun(run.id);
        const selected = state.candidates.find(candidate => candidate.selected)!;
        assert.equal(selected.diet, fixtureDiet);
        assert.equal(selected.dietSelection?.target, fixtureDiet);
        assert.equal(selected.dietSelection?.selected, fixtureDiet);
        assert.equal(selected.dietSelection?.fallback, false);
        assert.equal(state.recipe?.content.aiPhotography?.recipeDietTarget, fixtureDiet);
        const admission = await trendJob(run.id, 'recipe');
        const captured = await getJobForExecution(admission.job.id);
        assert.equal(captured.input.aiPhotography?.recipeDietTarget, fixtureDiet);
        assert.equal(captured.providerRequestId, null);
    } finally { await cleanupRun(run.id); }
});
