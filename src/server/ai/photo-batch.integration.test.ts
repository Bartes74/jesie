import { createStepPhotoOmission } from '@/lib/step-photo-selection';
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import { Pool } from 'pg';
import sharp from 'sharp';
import type { EditorialActor, EditorialContent, EditorialRecord } from '@/lib/editorial-types';
import { recipes } from '@/lib/recipes';
import { getIngredientImage, getStepImage } from '@/lib/recipe-media';
import { resolveHeroPresentation } from '@/lib/hero-presentation';
import { closeDb } from '@/server/db';
import { createRecipe, deleteRecipe, EditorialError, getRecipe, performRecipeAction, saveRecipe } from '@/server/editorial/store';
import { AiError } from './errors';
import { capturedIngredientStyleProfile, ingredientImageIdentity, ingredientStyleProfile, isOpaqueStudioIngredientProfile, paperIngredientStyleProfile, whiteIngredientStyleProfile } from './ingredient-profile';
import { importIngredientBackgroundEdits, type IngredientBackgroundImport, type IngredientBackgroundImportStorage } from './ingredient-background-import';
import { importReviewedHeroCorrection, reuseReviewedLiquidCream, reviewedHeroCorrectionModel, type ReviewedHeroCorrection } from './reviewed-photo-correction';
import { heroCenterFoodRejectionMessage, heroCutoutModel } from './image-actions';
import { photoBatchBilling } from './photo-batch-billing';
import { applyJob, attachProviderRequest, cancelJob, claimSubmission, createJob, createJobAdmission, ensureSubmissionAllowed, failJob, finishAsset, finishRecipe, getConfiguration, getJobForExecution, markProviderTerminal, resumeJob, resolveIngredientReuse, settleCost } from './store';
import { applyPhotoBatch, claimPhotoBatchWorkflow, createPhotoBatch as createCurrentPhotoBatch, getPhotoBatch, getPhotoBatchRecoveryState, listPhotoBatches, nextPhotoBatchOperation, nextPhotoBatchWave, recordPhotoBatchWorkflowDispatch, resumePhotoBatch, stopPhotoBatch, stopPhotoBatchDispatchUnconfirmed, type PhotoBatchWorkflowEvidence } from './photo-batch';
import { approveRecipeContent, isRecipeContentApproved } from '../editorial/content-approval';
import { replaceReviewedBatchIngredient } from './photo-batch';
import { registerFixturePhotos } from './recipe-photo-test-fixture';
// Historical cases explicitly exercise persisted v1 capture compatibility.
const createPhotoBatch:typeof createCurrentPhotoBatch=(input,actor)=>createCurrentPhotoBatch(input,actor,{ingredientStyleProfile});

const schema = `photo_batch_test_${randomUUID().replaceAll('-', '')}`;
let adminPool: Pool; let isolatedPool: Pool;
const actor: EditorialActor = { id: 'batch-owner', name: 'Untrusted name', email: 'owner@example.invalid', role: 'owner' };

before(async () => {
  if (process.env.NODE_ENV === 'production') throw new Error('Photo batch tests require development.');
  config({ path: '.env.local', quiet: true });
  const connection = process.env.AI_TEST_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING;
  if (!connection) throw new Error('A development Postgres connection is required.');
  adminPool = new Pool({ connectionString: connection, max: 1 });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connection); url.searchParams.set('options', `-c search_path=${schema}`); process.env.DATABASE_URL = url.toString();
  isolatedPool = new Pool({ connectionString: url.toString(), max: 1 });
  await isolatedPool.query(`CREATE TABLE auth_user(id text PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,image text,role text NOT NULL DEFAULT 'admin',disabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
  await isolatedPool.query(`INSERT INTO auth_user(id,name,email,role) VALUES('batch-owner','Stored batch owner','owner@example.invalid','owner')`);
  for (const name of ['0001-editorial', '0002-ai', '0003-trends', '0004-trend-research', '0005-trend-manual-runs', '0006-ingredient-reuse', '0007-local-photo-corrections', '0008-ai-photo-batches', '0009-ai-budget-settings', '0010-daily-publication','0011-seo-discovery','0014-seo-workflows', '0015-recipe-trash', '0018-content-approval','0021-recipe-result-recovery', '0026-remove-spending-limits','0027-manual-review-workflow','0028-ingredient-dictionary','0029-ingredient-evidence-recheck']) await isolatedPool.query(await readFile(`migrations/${name}.sql`, 'utf8'));
  process.env.OPENAI_API_KEY = 'test-unused'; process.env.FAL_KEY = 'test-unused'; process.env.BLOB_READ_WRITE_TOKEN = 'test-unused';
  process.env.AI_DAILY_LIMIT_USD = '1000'; process.env.AI_MONTHLY_LIMIT_USD = '1000'; process.env.AI_PILOT_LIMIT_USD = '1000';
});
afterEach(async () => {
  // Synthetic receipts never reached a provider. Release test slots without
  // altering immutable captured subjects or receipts between independent cases.
  await isolatedPool.query(`UPDATE ai_job SET provider_finished_at=now(),ingredient_resolved_at=now() WHERE provider_finished_at IS NULL`);
  await isolatedPool.query(`UPDATE ai_photo_batch SET remaining_reserved_usd=0 WHERE remaining_reserved_usd>0`);
});
after(async () => {
  await closeDb(); if (isolatedPool) await isolatedPool.end();
  if (adminPool) { await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await adminPool.end(); }
});

async function fixture(options: { hero?: boolean; ingredient?: boolean; step?: boolean; secondStep?: boolean; secondIngredient?: boolean; duplicateIngredient?: boolean; libraryIngredient?: boolean } = {}) {
  const draft = await createRecipe({ title: 'Batch fixture', originalText: 'Private original recipe' }, actor);
  const recipe = structuredClone(recipes[0]); const originalId = recipe.id;
  recipe.id = draft.id; recipe.slug = { pl: `test-${draft.id}`, en: `test-${draft.id}` };
  recipe.ingredients = [structuredClone(recipe.ingredients[0])];
  recipe.ingredients[0].name = options.libraryIngredient ? { pl: 'Mąka pszenna', en: 'Plain flour' } : { pl: `Produkt ${randomUUID()}`, en: `Product ${randomUUID()}` };
  recipe.ingredients[0].id = 'ingredient'; recipe.ingredients[0].note = undefined;
  recipe.steps = [{ id: 'step', title: { pl: 'Wymieszaj', en: 'Mix' }, text: { pl: 'Wymieszaj {{ingredient}}.', en: 'Mix {{ingredient}}.' } }];
  if (options.secondStep) recipe.steps.push({ ...structuredClone(recipe.steps[0]), id: 'step-two' });
  recipe.substitutions = [];
  const content: EditorialContent = { recipe, originalText: 'Private original recipe', author: 'Original author', sources: [],
    photos: { ingredients: { ingredient: { ...getIngredientImage(originalId, recipes[0].ingredients[0].id), alt: recipe.ingredients[0].name } }, steps: { step: getStepImage(originalId, recipes[0].steps[0].id) } } };
  if (options.duplicateIngredient) { recipe.ingredients.push({ ...structuredClone(recipe.ingredients[0]), id: 'ingredient-copy' }); content.photos.ingredients['ingredient-copy'] = structuredClone(content.photos.ingredients.ingredient); }
  if (options.secondIngredient) recipe.ingredients.push({ ...structuredClone(recipe.ingredients[0]), id: 'ingredient-two', name: { pl: `Drugi produkt ${randomUUID()}`, en: `Second product ${randomUUID()}` } });
  if (options.hero) recipe.image = '';
  if (options.ingredient) { delete content.photos.ingredients.ingredient; delete content.photos.ingredients['ingredient-copy']; }
  if (options.step) delete content.photos.steps.step;
  await registerFixturePhotos(content, actor, draft.revision);
  const saved = await saveRecipe(draft.id, { expectedRevision: draft.revision, content }, actor);
  await approveRecipeContent(saved.id, saved.revision, actor);
  return saved;
}
async function batch(recipe: EditorialRecord) { return createPhotoBatch({ recipeId: recipe.id, expectedRevision: recipe.revision, requestKey: randomUUID() }, actor); }
async function claimBatch(id: string, generation: number) { assert.equal(await claimPhotoBatchWorkflow(id, generation, `workflow-${id}-${generation}`), true); }
async function asset(id: string) {
  assert.equal((await claimSubmission(id)).shouldSubmit, true);
  await ensureSubmissionAllowed(id);
  await attachProviderRequest(id, `receipt_${id}`);
  return claimedAsset(id);
}
async function claimedAsset(id: string) {
  const captured = await getJobForExecution(id);
  return finishAsset(id, { blobPathname: `test/${id}.png`, width: captured.kind === 'step' ? 2240 : 1024, height: captured.kind === 'step' ? 960 : 1024,
    contentType: 'image/png', alt: { pl: 'Zdjęcie', en: 'Photograph' }, caption: { pl: 'Detal', en: 'Detail' }, hasTransparency: captured.kind==='ingredient'?!isOpaqueStudioIngredientProfile(capturedIngredientStyleProfile(captured.input)):true, styleProfile: captured.kind==='ingredient'?capturedIngredientStyleProfile(captured.input):ingredientStyleProfile }, { chargedUsd: '0.05', costBasis: 'usage' });
}
function code(expected: string) { return (error: unknown) => error instanceof AiError && error.code === expected; }

async function billingFixture() {
  const recipe = await fixture({ step: true }); const admission = await batch(recipe);
  await claimBatch(admission.batch.id, admission.generation);
  const operation = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  await claimSubmission(operation.jobId!); await attachProviderRequest(operation.jobId!, `receipt_${operation.jobId}`);
  await finishAsset(operation.jobId!, { blobPathname: `billing/${operation.jobId}.webp`, width: 2240, height: 960,
    contentType: 'image/webp', alt: { pl: 'Etap', en: 'Step' }, caption: { pl: '', en: '' }, hasTransparency: false });
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation)).state, 'done');
  return { recipe, admission, jobId: operation.jobId! };
}

test('packet billing authenticates stored actors before provider access and again after it', async () => {
  const f = await billingFixture(); let reads = 0;
  const reader = async () => { reads++; return { status: 'verified' as const, httpStatus: 200, costs: { [`receipt_${f.jobId}`]: '0.04240000' } }; };
  await assert.rejects(photoBatchBilling(f.admission.batch.id, { ...actor, role: 'trend_worker' }, true, reader), code('FORBIDDEN'));
  await isolatedPool.query('UPDATE auth_user SET disabled=true WHERE id=$1', [actor.id]);
  try { await assert.rejects(photoBatchBilling(f.admission.batch.id, actor, true, reader), code('FORBIDDEN')); assert.equal(reads, 0); }
  finally { await isolatedPool.query('UPDATE auth_user SET disabled=false WHERE id=$1', [actor.id]); }
  const disablingReader = async () => { await isolatedPool.query('UPDATE auth_user SET disabled=true WHERE id=$1', [actor.id]); return reader(); };
  try {
    await assert.rejects(photoBatchBilling(f.admission.batch.id, actor, true, disablingReader), code('FORBIDDEN'));
    assert.equal((await getJobForExecution(f.jobId)).costBasis, 'reservation');
  } finally { await isolatedPool.query('UPDATE auth_user SET disabled=false WHERE id=$1', [actor.id]); }
});

test('packet billing reconciles one immutable ledger delta without duplicate spend, submissions or increased limits', async () => {
  const f = await billingFixture(); const before = await getConfiguration();
  const original = await getJobForExecution(f.jobId);
  const ledger = (await isolatedPool.query('SELECT * FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry', [f.jobId])).rows;
  const reader = async () => ({ status: 'verified' as const, httpStatus: 200, costs: { [`receipt_${f.jobId}`]: '0.04240000' } });
  const readonly = await photoBatchBilling(f.admission.batch.id, actor, false, reader);
  assert.equal(readonly.totalCommitmentUsd, '0.00000000'); assert.equal(readonly.reconciledJobs, 0); assert.equal(readonly.pendingJobs, 1);
  assert.deepEqual(await getJobForExecution(f.jobId), original);
  const settled = await photoBatchBilling(f.admission.batch.id, actor, true, reader);
  assert.equal(settled.verifiedCostUsd, '0.04240000'); assert.equal(settled.totalCommitmentUsd, '0.04240000');
  assert.equal(settled.availableWithinOriginalUsd, '0.00000000'); assert.equal(settled.reconciledJobs, 1); assert.equal(settled.pendingJobs, 0);
  assert.equal(settled.originalReservationUsd, '0.00000000');
  const repeated = await photoBatchBilling(f.admission.batch.id, actor, true, reader);
  assert.equal(repeated.totalCommitmentUsd, settled.totalCommitmentUsd); assert.equal(repeated.reconciledJobs, 0);
  const current = await getJobForExecution(f.jobId); assert.equal(current.providerRequestId, original.providerRequestId);
  assert.deepEqual(current.result, original.result); assert.equal(current.status, original.status);
  const afterLedger = (await isolatedPool.query('SELECT * FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry', [f.jobId])).rows;
  for (const old of ledger) assert.deepEqual(afterLedger.find(row => row.id === old.id), old);
  assert.equal(afterLedger.length, ledger.length + 1);
  assert.equal(afterLedger.find(row => !ledger.some(old => old.id === row.id)).amount_usd, '0.04240000');
  const after = await getConfiguration(); assert.equal(after.budget.dailyLimitUsd, before.budget.dailyLimitUsd);
  assert.equal(after.budget.monthlyLimitUsd, before.budget.monthlyLimitUsd); assert.equal(after.budget.pilotLimitUsd, before.budget.pilotLimitUsd);
  assert.equal((await isolatedPool.query('SELECT count(*) FROM ai_job WHERE photo_batch_id=$1', [f.admission.batch.id])).rows[0].count, '1');
});

test('packet billing permission failure preserves pending receipt and ledger history without inventing a cost', async () => {
  const f = await billingFixture(); const original = await getJobForExecution(f.jobId);
  const ledger = (await isolatedPool.query('SELECT * FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry', [f.jobId])).rows;
  const denied = await photoBatchBilling(f.admission.batch.id, actor, true, async () => ({ status: 'forbidden', httpStatus: 403, costs: {} }));
  assert.equal(denied.totalCommitmentUsd, '0.00000000'); assert.equal(denied.conservativeCostUsd, '0.00000000');
  assert.equal(denied.verifiedCostUsd, '0.00000000'); assert.equal(denied.read.httpStatus, 403); assert.equal(denied.pendingJobs, 1);
  assert.deepEqual(await getJobForExecution(f.jobId), original);
  assert.deepEqual((await isolatedPool.query('SELECT * FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry', [f.jobId])).rows, ledger);
});

test('packet billing settles a known completed provider failure and preserves unfinished accepted receipts', async () => {
  const recipe = await fixture({ step: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const operation = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  await claimSubmission(operation.jobId!); await attachProviderRequest(operation.jobId!, `receipt_${operation.jobId}`);
  await failJob(operation.jobId!, { code: 'AI_TRANSPARENCY_MISSING', message: 'Completed provider image failed local validation', uncertain: false, providerFinished: true });
  const failed = await getJobForExecution(operation.jobId!); assert.equal(failed.status, 'failed'); assert.equal(failed.costBasis, 'reservation');
  const result = await photoBatchBilling(admission.batch.id, actor, true, async requests => {
    assert.deepEqual(requests.map(item => item.requestId), [failed.providerRequestId]);
    return { status: 'verified', httpStatus: 200, costs: { [failed.providerRequestId!]: '0.04240000' } };
  });
  assert.equal(result.reconciledJobs, 1); const reconciled = await getJobForExecution(failed.id);
  assert.equal(reconciled.chargedUsd, '0.04240000'); assert.equal(reconciled.status, failed.status);
  assert.equal(reconciled.errorCode, failed.errorCode); assert.equal(reconciled.providerRequestId, failed.providerRequestId);
  const next = await fixture({ step: true }); const pendingBatch = await batch(next); await claimBatch(pendingBatch.batch.id, pendingBatch.generation);
  const pending = await nextPhotoBatchOperation(pendingBatch.batch.id, pendingBatch.generation);
  await claimSubmission(pending.jobId!); await attachProviderRequest(pending.jobId!, `receipt_${pending.jobId}`);
  const unchanged = await getJobForExecution(pending.jobId!);
  const deferred = await photoBatchBilling(pendingBatch.batch.id, actor, true, async requests => {
    assert.equal(requests.length, 0); return { status: 'verified', httpStatus: null, costs: {} };
  });
  assert.equal(deferred.totalCommitmentUsd, '0.00000000'); assert.equal(deferred.reconciledJobs, 0); assert.equal(deferred.pendingJobs, 1);
  assert.deepEqual(await getJobForExecution(pending.jobId!), unchanged);
});

test('reviewed zero-cost hero correction is immutable, generation-fenced, replayable and cannot change packet costs or source history', async () => {
  const recipe = await fixture({ hero: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const operation = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  await claimSubmission(operation.jobId!); await attachProviderRequest(operation.jobId!, `receipt_${operation.jobId}`);
  await failJob(operation.jobId!, { code: 'AI_TRANSPARENCY_MISSING', message: 'Retained opaque source fixture', uncertain: false, chargedUsd: '0.05', providerFinished: true });
  const mask = await nextPhotoBatchOperation(admission.batch.id, admission.generation); const sourceJobId = mask.jobId!;
  await claimSubmission(sourceJobId); await attachProviderRequest(sourceJobId, `receipt_${sourceJobId}`);
  // Synthetic accepted and completed SAM; no provider or storage requests.
  await finishAsset(sourceJobId, { blobPathname: `test/${sourceJobId}/cutout.png`, originalBlobPathname: `test/${sourceJobId}/archive.png`,
    width: 40, height: 40, contentType: 'image/png', alt: { pl: 'Potrawa', en: 'Dish' }, caption: { pl: '', en: '' }, hasTransparency: true }, { chargedUsd: '0.05', costBasis: 'usage' });
  const original = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 240, g: 180, b: 120, alpha: 1 } } }).png().toBuffer();
  const raw = await sharp(original).raw().toBuffer();
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) raw[(y * 40 + x) * 4 + 3] = x >= 5 && x < 35 && y >= 5 && y < 35 ? 255 : 0;
  const corrected = await sharp(raw, { raw: { width: 40, height: 40, channels: 4 } }).png().toBuffer();
  const directory = await mkdtemp(join(tmpdir(), 'jesie-reviewed-hero-')); const localPath = join(directory, 'corrected.png'); await writeFile(localPath, corrected);
  let uploads = 0; const io = { read: async () => original, ensure: async (pathname: string) => { uploads++; return pathname; } };
  const manifest: ReviewedHeroCorrection = { batchId: admission.batch.id, generation: admission.generation, expectedRevision: recipe.revision,
    sourceJobId, sourceAssetId: sourceJobId, sourceSha256: createHash('sha256').update(original).digest('hex'),
    sha256: createHash('sha256').update(corrected).digest('hex'), localPath, requestKey: randomUUID(), reviewNote: 'Reviewed closed bowl contour from same source.' };
  try {
    await assert.rejects(importReviewedHeroCorrection(manifest, actor, io), code('PHOTO_BATCH_CORRECTION_SCOPE')); assert.equal(uploads, 0);
    assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation)).state, 'done');
    const beforeJob = (await isolatedPool.query(`SELECT * FROM ai_job WHERE id=$1`, [sourceJobId])).rows[0];
    const beforeLedger = (await isolatedPool.query(`SELECT * FROM ai_cost_ledger WHERE job_id=$1 ORDER BY id`, [sourceJobId])).rows;
    const beforeBatch = await getPhotoBatch(admission.batch.id); const beforeBudget = await getConfiguration();
    await assert.rejects(importReviewedHeroCorrection({ ...manifest, generation: admission.generation + 1 }, actor, io), code('PHOTO_BATCH_CORRECTION_SCOPE'));
    const repaired = await importReviewedHeroCorrection(manifest, actor, io); assert.equal(uploads, 1);
    const repairedJob = repaired.slots[0].job!; assert.notEqual(repairedJob.id, sourceJobId); assert.equal(repairedJob.model, reviewedHeroCorrectionModel);
    assert.equal(repairedJob.reservedUsd, '0.00000000'); assert.equal(repairedJob.chargedUsd, '0.00000000'); assert.equal(repairedJob.providerRequestId, null);
    assert.equal(repaired.reservedUsd, beforeBatch.reservedUsd); assert.equal(repaired.remainingReservedUsd, beforeBatch.remainingReservedUsd);
    assert.equal((await getConfiguration()).budget.pilotUsedUsd, beforeBudget.budget.pilotUsedUsd);
    assert.deepEqual((await isolatedPool.query(`SELECT * FROM ai_job WHERE id=$1`, [sourceJobId])).rows[0], beforeJob);
    assert.deepEqual((await isolatedPool.query(`SELECT * FROM ai_cost_ledger WHERE job_id=$1 ORDER BY id`, [sourceJobId])).rows, beforeLedger);
    assert.equal((await importReviewedHeroCorrection(manifest, actor, io)).slots[0].job!.id, repairedJob.id); assert.equal(uploads, 1);
    const applied = await applyPhotoBatch(admission.batch.id, recipe.revision, actor);
    assert.equal(applied.recipe.content.recipe.image, repairedJob.result!.asset!.src); assert.equal(applied.recipe.publicationStatus, 'never_published');
    assert.equal((await importReviewedHeroCorrection(manifest, actor, io)).slots[0].job!.id, repairedJob.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('reviewed liquid cream reuse preserves prior costs and jobs, rejects the bad catalog image and applies the exact existing source without new photos', async () => {
  const originalRecipe = await fixture({ ingredient: true }); const sourceContent = structuredClone(originalRecipe.content);
  sourceContent.recipe.ingredients[0].name = { pl: 'śmietanka 30% lub 36%', en: 'whipping cream, 30–36% fat' };
  const sourceRecipe = await saveRecipe(originalRecipe.id, { expectedRevision: originalRecipe.revision, content: sourceContent }, actor);
  await approveRecipeContent(sourceRecipe.id, sourceRecipe.revision, actor);
  const source = (await createJobAdmission({ recipeId: sourceRecipe.id, expectedRevision: sourceRecipe.revision, kind: 'ingredient', targetId: 'ingredient',
    brief: 'Liquid cream fixture', requestKey: randomUUID() }, actor, undefined, { ingredientStyleProfile: paperIngredientStyleProfile })).job;
  await asset(source.id);
  const draft = await fixture({ ingredient: true }); const current = structuredClone(draft.content);
  current.recipe.ingredients[0].name = { pl: 'śmietanka 30%', en: 'whipping cream' };
  const targetRecipe = await saveRecipe(draft.id, { expectedRevision: draft.revision, content: current }, actor);
  await approveRecipeContent(targetRecipe.id, targetRecipe.revision, actor);
  const admission = await createCurrentPhotoBatch({ recipeId: targetRecipe.id, expectedRevision: targetRecipe.revision, requestKey: randomUUID() }, actor, { ingredientStyleProfile: paperIngredientStyleProfile });
  await claimBatch(admission.batch.id, admission.generation);
  const wrong = await nextPhotoBatchOperation(admission.batch.id, admission.generation); await asset(wrong.jobId!);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation)).state, 'done');
  const sourceBytes = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#faf8f2' } }).png().toBuffer();
  const manifest = { batchId: admission.batch.id, generation: admission.generation, expectedRevision: targetRecipe.revision, targetId: 'ingredient',
    replacedJobId: wrong.jobId!, sourceJobId: source.id, sourceAssetId: source.id, sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
    requestKey: randomUUID(), reviewNote: 'Visually reviewed unwhipped liquid cream jug, source range includes the target 30% cream.' };
  const io = { read: async () => sourceBytes, ensure: async () => { throw new Error('Reuse must not upload an image'); } };
  const before = (await isolatedPool.query(`SELECT * FROM ai_job WHERE id=$1`, [wrong.jobId])).rows[0];
  const beforeBudget = await getConfiguration();
  const corrected = await reuseReviewedLiquidCream(manifest, actor, io);
  const reuse = corrected.slots[0].job!; assert.equal(reuse.chargedUsd, '0.00000000'); assert.equal(reuse.providerRequestId, null);
  assert.equal(reuse.result!.reusedPhoto!.src, `/media/${source.id}`);
  assert.equal((await getConfiguration()).budget.pilotUsedUsd, beforeBudget.budget.pilotUsedUsd);
  assert.deepEqual((await isolatedPool.query(`SELECT * FROM ai_job WHERE id=$1`, [wrong.jobId])).rows[0], before);
  assert.equal((await isolatedPool.query(`SELECT eligibility FROM ingredient_image_catalog WHERE asset_id=$1`, [wrong.jobId])).rows[0].eligibility, 'rejected');
  assert.equal((await reuseReviewedLiquidCream(manifest, actor, io)).slots[0].job!.id, reuse.id);
  const applied = await applyPhotoBatch(admission.batch.id, targetRecipe.revision, actor);
  assert.equal(applied.recipe.content.photos.ingredients.ingredient.src, `/media/${source.id}`); assert.equal(applied.recipe.publicationStatus, 'never_published');
});

test('reviewed white wine replacement ignores spending limits and quarantines the wrong library photo before a single new paid claim', async () => {
  const draft = await fixture({ hero: true, ingredient: true }); const content = structuredClone(draft.content);
  content.recipe.ingredients[0].id = 'white_wine'; content.recipe.ingredients[0].name = { pl: 'wytrawne białe wino', en: 'dry white wine' };
  content.recipe.steps[0].text = { pl: 'Dodaj {{white_wine}}.', en: 'Add {{white_wine}}.' };
  const recipe = await saveRecipe(draft.id, { expectedRevision: draft.revision, content }, actor);
  await approveRecipeContent(recipe.id, recipe.revision, actor);
  const admission = await createCurrentPhotoBatch({ recipeId: recipe.id, expectedRevision: recipe.revision, requestKey: randomUUID() }, actor, { ingredientStyleProfile: paperIngredientStyleProfile });
  await claimBatch(admission.batch.id, admission.generation);
  const wrong = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  await claimSubmission(wrong.jobId!); await attachProviderRequest(wrong.jobId!, `receipt_${wrong.jobId}`);
  await finishAsset(wrong.jobId!, { blobPathname: `test/${wrong.jobId}/image.png`, width: 1024, height: 1024, contentType: 'image/png', alt: { pl: 'Białe wino', en: 'White wine' }, caption: { pl: '', en: '' }, hasTransparency: false, styleProfile: paperIngredientStyleProfile }, { chargedUsd: '0.5', costBasis: 'reservation' });
  const hero = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  await claimSubmission(hero.jobId!); await attachProviderRequest(hero.jobId!, `receipt_${hero.jobId}`);
  await finishAsset(hero.jobId!, { blobPathname: `test/${hero.jobId}/image.png`, width: 1024, height: 1024, contentType: 'image/png', alt: { pl: 'Potrawa', en: 'Dish' }, caption: { pl: '', en: '' }, hasTransparency: true }, { chargedUsd: '2', costBasis: 'reservation' });
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation)).state, 'done');
  const input = { generation: admission.generation, expectedRevision: recipe.revision, targetId: 'white_wine' as const, replacedJobId: wrong.jobId!,
    reviewNote: 'Clear liquid white wine, never dry flakes.', requestKey: randomUUID() };
  const before = (await isolatedPool.query(`SELECT * FROM ai_job WHERE id=$1`, [wrong.jobId])).rows[0];
  assert.equal((await isolatedPool.query(`SELECT eligibility FROM ingredient_image_catalog WHERE asset_id=$1`, [wrong.jobId])).rows[0].eligibility, 'usable');
  const replaced = await replaceReviewedBatchIngredient(admission.batch.id, input, actor);
  assert(replaced.dispatch); assert.equal(replaced.generation, admission.generation + 1); assert.equal(replaced.batch.remainingReservedUsd, '0.00000000');
  assert.equal((await replaceReviewedBatchIngredient(admission.batch.id, input, actor)).dispatch, false);
  assert.equal((await replaceReviewedBatchIngredient(admission.batch.id, { ...input, requestKey: randomUUID() }, actor)).dispatch, false);
  assert.deepEqual((await isolatedPool.query(`SELECT * FROM ai_job WHERE id=$1`, [wrong.jobId])).rows[0], before);
  assert.equal((await isolatedPool.query(`SELECT eligibility FROM ingredient_image_catalog WHERE asset_id=$1`, [wrong.jobId])).rows[0].eligibility, 'rejected');
  await claimBatch(admission.batch.id, replaced.generation);
  const operation = await nextPhotoBatchOperation(admission.batch.id, replaced.generation); assert.equal(operation.state, 'job'); assert.notEqual(operation.jobId, wrong.jobId);
  const newJob = await getJobForExecution(operation.jobId!); assert.equal(newJob.photoBatchId, admission.batch.id); assert.equal(newJob.reservedUsd, '0.00000000'); assert.equal(newJob.result, null);
  assert.equal((await claimSubmission(newJob.id)).shouldSubmit, true); await ensureSubmissionAllowed(newJob.id);
  assert.equal((await claimSubmission(newJob.id)).shouldSubmit, false);
  assert.equal((await getJobForExecution(newJob.id)).providerRequestId, null);
  await attachProviderRequest(newJob.id, `receipt_${newJob.id}`); await markProviderTerminal(newJob.id);
  const finished = await finishAsset(newJob.id, { blobPathname: `test/${newJob.id}/liquid-wine.png`, width: 1024, height: 1024, contentType: 'image/png',
    alt: { pl: 'Wytrawne białe wino', en: 'Dry white wine' }, caption: { pl: '', en: '' }, hasTransparency: false, styleProfile: paperIngredientStyleProfile });
  assert.equal(finished.status, 'ready'); assert.equal(finished.result!.asset!.src, `/media/${newJob.id}`);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, replaced.generation)).state, 'done');
  assert.equal((await isolatedPool.query(`SELECT eligibility FROM ingredient_image_catalog WHERE asset_id=$1`, [newJob.id])).rows[0].eligibility, 'usable');
  assert.equal((await isolatedPool.query(`SELECT eligibility FROM ingredient_image_catalog WHERE asset_id=$1`, [wrong.jobId])).rows[0].eligibility, 'rejected');
});

test('post-apply reviewed hero fix changes only the unapproved draft image and preserves the closed packet and every old source record', async () => {
  const recipe = await fixture({ hero: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const originalOperation = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  await claimSubmission(originalOperation.jobId!); await attachProviderRequest(originalOperation.jobId!, `receipt_${originalOperation.jobId}`);
  await failJob(originalOperation.jobId!, { code: 'AI_TRANSPARENCY_MISSING', message: 'Opaque source fixture', uncertain: false, chargedUsd: '0.05', providerFinished: true });
  const maskOperation = await nextPhotoBatchOperation(admission.batch.id, admission.generation); const sourceJobId = maskOperation.jobId!;
  await claimSubmission(sourceJobId); await attachProviderRequest(sourceJobId, `receipt_${sourceJobId}`);
  await finishAsset(sourceJobId, { blobPathname: `test/${sourceJobId}/cutout.png`, originalBlobPathname: `test/${sourceJobId}/archive.png`, width: 40, height: 40,
    contentType: 'image/png', alt: { pl: 'Potrawa', en: 'Dish' }, caption: { pl: '', en: '' }, hasTransparency: true }, { chargedUsd: '0.05', costBasis: 'usage' });
  await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  const saved = await applyPhotoBatch(admission.batch.id, recipe.revision, actor); const oldPacket = (await isolatedPool.query(`SELECT * FROM ai_photo_batch WHERE id=$1`, [admission.batch.id])).rows[0];
  const original = await sharp({ create: { width: 40, height: 40, channels: 4, background: '#f4b070' } }).png().toBuffer();
  const raw = await sharp(original).raw().toBuffer(); for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) raw[(y * 40 + x) * 4 + 3] = x >= 5 && x < 35 && y >= 5 && y < 35 ? 255 : 0;
  const corrected = await sharp(raw, { raw: { width: 40, height: 40, channels: 4 } }).png().toBuffer();
  const directory = await mkdtemp(join(tmpdir(), 'jesie-postapply-hero-')); const localPath = join(directory, 'corrected.png'); await writeFile(localPath, corrected);
  const input: ReviewedHeroCorrection = { batchId: admission.batch.id, generation: admission.generation, expectedRevision: saved.recipe.revision,
    sourceJobId, sourceAssetId: sourceJobId, sourceSha256: createHash('sha256').update(original).digest('hex'), sha256: createHash('sha256').update(corrected).digest('hex'),
    localPath, requestKey: randomUUID(), reviewNote: 'Same-source reviewed whole vessel outline.', applyToDraft: true };
  const beforeJob = (await isolatedPool.query(`SELECT * FROM ai_job WHERE id=$1`, [sourceJobId])).rows[0];
  const beforeBudget = await getConfiguration(); const io = { read: async () => original, ensure: async (pathname: string) => pathname };
  try {
    await importReviewedHeroCorrection(input, actor, io);
    const current = await getRecipe(recipe.id); const changed = structuredClone(saved.recipe.content); changed.recipe.image = current.content.recipe.image;
    assert.deepEqual(current.content, changed); assert.equal(current.revision, saved.recipe.revision + 1); assert.equal(current.publicationStatus, 'never_published'); assert.notEqual(current.editorialStatus, 'approved');
    assert.deepEqual((await isolatedPool.query(`SELECT * FROM ai_photo_batch WHERE id=$1`, [admission.batch.id])).rows[0], oldPacket);
    assert.deepEqual((await isolatedPool.query(`SELECT * FROM ai_job WHERE id=$1`, [sourceJobId])).rows[0], beforeJob);
    assert.equal((await getConfiguration()).budget.pilotUsedUsd, beforeBudget.budget.pilotUsedUsd);
    await importReviewedHeroCorrection(input, actor, io); assert.equal((await getRecipe(recipe.id)).revision, current.revision);
    await assert.rejects(importReviewedHeroCorrection({ ...input, expectedRevision: current.revision, requestKey: randomUUID() }, actor, io), code('DRAFT_PHOTO_CHANGED'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('trash stops photo orchestration, releases unadmitted remainder and queued children while preserving accepted receipt costs',async()=>{
  const recipe=await fixture({hero:true,ingredient:true,step:true});
  const baseline=Number((await getConfiguration()).budget.pilotUsedUsd);
  const admission=await batch(recipe);await claimBatch(admission.batch.id,admission.generation);
  const operation=await nextPhotoBatchOperation(admission.batch.id,admission.generation);assert.equal(operation.state,'job');assert.ok(operation.jobId);
  await claimSubmission(operation.jobId!);await attachProviderRequest(operation.jobId!,`receipt_${operation.jobId}`);
  const removed=await deleteRecipe(recipe.id,{expectedRevision:recipe.revision},actor);
  const stopped=await getPhotoBatch(admission.batch.id);
  assert.equal(stopped.status,'failed');assert.equal(Number(stopped.remainingReservedUsd),0);assert.equal(stopped.errorCode,'RECIPE_DELETED');
  assert.equal(stopped.canResume,false);assert.equal(stopped.canApply,false);
  assert.equal((await getConfiguration()).budget.pilotUsedUsd,baseline.toFixed(8));
  assert.equal((await nextPhotoBatchOperation(admission.batch.id,admission.generation)).state,'done');
  assert.equal(await claimPhotoBatchWorkflow(admission.batch.id,admission.generation,'late-worker'),false);
  await assert.rejects(resumePhotoBatch(admission.batch.id,actor),code('RECIPE_DELETED'));
  await assert.rejects(createPhotoBatch({recipeId:recipe.id,expectedRevision:removed.revision,requestKey:randomUUID()},actor),code('RECIPE_DELETED'));
  await assert.rejects(applyPhotoBatch(admission.batch.id,removed.revision,actor),code('RECIPE_DELETED'));
  await claimedAsset(operation.jobId!);
  assert.equal((await getJobForExecution(operation.jobId!)).status,'ready');
  assert.equal((await getConfiguration()).budget.pilotUsedUsd,(baseline+0.05).toFixed(8));

  const queuedRecipe=await fixture({ingredient:true,step:true});
  const queuedBaseline=Number((await getConfiguration()).budget.pilotUsedUsd);
  const queuedAdmission=await batch(queuedRecipe);await claimBatch(queuedAdmission.batch.id,queuedAdmission.generation);
  const queuedOperation=await nextPhotoBatchOperation(queuedAdmission.batch.id,queuedAdmission.generation);assert.ok(queuedOperation.jobId);
  await deleteRecipe(queuedRecipe.id,{expectedRevision:queuedRecipe.revision},actor);
  const cancelled=await getJobForExecution(queuedOperation.jobId!);
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.chargedUsd,'0.00000000');assert.ok(cancelled.providerFinishedAt);
  assert.equal(Number((await getConfiguration()).budget.pilotUsedUsd),queuedBaseline);
});

test('restoration preserves a ready photo package and permits its existing result without another generation',async()=>{
  const recipe=await fixture({ingredient:true});
  const admission=await batch(recipe);await claimBatch(admission.batch.id,admission.generation);
  const operation=await nextPhotoBatchOperation(admission.batch.id,admission.generation);assert.ok(operation.jobId);
  await asset(operation.jobId!);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id,admission.generation)).state,'done');
  assert.equal((await getPhotoBatch(admission.batch.id)).status,'ready');
  const costBefore=(await getConfiguration()).budget.pilotUsedUsd;
  const removed=await deleteRecipe(recipe.id,{expectedRevision:recipe.revision},actor);
  const trashed=await getPhotoBatch(admission.batch.id);assert.equal(trashed.status,'ready');assert.equal(trashed.canApply,false);
  await assert.rejects(applyPhotoBatch(admission.batch.id,removed.revision,actor),code('RECIPE_DELETED'));
  const restored=await performRecipeAction(recipe.id,{action:'restore_deleted',expectedRevision:removed.revision},actor);
  assert.equal((await getPhotoBatch(admission.batch.id)).canApply,true);
  const applied=await applyPhotoBatch(admission.batch.id,restored.revision,actor);
  assert.ok(applied.recipe.content.photos.ingredients.ingredient);assert.equal(applied.recipe.editorialStatus,'draft');
  assert.equal((await getConfiguration()).budget.pilotUsedUsd,costBefore);
  assert.equal((await isolatedPool.query('SELECT count(*)::int n FROM ai_job WHERE recipe_id=$1 AND photo_batch_id=$2',[recipe.id,admission.batch.id])).rows[0].n,1);
});

async function failMask(id: string, generation: number) {
  const original = await nextPhotoBatchOperation(id, generation);
  assert.equal((await claimSubmission(original.jobId!)).shouldSubmit, true);
  await attachProviderRequest(original.jobId!, `receipt_${original.jobId}`);
  await failJob(original.jobId!, { code: 'AI_TRANSPARENCY_MISSING', message: 'Transparency missing', uncertain: false, chargedUsd: '0.05', providerFinished: true });
  const correction = await nextPhotoBatchOperation(id, generation);
  assert.equal((await getJobForExecution(correction.jobId!)).model, heroCutoutModel);
  assert.equal((await claimSubmission(correction.jobId!)).shouldSubmit, true);
  await attachProviderRequest(correction.jobId!, `receipt_${correction.jobId}`);
  await failJob(correction.jobId!, { code: 'AI_MASK_NOT_FOUND', message: 'Dostawca nie zwrócił maski wycięcia.', uncertain: false, chargedUsd: '0.01', providerFinished: true });
  return { originalId: original.jobId!, correctionId: correction.jobId! };
}

test('one admission reserves the entire package atomically and double clicks share it', async () => {
  const recipe = await fixture({ hero: true, ingredient: true, step: true });
  const input = { recipeId: recipe.id, expectedRevision: recipe.revision, requestKey: randomUUID() };
  const created = await Promise.all([createPhotoBatch(input, actor), createPhotoBatch(input, actor), createPhotoBatch({ ...input, requestKey: randomUUID() }, actor)]);
  assert.equal(created.filter(item => item.created).length, 1);
  assert.equal(new Set(created.map(item => item.batch.id)).size, 1);
  assert.equal(created[0].batch.reservedUsd, '0.00000000');
  assert.equal(created[0].batch.progress.total, 3);
  assert.equal((await getConfiguration()).budget.activeJobs, 0);
  const replay = await createPhotoBatch(input, actor); assert.equal(replay.created, false); assert.equal(replay.batch.status, 'queued');
  await claimBatch(replay.batch.id, replay.generation);
  assert.equal(await claimPhotoBatchWorkflow(replay.batch.id, replay.generation, 'duplicate-workflow'), false);
  await assert.rejects(createPhotoBatch({ ...input, expectedRevision: recipe.revision + 1 }, actor), code('REQUEST_KEY_REUSED'));
  await assert.rejects(isolatedPool.query('UPDATE ai_photo_batch SET input=$1 WHERE id=$2', [{ ...recipe.content, originalText: 'Changed capture' }, created[0].batch.id]), /immutable/);
});

test('new photographs require explicit cooking-text approval and edits revoke permission before a paid POST', async () => {
  const prepared = await fixture({ ingredient: true });
  const content = structuredClone(prepared.content); content.recipe.description.pl += ' Nowy wariant do sprawdzenia.';
  const changed = await saveRecipe(prepared.id, { expectedRevision: prepared.revision, content }, actor);
  assert.equal(await isRecipeContentApproved(changed), false);
  await assert.rejects(batch(changed), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'CONTENT_APPROVAL_REQUIRED'));
  const approval = await approveRecipeContent(changed.id, changed.revision, { ...actor, name: 'Forged name' });
  assert.equal(approval.approvedBy, actor.id);
  assert.equal((await getRecipe(changed.id)).revision, changed.revision);
  const receipt = (await isolatedPool.query('SELECT actor_name FROM editorial_content_approval WHERE recipe_id=$1 AND content_hash=$2', [changed.id, approval.contentHash])).rows[0];
  assert.equal(receipt.actor_name, 'Stored batch owner');
  const admission = await batch(changed); await claimBatch(admission.batch.id, admission.generation);
  const operation = await nextPhotoBatchOperation(admission.batch.id, admission.generation); await claimSubmission(operation.jobId!);
  const revised = structuredClone(changed.content); revised.recipe.steps[0].text.en += ' Drain before serving.';
  const edited = await saveRecipe(changed.id, { expectedRevision: changed.revision, content: revised }, actor);
  await assert.rejects(ensureSubmissionAllowed(operation.jobId!), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'CONTENT_APPROVAL_REQUIRED'));
  assert.equal((await getJobForExecution(operation.jobId!)).providerRequestId, null);
  await approveRecipeContent(edited.id, edited.revision, actor);
  await assert.rejects(ensureSubmissionAllowed(operation.jobId!), code('PHOTO_CONTENT_CHANGED'));
  // A late receipt from an earlier transport remains recoverable after edits;
  // the absence of fresh approval must never turn recovery into another POST.
  await attachProviderRequest(operation.jobId!, `late_receipt_${operation.jobId}`);
  assert.equal((await claimSubmission(operation.jobId!)).shouldSubmit, false);
  await claimedAsset(operation.jobId!);
  assert.equal((await getJobForExecution(operation.jobId!)).status, 'ready');
});

test('a missing final presentation can be saved before approval and unlocks photos only for the reviewed revision', async () => {
  const initial = await fixture({ hero: true, libraryIngredient: true });
  const incomplete = structuredClone(initial.content);
  incomplete.recipe.heroPresentation = null;
  incomplete.recipe.steps[0].text = { pl: 'Wymieszaj {{ingredient}} i podaj w szklance.', en: 'Mix {{ingredient}} and serve in a glass.' };
  const unresolved = await saveRecipe(initial.id, { expectedRevision: initial.revision, content: incomplete }, actor);
  assert.equal(await isRecipeContentApproved(unresolved), false);
  await assert.rejects(approveRecipeContent(unresolved.id, unresolved.revision, actor), (error: unknown) => {
    assert(error instanceof EditorialError);
    assert.equal(error.code, 'CONTENT_REVIEW_REQUIRED');
    assert(error.issues?.some(issue => issue.field === 'heroPresentation'));
    return true;
  });
  await assert.rejects(batch(unresolved), (error: unknown) => error instanceof EditorialError && error.code === 'CONTENT_APPROVAL_REQUIRED');

  const completed = structuredClone(unresolved.content);
  completed.recipe.heroPresentation = { container: 'glass', profileVersion: 'jesie-finished-dish-v2',
    finalAppearance: { pl: 'Gotowa potrawa podana w przezroczystej szklance.', en: 'The finished food served in a clear drinking glass.' },
    evidenceStepIds: ['step'] };
  const saved = await saveRecipe(unresolved.id, { expectedRevision: unresolved.revision, content: completed }, actor);
  assert.equal(saved.revision, unresolved.revision + 1);
  assert.deepEqual(saved.content.recipe.heroPresentation, completed.recipe.heroPresentation);
  assert.equal(await isRecipeContentApproved(saved), false, 'Saving settings must not approve them for the editor.');
  await assert.rejects(approveRecipeContent(saved.id, unresolved.revision, actor), (error: unknown) => error instanceof EditorialError && error.code === 'REVISION_CONFLICT');
  await assert.rejects(batch(saved), (error: unknown) => error instanceof EditorialError && error.code === 'CONTENT_APPROVAL_REQUIRED');
  await approveRecipeContent(saved.id, saved.revision, actor);
  assert.equal(await isRecipeContentApproved(saved), true);

  const admission = await batch(saved);
  assert.equal(admission.batch.slots.length, 1);
  assert.equal(admission.batch.slots[0].kind, 'hero');
  assert.equal((await getRecipe(saved.id)).revision, saved.revision, 'Photo admission does not rewrite the reviewed draft.');
  await claimBatch(admission.batch.id, admission.generation);
  const operation = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  const captured = await getJobForExecution(operation.jobId!);
  assert.deepEqual(captured.input.recipe.heroPresentation, completed.recipe.heroPresentation);
  assert.equal((await claimSubmission(captured.id)).shouldSubmit, true);

  const changed = structuredClone(saved.content);
  changed.recipe.heroPresentation!.finalAppearance.en += ' A changed serving arrangement.';
  const revised = await saveRecipe(saved.id, { expectedRevision: saved.revision, content: changed }, actor);
  assert.equal(await isRecipeContentApproved(revised), false);
  await assert.rejects(ensureSubmissionAllowed(captured.id), (error: unknown) => error instanceof EditorialError && error.code === 'CONTENT_APPROVAL_REQUIRED');
  await approveRecipeContent(revised.id, revised.revision, actor);
  await assert.rejects(ensureSubmissionAllowed(captured.id), code('PHOTO_CONTENT_CHANGED'));
  assert.equal((await getJobForExecution(captured.id)).providerRequestId, null, 'The workflow never sent a paid provider request.');
});

test('one content approval saves the reviewed vessel and appearance atomically without exposing evidence or starting photos', async () => {
  const initial = await fixture({ hero: true, libraryIngredient: true });
  const incomplete = structuredClone(initial.content); incomplete.recipe.heroPresentation = null;
  incomplete.recipe.steps[0].text = { pl: 'Wymieszaj {{ingredient}} i podaj w szklance.', en: 'Mix {{ingredient}} and serve in a glass.' };
  const unresolved = await saveRecipe(initial.id, { expectedRevision: initial.revision, content: incomplete }, actor);
  const visible = { container: 'glass' as const, finalAppearance: { pl: 'Jasna gotowa potrawa w przezroczystej szklance.', en: 'Pale finished food in a clear glass.' } };
  const snapshot = async () => ({
    recipe: await getRecipe(unresolved.id),
    approvals: (await isolatedPool.query('SELECT * FROM editorial_content_approval WHERE recipe_id=$1 ORDER BY content_hash', [unresolved.id])).rows,
    audit: (await isolatedPool.query('SELECT * FROM editorial_audit WHERE recipe_id=$1 ORDER BY revision,id', [unresolved.id])).rows,
    jobs: (await isolatedPool.query('SELECT id,provider_request_id FROM ai_job WHERE recipe_id=$1 ORDER BY id', [unresolved.id])).rows,
  });
  const before = await snapshot();
  await assert.rejects(approveRecipeContent(unresolved.id, unresolved.revision, actor, { ...visible, finalAppearance: { ...visible.finalAppearance, en: '' } }),
    (error: unknown) => error instanceof EditorialError && error.code === 'INVALID_HERO_PRESENTATION');
  await assert.rejects(approveRecipeContent(unresolved.id, unresolved.revision, actor, { ...visible, evidenceStepIds: ['client-step'] } as typeof visible),
    (error: unknown) => error instanceof EditorialError && error.code === 'INVALID_HERO_PRESENTATION');
  assert.deepEqual(await snapshot(), before, 'Rejected approval must write neither the edit nor an approval/history receipt.');

  const approval = await approveRecipeContent(unresolved.id, unresolved.revision, { ...actor, name: 'Forged actor name' }, visible);
  const approved = await getRecipe(unresolved.id);
  assert.equal(approved.revision, unresolved.revision + 1);
  assert.equal(await isRecipeContentApproved(approved), true);
  assert.deepEqual(approved.content.recipe.heroPresentation, { ...visible, evidenceStepIds: ['step'], profileVersion: 'jesie-finished-dish-v2' });
  assert.equal(approved.publicationStatus, 'never_published');
  assert.equal(approved.editorialStatus, 'draft');
  const after = await snapshot();
  assert.deepEqual(after.jobs, before.jobs, 'Approval cannot admit photographs or submit a provider request.');
  assert.equal(after.audit.length, before.audit.length + 1);
  const receipt = (await isolatedPool.query('SELECT revision,actor_name FROM editorial_content_approval WHERE recipe_id=$1 AND content_hash=$2', [approved.id, approval.contentHash])).rows[0];
  assert.equal(receipt.revision, approved.revision); assert.equal(receipt.actor_name, 'Stored batch owner');
  await approveRecipeContent(approved.id, approved.revision, actor, visible);
  assert.deepEqual(await snapshot(), after, 'Reaccepting the same visible settings does not invent another editorial revision.');
  await assert.rejects(approveRecipeContent(approved.id, unresolved.revision, actor, visible),
    (error: unknown) => error instanceof EditorialError && error.code === 'REVISION_CONFLICT');

  const admission = await batch(approved);
  const changed = { ...visible, finalAppearance: { ...visible.finalAppearance, en: visible.finalAppearance.en + ' Changed arrangement.' } };
  await assert.rejects(approveRecipeContent(approved.id, approved.revision, actor, changed),
    (error: unknown) => error instanceof EditorialError && error.code === 'GENERATION_PENDING');
  assert.equal((await getRecipe(approved.id)).revision, approved.revision);
  await claimBatch(admission.batch.id, admission.generation);
  const operation = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  const captured = await getJobForExecution(operation.jobId!);
  assert.deepEqual(captured.input.recipe.heroPresentation, approved.content.recipe.heroPresentation);
  assert.equal(captured.providerRequestId, null);
});

test('historical hero-first packets retain child request indexes while the selector follows the new phase order', async () => {
  const recipe = await fixture({ hero: true, ingredient: true, step: true }); const original = await batch(recipe);
  const id = randomUUID();
  await isolatedPool.query("UPDATE ai_photo_batch SET status='failed',remaining_reserved_usd=0 WHERE id=$1", [original.batch.id]);
  await isolatedPool.query(`INSERT INTO ai_photo_batch(id,recipe_id,base_revision,input,input_hash,slots,status,request_key,created_by,created_by_name,reserved_usd,remaining_reserved_usd)
    SELECT $1,recipe_id,base_revision,input,input_hash,jsonb_build_array(slots->2,slots->0,slots->1),'queued',$2,created_by,created_by_name,reserved_usd,reserved_usd FROM ai_photo_batch WHERE id=$3`, [id, randomUUID(), original.batch.id]);
  await claimBatch(id, 1);
  const ingredient = await nextPhotoBatchOperation(id, 1);
  assert.equal((await getJobForExecution(ingredient.jobId!)).requestKey, `photo_batch_${id}_1`);
  await asset(ingredient.jobId!);
  const step = await nextPhotoBatchOperation(id, 1);
  assert.equal((await getJobForExecution(step.jobId!)).requestKey, `photo_batch_${id}_2`);
  await asset(step.jobId!);
  const hero = await nextPhotoBatchOperation(id, 1);
  assert.equal((await getJobForExecution(hero.jobId!)).requestKey, `photo_batch_${id}_0`);
  await asset(hero.jobId!);
});

test('an already finished compatible hero survives the new phase order without another hero generation', async () => {
  const recipe = await fixture({ hero: true, ingredient: true, step: true });
  const hero = await createJob({ recipeId: recipe.id, expectedRevision: recipe.revision, kind: 'hero', brief: 'Existing finished photograph', requestKey: randomUUID() }, actor);
  await asset(hero.id);
  const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  assert.equal(admission.batch.slots.find(slot => slot.kind === 'hero')?.job?.id, hero.id);
  const ingredient = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  assert.equal((await getJobForExecution(ingredient.jobId!)).kind, 'ingredient'); await asset(ingredient.jobId!);
  const step = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  assert.equal((await getJobForExecution(step.jobId!)).kind, 'step'); await asset(step.jobId!);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation)).state, 'done');
  const ready = await getPhotoBatch(admission.batch.id);
  assert.equal(ready.status, 'ready'); assert.equal(ready.slots.find(slot => slot.kind === 'hero')?.job?.id, hero.id);
  assert.equal(Number((await isolatedPool.query("SELECT count(*) FROM ai_job WHERE recipe_id=$1 AND kind='hero'", [recipe.id])).rows[0].count), 1);
});

test('ingredients precede steps and final hero; previews stay private until one atomic draft apply', async () => {
  const recipe = await fixture({ hero: true, ingredient: true, step: true }); const admission = await batch(recipe);
  await claimBatch(admission.batch.id, admission.generation);
  const ingredient = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  assert.equal((await getJobForExecution(ingredient.jobId!)).kind, 'ingredient');
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation, [ingredient.jobId!])).state, 'waiting');
  assert.equal((await getJobForExecution(ingredient.jobId!)).input.recipe.image, '');
  await asset(ingredient.jobId!);
  const step = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  assert.equal((await getJobForExecution(step.jobId!)).kind, 'step');
  assert.equal((await getJobForExecution(step.jobId!)).input.recipe.image, '');
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation, [step.jobId!])).state, 'waiting');
  await asset(step.jobId!);
  const hero = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  assert.equal((await getJobForExecution(hero.jobId!)).kind, 'hero');
  const finishedHero = await asset(hero.jobId!);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation)).state, 'done');
  const ready = await getPhotoBatch(admission.batch.id); assert.equal(ready.status, 'ready'); assert.equal(ready.progress.completed, 3);
  assert.equal((await getRecipe(recipe.id)).content.recipe.image, '');
  const applied = await applyPhotoBatch(admission.batch.id, recipe.revision, actor);
  assert.equal(applied.recipe.revision, recipe.revision + 1); assert.equal(applied.recipe.publicationStatus, 'never_published');
  assert.equal(applied.recipe.content.recipe.image, finishedHero.result!.asset!.src);
  assert.ok(applied.recipe.content.photos.ingredients.ingredient); assert.ok(applied.recipe.content.photos.steps.step);
  assert.equal(await isRecipeContentApproved(applied.recipe), true, 'Media-only application preserves the accepted cooking text.');
  assert.equal((await applyPhotoBatch(admission.batch.id, recipe.revision, actor)).recipe.revision, applied.recipe.revision);
});

test('parallel waves wait for the whole ingredient and step phase before the exclusive final hero', async () => {
  const draft = await fixture({ hero: true, ingredient: true, secondIngredient: true, step: true, secondStep: true });
  const content = structuredClone(draft.content);
  delete content.recipe.heroPresentation;
  content.recipe.steps[1].text = {
    pl: 'Delikatnie wymieszaj potrawę. Podaj gotową potrawę w glinianym garnku. Na wierzchu ułóż marynowane żółtko.',
    en: 'Stir the food gently. Serve the finished dish in the clay pot. Place the cured egg yolk on top.',
  };
  const recipe = await saveRecipe(draft.id, { expectedRevision: draft.revision, content }, actor);
  await approveRecipeContent(recipe.id, recipe.revision, actor);
  const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const capturedPacket = (await isolatedPool.query('SELECT input FROM ai_photo_batch WHERE id=$1', [admission.batch.id])).rows[0].input as EditorialContent;
  const legacyPresentation = resolveHeroPresentation(recipe.content.recipe)!;
  assert.equal(legacyPresentation.container, 'plate');
  assert.deepEqual(capturedPacket.recipe.heroPresentation, legacyPresentation);
  assert.equal(capturedPacket.aiPhotography?.heroPresentationOverride?.container, 'clay-pot');
  assert.match(capturedPacket.aiPhotography!.heroPresentationOverride!.finalAppearance.en, /cured egg yolk/iu);
  const nextWave = () => nextPhotoBatchWave(admission.batch.id, admission.generation);
  const ingredients = await nextWave(); assert.equal(ingredients.state, 'jobs'); if (ingredients.state !== 'jobs') return;
  assert.deepEqual(ingredients.jobs.map(job => job.kind), ['ingredient', 'ingredient']);
  await asset(ingredients.jobs[0].jobId);
  const waitingIngredient = await nextWave(); assert.equal(waitingIngredient.state, 'jobs'); if (waitingIngredient.state !== 'jobs') return;
  assert.deepEqual(waitingIngredient.jobs.map(job => job.jobId), [ingredients.jobs[1].jobId]);
  assert.equal(Number((await isolatedPool.query("SELECT count(*) FROM ai_job WHERE photo_batch_id=$1 AND kind IN ('step','hero')", [admission.batch.id])).rows[0].count), 0);
  await asset(ingredients.jobs[1].jobId);
  const steps = await nextWave(); assert.equal(steps.state, 'jobs'); if (steps.state !== 'jobs') return;
  assert.deepEqual(steps.jobs.map(job => job.kind), ['step', 'step']);
  await asset(steps.jobs[0].jobId);
  const waitingStep = await nextWave(); assert.equal(waitingStep.state, 'jobs'); if (waitingStep.state !== 'jobs') return;
  assert.deepEqual(waitingStep.jobs.map(job => job.jobId), [steps.jobs[1].jobId]);
  assert.equal(Number((await isolatedPool.query("SELECT count(*) FROM ai_job WHERE photo_batch_id=$1 AND kind='hero'", [admission.batch.id])).rows[0].count), 0);
  await asset(steps.jobs[1].jobId);
  const final = await nextWave(); assert.equal(final.state, 'jobs'); if (final.state !== 'jobs') return;
  assert.deepEqual(final.jobs.map(job => job.kind), ['hero']);
  const capturedHero = await getJobForExecution(final.jobs[0].jobId);
  assert.deepEqual(capturedHero.input.recipe.heroPresentation, legacyPresentation);
  assert.deepEqual(capturedHero.input.aiPhotography?.heroPresentationOverride, capturedPacket.aiPhotography?.heroPresentationOverride);
  assert.deepEqual(capturedHero.input.recipe.steps, recipe.content.recipe.steps);
  assert.equal(capturedHero.input.originalText, recipe.content.originalText);
  await asset(final.jobs[0].jobId);
  assert.equal((await nextWave()).state, 'done');
  assert.equal((await getPhotoBatch(admission.batch.id)).status, 'ready');
});

test('library-only package costs zero with no image credentials and preserves existing photos', async () => {
  const recipe = await fixture({ ingredient: true, libraryIngredient: true });
  delete process.env.FAL_KEY; delete process.env.FAL_API_KEY; delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const admission = await batch(recipe); assert.equal(admission.batch.reservedUsd, '0.00000000');
    await claimBatch(admission.batch.id, admission.generation);
    assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation)).state, 'done');
    const ready = await getPhotoBatch(admission.batch.id); assert.equal(ready.slots[0].job!.result!.reuse!.source, 'library');
    const applied = await applyPhotoBatch(admission.batch.id, recipe.revision, actor);
    assert.equal(applied.recipe.content.recipe.image, recipe.content.recipe.image);
    assert.deepEqual(applied.recipe.content.photos.steps, recipe.content.photos.steps);
  } finally { process.env.FAL_KEY = 'test-unused'; process.env.BLOB_READ_WRITE_TOKEN = 'test-unused'; }
});

test('identical missing ingredients reserve one paid source and share the verified cutout', async () => {
  const recipe = await fixture({ ingredient: true, duplicateIngredient: true }); const admission = await batch(recipe);
  assert.equal(admission.batch.reservedUsd, '0.00000000');
  await claimBatch(admission.batch.id, admission.generation);
  const first = await nextPhotoBatchOperation(admission.batch.id, admission.generation); await asset(first.jobId!);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation)).state, 'done');
  const ready = await getPhotoBatch(admission.batch.id);
  assert.equal(ready.slots[1].job!.chargedUsd, '0.00000000');
  assert.equal(ready.slots[1].job!.result!.reusedPhoto!.src, ready.slots[0].job!.result!.asset!.src);
});

test('concurrent packages follow one existing ingredient producer with receipt-only resolution', async () => {
  const firstRecipe = await fixture({ ingredient: true });
  const first = await batch(firstRecipe); await claimBatch(first.batch.id, first.generation);
  const producer = await nextPhotoBatchOperation(first.batch.id, first.generation);
  const secondRecipe = await fixture({ ingredient: true }); const matched = structuredClone(secondRecipe.content);
  matched.recipe.ingredients[0].name = firstRecipe.content.recipe.ingredients[0].name;
  const secondSaved = await saveRecipe(secondRecipe.id, { expectedRevision: secondRecipe.revision, content: matched }, actor);
  await approveRecipeContent(secondSaved.id, secondSaved.revision, actor);
  const second = await batch(secondSaved); assert.equal(second.batch.reservedUsd, '0.00000000');
  await claimBatch(second.batch.id, second.generation);
  const follower = await nextPhotoBatchOperation(second.batch.id, second.generation);
  assert.equal((await getJobForExecution(follower.jobId!)).reuseSourceJobId, producer.jobId);
  assert.equal((await claimSubmission(follower.jobId!)).shouldSubmit, false);
  assert.equal(await resolveIngredientReuse(follower.jobId!), false);
  await asset(producer.jobId!);
  assert.equal(await resolveIngredientReuse(follower.jobId!), true);
  assert.equal((await nextPhotoBatchOperation(second.batch.id, second.generation)).state, 'done');
  assert.equal((await getPhotoBatch(second.batch.id)).slots[0].job!.chargedUsd, '0.00000000');
});

test('disabled spending limits allow zero-reservation packages while global claimed concurrency remains bounded', async () => {
  const recipe = await fixture({ hero: true, ingredient: true, step: true });
  const used = Number((await getConfiguration()).budget.dailyUsedUsd);
  process.env.AI_DAILY_LIMIT_USD = (used + 6).toFixed(8);
  let admission;
  try { admission = await batch(recipe); assert.equal(admission.batch.reservedUsd, '0.00000000'); }
  finally { process.env.AI_DAILY_LIMIT_USD = '1000'; }
  await claimBatch(admission.batch.id, admission.generation);
  const regular = await Promise.all([createJob({ recipeId: recipe.id, expectedRevision: recipe.revision, kind: 'recipe', brief: 'Other generation one', requestKey: randomUUID() }, actor), createJob({ recipeId: recipe.id, expectedRevision: recipe.revision, kind: 'recipe', brief: 'Other generation two', requestKey: randomUUID() }, actor)]);
  const operation = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  assert.equal((await claimSubmission(operation.jobId!)).shouldSubmit, false);
  assert.equal((await getJobForExecution(operation.jobId!)).status, 'queued');
  await failJob(regular[0].id, { code: 'TEST_UNSENT', message: 'Not sent', uncertain: false, chargedUsd: '0', providerFinished: true });
  assert.equal((await claimSubmission(operation.jobId!)).shouldSubmit, true);
  assert.equal((await getConfiguration()).budget.activeJobs, 2);
});

test('zero reservations still require providers for new photos and permit completed no-work packages without them', async () => {
  const missing = await fixture({ step: true }); const completed = await fixture();
  const credentials = { FAL_KEY: process.env.FAL_KEY, FAL_API_KEY: process.env.FAL_API_KEY, BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN };
  delete process.env.FAL_KEY; delete process.env.FAL_API_KEY; delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    await assert.rejects(batch(missing), code('PROVIDER_NOT_CONFIGURED'));
    assert.equal((await isolatedPool.query('SELECT count(*) FROM ai_photo_batch WHERE recipe_id=$1', [missing.id])).rows[0].count, '0');
    const free = await batch(completed);
    assert.equal(free.batch.status, 'ready'); assert.equal(free.batch.reservedUsd, '0.00000000');
    assert.equal(free.batch.slots.length, 0);
  } finally {
    for (const [key, value] of Object.entries(credentials)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('unconfirmed paid acceptance remains blocked through explicit resume and has no second claim', async () => {
  const recipe = await fixture({ hero: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const operation = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  assert.equal((await claimSubmission(operation.jobId!)).shouldSubmit, true);
  assert.equal((await claimSubmission(operation.jobId!)).shouldSubmit, false);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation)).state, 'blocked');
  await stopPhotoBatch(admission.batch.id, admission.generation, 'SUBMISSION_UNCERTAIN', 'Unknown acceptance');
  const resumed = await resumePhotoBatch(admission.batch.id, actor); await claimBatch(resumed.batch.id, resumed.generation);
  assert.equal((await nextPhotoBatchOperation(resumed.batch.id, resumed.generation)).state, 'blocked');
  assert.equal((await claimSubmission(operation.jobId!)).shouldSubmit, false);
});

test('active packages only restart against matching terminal worker evidence; racing recovery dispatches once', async () => {
  const recipe = await fixture({ hero: true, step: true }); const admission = await batch(recipe);
  assert.equal((await getPhotoBatch(admission.batch.id)).canResume, true);
  assert.equal((await resumePhotoBatch(admission.batch.id, actor)).dispatch, false);
  await claimBatch(admission.batch.id, admission.generation);
  const operation = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  await claimSubmission(operation.jobId!); await attachProviderRequest(operation.jobId!, `receipt_${operation.jobId}`);
  await failJob(operation.jobId!, { code: 'READ_TIMEOUT', message: 'Read stopped after acceptance', uncertain: true });
  const state = await getPhotoBatchRecoveryState(admission.batch.id);
  assert.equal(state.workflowRunId, `workflow-${admission.batch.id}-${admission.generation}`);
  const evidence: PhotoBatchWorkflowEvidence = { generation: state.generation, runId: state.workflowRunId, status: 'failed' };
  for (const incorrect of [
    { ...evidence, generation: state.generation + 1 }, { ...evidence, runId: 'different-worker' },
    { ...evidence, status: 'running' as PhotoBatchWorkflowEvidence['status'] },
  ]) {
    const checked = await resumePhotoBatch(admission.batch.id, actor, incorrect);
    assert.equal(checked.dispatch, false); assert.equal(checked.generation, admission.generation);
  }
  assert.equal((await resumePhotoBatch(admission.batch.id, actor)).dispatch, false);
  const before = await getPhotoBatch(admission.batch.id); const cost = (await getConfiguration()).budget.pilotUsedUsd;
  const recoveries = await Promise.all([resumePhotoBatch(admission.batch.id, actor, evidence), resumePhotoBatch(admission.batch.id, actor, evidence), resumePhotoBatch(admission.batch.id, actor, evidence)]);
  assert.equal(recoveries.filter(result => result.dispatch).length, 1);
  assert.deepEqual(recoveries.map(result => result.generation), [admission.generation + 1, admission.generation + 1, admission.generation + 1]);
  const recovered = await getPhotoBatch(admission.batch.id);
  assert.equal(recovered.remainingReservedUsd, before.remainingReservedUsd);
  assert.deepEqual(recovered.slots.map(slot => slot.job?.id), before.slots.map(slot => slot.job?.id));
  assert.equal((await getConfiguration()).budget.pilotUsedUsd, cost);
  assert.equal(Number((await isolatedPool.query('SELECT count(*) FROM ai_job WHERE photo_batch_id=$1', [admission.batch.id])).rows[0].count), 1);
  assert.equal((await getPhotoBatchRecoveryState(admission.batch.id)).workflowRunId, null);
  assert.equal(await claimPhotoBatchWorkflow(admission.batch.id, admission.generation, state.workflowRunId!), false);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation)).state, 'done');
  await claimBatch(admission.batch.id, admission.generation + 1);
  const resumedJob = await nextPhotoBatchOperation(admission.batch.id, admission.generation + 1);
  assert.equal(resumedJob.state, 'job'); if (resumedJob.state !== 'job') return;
  assert.equal(resumedJob.jobId, operation.jobId); assert.equal(resumedJob.submit, false); assert.equal(resumedJob.receipt, true);
  assert.equal((await claimSubmission(operation.jobId!)).shouldSubmit, false);
  assert.equal((await getJobForExecution(operation.jobId!)).providerRequestId, `receipt_${operation.jobId}`);
});

test('a missing unclaimed worker requires matching evidence and only one concurrent recovery dispatch', async () => {
  const recipe = await fixture({ step: true }); const admission = await batch(recipe);
  const state = await getPhotoBatchRecoveryState(admission.batch.id);
  const evidence: PhotoBatchWorkflowEvidence = { generation: state.generation, runId: null, status: 'missing' };
  assert.equal((await resumePhotoBatch(admission.batch.id, actor, evidence)).dispatch, false);
  assert.equal(typeof state.updatedAt, 'string');
  await isolatedPool.query("UPDATE ai_photo_batch SET updated_at=now()-interval '3 minutes' WHERE id=$1", [admission.batch.id]);
  const recoveries = await Promise.all([resumePhotoBatch(admission.batch.id, actor, evidence), resumePhotoBatch(admission.batch.id, actor, evidence)]);
  assert.equal(recoveries.filter(result => result.dispatch).length, 1);
  assert.equal((await getPhotoBatch(admission.batch.id)).remainingReservedUsd, admission.batch.remainingReservedUsd);
  assert.equal(Number((await isolatedPool.query('SELECT count(*) FROM ai_job WHERE photo_batch_id=$1', [admission.batch.id])).rows[0].count), 0);
  assert.equal(await claimPhotoBatchWorkflow(admission.batch.id, admission.generation, 'late-original-worker'), false);
  const restarted = await getPhotoBatchRecoveryState(admission.batch.id);
  assert.equal((await resumePhotoBatch(admission.batch.id, actor, { generation: restarted.generation, runId: null, status: 'missing' })).dispatch, false);
});

test('dispatch stores its engine receipt before claim and never replaces another or superseded worker', async () => {
  const recipe = await fixture({ step: true }); const admission = await batch(recipe);
  const before = await getPhotoBatch(admission.batch.id);
  assert.equal(await recordPhotoBatchWorkflowDispatch(admission.batch.id, admission.generation, 'accepted-worker'), true);
  assert.equal((await getPhotoBatchRecoveryState(admission.batch.id)).workflowRunId, 'accepted-worker');
  assert.equal((await getPhotoBatchRecoveryState(admission.batch.id)).status, 'queued');
  assert.equal(await recordPhotoBatchWorkflowDispatch(admission.batch.id, admission.generation, 'different-worker'), false);
  assert.equal(await claimPhotoBatchWorkflow(admission.batch.id, admission.generation, 'different-worker'), false);
  assert.equal(await claimPhotoBatchWorkflow(admission.batch.id, admission.generation, 'accepted-worker'), true);
  assert.equal(await recordPhotoBatchWorkflowDispatch(admission.batch.id, admission.generation, 'accepted-worker'), true);
  const resumed = await resumePhotoBatch(admission.batch.id, actor, { generation: admission.generation, runId: 'accepted-worker', status: 'missing' });
  assert.equal(resumed.dispatch, true);
  assert.equal(resumed.batch.remainingReservedUsd, before.remainingReservedUsd);
  assert.equal(await recordPhotoBatchWorkflowDispatch(admission.batch.id, admission.generation, 'accepted-worker'), false);
  await stopPhotoBatch(admission.batch.id, resumed.generation, 'TEST_BLOCKED', 'Stopped before claim');
  assert.equal(await recordPhotoBatchWorkflowDispatch(admission.batch.id, resumed.generation, 'late-dispatched-worker'), false);
});

test('a concurrent failed dispatch response cannot pause an attached worker or alter its package reservation', async () => {
  const recipe = await fixture({ step: true }); const admission = await batch(recipe);
  assert.equal(await recordPhotoBatchWorkflowDispatch(admission.batch.id, admission.generation, 'accepted-dispatch-worker'), true);
  const before = await getPhotoBatch(admission.batch.id); const cost = (await getConfiguration()).budget.pilotUsedUsd;
  const outcomes = await Promise.all([
    claimPhotoBatchWorkflow(admission.batch.id, admission.generation, 'accepted-dispatch-worker'),
    stopPhotoBatchDispatchUnconfirmed(admission.batch.id, admission.generation, 'A duplicate dispatch response failed'),
    recordPhotoBatchWorkflowDispatch(admission.batch.id, admission.generation, 'accepted-dispatch-worker'),
  ]);
  assert.equal(outcomes[0], true); assert.equal(outcomes[2], true);
  const after = await getPhotoBatch(admission.batch.id); const state = await getPhotoBatchRecoveryState(admission.batch.id);
  assert.equal(after.status, 'generating'); assert.equal(after.errorCode, null);
  assert.equal(state.workflowRunId, 'accepted-dispatch-worker'); assert.equal(state.generation, admission.generation);
  assert.equal(after.remainingReservedUsd, before.remainingReservedUsd); assert.deepEqual(after.slots, before.slots);
  assert.equal((await getConfiguration()).budget.pilotUsedUsd, cost);
});

test('unconfirmed dispatch only pauses its own unattached generation and preserves the new recovery worker', async () => {
  const recipe = await fixture({ step: true }); const admission = await batch(recipe);
  const paused = await stopPhotoBatchDispatchUnconfirmed(admission.batch.id, admission.generation, 'Response lost before worker attachment');
  assert.equal(paused.status, 'blocked'); assert.equal(paused.errorCode, 'PHOTO_BATCH_DISPATCH_UNCONFIRMED');
  assert.equal(paused.remainingReservedUsd, admission.batch.remainingReservedUsd);
  assert.equal(await claimPhotoBatchWorkflow(admission.batch.id, admission.generation, 'late-original-worker'), false);
  const resumed = await resumePhotoBatch(admission.batch.id, actor);
  assert.equal(resumed.dispatch, true);
  const checked = await stopPhotoBatchDispatchUnconfirmed(admission.batch.id, admission.generation, 'Delayed old dispatch failure');
  assert.equal(checked.status, 'queued'); assert.equal(checked.errorCode, null);
  assert.equal((await getPhotoBatchRecoveryState(admission.batch.id)).generation, resumed.generation);
  assert.equal(checked.remainingReservedUsd, paused.remainingReservedUsd);
  assert.equal(await recordPhotoBatchWorkflowDispatch(admission.batch.id, resumed.generation, 'new-dispatch-worker'), true);
});

test('manual continuation retries a proven unsent cutout once with a new immutable job without financial reservations', async () => {
  const recipe = await fixture({ hero: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const original = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  await claimSubmission(original.jobId!); await attachProviderRequest(original.jobId!, `receipt_${original.jobId}`);
  await failJob(original.jobId!, { code: 'AI_TRANSPARENCY_MISSING', message: 'Opaque finished image', uncertain: false, chargedUsd: '0.05', providerFinished: true });
  const correction = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  await claimSubmission(correction.jobId!);
  await failJob(correction.jobId!, { code: 'AI_REFERENCE_UNAVAILABLE', message: 'Storage blocked before POST', uncertain: false, chargedUsd: '0', providerFinished: true });
  await stopPhotoBatch(admission.batch.id, admission.generation, 'PHOTO_BATCH_UNCONFIRMED', 'Read stopped');
  const before = await getPhotoBatch(admission.batch.id); const used = Number((await getConfiguration()).budget.dailyUsedUsd);
  process.env.AI_DAILY_LIMIT_USD = (used + 0.09).toFixed(8);
  let recoveries;
  try { recoveries = await Promise.all([resumePhotoBatch(admission.batch.id, actor), resumePhotoBatch(admission.batch.id, actor)]); }
  finally { process.env.AI_DAILY_LIMIT_USD = '1000'; }
  assert.equal(recoveries.filter(result => result.dispatch).length, 1);
  const resumed = await getPhotoBatch(admission.batch.id); const retry = resumed.slots[0].job!;
  assert.notEqual(retry.id, correction.jobId); assert.equal(retry.status, 'queued'); assert.equal(retry.model, heroCutoutModel);
  const storedRetry = await getJobForExecution(retry.id);
  assert.equal(storedRetry.requestKey, `photo_batch_retry_${correction.jobId}`);
  assert.equal(storedRetry.input.recipe.image, `/ai-result/${original.jobId}`);
  assert.equal(resumed.remainingReservedUsd, before.remainingReservedUsd);
  assert.equal((await getConfiguration()).budget.dailyUsedUsd, used.toFixed(8));
  const failed = await getJobForExecution(correction.jobId!);
  assert.equal(failed.status, 'failed'); assert.equal(failed.providerRequestId, null); assert.equal(failed.chargedUsd, '0.00000000');
  const history = await isolatedPool.query('SELECT count(*)::int AS entries,sum(amount_usd)::text AS total FROM ai_cost_ledger WHERE job_id=$1', [correction.jobId]);
  assert.equal(history.rows[0].entries, 1); assert.equal(Number(history.rows[0].total), 0);
  const children = await isolatedPool.query('SELECT count(*)::int AS count FROM ai_job WHERE photo_batch_id=$1', [admission.batch.id]);
  assert.equal(children.rows[0].count, 3);
  await assert.rejects(isolatedPool.query('UPDATE ai_job SET brief=$1 WHERE id=$2', ['Changed retry capture', retry.id]), /immutable/);
  await claimBatch(admission.batch.id, recoveries[0].generation);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, recoveries[0].generation)).jobId, retry.id);
  assert.equal((await claimSubmission(retry.id)).shouldSubmit, true); await attachProviderRequest(retry.id, `receipt_${retry.id}`);
  assert.equal((await claimSubmission(retry.id)).shouldSubmit, false);
  assert.equal((await getJobForExecution(original.jobId!)).providerRequestId, `receipt_${original.jobId}`);
});

test('manual continuation hydrates an admitted but unlinked retry and never restores its reservation twice', async () => {
  const recipe = await fixture({ step: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const original = await nextPhotoBatchOperation(admission.batch.id, admission.generation); await claimSubmission(original.jobId!);
  await failJob(original.jobId!, { code: 'AI_STORAGE_UNAVAILABLE', message: 'Storage unavailable before POST', uncertain: false, chargedUsd: '0', providerFinished: true });
  await stopPhotoBatch(admission.batch.id, admission.generation, 'AI_STORAGE_UNAVAILABLE', 'Storage unavailable');
  // Reproduce a stop after restoring a parent's reserve but before its new
  // immutable attempt was admitted. Recomputing required work reuses it.
  await isolatedPool.query('UPDATE ai_photo_batch SET remaining_reserved_usd=reserved_usd WHERE id=$1', [admission.batch.id]);
  const resumed = await resumePhotoBatch(admission.batch.id, actor); const retry = resumed.batch.slots[0].job!;
  assert.equal(retry.reservedUsd, '0.00000000'); assert.equal(resumed.batch.remainingReservedUsd, '0.00000000');
  const cost = (await getConfiguration()).budget.pilotUsedUsd;
  await isolatedPool.query("UPDATE ai_photo_batch SET slots=jsonb_set(slots,'{0,jobId}',to_jsonb($1::text)) WHERE id=$2", [original.jobId, admission.batch.id]);
  await stopPhotoBatch(admission.batch.id, resumed.generation, 'PHOTO_BATCH_RETRY_ADMISSION_UNCONFIRMED', 'Slot link unavailable');
  const rechecked = await resumePhotoBatch(admission.batch.id, actor);
  assert.equal(rechecked.batch.slots[0].job!.id, retry.id); assert.equal(rechecked.batch.remainingReservedUsd, '0.00000000');
  assert.equal((await getConfiguration()).budget.pilotUsedUsd, cost);
  assert.equal(Number((await isolatedPool.query('SELECT count(*) FROM ai_job WHERE photo_batch_id=$1', [admission.batch.id])).rows[0].count), 2);
  assert.equal((await getJobForExecution(original.jobId!)).chargedUsd, '0.00000000');
});

test('a failed accepted receipt never becomes a new paid preflight retry even when its error and bill look retryable', async () => {
  const recipe = await fixture({ step: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const operation = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  await claimSubmission(operation.jobId!); await attachProviderRequest(operation.jobId!, `receipt_${operation.jobId}`);
  await failJob(operation.jobId!, { code: 'AI_REFERENCE_UNAVAILABLE', message: 'An accepted result remains attached', uncertain: false, chargedUsd: '0', providerFinished: true });
  await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  const settled = await getPhotoBatch(admission.batch.id); assert.equal(settled.canResume, false);
  const checked = await resumePhotoBatch(admission.batch.id, actor); assert.equal(checked.dispatch, false);
  assert.equal(checked.batch.slots[0].job!.id, operation.jobId);
  assert.equal(Number((await isolatedPool.query('SELECT count(*) FROM ai_job WHERE photo_batch_id=$1', [admission.batch.id])).rows[0].count), 1);
});

test('a later unlinked uncertain child blocks a hero retry while an existing receipt remains readable', async () => {
  const recipe = await fixture({ hero: true, ingredient: true, step: true, secondStep: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const original = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  await claimSubmission(original.jobId!); await attachProviderRequest(original.jobId!, `receipt_${original.jobId}`);
  await failJob(original.jobId!, { code: 'AI_TRANSPARENCY_MISSING', message: 'Opaque hero', uncertain: false, chargedUsd: '0.05', providerFinished: true });
  const correction = await nextPhotoBatchOperation(admission.batch.id, admission.generation); await claimSubmission(correction.jobId!);
  await failJob(correction.jobId!, { code: 'AI_REFERENCE_UNAVAILABLE', message: 'No POST before missing source', uncertain: false, chargedUsd: '0', providerFinished: true });
  const wave = await nextPhotoBatchWave(admission.batch.id, admission.generation); assert.equal(wave.state, 'jobs'); if (wave.state !== 'jobs') return;
  const unknown = wave.jobs[0]; const accepted = wave.jobs[1];
  await claimSubmission(accepted.jobId); await attachProviderRequest(accepted.jobId, `receipt_${accepted.jobId}`);
  await claimSubmission(unknown.jobId); await claimSubmission(unknown.jobId);
  await assert.rejects(createJobAdmission({ recipeId: recipe.id, expectedRevision: recipe.revision, kind: 'hero', brief: 'New attempt after uncertainty', requestKey: randomUUID() }, actor, undefined, { photoBatchId: admission.batch.id }), code('SUBMISSION_UNCERTAIN'));
  await isolatedPool.query("UPDATE ai_photo_batch SET slots=jsonb_set(slots,'{1,jobId}','null'::jsonb) WHERE id=$1", [admission.batch.id]);
  const receiptOnly = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  assert.equal(receiptOnly.state, 'job'); if (receiptOnly.state !== 'job') return;
  assert.equal(receiptOnly.jobId, accepted.jobId); assert.equal(receiptOnly.submit, false);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation, [accepted.jobId])).state, 'blocked');
  await stopPhotoBatch(admission.batch.id, admission.generation, 'SUBMISSION_UNCERTAIN', 'Acceptance unknown');
  const before = await getPhotoBatch(admission.batch.id); const cost = (await getConfiguration()).budget.pilotUsedUsd;
  await assert.rejects(resumePhotoBatch(admission.batch.id, actor), code('SUBMISSION_UNCERTAIN'));
  assert.equal((await getPhotoBatch(admission.batch.id)).remainingReservedUsd, before.remainingReservedUsd);
  assert.equal((await getConfiguration()).budget.pilotUsedUsd, cost);
  assert.equal(Number((await isolatedPool.query("SELECT count(*) FROM ai_job WHERE photo_batch_id=$1 AND request_key LIKE 'photo_batch_retry_%'", [admission.batch.id])).rows[0].count), 0);
  assert.equal((await claimSubmission(unknown.jobId)).shouldSubmit, false);
});

test('a partial package with a proven unsent preflight failure offers continuation before application', async () => {
  const recipe = await fixture({ ingredient: true, step: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const ingredient = await nextPhotoBatchOperation(admission.batch.id, admission.generation); await asset(ingredient.jobId!);
  const step = await nextPhotoBatchOperation(admission.batch.id, admission.generation); await claimSubmission(step.jobId!);
  await failJob(step.jobId!, { code: 'AI_STORAGE_CAPACITY', message: 'No POST before capacity failure', uncertain: false, chargedUsd: '0', providerFinished: true });
  await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  const partial = await getPhotoBatch(admission.batch.id);
  assert.equal(partial.status, 'failed'); assert.equal(partial.errorCode, 'PHOTO_BATCH_PARTIAL');
  assert.equal(partial.canResume, true); assert.equal(partial.canApply, false);
  assert.equal(partial.progress.completed, 1);
  await assert.rejects(applyPhotoBatch(partial.id, recipe.revision, actor), code('PHOTO_BATCH_NOT_READY'));
});

test('a wave permits simultaneous normal preparation but its final POST preflight stops after recorded uncertainty', async () => {
  const recipe = await fixture({ step: true, secondStep: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const wave = await nextPhotoBatchWave(admission.batch.id, admission.generation); assert.equal(wave.state, 'jobs'); if (wave.state !== 'jobs') return;
  const first = wave.jobs[0]; const second = wave.jobs[1];
  assert.equal((await claimSubmission(first.jobId)).shouldSubmit, true); assert.equal((await claimSubmission(second.jobId)).shouldSubmit, true);
  await ensureSubmissionAllowed(first.jobId); await ensureSubmissionAllowed(second.jobId);
  await failJob(first.jobId, { code: 'AI_SUBMISSION_UNCERTAIN', message: 'Receipt lost after POST', uncertain: true });
  await assert.rejects(ensureSubmissionAllowed(second.jobId), code('SUBMISSION_UNCERTAIN'));
  assert.equal((await getJobForExecution(first.jobId)).providerRequestId, null);
  assert.equal((await getJobForExecution(first.jobId)).costBasis, 'reservation');
});

test('provider reconciliation retains actual costs without blocking new photo admission or existing receipt recovery', async () => {
  const recipe = await fixture({ step: true, secondStep: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const wave = await nextPhotoBatchWave(admission.batch.id, admission.generation); assert.equal(wave.state, 'jobs'); if (wave.state !== 'jobs') return;
  const accepted = wave.jobs[0]; const unsent = wave.jobs[1];
  await claimSubmission(accepted.jobId); await attachProviderRequest(accepted.jobId, `receipt_${accepted.jobId}`);
  await failJob(accepted.jobId, { code: 'READ_TIMEOUT', message: 'Accepted receipt requires another GET', uncertain: true });
  await settleCost(accepted.jobId, { chargedUsd: '2.20000000', costBasis: 'usage' });
  const before = await getPhotoBatch(admission.batch.id); const captured = await getJobForExecution(accepted.jobId);
  assert.equal(captured.chargedUsd, '2.20000000'); assert.equal(captured.costBasis, 'usage');
  const recovered = await resumeJob(accepted.jobId, actor);
  assert.equal(recovered.status, 'generating'); assert.equal(recovered.providerRequestId, `receipt_${accepted.jobId}`);
  const replay = await createJobAdmission({ recipeId: recipe.id, expectedRevision: recipe.revision, kind: captured.kind as 'ingredient', targetId: captured.targetId!, brief: captured.brief, requestKey: captured.requestKey }, actor, undefined, { photoBatchId: admission.batch.id });
  assert.equal(replay.created, false); assert.equal(replay.job.id, accepted.jobId); assert.equal(replay.job.providerRequestId, captured.providerRequestId);
  assert.equal((await claimSubmission(accepted.jobId)).shouldSubmit, false);
  const extra = await createJobAdmission({ recipeId: recipe.id, expectedRevision: recipe.revision, kind: 'step', targetId: 'step', brief: 'A new photo after a confirmed cost', requestKey: randomUUID() }, actor, undefined, { photoBatchId: admission.batch.id });
  assert.equal(extra.created, true); assert.equal(extra.job.reservedUsd, '0.00000000');
  assert.equal((await claimSubmission(unsent.jobId)).shouldSubmit, true);
  await ensureSubmissionAllowed(unsent.jobId);
  assert.equal((await getJobForExecution(unsent.jobId)).providerRequestId, null);
  assert.equal((await getPhotoBatch(admission.batch.id)).remainingReservedUsd, before.remainingReservedUsd);
  assert.equal((await getPhotoBatch(admission.batch.id)).reservedUsd, admission.batch.reservedUsd);
  assert.equal(Number((await isolatedPool.query('SELECT count(*) FROM ai_job WHERE photo_batch_id=$1', [admission.batch.id])).rows[0].count), 3);
  const ledger = await isolatedPool.query('SELECT count(*)::int AS entries,sum(amount_usd)::text AS total FROM ai_cost_ledger WHERE job_id=$1', [accepted.jobId]);
  assert.equal(ledger.rows[0].entries, 1); assert.equal(Number(ledger.rows[0].total), 2.2);
});

test('an overrun does not block a new zero-cost library reuse within the captured package', async () => {
  const recipe = await fixture({ ingredient: true, libraryIngredient: true, step: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const wave = await nextPhotoBatchWave(admission.batch.id, admission.generation); assert.equal(wave.state, 'jobs'); if (wave.state !== 'jobs') return;
  const accepted = wave.jobs[0]; assert.equal(accepted.kind, 'step');
  await claimSubmission(accepted.jobId); await attachProviderRequest(accepted.jobId, `receipt_${accepted.jobId}`);
  await failJob(accepted.jobId, { code: 'READ_TIMEOUT', message: 'Known receipt may still be read', uncertain: true });
  await settleCost(accepted.jobId, { chargedUsd: '2.20000000', costBasis: 'usage' });
  const before = (await getConfiguration()).budget.pilotUsedUsd;
  const free = await createJobAdmission({ recipeId: recipe.id, expectedRevision: recipe.revision, kind: 'ingredient', targetId: 'ingredient', brief: 'Reuse the existing library image after reconciliation', requestKey: randomUUID() }, actor, undefined, { photoBatchId: admission.batch.id });
  assert.equal(free.created, true); assert.equal(free.job.status, 'ready'); assert.equal(free.job.reservedUsd, '0.00000000');
  assert.equal(free.job.chargedUsd, '0.00000000'); assert.ok(free.job.result?.reusedPhoto);
  assert.equal((await getConfiguration()).budget.pilotUsedUsd, before);
  assert.equal((await claimSubmission(free.job.id)).shouldSubmit, false);
});

test('cancelled accepted child stays attached for receipt-only polling and then settles as a terminal slot', async () => {
  const recipe = await fixture({ step: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const operation = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  await claimSubmission(operation.jobId!); await attachProviderRequest(operation.jobId!, `receipt_${operation.jobId}`);
  await cancelJob(operation.jobId!, actor);
  const cancelled = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  assert.equal(cancelled.state, 'job'); if (cancelled.state !== 'job') return;
  assert.equal(cancelled.state, 'job'); assert.equal(cancelled.jobId, operation.jobId); assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.submit, false); assert.equal(cancelled.receipt, true);
  assert.equal((await claimSubmission(operation.jobId!)).shouldSubmit, false);
  await markProviderTerminal(operation.jobId!);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation)).state, 'done');
  assert.equal((await getPhotoBatch(admission.batch.id)).errorCode, 'PHOTO_BATCH_PARTIAL');
});

test('a queued cancellation with proof of no submission settles its slot without an acceptance blocker', async () => {
  const recipe = await fixture({ step: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const operation = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  const cancelled = await cancelJob(operation.jobId!, actor);
  assert.equal(cancelled.chargedUsd, '0.00000000');
  assert.equal((await getJobForExecution(operation.jobId!)).providerRequestId, null);
  assert.ok((await getJobForExecution(operation.jobId!)).providerFinishedAt);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation)).state, 'done');
  const settled = await getPhotoBatch(admission.batch.id);
  assert.equal(settled.errorCode, 'PHOTO_BATCH_PARTIAL'); assert.equal(settled.canResume, false);
  assert.equal((await claimSubmission(operation.jobId!)).shouldSubmit, false);
});

test('known transparency failure uses only a separately reserved cutout correction', async () => {
  const recipe = await fixture({ hero: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const original = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  await claimSubmission(original.jobId!); await attachProviderRequest(original.jobId!, `receipt_${original.jobId}`);
  await failJob(original.jobId!, { code: 'AI_TRANSPARENCY_MISSING', message: 'Transparency missing', uncertain: false, chargedUsd: '0.05', providerFinished: true });
  const recovery = await nextPhotoBatchOperation(admission.batch.id, admission.generation); const correction = await getJobForExecution(recovery.jobId!);
  assert.notEqual(correction.id, original.jobId); assert.equal(correction.model, heroCutoutModel); assert.equal(correction.reservedUsd, '0.00000000');
  assert.equal(correction.input.recipe.image, `/ai-result/${original.jobId}`);
  assert.equal((await getPhotoBatch(admission.batch.id)).remainingReservedUsd, '0.00000000');
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation)).jobId, correction.id);
});

test('reviewed source must first be saved and compatible source aliases recover the same package', async () => {
  const recipe = await fixture({ ingredient: true, libraryIngredient: true });
  const source = await createJob({ recipeId: recipe.id, expectedRevision: recipe.revision, kind: 'recipe', brief: 'Review source', requestKey: randomUUID() }, actor);
  await claimSubmission(source.id); await attachProviderRequest(source.id, `receipt_${source.id}`);
  await finishRecipe(source.id, recipe.content, { chargedUsd: '0', costBasis: 'usage' });
  await assert.rejects(createPhotoBatch({ recipeId: recipe.id, expectedRevision: recipe.revision, requestKey: randomUUID(), sourceJobId: source.id }, actor), code('RECIPE_DRAFT_NOT_SAVED'));
  const saved = await applyJob(source.id, { expectedRevision: recipe.revision, acknowledgeStale: false }, actor);
  await approveRecipeContent(saved.recipe.id, saved.recipe.revision, actor);
  const admission = await createPhotoBatch({ recipeId: recipe.id, expectedRevision: saved.recipe.revision, requestKey: randomUUID(), sourceJobId: source.id }, actor);
  assert.equal((await listPhotoBatches(recipe.id, source.id))[0].id, admission.batch.id);
  assert.equal(admission.batch.sourceJobId, source.id);
  const secondSource = await createJob({ recipeId: recipe.id, expectedRevision: saved.recipe.revision, kind: 'recipe', brief: 'Second reviewed same dish', requestKey: randomUUID() }, actor);
  await claimSubmission(secondSource.id); await attachProviderRequest(secondSource.id, `receipt_${secondSource.id}`);
  await finishRecipe(secondSource.id, saved.recipe.content, { chargedUsd: '0', costBasis: 'usage' });
  const secondSaved = await applyJob(secondSource.id, { expectedRevision: saved.recipe.revision, acknowledgeStale: false }, actor);
  await approveRecipeContent(secondSaved.recipe.id, secondSaved.recipe.revision, actor);
  const alias = await createPhotoBatch({ recipeId: recipe.id, expectedRevision: secondSaved.recipe.revision, requestKey: randomUUID(), sourceJobId: secondSource.id }, actor);
  assert.equal(alias.batch.id, admission.batch.id);
  assert.equal((await listPhotoBatches(recipe.id, secondSource.id))[0].id, admission.batch.id);
});

test('food edits stop further paid children and prevent atomic application; photo edits are preserved', async () => {
  const recipe = await fixture({ hero: true, step: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const hero = await nextPhotoBatchOperation(admission.batch.id, admission.generation); await asset(hero.jobId!);
  const step = await nextPhotoBatchOperation(admission.batch.id, admission.generation); await asset(step.jobId!);
  await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  const replacement = structuredClone(recipe.content); replacement.photos = { ingredients: {}, steps: {} }; replacement.recipe.image = recipes[0].image;
  await registerFixturePhotos(replacement, actor, recipe.revision);
  const photos = structuredClone(recipe.content); photos.recipe.image = replacement.recipe.image; photos.recipe.imageAlt = replacement.recipe.imageAlt;
  const photoEdited = await saveRecipe(recipe.id, { expectedRevision: recipe.revision, content: photos }, actor);
  const applied = await applyPhotoBatch(admission.batch.id, photoEdited.revision, actor);
  assert.equal(applied.recipe.content.recipe.image, replacement.recipe.image);

  const other = await fixture({ hero: true }); const stale = await batch(other); await claimBatch(stale.batch.id, stale.generation);
  const operation = await nextPhotoBatchOperation(stale.batch.id, stale.generation); await asset(operation.jobId!); await nextPhotoBatchOperation(stale.batch.id, stale.generation);
  const changed = structuredClone(other.content); changed.recipe.title.pl = 'A different dish';
  const edited = await saveRecipe(other.id, { expectedRevision: other.revision, content: changed }, actor);
  await assert.rejects(applyPhotoBatch(stale.batch.id, edited.revision, actor), code('STALE_BATCH'));
});

test('failed ingredient mask settles only that slot; later steps finish and ready subset applies atomically', async () => {
  const recipe = await fixture({ hero: true, ingredient: true, step: true }); const admission = await batch(recipe);
  await claimBatch(admission.batch.id, admission.generation);
  const failed = await failMask(admission.batch.id, admission.generation);
  const step = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  assert.equal((await getJobForExecution(step.jobId!)).kind, 'step');
  const readyStep = await asset(step.jobId!);
  const hero = await nextPhotoBatchOperation(admission.batch.id, admission.generation); const readyHero = await asset(hero.jobId!);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation)).state, 'done');
  const partial = await getPhotoBatch(admission.batch.id);
  assert.equal(partial.status, 'failed'); assert.equal(partial.errorCode, 'PHOTO_BATCH_PARTIAL');
  assert.deepEqual(partial.progress, { completed: 2, failed: 1, total: 3 }); assert.equal(partial.canApply, true); assert.equal(partial.canResume, false);
  assert.equal(partial.remainingReservedUsd, '0.00000000');
  assert.equal((await claimSubmission(failed.originalId)).shouldSubmit, false); assert.equal((await claimSubmission(failed.correctionId)).shouldSubmit, false);
  await assert.rejects(applyPhotoBatch(partial.id, recipe.revision + 1, actor), error => error instanceof Error && 'code' in error && error.code === 'REVISION_CONFLICT');
  const applied = await applyPhotoBatch(partial.id, recipe.revision, actor);
  assert.equal(applied.recipe.revision, recipe.revision + 1); assert.equal(applied.recipe.publicationStatus, 'never_published');
  assert.equal(applied.recipe.content.recipe.image, readyHero.result!.asset!.src);
  assert.equal(applied.recipe.content.photos.steps.step.src, readyStep.result!.asset!.src);
  assert.equal(applied.recipe.content.photos.ingredients.ingredient, undefined);
  assert.equal((await getJobForExecution(failed.correctionId)).status, 'failed');
  assert.equal((await applyPhotoBatch(partial.id, recipe.revision, actor)).recipe.revision, applied.recipe.revision);
});

test('failed interrupted package resumes only pending photos without reservations and never repeats successful or failed requests', async () => {
  const recipe = await fixture({ ingredient: true, step: true, secondStep: true }); const admission = await batch(recipe);
  await claimBatch(admission.batch.id, admission.generation);
  const failed = await failMask(admission.batch.id, admission.generation);
  const completedStep = await nextPhotoBatchOperation(admission.batch.id, admission.generation); await asset(completedStep.jobId!);
  await stopPhotoBatch(admission.batch.id, admission.generation, 'PHOTO_BATCH_CHILD_FAILED', 'Legacy stop after failed mask', true);
  const stopped = await getPhotoBatch(admission.batch.id); assert.equal(stopped.canResume, true); assert.equal(stopped.canApply, false);
  assert.equal(stopped.remainingReservedUsd, '0.00000000');
  const used = Number((await getConfiguration()).budget.dailyUsedUsd); process.env.AI_DAILY_LIMIT_USD = (used + 1.99).toFixed(8);
  let resumed;
  try { resumed = await resumePhotoBatch(stopped.id, actor); }
  finally { process.env.AI_DAILY_LIMIT_USD = '1000'; } assert.equal(resumed.batch.remainingReservedUsd, '0.00000000');
  assert.equal(resumed.generation, admission.generation + 1); assert.equal(resumed.dispatch, true);
  const replay = await resumePhotoBatch(stopped.id, actor); assert.equal(replay.generation, resumed.generation); assert.equal(replay.batch.remainingReservedUsd, '0.00000000'); assert.equal(replay.dispatch, false);
  await claimBatch(stopped.id, resumed.generation);
  const step = await nextPhotoBatchOperation(stopped.id, resumed.generation); assert.equal((await getJobForExecution(step.jobId!)).kind, 'step');
  const resumedSlots = await getPhotoBatch(stopped.id); assert.equal(resumedSlots.slots.find(slot=>slot.targetId==='step')!.job!.id, completedStep.jobId); assert.equal(resumedSlots.slots[0].job!.id, failed.correctionId);
  assert.equal((await claimSubmission(completedStep.jobId!)).shouldSubmit, false); assert.equal((await claimSubmission(failed.correctionId)).shouldSubmit, false);
  await asset(step.jobId!); await nextPhotoBatchOperation(stopped.id, resumed.generation);
  assert.equal((await getPhotoBatch(stopped.id)).errorCode, 'PHOTO_BATCH_PARTIAL');
});

test('terminal failed final hero preserves completed ingredient and step photographs', async () => {
  const recipe = await fixture({ hero: true, ingredient: true, step: true }); const admission = await batch(recipe);
  await claimBatch(admission.batch.id, admission.generation);
  const ingredient = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  assert.equal((await getJobForExecution(ingredient.jobId!)).kind, 'ingredient'); assert.equal((await getJobForExecution(ingredient.jobId!)).input.recipe.image, '');
  await asset(ingredient.jobId!);
  const step = await nextPhotoBatchOperation(admission.batch.id, admission.generation); await asset(step.jobId!);
  await failMask(admission.batch.id, admission.generation);
  await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  const partial = await getPhotoBatch(admission.batch.id); assert.equal(partial.canApply, true);
  const edited = structuredClone(recipe.content); edited.recipe.title.pl = 'Different food after partial package';
  const changed = await saveRecipe(recipe.id, { expectedRevision: recipe.revision, content: edited }, actor);
  await assert.rejects(applyPhotoBatch(partial.id, changed.revision, actor), code('STALE_BATCH'));
  assert.equal((await getPhotoBatch(partial.id)).status, 'failed');
});

test('a rejected final hero can resume its accepted mask and complete the same partial package without another request', async () => {
  let recipe = await fixture({ hero: true, step: true, libraryIngredient: true });
  const content = structuredClone(recipe.content);
  content.recipe.heroPresentation = { container: 'pan', profileVersion: 'jesie-finished-dish-v2',
    evidenceStepIds: ['step'], finalAppearance: { pl: 'Gotowa potrawa na patelni.', en: 'Finished dish in a pan.' } };
  recipe = await saveRecipe(recipe.id, { expectedRevision: recipe.revision, content }, actor);
  await approveRecipeContent(recipe.id, recipe.revision, actor);
  const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const step = await nextPhotoBatchOperation(admission.batch.id, admission.generation); await asset(step.jobId!);
  const original = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  await claimSubmission(original.jobId!); await attachProviderRequest(original.jobId!, `receipt_${original.jobId}`);
  await failJob(original.jobId!, { code: 'AI_TRANSPARENCY_MISSING', message: 'Retained original.', uncertain: false, providerFinished: true, chargedUsd: '0.16' });
  const mask = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  await claimSubmission(mask.jobId!); await attachProviderRequest(mask.jobId!, `receipt_${mask.jobId}`);
  await failJob(mask.jobId!, { code: 'AI_IMAGE_INVALID', message: heroCenterFoodRejectionMessage, uncertain: false, providerFinished: true, chargedUsd: '0.005' });
  await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  const partial = await getPhotoBatch(admission.batch.id);
  assert.equal(partial.status, 'failed'); assert.equal(partial.canResume, true); assert.equal(partial.canApply, true);
  const failed = await getJobForExecution(mask.jobId!);
  const originalBefore = await getJobForExecution(original.jobId!);
  const ledger = (await isolatedPool.query('SELECT * FROM ai_cost_ledger WHERE job_id IN ($1,$2) ORDER BY job_id,entry', [original.jobId, mask.jobId])).rows;
  await resumeJob(mask.jobId!, actor);
  assert.equal((await claimSubmission(mask.jobId!)).shouldSubmit, false);
  await claimedAsset(mask.jobId!);
  const resumed = await resumePhotoBatch(admission.batch.id, actor);
  assert.equal(resumed.dispatch, false); assert.equal(resumed.generation, admission.generation);
  assert.equal(resumed.batch.status, 'ready'); assert.equal(resumed.batch.errorCode, null); assert.equal(resumed.batch.errorMessage, null);
  assert.deepEqual(resumed.batch.progress, { completed: 2, failed: 0, total: 2 });
  assert.equal(resumed.batch.slots.find(slot => slot.kind === 'hero')?.job?.id, mask.jobId);
  const ready = await getJobForExecution(mask.jobId!);
  assert.equal(ready.providerRequestId, failed.providerRequestId); assert.equal(ready.chargedUsd, failed.chargedUsd);
  assert.deepEqual(ready.input, failed.input); assert.deepEqual(await getJobForExecution(original.jobId!), originalBefore);
  assert.deepEqual((await isolatedPool.query('SELECT * FROM ai_cost_ledger WHERE job_id IN ($1,$2) ORDER BY job_id,entry', [original.jobId, mask.jobId])).rows, ledger);
  assert.deepEqual((await getRecipe(recipe.id)).content, recipe.content);
  assert.equal((await isolatedPool.query('SELECT count(*) FROM ai_job WHERE photo_batch_id=$1', [admission.batch.id])).rows[0].count, '3');
});

test('resume recovers admitted-but-unlinked pending child without a second reservation or provider claim', async () => {
  const recipe = await fixture({ step: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const step = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  await isolatedPool.query(`UPDATE ai_photo_batch SET slots=jsonb_set(slots,'{0,jobId}','null'::jsonb) WHERE id=$1`, [admission.batch.id]);
  await stopPhotoBatch(admission.batch.id, admission.generation, 'PHOTO_BATCH_CHILD_FAILED', 'Interrupted admission', true);
  const resumed = await resumePhotoBatch(admission.batch.id, actor); assert.equal(resumed.batch.remainingReservedUsd, '0.00000000'); assert.equal(resumed.batch.slots[0].job!.id, step.jobId);
  await claimBatch(admission.batch.id, resumed.generation);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, resumed.generation)).jobId, step.jobId);
  assert.equal((await claimSubmission(step.jobId!)).shouldSubmit, true); await attachProviderRequest(step.jobId!, `receipt_${step.jobId}`);
  assert.equal((await claimSubmission(step.jobId!)).shouldSubmit, false);
});

test('waves finish ingredients, admit two steps and keep the final hero exclusive without premature completion', async () => {
  const recipe = await fixture({ hero: true, ingredient: true, step: true, secondStep: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const ingredients = await nextPhotoBatchWave(admission.batch.id, admission.generation); assert.equal(ingredients.state, 'jobs'); if (ingredients.state !== 'jobs') return;
  assert.equal(ingredients.jobs.length, 1); assert.equal(ingredients.jobs[0].kind, 'ingredient');
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation, [ingredients.jobs[0].jobId])).state, 'waiting');
  assert.equal((await getPhotoBatch(admission.batch.id)).slots.filter(slot => slot.job).length, 1);
  await asset(ingredients.jobs[0].jobId);
  const wave = await nextPhotoBatchWave(admission.batch.id, admission.generation); assert.equal(wave.state, 'jobs'); if (wave.state !== 'jobs') return;
  assert.equal(wave.jobs.length, 2); assert.deepEqual(wave.jobs.map(job => job.kind), ['step', 'step']);
  assert.equal(new Set(wave.jobs.map(job => job.jobId)).size, 2);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation, wave.jobs.map(job => job.jobId))).state, 'waiting');
  assert.equal((await getPhotoBatch(admission.batch.id)).status, 'generating');
  const claims = await Promise.all(wave.jobs.map(job => claimSubmission(job.jobId))); assert.deepEqual(claims.map(claim => claim.shouldSubmit), [true, true]);
  assert.equal((await getConfiguration()).budget.activeJobs, 2);
  await Promise.all(wave.jobs.map(job => attachProviderRequest(job.jobId, `receipt_${job.jobId}`)));
  assert.deepEqual((await Promise.all(wave.jobs.map(job => claimSubmission(job.jobId)))).map(claim => claim.shouldSubmit), [false, false]);
  await Promise.all(wave.jobs.map(job => claimedAsset(job.jobId)));
  const hero = await nextPhotoBatchWave(admission.batch.id, admission.generation); assert.equal(hero.state, 'jobs'); if (hero.state !== 'jobs') return;
  assert.equal(hero.jobs.length, 1); assert.equal(hero.jobs[0].kind, 'hero');
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation, [hero.jobs[0].jobId])).state, 'waiting');
  await asset(hero.jobs[0].jobId);
  assert.equal((await nextPhotoBatchWave(admission.batch.id, admission.generation)).state, 'done');
  assert.equal((await getPhotoBatch(admission.batch.id)).status, 'ready');
});

test('two-wide identical ingredient wave shares one paid producer and cannot settle before its follower', async () => {
  const recipe = await fixture({ ingredient: true, duplicateIngredient: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const wave = await nextPhotoBatchWave(admission.batch.id, admission.generation); assert.equal(wave.state, 'jobs'); if (wave.state !== 'jobs') return;
  assert.equal(wave.jobs.length, 2); assert.equal(admission.batch.reservedUsd, '0.00000000');
  const producer = wave.jobs[0]; const follower = wave.jobs[1];
  assert.equal((await getJobForExecution(follower.jobId)).reuseSourceJobId, producer.jobId); assert.equal((await claimSubmission(follower.jobId)).shouldSubmit, false);
  await asset(producer.jobId);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation, [follower.jobId])).state, 'waiting');
  assert.equal(await resolveIngredientReuse(follower.jobId), true);
  assert.equal((await nextPhotoBatchWave(admission.batch.id, admission.generation)).state, 'done');
  assert.equal((await getJobForExecution(follower.jobId)).chargedUsd, '0.00000000');
});

test('uncertain excluded wave member blocks all new selection while successful sibling stays usable', async () => {
  const recipe = await fixture({ step: true, secondStep: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const wave = await nextPhotoBatchWave(admission.batch.id, admission.generation); assert.equal(wave.state, 'jobs'); if (wave.state !== 'jobs') return;
  const first = wave.jobs[0]; const second = wave.jobs[1];
  assert.equal((await claimSubmission(first.jobId)).shouldSubmit, true);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, admission.generation, [first.jobId])).state, 'blocked');
  await asset(second.jobId);
  await claimSubmission(first.jobId);
  assert.equal((await nextPhotoBatchWave(admission.batch.id, admission.generation)).state, 'blocked');
  assert.equal((await getJobForExecution(second.jobId)).status, 'ready'); assert.equal((await claimSubmission(first.jobId)).shouldSubmit, false);
});

test('resume hydrates existing unlinked correction before reserving the rest of a failed package', async () => {
  const recipe = await fixture({ ingredient: true, step: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const original = await nextPhotoBatchOperation(admission.batch.id, admission.generation); await claimSubmission(original.jobId!); await attachProviderRequest(original.jobId!, `receipt_${original.jobId}`);
  await failJob(original.jobId!, { code: 'AI_TRANSPARENCY_MISSING', message: 'Transparency missing', uncertain: false, chargedUsd: '0.05', providerFinished: true });
  const correction = await nextPhotoBatchOperation(admission.batch.id, admission.generation);
  await isolatedPool.query(`UPDATE ai_photo_batch SET slots=jsonb_set(slots,'{0}',(slots->0)-'recoverySourceJobId'||jsonb_build_object('jobId',null)) WHERE id=$1`, [admission.batch.id]);
  await stopPhotoBatch(admission.batch.id, admission.generation, 'PHOTO_BATCH_CHILD_FAILED', 'Lost correction link', true);
  const resumed = await resumePhotoBatch(admission.batch.id, actor); assert.equal(resumed.batch.slots[0].job!.id, correction.jobId);
  assert.equal(resumed.batch.remainingReservedUsd, '0.00000000');
  await claimBatch(admission.batch.id, resumed.generation);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id, resumed.generation)).jobId, correction.jobId);
});

test('blocked second wave member preserves an accepted first receipt but never submits an unsent first', async () => {
  const recipe = await fixture({ step: true, secondStep: true }); const admission = await batch(recipe); await claimBatch(admission.batch.id, admission.generation);
  const selected = await nextPhotoBatchWave(admission.batch.id, admission.generation); assert.equal(selected.state, 'jobs'); if (selected.state !== 'jobs') return;
  const first = selected.jobs[0]; const second = selected.jobs[1];
  await claimSubmission(first.jobId); await attachProviderRequest(first.jobId, `receipt_${first.jobId}`); await claimSubmission(second.jobId);
  const preserved = await nextPhotoBatchWave(admission.batch.id, admission.generation); assert.equal(preserved.state, 'jobs'); if (preserved.state !== 'jobs') return;
  assert.equal(preserved.jobs.length, 1); assert.equal(preserved.jobs[0].jobId, first.jobId); assert.equal(preserved.jobs[0].receipt, true); assert.ok(preserved.blocked);
  assert.equal((await claimSubmission(first.jobId)).shouldSubmit, false); await claimedAsset(first.jobId);
  assert.equal((await nextPhotoBatchWave(admission.batch.id, admission.generation)).state, 'blocked');
  assert.equal((await getJobForExecution(first.jobId)).status, 'ready');
  await isolatedPool.query('UPDATE ai_job SET provider_finished_at=now() WHERE id=$1', [second.jobId]);

  const other = await fixture({ step: true, secondStep: true }); const otherBatch = await batch(other); await claimBatch(otherBatch.batch.id, otherBatch.generation);
  const unsent = await nextPhotoBatchWave(otherBatch.batch.id, otherBatch.generation); assert.equal(unsent.state, 'jobs'); if (unsent.state !== 'jobs') return;
  await claimSubmission(unsent.jobs[1].jobId);
  assert.equal((await nextPhotoBatchWave(otherBatch.batch.id, otherBatch.generation)).state, 'blocked');
  assert.equal((await getJobForExecution(unsent.jobs[0].jobId)).status, 'queued'); assert.equal((await getJobForExecution(unsent.jobs[0].jobId)).providerRequestId, null);
});

test('white replacement ignores legacy atlas, captures opaque profile and applies only the targeted ingredient', async () => {
  const recipe=await fixture({libraryIngredient:true});
  const input={recipeId:recipe.id,expectedRevision:recipe.revision,requestKey:randomUUID(),mode:'ingredients-white' as const};
  const admission=await createCurrentPhotoBatch(input,actor);assert.equal(admission.batch.mode,'ingredients-white');assert.equal(admission.batch.reservedUsd,'0.00000000');
  assert.equal(admission.batch.slots.length,1);assert.equal((await createCurrentPhotoBatch(input,actor)).batch.id,admission.batch.id);
  assert.equal((await createCurrentPhotoBatch({...input,requestKey:randomUUID()},actor)).batch.id,admission.batch.id);
  await claimBatch(admission.batch.id,admission.generation);
  const operation=await nextPhotoBatchOperation(admission.batch.id,admission.generation);const captured=await getJobForExecution(operation.jobId!);
  assert.equal(capturedIngredientStyleProfile(captured.input),whiteIngredientStyleProfile);assert.equal(captured.reservedUsd,'0.00000000');
  assert.notEqual(captured.ingredientKey,ingredientImageIdentity(recipe.content.recipe.ingredients[0]).key);
  const finished=await asset(captured.id);await nextPhotoBatchOperation(admission.batch.id,admission.generation);
  const catalog=await isolatedPool.query('SELECT style_profile FROM ingredient_image_catalog WHERE source_job_id=$1',[captured.id]);assert.equal(catalog.rows[0].style_profile,whiteIngredientStyleProfile);
  const applied=await applyPhotoBatch(admission.batch.id,recipe.revision,actor);
  assert.equal(applied.recipe.content.photos.ingredients.ingredient.src,finished.result!.asset!.src);
  assert.equal(applied.recipe.content.recipe.image,recipe.content.recipe.image);assert.deepEqual(applied.recipe.content.photos.steps,recipe.content.photos.steps);assert.equal(applied.recipe.publicationStatus,'never_published');
  assert.equal((await getJobForExecution(captured.id)).providerRequestId,`receipt_${captured.id}`);
});

test('white package carries only already-ready missing steps and applies them together without another charge',async()=>{
  const recipe=await fixture({hero:true,step:true});const legacy=await batch(recipe);await claimBatch(legacy.batch.id,legacy.generation);
  const step=await nextPhotoBatchOperation(legacy.batch.id,legacy.generation);const readyStep=await asset(step.jobId!);await nextPhotoBatchOperation(legacy.batch.id,legacy.generation);
  const hero=await nextPhotoBatchOperation(legacy.batch.id,legacy.generation);const readyHero=await asset(hero.jobId!);await nextPhotoBatchOperation(legacy.batch.id,legacy.generation);
  const saved=await applyJob(hero.jobId!,{expectedRevision:recipe.revision,acknowledgeStale:false},actor);
  const admission=await createCurrentPhotoBatch({recipeId:recipe.id,expectedRevision:saved.recipe.revision,requestKey:randomUUID(),mode:'ingredients-white'},actor);
  assert.equal(admission.batch.reservedUsd,'0.00000000');assert.equal(admission.batch.slots.length,2);assert.equal(admission.batch.slots.find(slot=>slot.kind==='step')!.job!.id,step.jobId);
  assert.equal((await claimSubmission(step.jobId!)).shouldSubmit,false);
  await claimBatch(admission.batch.id,admission.generation);const ingredient=await nextPhotoBatchOperation(admission.batch.id,admission.generation);await asset(ingredient.jobId!);
  assert.equal((await nextPhotoBatchOperation(admission.batch.id,admission.generation)).state,'done');
  const applied=await applyPhotoBatch(admission.batch.id,saved.recipe.revision,actor);assert.equal(applied.recipe.revision,saved.recipe.revision+1);
  assert.equal(applied.recipe.content.photos.steps.step.src,readyStep.result!.asset!.src);assert.equal(applied.recipe.content.recipe.image,readyHero.result!.asset!.src);
});

test('replacement compare-and-swap rejects a photo-only edit and preserves both original and generated results',async()=>{
  const recipe=await fixture();const admission=await createCurrentPhotoBatch({recipeId:recipe.id,expectedRevision:recipe.revision,requestKey:randomUUID(),mode:'ingredients-white'},actor);await claimBatch(admission.batch.id,admission.generation);
  const job=await nextPhotoBatchOperation(admission.batch.id,admission.generation);await asset(job.jobId!);await nextPhotoBatchOperation(admission.batch.id,admission.generation);
  const changed=structuredClone(recipe.content);changed.photos.ingredients.ingredient={...changed.photos.ingredients.ingredient,alt:{pl:'Ręcznie poprawiony podpis',en:'Manually edited alternative'}};
  const edited=await saveRecipe(recipe.id,{expectedRevision:recipe.revision,content:changed},actor);
  await assert.rejects(applyPhotoBatch(admission.batch.id,edited.revision,actor),code('PHOTO_REPLACEMENT_CONFLICT'));
  assert.deepEqual((await getRecipe(recipe.id)).content.photos.ingredients.ingredient,edited.content.photos.ingredients.ingredient);assert.equal((await getJobForExecution(job.jobId!)).status,'ready');assert.equal((await getPhotoBatch(admission.batch.id)).status,'ready');
});

test('white repeated ingredients share one opaque catalogue source without financial reservations',async()=>{
  const recipe=await fixture({duplicateIngredient:true});const admission=await createCurrentPhotoBatch({recipeId:recipe.id,expectedRevision:recipe.revision,requestKey:randomUUID(),mode:'ingredients-white'},actor);assert.equal(admission.batch.reservedUsd,'0.00000000');await claimBatch(admission.batch.id,admission.generation);
  const wave=await nextPhotoBatchWave(admission.batch.id,admission.generation);assert.equal(wave.state,'jobs');if(wave.state!=='jobs')return;
  assert.equal(wave.jobs.length,2);assert.equal((await getJobForExecution(wave.jobs[1].jobId)).reuseSourceJobId,wave.jobs[0].jobId);
  await asset(wave.jobs[0].jobId);assert.equal(await resolveIngredientReuse(wave.jobs[1].jobId),true);await nextPhotoBatchWave(admission.batch.id,admission.generation);
  assert.equal((await getJobForExecution(wave.jobs[1].jobId)).chargedUsd,'0.00000000');assert.equal((await getJobForExecution(wave.jobs[0].jobId)).reservedUsd,'0.00000000');
  const entries=await isolatedPool.query('SELECT entry,amount_usd FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry',[wave.jobs[0].jobId]);assert.equal(entries.rows.filter(row=>row.entry==='reserve').length,0);assert.equal(entries.rows.reduce((sum,row)=>sum+Number(row.amount_usd),0),0.05);
});

test('white style never bypasses unresolved legacy paid acceptance for the same target',async()=>{
  const recipe=await fixture({ingredient:true});const legacy=await createJobAdmission({recipeId:recipe.id,expectedRevision:recipe.revision,kind:'ingredient',targetId:'ingredient',brief:'Legacy receipt',requestKey:randomUUID()},actor,undefined,{ingredientStyleProfile});
  await claimSubmission(legacy.job.id);
  await assert.rejects(createCurrentPhotoBatch({recipeId:recipe.id,expectedRevision:recipe.revision,requestKey:randomUUID(),mode:'ingredients-white'},actor),code('INGREDIENT_JOB_UNCONFIRMED'));
  assert.equal((await getJobForExecution(legacy.job.id)).providerRequestId,null);
  assert.equal(Number((await isolatedPool.query('SELECT count(*) FROM ai_photo_batch WHERE recipe_id=$1',[recipe.id])).rows[0].count),0);
});

test('white package admissions ignore the former financial cap and reserve no money',async()=>{
  const recipes=await Promise.all([fixture(),fixture()]);const used=Number((await getConfiguration()).budget.dailyUsedUsd);process.env.AI_DAILY_LIMIT_USD=(used+0.5).toFixed(8);
  try{
    const results=await Promise.allSettled(recipes.map(recipe=>createCurrentPhotoBatch({recipeId:recipe.id,expectedRevision:recipe.revision,requestKey:randomUUID(),mode:'ingredients-white'},actor)));
    assert.equal(results.filter(result=>result.status==='fulfilled').length,2);for(const result of results){assert.equal(result.status,'fulfilled');if(result.status==='fulfilled')assert.equal(result.value.batch.reservedUsd,'0.00000000');}
    assert.equal(Number((await getConfiguration()).budget.dailyUsedUsd),used);
  }finally{process.env.AI_DAILY_LIMIT_USD='1000';}
});

test('an old packet retains historical money fields while new children use zero reservation and legacy style',async()=>{
  const recipe=await fixture({ingredient:true});const id=randomUUID();
  await isolatedPool.query(`INSERT INTO ai_photo_batch(id,recipe_id,base_revision,input,input_hash,slots,request_key,created_by,created_by_name,reserved_usd,remaining_reserved_usd) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,2.1,2.1)`,[id,recipe.id,recipe.revision,recipe.content,randomUUID(),JSON.stringify([{kind:'ingredient',targetId:'ingredient',label:'Historical slot',jobId:null}]),randomUUID(),actor.id,'Stored batch owner']);
  await claimBatch(id,1);const operation=await nextPhotoBatchOperation(id,1);const captured=await getJobForExecution(operation.jobId!);
  assert.equal(capturedIngredientStyleProfile(captured.input),ingredientStyleProfile);assert.equal(captured.reservedUsd,'0.00000000');assert.equal((await getPhotoBatch(id)).remainingReservedUsd,'2.10000000');assert.equal((await getPhotoBatch(id)).reservedUsd,'2.10000000');
});

test('a white ingredient failure never admits a SAM recovery or consumes an extra correction reservation',async()=>{
  const recipe=await fixture();const admission=await createCurrentPhotoBatch({recipeId:recipe.id,expectedRevision:recipe.revision,requestKey:randomUUID(),mode:'ingredients-white'},actor);await claimBatch(admission.batch.id,admission.generation);
  const original=await nextPhotoBatchOperation(admission.batch.id,admission.generation);await claimSubmission(original.jobId!);await attachProviderRequest(original.jobId!,`receipt_${original.jobId}`);
  await failJob(original.jobId!,{code:'AI_TRANSPARENCY_MISSING',message:'Synthetic legacy error on white photo',uncertain:false,chargedUsd:'0.05',providerFinished:true});
  assert.equal((await nextPhotoBatchOperation(admission.batch.id,admission.generation)).state,'done');
  const stopped=await getPhotoBatch(admission.batch.id);assert.equal(stopped.errorCode,'PHOTO_BATCH_PARTIAL');assert.equal(stopped.slots[0].job!.id,original.jobId);assert.equal(stopped.remainingReservedUsd,'0.00000000');
  assert.equal(Number((await isolatedPool.query('SELECT count(*) FROM ai_job WHERE photo_batch_id=$1',[admission.batch.id])).rows[0].count),1);
});

test('white replacement carries a ready missing hero and step without reserving or admitting them again',async()=>{
  const recipe=await fixture({hero:true,step:true});const legacy=await batch(recipe);await claimBatch(legacy.batch.id,legacy.generation);
  const step=await nextPhotoBatchOperation(legacy.batch.id,legacy.generation);await asset(step.jobId!);
  const hero=await nextPhotoBatchOperation(legacy.batch.id,legacy.generation);await asset(hero.jobId!);await nextPhotoBatchOperation(legacy.batch.id,legacy.generation);
  const admission=await createCurrentPhotoBatch({recipeId:recipe.id,expectedRevision:recipe.revision,requestKey:randomUUID(),mode:'ingredients-white'},actor);
  assert.equal(admission.batch.reservedUsd,'0.00000000');assert.equal(admission.batch.progress.completed,2);assert.equal(admission.batch.progress.total,3);
  assert.equal(admission.batch.slots.find(slot=>slot.kind==='hero')!.job!.id,hero.jobId);assert.equal(admission.batch.slots.find(slot=>slot.kind==='step')!.job!.id,step.jobId);
  await claimBatch(admission.batch.id,admission.generation);const ingredient=await nextPhotoBatchOperation(admission.batch.id,admission.generation);
  assert.equal(ingredient.state,'job');if(ingredient.state!=='job')return;
  assert.equal(ingredient.kind,'ingredient');assert.equal((await getJobForExecution(ingredient.jobId!)).input.recipe.image,'');
  await asset(ingredient.jobId!);assert.equal((await nextPhotoBatchOperation(admission.batch.id,admission.generation)).state,'done');
  const children=await isolatedPool.query('SELECT kind FROM ai_job WHERE photo_batch_id=$1',[admission.batch.id]);assert.deepEqual(children.rows.map(row=>row.kind),['ingredient']);
  const applied=await applyPhotoBatch(admission.batch.id,recipe.revision,actor);assert.ok(applied.recipe.content.recipe.image);assert.ok(applied.recipe.content.photos.steps.step);
});

test('paper admission isolates the white catalogue and captures the new profile without a reservation',async()=>{
  const recipe=await fixture({libraryIngredient:true});
  const admission=await createCurrentPhotoBatch({recipeId:recipe.id,expectedRevision:recipe.revision,requestKey:randomUUID(),mode:'ingredients-paper'},actor);
  assert.equal(admission.batch.mode,'ingredients-paper');assert.equal(admission.batch.reservedUsd,'0.00000000');
  await claimBatch(admission.batch.id,admission.generation);const operation=await nextPhotoBatchOperation(admission.batch.id,admission.generation);
  const captured=await getJobForExecution(operation.jobId!);assert.equal(capturedIngredientStyleProfile(captured.input),paperIngredientStyleProfile);
  assert.notEqual(captured.ingredientKey,ingredientImageIdentity(recipe.content.recipe.ingredients[0],whiteIngredientStyleProfile).key);
  const result=await asset(operation.jobId!);assert.equal(result.result!.asset!.styleProfile,paperIngredientStyleProfile);
  assert.equal((await getConfiguration()).paperIngredientReservationUsd,'0.00000000');
});

async function importFixture() {
  const recipe=await fixture();const admission=await createCurrentPhotoBatch({recipeId:recipe.id,expectedRevision:recipe.revision,requestKey:randomUUID(),mode:'ingredients-white'},actor);
  await claimBatch(admission.batch.id,admission.generation);const operation=await nextPhotoBatchOperation(admission.batch.id,admission.generation);const source=await asset(operation.jobId!);
  await nextPhotoBatchOperation(admission.batch.id,admission.generation);const saved=await applyPhotoBatch(admission.batch.id,recipe.revision,actor);
  const directory=await mkdtemp(join(tmpdir(),'ingredient-paper-import-'));const localPath=join(directory,'edited.png');
  // Synthetic decoder fixture, not a pixel edit of a user's photograph.
  const bytes=await sharp({create:{width:512,height:512,channels:3,background:'#FAF8F2'}}).png().toBuffer();await writeFile(localPath,bytes);
  const input:IngredientBackgroundImport={recipeId:recipe.id,expectedRevision:saved.recipe.revision,requestKey:randomUUID(),entries:[{targetId:'ingredient',sourceJobId:source.id,sourceAssetId:source.result!.asset!.id,
    localPath,sha256:createHash('sha256').update(bytes).digest('hex'),expectedPhoto:structuredClone(saved.recipe.content.photos.ingredients.ingredient)}]};
  const uploaded:{path:string;bytes:Buffer}[]=[];const storage:IngredientBackgroundImportStorage={async ensure(path,bytes){uploaded.push({path,bytes});return path;}};
  return {input,source,recipe:saved.recipe,directory,bytes,uploaded,storage};
}

test('reviewed background import preserves full tool pixels, immutable source and published snapshot while a zero-cost draft correction applies',async()=>{
  const f=await importFixture();
  try{
    const publicationId=randomUUID();await isolatedPool.query(`INSERT INTO editorial_publication(id,recipe_id,revision,snapshot,content_hash,checks,approval_origin,published_by,published_by_name) VALUES($1,$2,$3,$4,$5,'{}','manual',$6,'Stored owner')`,[publicationId,f.recipe.id,f.recipe.revision,f.recipe.content,'fixture-hash',actor.id]);
    await isolatedPool.query(`UPDATE editorial_recipe SET publication_status='published',published_id=$1,published_revision=$2 WHERE id=$3`,[publicationId,f.recipe.revision,f.recipe.id]);
    const original=await getJobForExecution(f.source.id);const oldLedger=(await isolatedPool.query('SELECT entry,amount_usd,basis FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry',[f.source.id])).rows;
    const budgetBefore=(await getConfiguration()).budget;
    const packet=await importIngredientBackgroundEdits(f.input,actor,f.storage);assert.equal(packet.status,'ready');assert.equal(packet.mode,'ingredients-paper');assert.equal(packet.reservedUsd,'0.00000000');assert.equal(f.uploaded.length,1);assert.deepEqual(f.uploaded[0].bytes,f.bytes);
    const job=await getJobForExecution(packet.slots[0].job!.id);assert.equal(job.provider,'openai');assert.equal(job.providerRequestId,null);assert.equal(job.reservedUsd,'0.00000000');assert.equal(job.chargedUsd,'0.00000000');assert.equal(job.input.aiPhotography!.ingredientEditSource!.sourceJobId,f.source.id);
    assert.equal(job.result!.derivation!.sourceAssetId,f.source.result!.asset!.id);assert.equal(packet.slots[0].job!.result!.asset!.styleProfile,paperIngredientStyleProfile);
    const registered=(await isolatedPool.query('SELECT blob_pathname,original_blob_pathname FROM ai_asset WHERE job_id=$1',[job.id])).rows[0];assert.equal(registered.blob_pathname,f.uploaded[0].path);assert.equal(registered.original_blob_pathname,f.uploaded[0].path);
    assert.equal((await getConfiguration()).budget.pilotUsedUsd,budgetBefore.pilotUsedUsd);assert.equal((await getConfiguration()).budget.activeJobs,0);
    await rm(f.directory,{recursive:true,force:true});assert.equal((await importIngredientBackgroundEdits(f.input,actor,f.storage)).id,packet.id);assert.equal(f.uploaded.length,1);
    const applied=await applyPhotoBatch(packet.id,f.recipe.revision,actor);assert.equal(applied.recipe.revision,f.recipe.revision+1);assert.equal(applied.recipe.editorialStatus,'draft');assert.equal(applied.recipe.publicationStatus,'published');assert.equal(applied.recipe.publishedRevision,f.recipe.revision);
    assert.deepEqual((await isolatedPool.query('SELECT snapshot FROM editorial_publication WHERE id=$1',[publicationId])).rows[0].snapshot,f.recipe.content);
    assert.equal(applied.recipe.content.recipe.image,f.recipe.content.recipe.image);assert.deepEqual(applied.recipe.content.photos.steps,f.recipe.content.photos.steps);assert.equal(applied.recipe.content.photos.ingredients.ingredient.src,`/media/${job.id}`);
    assert.deepEqual(await getJobForExecution(f.source.id),original);assert.deepEqual((await isolatedPool.query('SELECT entry,amount_usd,basis FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry',[f.source.id])).rows,oldLedger);
    assert(!JSON.stringify(packet).includes('blob_pathname'));assert(!JSON.stringify(packet).includes('test/'));
    const follow=await fixture({ingredient:true});const matched=structuredClone(follow.content);matched.recipe.ingredients[0].name=f.recipe.content.recipe.ingredients[0].name;
    const next=await saveRecipe(follow.id,{expectedRevision:follow.revision,content:matched},actor);await approveRecipeContent(next.id,next.revision,actor);const reused=await createCurrentPhotoBatch({recipeId:next.id,expectedRevision:next.revision,requestKey:randomUUID(),mode:'ingredients-paper'},actor);assert.equal(reused.batch.reservedUsd,'0.00000000');
  }finally{await rm(f.directory,{recursive:true,force:true});}
});

test('background import rejects changed files and disabled actors before any private upload',async()=>{
  const f=await importFixture();try{
    await assert.rejects(importIngredientBackgroundEdits({...f.input,entries:[{...f.input.entries[0],sha256:'0'.repeat(64)}]},actor,f.storage),code('IMPORTED_IMAGE_INVALID'));assert.equal(f.uploaded.length,0);
    await isolatedPool.query('UPDATE auth_user SET disabled=true WHERE id=$1',[actor.id]);
    await assert.rejects(importIngredientBackgroundEdits(f.input,actor,f.storage),code('FORBIDDEN'));assert.equal(f.uploaded.length,0);
  }finally{await isolatedPool.query('UPDATE auth_user SET disabled=false WHERE id=$1',[actor.id]);await rm(f.directory,{recursive:true,force:true});}
});

test('background import atomically rejects a photo changed during upload without changing source, catalogue or recipe',async()=>{
  const f=await importFixture();try{
    const edited=structuredClone(f.recipe.content);edited.photos.ingredients.ingredient.alt.pl='Concurrent manual photo edit';
    const storage:IngredientBackgroundImportStorage={async ensure(path,bytes){f.uploaded.push({path,bytes});await saveRecipe(f.recipe.id,{expectedRevision:f.recipe.revision,content:edited},actor);return path;}};
    await assert.rejects(importIngredientBackgroundEdits(f.input,actor,storage),code('REVISION_CONFLICT'));
    assert.equal(Number((await isolatedPool.query('SELECT count(*) FROM ai_photo_batch WHERE request_key=$1',[f.input.requestKey])).rows[0].count),0);
    assert.equal((await getJobForExecution(f.source.id)).status,'applied');assert.equal((await getRecipe(f.recipe.id)).content.photos.ingredients.ingredient.alt.pl,'Concurrent manual photo edit');
  }finally{await rm(f.directory,{recursive:true,force:true});}
});


test('reviewed omissions skip missing-photo slots and invalidate an older paid-admission plan', async () => {
  const recipe = await fixture({ step: true });
  const captured = await batch(recipe);
  assert.equal(captured.batch.slots.filter(slot => slot.kind === 'step').length, 1);
  const content = structuredClone(recipe.content);
  content.photos.omittedSteps = { step: createStepPhotoOmission(content.recipe.steps[0], { pl: 'Powtarza poprzedni stan.', en: 'Repeats the preceding state.' }) };
  const saved = await saveRecipe(recipe.id, { expectedRevision: recipe.revision, content }, actor);
  await approveRecipeContent(saved.id, saved.revision, actor);
  await claimBatch(captured.batch.id, captured.generation);
  const blocked = await nextPhotoBatchOperation(captured.batch.id, captured.generation);
  assert.equal(blocked.state, 'blocked');
  const fresh = await batch(saved);
  assert.notEqual(fresh.batch.id, captured.batch.id);
  assert.equal(fresh.batch.slots.filter(slot => slot.kind === 'step').length, 0);
  assert.equal(fresh.batch.status, 'ready');
  const changed = structuredClone(saved.content);
  changed.recipe.steps[0].text.pl += ' Sprawdź konsystencję.';
  const revised = await saveRecipe(saved.id, { expectedRevision: saved.revision, content: changed }, actor);
  await approveRecipeContent(revised.id, revised.revision, actor);
  const needsReview = await batch(revised);
  assert.equal(needsReview.batch.slots.filter(slot => slot.kind === 'step').length, 1);
});

test('a reviewed wrong-state step result cannot be reattached from a historical ready job', async () => {
  const recipe = await fixture({ step: true });
  const previousId = randomUUID();
  const badAsset = { id: 'aa81db26-6a98-41e7-8f2e-b8a98fd0e325', src: '/media/aa81db26-6a98-41e7-8f2e-b8a98fd0e325', kind: 'step', recipeId: recipe.id, targetId: 'step', width: 2240, height: 960, alt: { pl: 'Stary kadr', en: 'Old frame' }, caption: { pl: 'Stary kadr', en: 'Old frame' } };
  // Insert a historical completed receipt directly in the isolated test schema.
  // The real receipt and result stay immutable throughout this test.
  await isolatedPool.query(`INSERT INTO ai_job SELECT (jsonb_populate_record(NULL::ai_job, to_jsonb(j) || $2::jsonb)).* FROM ai_job j WHERE recipe_id=$1 AND kind='hero' LIMIT 1`, [recipe.id, JSON.stringify({ id: previousId, request_key: randomUUID(), kind: 'step', target_id: 'step', status: 'ready', result: { asset: badAsset } })]);
  const captured = await getJobForExecution(previousId);
  assert.equal(captured.status, 'ready');
  const next = await batch(recipe);
  const slot = next.batch.slots.find(item => item.kind === 'step')!;
  assert.equal(slot.job, null, 'The reviewed bad image is retained in history, but not reused.');
  await claimBatch(next.batch.id, next.generation);
  const fresh = await nextPhotoBatchOperation(next.batch.id, next.generation);
  assert.notEqual(fresh.jobId, captured.id);
  assert.deepEqual((await getJobForExecution(captured.id)).result, captured.result);
});
