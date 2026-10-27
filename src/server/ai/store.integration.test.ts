import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { Pool } from 'pg';
import type { EditorialActor, EditorialContent, EditorialRecord } from '../../lib/editorial-types';
import { heroCutoutSemanticRetryBrief, ingredientCutoutRecoveryBrief, type AiJob } from '../../lib/ai-types';
import { recipes } from '../../lib/recipes';
import { heroPresentationProfile, resolveHeroPresentation } from '../../lib/hero-presentation';
import { recipeDietBaseNotes } from '../../lib/recipe-diet';
import { getIngredientImage, getStepImage } from '../../lib/recipe-media';
import { closeDb } from '../db';
import { contentHash, createRecipe, deleteRecipe, EditorialError, emptyChecks, getPublishedRecipe, getRecipe, performRecipeAction, saveRecipe } from '../editorial/store';
import { publicationIssues } from '../editorial/validation';
import { approveAutomatedRecipeContentInTransaction, approveRecipeContent, contentApprovalHash, isRecipeContentApproved, recipeContentIssues } from '../editorial/content-approval';
import { AiError } from './errors';
import { ingredientStyleProfile } from './ingredient-profile';
import { missingIngredientKeys } from './ingredient-reuse';
import { admitManualHeroCutout } from './manual-hero-recovery';
import { registerFixturePhotos } from './recipe-photo-test-fixture';
import { canRestoreHeroContents, heroCenterFoodRejectionMessage, heroCutoutModel, heroMaskPromptVersion, glassHeroMaskPromptVersion, stepFormatModel, filledHeroModel, failedHeroSourcePrefix } from './image-actions';
import { getDb } from '../db';
import { applyJob, attachProviderRequest, cancelJob, claimSubmission, confirmNotSubmitted, createJob as createCurrentJob, createJobAdmission, ensureSubmissionAllowed, failJob, finishAsset, finishRecipe, getAssetForExecution, getConfiguration, getJob, getJobForExecution, isAssetPublic, markProviderTerminal, resumeJob, resolveIngredientReuse, settleCost } from './store';
// These existing cases prove backward compatibility of the historical v1 jobs.
const createJob:typeof createCurrentJob=async(input,actor)=>(await createJobAdmission(input,actor,undefined,{ingredientStyleProfile})).job;

const schema=`ai_test_${randomUUID().replaceAll('-','')}`;
const historicalAutomatedRecipeId=randomUUID();
let adminPool:Pool; let isolatedPool:Pool;
const actor:EditorialActor={id:'test-owner',name:'Forged owner',email:'owner@example.invalid',role:'owner'};
const checks={pl:true,en:true,quantities:true,method:true,photos:true,sources:true};

before(async()=>{
  if(process.env.NODE_ENV==='production')throw new Error('AI tests require development.');
  config({path:'.env.local',quiet:true});
  const connection=process.env.AI_TEST_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING;
  if(!connection)throw new Error('A real development Postgres connection is required.');
  adminPool=new Pool({connectionString:connection,max:1});await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const url=new URL(connection);url.searchParams.set('options',`-c search_path=${schema}`);process.env.DATABASE_URL=url.toString();
  isolatedPool=new Pool({connectionString:url.toString(),max:1});
  await isolatedPool.query(`CREATE TABLE auth_user(id text PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,image text,role text NOT NULL DEFAULT 'admin',disabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
  await isolatedPool.query(`INSERT INTO auth_user(id,name,email,role) VALUES('test-owner','Stored owner','owner@example.invalid','owner'),('disabled','Disabled','disabled@example.invalid','owner'),('reader','Reader','reader@example.invalid','reader')`);
  await isolatedPool.query(`UPDATE auth_user SET disabled=true WHERE id='disabled'`);
  await isolatedPool.query(await readFile('migrations/0001-editorial.sql','utf8'));await isolatedPool.query(await readFile('migrations/0002-ai.sql','utf8'));await isolatedPool.query(await readFile('migrations/0003-trends.sql','utf8'));
  await isolatedPool.query(await readFile('migrations/0004-trend-research.sql','utf8'));
  await isolatedPool.query(await readFile('migrations/0005-trend-manual-runs.sql','utf8'));
  await isolatedPool.query(await readFile('migrations/0006-ingredient-reuse.sql','utf8'));
  await isolatedPool.query(await readFile('migrations/0007-local-photo-corrections.sql','utf8'));
  await isolatedPool.query(await readFile('migrations/0008-ai-photo-batches.sql','utf8'));
  await isolatedPool.query(await readFile('migrations/0009-ai-budget-settings.sql','utf8'));
  await isolatedPool.query(await readFile('migrations/0010-daily-publication.sql','utf8'));
  await isolatedPool.query(await readFile('migrations/0011-seo-discovery.sql','utf8'));
  await isolatedPool.query(await readFile('migrations/0014-seo-workflows.sql','utf8'));
  await isolatedPool.query(await readFile('migrations/0015-recipe-trash.sql','utf8'));
  await isolatedPool.query(await readFile('migrations/0018-content-approval.sql','utf8'));
  await isolatedPool.query(await readFile('migrations/0021-recipe-result-recovery.sql','utf8'));
  await isolatedPool.query(await readFile('migrations/0026-remove-spending-limits.sql','utf8'));
  // Historical receipt is seeded before the permanent fence, exactly as existing
  // production history survives migration 0027. Tests never weaken the fence.
  const historicalContent=completeContent(historicalAutomatedRecipeId);
  await isolatedPool.query('INSERT INTO editorial_recipe(id,content,content_hash,checks,created_by,updated_by,updated_by_name) VALUES($1,$2,$3,$4,$5,$5,$6)',[historicalAutomatedRecipeId,historicalContent,contentHash(historicalContent),emptyChecks(),'jesie-trend-worker','Historical automated worker']);
  await isolatedPool.query("INSERT INTO editorial_content_approval(recipe_id,content_hash,origin,revision,actor_id,actor_name) VALUES($1,$2,'automated',1,'jesie-trend-worker','Historical automated worker')",[historicalAutomatedRecipeId,contentApprovalHash(historicalContent)]);
  await isolatedPool.query(await readFile('migrations/0027-manual-review-workflow.sql','utf8'));
  await isolatedPool.query(await readFile('migrations/0028-ingredient-dictionary.sql','utf8'));
  await isolatedPool.query(await readFile('migrations/0029-ingredient-evidence-recheck.sql','utf8'));
  // No provider network calls occur: these placeholders exercise configuration-presence guards only.
  process.env.OPENAI_API_KEY='test-unused';process.env.FAL_KEY='test-unused';process.env.BLOB_READ_WRITE_TOKEN='test-unused';process.env.AI_RECIPE_MODEL='gpt-6.1-sol';
  process.env.AI_DAILY_LIMIT_USD='100';process.env.AI_MONTHLY_LIMIT_USD='100';process.env.AI_PILOT_LIMIT_USD='100';
});
after(async()=>{await closeDb();if(isolatedPool)await isolatedPool.end();if(adminPool){await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await adminPool.end();}});
function completeContent(id:string):EditorialContent {
  const recipe=structuredClone(recipes[0]);const originalId=recipe.id;recipe.id=id;recipe.slug={pl:`test-${id}`,en:`test-${id}`};
  return {recipe,originalText:'Private input',author:'Original author',sources:[],photos:{ingredients:Object.fromEntries(recipe.ingredients.map(item=>[item.id,getIngredientImage(originalId,item.id)])),steps:Object.fromEntries(recipe.steps.map(item=>[item.id,getStepImage(originalId,item.id)]))}};
}
async function fixture(){const draft=await createRecipe({title:'AI test',originalText:'Private input'},actor);const saved=await saveRecipe(draft.id,{expectedRevision:draft.revision,content:completeContent(draft.id)},actor);await approveRecipeContent(saved.id,saved.revision,actor);return saved;}
async function approveCompleteFixture(recipe:EditorialRecord){assert.deepEqual(recipeContentIssues(recipe.content),[],'Changed-food fixtures must retain complete, classifiable cooking text.');return approveRecipeContent(recipe.id,recipe.revision,actor);}
async function job(recipe:EditorialRecord,brief=`Brief ${randomUUID()}`,kind:'recipe'|'hero'|'ingredient'|'step'='recipe',targetId?:string){return createJob({recipeId:recipe.id,expectedRevision:recipe.revision,kind,targetId,brief,requestKey:randomUUID()},actor);}
async function readyRecipe(recipe:EditorialRecord):Promise<AiJob> {const created=await job(recipe);await claimSubmission(created.id);await attachProviderRequest(created.id,`mock-${created.id}`);const proposal=structuredClone(recipe.content);proposal.recipe.title.pl='Proposed title';return finishRecipe(created.id,proposal,{chargedUsd:'0',costBasis:'usage',usage:{inputTokens:100,outputTokens:200}});}
async function published(record:EditorialRecord){const reviewed=await performRecipeAction(record.id,{action:'checks',expectedRevision:record.revision,checks},actor);const approved=await performRecipeAction(record.id,{action:'approve',expectedRevision:reviewed.revision},actor);return performRecipeAction(record.id,{action:'publish',expectedRevision:approved.revision},actor);}
function aiCode(code:string){return (error:unknown)=>error instanceof AiError && error.code===code;}

test('historical automated approval cannot admit a new human photo; an explicit manual review can',async()=>{
  const recipe=await getRecipe(historicalAutomatedRecipeId);
  const history=(await isolatedPool.query("SELECT * FROM editorial_content_approval WHERE recipe_id=$1 AND origin='automated'",[recipe.id])).rows;
  assert.equal(history.length,1);
  assert.equal(await isRecipeContentApproved(recipe),false);
  await assert.rejects(job(recipe,'New photo after historical system approval','hero'),(error:unknown)=>error instanceof EditorialError && error.code==='CONTENT_APPROVAL_REQUIRED');
  assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM ai_job WHERE recipe_id=$1',[recipe.id])).rows[0].count,0);
  await approveRecipeContent(recipe.id,recipe.revision,actor);
  assert.equal(await isRecipeContentApproved(recipe),true);
  const admitted=await job(recipe,'New photo after explicit manual review','hero');
  assert.equal((await claimSubmission(admitted.id)).shouldSubmit,true);
  await ensureSubmissionAllowed(admitted.id);
  await cancelJob(admitted.id,actor);await confirmNotSubmitted(admitted.id);
  assert.deepEqual((await isolatedPool.query("SELECT * FROM editorial_content_approval WHERE recipe_id=$1 AND origin='automated'",[recipe.id])).rows,history);
});

test('a genuine legacy human review still admits a new photo without an independent approval receipt',async()=>{
  const draft=await createRecipe({title:'Legacy human-reviewed fixture',originalText:'Private input'},actor);
  const saved=await saveRecipe(draft.id,{expectedRevision:draft.revision,content:completeContent(draft.id)},actor);
  assert.equal(await isRecipeContentApproved(saved),false);
  const reviewed=await performRecipeAction(saved.id,{action:'checks',expectedRevision:saved.revision,checks},actor);
  const approved=await performRecipeAction(saved.id,{action:'approve',expectedRevision:reviewed.revision},actor);
  assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM editorial_content_approval WHERE recipe_id=$1',[approved.id])).rows[0].count,0);
  assert.equal(await isRecipeContentApproved(approved),true);
  const admitted=await job(approved,'New photograph after legacy human audit','hero');
  assert.equal((await claimSubmission(admitted.id)).shouldSubmit,true);
  await ensureSubmissionAllowed(admitted.id);
  await cancelJob(admitted.id,actor);await confirmNotSubmitted(admitted.id);
});

test('retired automatic content approval rejects explicitly and cannot append approval history',async()=>{
  const recipe=await getRecipe(historicalAutomatedRecipeId);
  const before=(await isolatedPool.query('SELECT count(*)::int count FROM editorial_content_approval')).rows[0].count;
  await assert.rejects(getDb().transaction(tx=>approveAutomatedRecipeContentInTransaction(tx,recipe,'jesie-trend-worker')),(error:unknown)=>error instanceof EditorialError && error.status===410 && error.code==='MANUAL_CONTENT_REVIEW_REQUIRED');
  assert.equal((await isolatedPool.query('SELECT count(*)::int count FROM editorial_content_approval')).rows[0].count,before);
});

test('concurrent double clicks admit once without reserving money; same request key is durable and captured input is immutable',async()=>{
  const recipe=await fixture();const brief='Same brief';const requestKey=randomUUID();
  const input={recipeId:recipe.id,expectedRevision:recipe.revision,kind:'recipe' as const,brief,requestKey};
  const admissions=await Promise.all([createJobAdmission(input,actor),createJobAdmission({...input,requestKey:randomUUID()},actor),createJobAdmission(input,actor)]);
  assert.equal(admissions.filter(result=>result.created).length,1);
  const results=admissions.map(result=>result.job);
  assert.equal(new Set(results.map(result=>result.id)).size,1);const created=results[0];assert.equal(created.createdByName,'Stored owner');
  const count=await isolatedPool.query(`SELECT count(*)::int AS count FROM ai_cost_ledger WHERE job_id=$1`,[created.id]);assert.equal(count.rows[0].count,0);
  await assert.rejects(createJob({...input,brief:'Changed'},actor),aiCode('REQUEST_KEY_REUSED'));
  await assert.rejects(isolatedPool.query('UPDATE ai_job SET brief=$1 WHERE id=$2',['changed',created.id]),/immutable/);
  const full=await getJobForExecution(created.id);assert.equal(full.input.originalText,'Private input');assert.equal('input' in await getJob(created.id),false);
  await cancelJob(created.id,actor);
});

test('an explicit ingredient retake honours its brief instead of reusing the library, and applies only its target',async()=>{
  const recipe=await fixture();
  const target=recipe.content.recipe.ingredients[0];
  const library=await job(recipe,'Find the existing ingredient photograph','ingredient',target.id);
  assert.equal(library.status,'ready');
  assert(library.result?.reusedPhoto);
  const input={recipeId:recipe.id,expectedRevision:recipe.revision,kind:'ingredient' as const,targetId:target.id,
    brief:'Pokaż ten składnik w małym szklanym naczyniu z delikatnym cieniem.',regenerate:true,requestKey:randomUUID()};
  const retake=await createJob(input,actor);
  assert.equal(retake.status,'queued');
  assert.equal(retake.reuseSourceJobId,null);
  assert.equal(retake.result,null);
  assert.equal((await createJob(input,actor)).id,retake.id);
  assert.equal((await createJob({...input,requestKey:randomUUID()},actor)).id,retake.id);
  await assert.rejects(createJob({...input,regenerate:false},actor),aiCode('REQUEST_KEY_REUSED'));
  assert.equal((await getJobForExecution(retake.id)).input.aiPhotography?.regenerate,true);
  assert.equal((await claimSubmission(retake.id)).shouldSubmit,true);
  await ensureSubmissionAllowed(retake.id);
  await attachProviderRequest(retake.id,`mock-${retake.id}`);
  await finishAsset(retake.id,{blobPathname:`private/${retake.id}.webp`,width:800,height:800,contentType:'image/webp',
    alt:target.name,caption:{pl:'Nowy kadr',en:'A new view'},hasTransparency:true,styleProfile:ingredientStyleProfile},{chargedUsd:'0',costBasis:'usage'});
  const applied=await applyJob(retake.id,{expectedRevision:recipe.revision,acknowledgeStale:false},actor);
  assert.equal(applied.recipe.content.photos.ingredients[target.id].src,`/media/${retake.id}`);
  assert.deepEqual(applied.recipe.content.recipe,recipe.content.recipe);
  assert.deepEqual(applied.recipe.content.photos.steps,recipe.content.photos.steps);
  assert.equal(applied.recipe.publicationStatus,recipe.publicationStatus);
});

test('a retake waits for a different pending ingredient brief without replacing it or buying a duplicate',async()=>{
  const recipe=await fixture();
  const input={recipeId:recipe.id,expectedRevision:recipe.revision,kind:'ingredient' as const,
    targetId:recipe.content.recipe.ingredients[0].id,brief:'Pierwszy własny kadr.',regenerate:true,requestKey:randomUUID()};
  const first=await createJob(input,actor);
  await assert.rejects(createJob({...input,brief:'Inny własny kadr.',requestKey:randomUUID()},actor),aiCode('INGREDIENT_GENERATION_PENDING'));
  await cancelJob(first.id,actor);
  const next=await createJob({...input,brief:'Inny własny kadr.',requestKey:randomUUID()},actor);
  assert.notEqual(first.id,next.id);
  await cancelJob(next.id,actor);
  await assert.rejects(createJob({...input,kind:'recipe',requestKey:randomUUID()},actor),aiCode('INVALID_REGENERATION'));
  await assert.rejects(createJob({...input,imageAction:'crop_step',kind:'step',requestKey:randomUUID()},actor),aiCode('INVALID_REGENERATION'));
});

test('natural-language hero vessel is captured for photography without changing approved recipe content',async()=>{
  const recipe=await fixture();
  const sourcePresentation=resolveHeroPresentation(recipe.content.recipe)!;
  const created=await job(recipe,'Pokaż gotową potrawę w glinianym garnku. Zachowaj dodatki wynikające z przepisu.','hero');
  const captured=await getJobForExecution(created.id);
  assert.equal(captured.input.aiPhotography?.heroPresentationOverride?.container,'clay-pot');
  assert.deepEqual(captured.input.recipe.heroPresentation,sourcePresentation);
  assert.equal(contentApprovalHash(captured.input),contentApprovalHash(recipe.content));
  assert.equal((await getJob(created.id)).heroContainer,'clay-pot');
  assert.equal((await claimSubmission(created.id)).shouldSubmit,true);
  await ensureSubmissionAllowed(created.id);
  await attachProviderRequest(created.id,`mock-${created.id}`);
  await finishAsset(created.id,{blobPathname:`private/${created.id}.webp`,width:1600,height:1600,contentType:'image/webp',
    alt:recipe.content.recipe.title,caption:{pl:'Danie w glinianym garnku',en:'Dish in a clay pot'},hasTransparency:true,styleProfile:heroPresentationProfile},{chargedUsd:'0',costBasis:'usage'});
  const applied=await applyJob(created.id,{expectedRevision:recipe.revision,acknowledgeStale:false},actor);
  assert.equal(applied.recipe.content.recipe.image,`/media/${created.id}`);
  assert.deepEqual(applied.recipe.content.photos,recipe.content.photos);
  assert.equal(await isRecipeContentApproved(applied.recipe),true);
  const correction=await createJob({recipeId:recipe.id,expectedRevision:applied.recipe.revision,kind:'hero',imageAction:'remove_background',
    brief:'Wytnij tło istniejącej fotografii.',requestKey:randomUUID()},actor);
  const correctionInput=(await getJobForExecution(correction.id)).input;
  assert.equal(correctionInput.aiPhotography?.heroPresentationOverride?.container,'clay-pot');
  assert.deepEqual(correctionInput.recipe.heroPresentation,sourcePresentation);
  await cancelJob(correction.id,actor);
});

test('new jobs capture recipe, research, timing and diet contracts without inventing a dietary target; changed vessel cannot override a stale hero',async()=>{
  let recipe=await fixture();
  const text=await job(recipe,'Capture finished-dish schema');
  const textInput=(await getJobForExecution(text.id)).input;
  assert.equal(textInput.aiPhotography?.recipeDietTarget,undefined,'An ordinary new recipe has no balancing target imposed on its author.');
  assert.deepEqual(textInput.aiPhotography,{recipeProposalVersion:'finished-dish-v2',recipePresentationVersion:'required-finished-dish-v1',recipeResearchVersion:'web-recipe-v1',recipeTimingVersion:'dependency-timing-v1',recipeDietVersion:'ingredient-diet-v1'});
  assert.equal(recipe.content.aiPhotography,undefined,'Admission captures the job contract without changing the editor draft.');
  await cancelJob(text.id,actor);
  const generated=await job(recipe,'Finished product photograph','hero');
  const captured=await getJobForExecution(generated.id);
  assert.equal(captured.input.aiPhotography?.heroStyleProfile,heroPresentationProfile);
  assert.equal(captured.input.recipe.heroPresentation?.container,'plate');
  assert.equal((await getJob(generated.id)).heroContainer,'plate');
  await claimSubmission(generated.id);await attachProviderRequest(generated.id,`mock-${generated.id}`);
  const ready=await finishAsset(generated.id,{blobPathname:`private/${generated.id}.webp`,width:1600,height:1600,contentType:'image/webp',alt:recipe.content.recipe.title,caption:{pl:'',en:''},hasTransparency:true,styleProfile:heroPresentationProfile},{chargedUsd:'0',costBasis:'usage'});
  assert.equal(ready.result?.asset?.styleProfile,heroPresentationProfile);
  const content=structuredClone(recipe.content);
  content.recipe.heroPresentation={...resolveHeroPresentation(content.recipe)!,container:'jar'};
  recipe=await saveRecipe(recipe.id,{expectedRevision:recipe.revision,content},actor);
  await assert.rejects(applyJob(generated.id,{expectedRevision:recipe.revision,acknowledgeStale:true},actor),aiCode('HERO_PRESENTATION_CHANGED'));
  assert.equal((await getJob(generated.id)).status,'ready');
  assert.equal((await getRecipe(recipe.id)).content.recipe.image,content.recipe.image);
});

test('a direct queued photograph cannot use approval of a different later recipe version',async()=>{
  const recipe=await fixture();
  const created=await job(recipe,'Hero from the originally accepted text','hero');
  assert.equal((await claimSubmission(created.id)).shouldSubmit,true);
  const content=structuredClone(recipe.content);content.recipe.description.en+=' A changed cooking concept.';
  const edited=await saveRecipe(recipe.id,{expectedRevision:recipe.revision,content},actor);
  await approveRecipeContent(edited.id,edited.revision,actor);
  await assert.rejects(ensureSubmissionAllowed(created.id),aiCode('PHOTO_CONTENT_CHANGED'));
  assert.equal((await getJobForExecution(created.id)).providerRequestId,null);
  await cancelJob(created.id,actor);await confirmNotSubmitted(created.id);
});

test('ambiguous preserve presentation is rejected before reserving money or creating an image job',async()=>{
  let recipe=await fixture();const content=structuredClone(recipe.content);
  content.recipe.title={pl:'Dżem testowy',en:'Test jam'};
  recipe=await saveRecipe(recipe.id,{expectedRevision:recipe.revision,content},actor);
  await approveRecipeContent(recipe.id,recipe.revision,actor);
  const before=(await getConfiguration()).budget;
  await assert.rejects(job(recipe,'Unresolved preserve','hero'),aiCode('HERO_PRESENTATION_REQUIRED'));
  const after=(await getConfiguration()).budget;
  assert.equal(after.reservedUsd,before.reservedUsd);
  assert.equal(after.activeJobs,before.activeJobs);
  assert.equal(after.dailyUsedUsd,before.dailyUsedUsd);
});

test('an explicit unresolved AI presentation never falls back to a local plate during admission',async()=>{
  let recipe=await fixture();const content=structuredClone(recipe.content);
  content.recipe.heroPresentation=null;
  recipe=await saveRecipe(recipe.id,{expectedRevision:recipe.revision,content},actor);
  assert(recipe.issues.some(issue=>issue.field==='heroPresentation'));
  const before=(await getConfiguration()).budget;
  await assert.rejects(approveRecipeContent(recipe.id,recipe.revision,actor),(error:unknown)=>error instanceof EditorialError && error.code==='CONTENT_REVIEW_REQUIRED');
  await assert.rejects(job(recipe,'Resolve final appearance first','hero'),(error:unknown)=>error instanceof EditorialError && error.code==='CONTENT_APPROVAL_REQUIRED');
  const after=(await getConfiguration()).budget;
  assert.equal(after.reservedUsd,before.reservedUsd);assert.equal(after.dailyUsedUsd,before.dailyUsedUsd);assert.equal(after.activeJobs,before.activeJobs);
  const count=await isolatedPool.query('SELECT count(*)::int AS count FROM ai_job WHERE recipe_id=$1',[recipe.id]);assert.equal(count.rows[0].count,0);
  assert.equal((await getRecipe(recipe.id)).content.recipe.heroPresentation,null,'an unresolved concept never becomes a local plate fallback');
});

test('zero-reservation admission still enforces two concurrent jobs and releases queued cancellation only',async()=>{
  const recipe=await fixture();const results=await Promise.allSettled([job(recipe),job(recipe),job(recipe)]);
  const accepted=results.filter(result=>result.status==='fulfilled') as PromiseFulfilledResult<AiJob>[];assert.equal(accepted.length,2);
  const failed=results.find(result=>result.status==='rejected') as PromiseRejectedResult;assert.equal(failed.reason.code,'CONCURRENCY_LIMIT');
  const budget=(await getConfiguration()).budget;assert.equal(budget.activeJobs,2);assert.equal(budget.reservedUsd,'0.00000000');
  for(const result of accepted)await cancelJob(result.value.id,actor);
  assert.equal((await getConfiguration()).budget.reservedUsd,'0.00000000');
});

test('removed spending caps admit both concurrent requests without reserves or estimated spending',async()=>{
  process.env.AI_DAILY_LIMIT_USD='0';const recipe=await fixture();
  try {
    const accepted=await Promise.all([job(recipe),job(recipe)]);
    assert.equal(accepted.length,2);assert(accepted.every(item=>item.reservedUsd==='0.00000000'&&item.chargedUsd===null));
    assert.equal((await getConfiguration()).budget.dailyUsedUsd,'0.00000000');
    await assert.rejects(job(recipe),aiCode('CONCURRENCY_LIMIT'));
    for(const item of accepted)await cancelJob(item.id,actor);
  } finally {process.env.AI_DAILY_LIMIT_USD='100';}
});

test('submission replay never permits a second paid call and preserves unknown billing',async()=>{
  const recipe=await fixture();const created=await job(recipe,'Uncertain identical request');
  assert.equal((await claimSubmission(created.id)).shouldSubmit,true);
  const replay=await claimSubmission(created.id);assert.equal(replay.shouldSubmit,false);assert.equal(replay.job.status,'uncertain');
  const uncertain=await getJob(created.id);assert.equal(uncertain.chargedUsd,null);assert.equal(uncertain.costBasis,'reservation');
  const duplicate=await job(recipe,'Uncertain identical request');assert.equal(duplicate.id,created.id);
  await assert.rejects(resumeJob(created.id,actor),aiCode('CANNOT_RESUME'));
  await failJob(created.id,{code:'TIMEOUT',message:'No acceptance confirmation',uncertain:true});assert.equal((await getConfiguration()).budget.dailyUsedUsd,'0.00000000');
  await attachProviderRequest(created.id,`mock-late-${created.id}`);
  await failJob(created.id,{code:'POLL_TIMEOUT',message:'Temporary polling failure',uncertain:true});
  // A completed provider may still need its existing result downloaded again.
  // This is a read-only resume and must not reserve or submit another request.
  await markProviderTerminal(created.id);
  assert.equal((await resumeJob(created.id,actor)).status,'generating');
  await finishRecipe(created.id,recipe.content,{chargedUsd:'0',costBasis:'usage'});
  const ledger=await isolatedPool.query('SELECT sum(amount_usd)::text AS total,count(*)::int AS count FROM ai_cost_ledger WHERE job_id=$1',[created.id]);assert.equal(Number(ledger.rows[0].total),0);assert.equal(ledger.rows[0].count,1);
});

test('accepted receipt-only recovery ignores occupied remote slots while another paid admission stays blocked',async()=>{
  const recipe=await fixture();const accepted=await job(recipe,'Receipt to read again');
  await claimSubmission(accepted.id);await attachProviderRequest(accepted.id,`receipt-${accepted.id}`);
  await failJob(accepted.id,{code:'READ_TIMEOUT',message:'Read can safely resume',uncertain:true});
  await markProviderTerminal(accepted.id);
  const others=[await job(recipe,'Occupied slot one'),await job(recipe,'Occupied slot two')];
  // Reproduce an earlier ambiguous terminal observation using only synthetic
  // test receipts. Three recorded remote jobs must not forbid a GET recovery.
  await isolatedPool.query('UPDATE ai_job SET provider_finished_at=NULL WHERE id=$1',[accepted.id]);
  assert.equal((await getConfiguration()).budget.activeJobs,3);
  const before=(await getConfiguration()).budget.pilotUsedUsd;
  const resumed=await resumeJob(accepted.id,actor);
  assert.equal(resumed.status,'generating');assert.equal(resumed.providerRequestId,`receipt-${accepted.id}`);
  assert.equal((await claimSubmission(accepted.id)).shouldSubmit,false);
  assert.equal((await getConfiguration()).budget.pilotUsedUsd,before);
  await assert.rejects(job(recipe,'An additional paid request'),aiCode('CONCURRENCY_LIMIT'));
  await finishRecipe(accepted.id,recipe.content,{chargedUsd:'0',costBasis:'usage'});
  for(const other of others)await cancelJob(other.id,actor);
});

test('current stored role and disabled flag protect creation, internal execution, apply and cancel',async()=>{
  const recipe=await fixture();
  for(const id of ['reader','disabled','missing'])await assert.rejects(createJob({recipeId:recipe.id,expectedRevision:recipe.revision,kind:'recipe',brief:'Forbidden',requestKey:randomUUID()},{...actor,id}),aiCode('FORBIDDEN'));
  const created=await job(recipe);await isolatedPool.query(`UPDATE auth_user SET disabled=true WHERE id='test-owner'`);
  try{await assert.rejects(claimSubmission(created.id),aiCode('FORBIDDEN'));await assert.rejects(cancelJob(created.id,actor),aiCode('FORBIDDEN'));}
  finally{await isolatedPool.query(`UPDATE auth_user SET disabled=false WHERE id='test-owner'`);}
  await cancelJob(created.id,actor);
});

test('known rejection before acceptance releases cost; provider accepted failures retain conservative cost',async()=>{
  const recipe=await fixture();const first=await job(recipe);await claimSubmission(first.id);const failure=await failJob(first.id,{code:'LOCAL_VALIDATION',message:'Request was not sent',uncertain:false});assert.equal(failure.status,'failed');assert.equal(failure.chargedUsd,'0.00000000');
  const accepted=await job(recipe);await claimSubmission(accepted.id);await attachProviderRequest(accepted.id,`mock-${accepted.id}`);const unknown=await failJob(accepted.id,{code:'RESULT_ERROR',message:'Unknown bill',uncertain:false,providerFinished:true});assert.equal(unknown.status,'failed');assert.equal(unknown.chargedUsd,null);assert.equal(unknown.costBasis,'reservation');assert((await getJobForExecution(accepted.id)).providerFinishedAt);
  await settleCost(accepted.id,{chargedUsd:'0',costBasis:'usage'});
});

test('cancelled in-flight requests keep both remote concurrency slots until confirmed terminal',async()=>{
  const baseline=(await getConfiguration()).budget.dailyUsedUsd;
  const recipe=await fixture();const first=await job(recipe);const second=await job(recipe);
  for(const created of [first,second]){await claimSubmission(created.id);await attachProviderRequest(created.id,`mock-${created.id}`);await cancelJob(created.id,actor);}
  assert.equal((await getConfiguration()).budget.activeJobs,2);assert.equal((await getConfiguration()).budget.dailyUsedUsd,baseline);
  await assert.rejects(job(recipe),aiCode('CONCURRENCY_LIMIT'));
  await markProviderTerminal(first.id);assert.equal((await getConfiguration()).budget.activeJobs,1);assert.equal((await getConfiguration()).budget.dailyUsedUsd,baseline);assert.equal((await getJob(first.id)).status,'cancelled');
  const third=await job(recipe);await cancelJob(third.id,actor);await settleCost(first.id,{chargedUsd:'0',costBasis:'usage'});await finishRecipe(second.id,recipe.content,{chargedUsd:'0',costBasis:'usage'});
  assert.equal((await getConfiguration()).budget.activeJobs,0);assert.equal((await getConfiguration()).budget.dailyUsedUsd,baseline);
});

test('ready AI content remains separate; manual stale apply uses CAS, preserves current sources and resets approvals',async()=>{
  const live=await published(await fixture());const originalTitle=live.content.recipe.title.pl;const ready=await readyRecipe(live);
  assert.equal((await getRecipe(live.id)).revision,live.revision);assert.equal((await getPublishedRecipe(live.content.recipe.slug.pl,'pl'))?.title.pl,originalTitle);
  const changed=structuredClone(live.content);changed.recipe.title.pl='Human draft edit';changed.author='Current author';changed.originalText='New human source';changed.sources=[{id:'source',title:'Current source',url:'https://example.invalid/source'}];
  const current=await saveRecipe(live.id,{expectedRevision:live.revision,content:changed},actor);
  await assert.rejects(applyJob(ready.id,{expectedRevision:live.revision,acknowledgeStale:true},actor),(error:unknown)=>error instanceof EditorialError && error.code==='REVISION_CONFLICT');
  await assert.rejects(applyJob(ready.id,{expectedRevision:current.revision,acknowledgeStale:false},actor),aiCode('STALE_RESULT'));
  const applied=await applyJob(ready.id,{expectedRevision:current.revision,acknowledgeStale:true},actor);assert.equal(applied.recipe.revision,current.revision+1);assert.equal(applied.job.status,'applied');assert.equal(applied.job.appliedRevision,applied.recipe.revision);assert.equal(applied.recipe.content.recipe.title.pl,'Proposed title');assert.equal(applied.recipe.content.originalText,'New human source');assert.equal(applied.recipe.content.author,'Current author');assert.equal(applied.recipe.content.sources[0].title,'Current source');assert.equal(applied.recipe.content.recipe.provenance.kitchenTested,false);assert(Object.values(applied.recipe.checks).every(value=>!value));assert.equal(applied.recipe.editorialStatus,'draft');assert.equal((await getPublishedRecipe(live.content.recipe.slug.pl,'pl'))?.title.pl,originalTitle);
  await assert.rejects(isolatedPool.query('UPDATE ai_job SET result=$1 WHERE id=$2',[JSON.stringify({content:null,asset:null,notes:[]}),ready.id]),/immutable/);
});

test('registered images are private until publication, exact target apply is bounded, and paths never leak in DTOs',async()=>{
  const initial=await fixture();initial.content.recipe.ingredients[0].name={pl:'Makaron linguine, suchy, z pszenicy durum',en:'Dried durum wheat linguine pasta'};
  delete initial.content.photos.ingredients[initial.content.recipe.ingredients[0].id];
  await registerFixturePhotos(initial.content,actor,initial.revision);
  const recipe=await saveRecipe(initial.id,{expectedRevision:initial.revision,content:initial.content},actor);await approveCompleteFixture(recipe);const created=await job(recipe,'Ingredient photograph','ingredient',recipe.content.recipe.ingredients[0].id);await claimSubmission(created.id);await attachProviderRequest(created.id,`mock-${created.id}`);
  const ready=await finishAsset(created.id,{blobPathname:`private/${created.id}.webp`,width:1024,height:1024,contentType:'image/webp',alt:{pl:'Składnik AI',en:'AI ingredient'},caption:{pl:'Detal składnika',en:'Ingredient detail'}},{chargedUsd:'0',costBasis:'usage'});
  assert.equal(ready.result?.asset?.id,created.id);assert.equal(ready.result?.asset?.src,`/media/${created.id}`);assert.equal(JSON.stringify(ready).includes('blobPathname'),false);assert.equal((await getAssetForExecution(created.id))?.blobPathname,`private/${created.id}.webp`);assert.equal(await isAssetPublic(created.id),false);
  const applied=await applyJob(created.id,{expectedRevision:recipe.revision,acknowledgeStale:false},actor);assert.equal(applied.recipe.content.photos.ingredients.pasta.src,`/media/${created.id}`);assert.equal(applied.recipe.content.recipe.image,recipe.content.recipe.image);assert.deepEqual(applied.recipe.issues,[]);
  assert(publicationIssues(applied.recipe.content).some(issue=>issue.field==='ingredients.pasta.photo'));
  const live=await published(applied.recipe);assert.equal(await isAssetPublic(created.id),true);
  await performRecipeAction(live.id,{action:'unpublish',expectedRevision:live.revision},actor);assert.equal(await isAssetPublic(created.id),false);
  await assert.rejects(isolatedPool.query('UPDATE ai_asset SET blob_pathname=$1 WHERE id=$2',['other',created.id]),/immutable/);
  const invalid=structuredClone(applied.recipe.content);invalid.photos.ingredients.pasta.src=`/media/${randomUUID()}`;
  await assert.rejects(saveRecipe(applied.recipe.id,{expectedRevision:live.revision+1,content:invalid},actor),(error:unknown)=>error instanceof EditorialError&&error.code==='INGREDIENT_PHOTO_MISMATCH');
  assert.equal((await getRecipe(applied.recipe.id)).revision,live.revision+1,'An unregistered source is rejected before changing the draft.');
});

test('image proposal cannot attach to a deleted target and cancellation after acceptance never becomes applicable',async()=>{
  const recipe=await fixture();const target=recipe.content.recipe.steps[0].id;const created=await job(recipe,'Step detail','step',target);await claimSubmission(created.id);await attachProviderRequest(created.id,`mock-${created.id}`);await finishAsset(created.id,{blobPathname:`private/${created.id}.png`,width:1000,height:800,contentType:'image/png',alt:{pl:'Detal',en:'Detail'},caption:{pl:'Konsystencja',en:'Texture'}},{chargedUsd:'0'});
  const changed=structuredClone(recipe.content);changed.recipe.steps=changed.recipe.steps.filter(step=>step.id!==target);delete changed.photos.steps[target];
  await registerFixturePhotos(changed,actor,recipe.revision);
  const current=await saveRecipe(recipe.id,{expectedRevision:recipe.revision,content:changed},actor);await assert.rejects(applyJob(created.id,{expectedRevision:current.revision,acknowledgeStale:true},actor),aiCode('TARGET_MISSING'));assert.equal((await getRecipe(recipe.id)).revision,current.revision);
  const cancelled=await job(current);await claimSubmission(cancelled.id);await cancelJob(cancelled.id,actor);await attachProviderRequest(cancelled.id,`mock-late-${cancelled.id}`);assert.equal((await getJob(cancelled.id)).status,'cancelled');assert.equal((await getJob(cancelled.id)).chargedUsd,null);
  const completed=await finishRecipe(cancelled.id,current.content,{chargedUsd:'0.123',costBasis:'usage'});assert.equal(completed.status,'cancelled');assert.equal(completed.chargedUsd,'0.12300000');assert(completed.result?.content);await assert.rejects(applyJob(cancelled.id,{expectedRevision:current.revision,acknowledgeStale:false},actor),aiCode('RESULT_NOT_READY'));
  const total=await isolatedPool.query('SELECT sum(amount_usd)::text AS total FROM ai_cost_ledger WHERE job_id=$1',[cancelled.id]);assert.equal(Number(total.rows[0].total),0.123);
});

test('a ready step photo cannot override changed quantities, method or approved appearance through stale acknowledgement',async()=>{
  const cases: {name:string; change:(content:EditorialContent)=>void}[] = [
    {name:'quantity',change:content=>{content.recipe.ingredients[0].amount={kind:'exact',value:'999'};}},
    {name:'base servings',change:content=>{content.recipe.baseServings+=1;}},
    {name:'method',change:content=>{content.recipe.steps[0].text.en+=' Continue until lightly browned.';}},
    {name:'approved Polish appearance',change:content=>{content.recipe.heroPresentation!.finalAppearance.pl+=' Jasnobrązowe białka po marynowaniu.';}},
    {name:'approved English appearance',change:content=>{content.recipe.heroPresentation!.finalAppearance.en+=' Light brown whites after marinating.';}},
  ];
  for(const item of cases){
    const recipe=await fixture();const target=recipe.content.recipe.steps[0].id;
    const created=await job(recipe,`Step consistency: ${item.name}`,'step',target);await claimSubmission(created.id);await attachProviderRequest(created.id,`mock-${created.id}`);
    await finishAsset(created.id,{blobPathname:`private/${created.id}.webp`,width:2100,height:900,contentType:'image/webp',alt:{pl:'Krok',en:'Step'},caption:{pl:'Przygotowanie',en:'Preparation'}},{chargedUsd:'0',costBasis:'usage'});
    const beforeJob=await getJobForExecution(created.id);
    const changed=structuredClone(recipe.content);changed.recipe.heroPresentation=resolveHeroPresentation(changed.recipe)!;item.change(changed);
    await registerFixturePhotos(changed,actor,recipe.revision);
    const current=await saveRecipe(recipe.id,{expectedRevision:recipe.revision,content:changed},actor);
    await assert.rejects(applyJob(created.id,{expectedRevision:current.revision,acknowledgeStale:true},actor),aiCode('STEP_CONTENT_CHANGED'),item.name);
    assert.deepEqual((await getRecipe(recipe.id)).content,current.content,item.name);
    assert.deepEqual(await getJobForExecution(created.id),beforeJob,'Rejected application preserves the ready result and receipt.');
  }
});

test('a reviewed ready step remains applicable across photo-only revisions and a vessel-only change',async()=>{
  const recipe=await fixture();const target=recipe.content.recipe.steps[0].id;
  const created=await job(recipe,'Step after photo-only changes','step',target);await claimSubmission(created.id);await attachProviderRequest(created.id,`mock-${created.id}`);
  await finishAsset(created.id,{blobPathname:`private/${created.id}.webp`,width:2100,height:900,contentType:'image/webp',alt:{pl:'Krok',en:'Step'},caption:{pl:'Przygotowanie',en:'Preparation'}},{chargedUsd:'0',costBasis:'usage'});
  const changed=structuredClone(recipe.content);changed.recipe.imageAlt.pl+=' Nowy opis zdjęcia.';
  changed.recipe.heroPresentation={...resolveHeroPresentation(changed.recipe)!,container:'platter'};
  const current=await saveRecipe(recipe.id,{expectedRevision:recipe.revision,content:changed},actor);
  await assert.rejects(applyJob(created.id,{expectedRevision:current.revision,acknowledgeStale:false},actor),aiCode('STALE_RESULT'));
  const applied=await applyJob(created.id,{expectedRevision:current.revision,acknowledgeStale:true},actor);
  const expected=structuredClone(current.content);expected.photos.steps[target]=applied.recipe.content.photos.steps[target];
  assert.deepEqual(applied.recipe.content,expected,'Only the reviewed step photo is replaced.');
  assert.equal(applied.recipe.content.photos.steps[target].src,`/media/${created.id}`);
  assert.equal(applied.recipe.revision,current.revision+1);assert.equal(applied.job.status,'applied');
});

test('pre-POST cancellation has a local proof path; accepted provider accounting survives disabled creator',async()=>{
  const recipe=await fixture();const preparing=await job(recipe);await claimSubmission(preparing.id);await ensureSubmissionAllowed(preparing.id);await cancelJob(preparing.id,actor);await assert.rejects(ensureSubmissionAllowed(preparing.id),aiCode('SUBMISSION_BLOCKED'));
  const confirmed=await confirmNotSubmitted(preparing.id);assert.equal(confirmed.status,'cancelled');assert.equal(confirmed.chargedUsd,'0.00000000');assert.equal((await getConfiguration()).budget.activeJobs,0);
  const accepted=await job(recipe);await claimSubmission(accepted.id);await isolatedPool.query(`UPDATE auth_user SET disabled=true WHERE id='test-owner'`);
  try{await assert.rejects(ensureSubmissionAllowed(accepted.id),aiCode('FORBIDDEN'));await attachProviderRequest(accepted.id,`mock-accepted-before-disable-${accepted.id}`);const recorded=await finishRecipe(accepted.id,recipe.content,{chargedUsd:'0.012',costBasis:'usage'});assert.equal(recorded.status,'ready');assert.equal(recorded.chargedUsd,'0.01200000');await assert.rejects(applyJob(accepted.id,{expectedRevision:recipe.revision,acknowledgeStale:false},actor),aiCode('FORBIDDEN'));}
  finally{await isolatedPool.query(`UPDATE auth_user SET disabled=false WHERE id='test-owner'`);}
});

async function ingredientFixture(name:{pl:string;en:string},note?:{pl:string;en:string}){
  const initial=await fixture();initial.content.recipe.ingredients[0].name=name;initial.content.recipe.ingredients[0].note=note;
  delete initial.content.photos.ingredients[initial.content.recipe.ingredients[0].id];
  // A different product/form cannot retain the seed pasta photograph or the
  // seed dish's static photo evidence. Register explicit mock sources instead.
  await registerFixturePhotos(initial.content,actor,initial.revision);
  const saved=await saveRecipe(initial.id,{expectedRevision:initial.revision,content:initial.content},actor);await approveRecipeContent(saved.id,saved.revision,actor);return saved;
}
async function finishedIngredient(recipe:EditorialRecord,created:AiJob,transparency=true){
  await claimSubmission(created.id);await attachProviderRequest(created.id,`mock-ingredient-${created.id}`);
  return finishAsset(created.id,{blobPathname:`private/${created.id}.webp`,width:1024,height:1024,contentType:'image/webp',alt:recipe.content.recipe.ingredients[0].name,caption:{pl:'',en:''},hasTransparency:transparency,styleProfile:ingredientStyleProfile},{chargedUsd:'0.03',costBasis:'usage'});
}

test('static matching aliases are reused across recipes with zero cost even offline or over budget',async()=>{
  const first=await ingredientFixture({pl:'mąka pszenna',en:'plain flour'});const second=await ingredientFixture({pl:'mąka do podsypywania',en:'all-purpose flour'});
  const savedKey=process.env.FAL_KEY;const savedLimit=process.env.AI_DAILY_LIMIT_USD;
  delete process.env.FAL_KEY;delete process.env.FAL_API_KEY;process.env.AI_DAILY_LIMIT_USD='0.01';
  try{
    const one=await job(first,'Flour photo','ingredient','pasta');const two=await job(second,'Different creative brief ignored for existing ingredient','ingredient','pasta');
    for(const item of [one,two]){assert.equal(item.status,'ready');assert.equal(item.reservedUsd,'0.00000000');assert.equal(item.chargedUsd,'0.00000000');assert.equal(item.providerRequestId,null);assert.equal(item.result?.reusedPhoto?.src,'/images/ingredients-2.webp');assert.equal(item.result?.reusedPhoto?.index,5);assert.equal((await claimSubmission(item.id)).shouldSubmit,false);}
    assert.equal(one.result?.reuse?.key,two.result?.reuse?.key);
    const applied=await applyJob(two.id,{expectedRevision:second.revision,acknowledgeStale:false},actor);assert.equal(applied.recipe.content.photos.ingredients.pasta.index,5);
  }finally{process.env.FAL_KEY=savedKey;process.env.AI_DAILY_LIMIT_USD=savedLimit;}
});

test('simultaneous shared missing products admit exactly one paid producer and a zero-cost follower',async()=>{
  const first=await ingredientFixture({pl:'brokuł',en:'broccoli'});const second=await ingredientFixture({pl:'brokuł',en:'broccoli'});
  const baseline=(await getConfiguration()).budget;
  const jobs=await Promise.all([job(first,'First recipe style','ingredient','pasta'),job(second,'Other recipe brief','ingredient','pasta')]);
  const producer=jobs.find(item=>!item.reuseSourceJobId)!;const follower=jobs.find(item=>Boolean(item.reuseSourceJobId))!;
  assert(producer&&follower);assert.equal(follower.reuseSourceJobId,producer.id);assert.equal((await getConfiguration()).budget.activeJobs,baseline.activeJobs+1);
  assert.equal(Number((await getConfiguration()).budget.dailyUsedUsd),Number(baseline.dailyUsedUsd));
  assert.equal((await claimSubmission(follower.id)).shouldSubmit,false);assert.equal(await resolveIngredientReuse(follower.id),false);
  const sourceRecipe=producer.recipeId===first.id?first:second;const destinationRecipe=follower.recipeId===first.id?first:second;
  await finishedIngredient(sourceRecipe,producer);assert.equal(await resolveIngredientReuse(follower.id),true);
  const ready=await getJob(follower.id);assert.equal(ready.status,'ready');assert.equal(ready.providerRequestId,null);assert.equal(ready.chargedUsd,'0.00000000');assert.equal(ready.result?.asset?.id,producer.id);assert.equal(ready.result?.reusedPhoto?.src,`/media/${producer.id}`);
  const sourceApplied=await applyJob(producer.id,{expectedRevision:sourceRecipe.revision,acknowledgeStale:false},actor);
  const destinationApplied=await applyJob(follower.id,{expectedRevision:destinationRecipe.revision,acknowledgeStale:false},actor);
  assert.equal(destinationApplied.recipe.content.photos.ingredients.pasta.src,`/media/${producer.id}`);
  const sourceLive=await published(sourceApplied.recipe);const destinationLive=await published(destinationApplied.recipe);
  await performRecipeAction(sourceLive.id,{action:'unpublish',expectedRevision:sourceLive.revision},actor);assert.equal(await isAssetPublic(producer.id),true);
  await performRecipeAction(destinationLive.id,{action:'unpublish',expectedRevision:destinationLive.revision},actor);assert.equal(await isAssetPublic(producer.id),false);
  const third=await ingredientFixture({pl:'BROKUŁ',en:'broccoli'});const reused=await job(third,'Repeated later','ingredient','pasta');assert.equal(reused.status,'ready');assert.equal(reused.reservedUsd,'0.00000000');assert.equal(reused.result?.asset?.id,producer.id);
});

test('prepared form separates catalog entries and budget only includes unique missing product forms',async()=>{
  const flour=await ingredientFixture({pl:'mąka pszenna',en:'plain flour'});
  const plain=await ingredientFixture({pl:'marchew',en:'carrot'});const chopped=await ingredientFixture({pl:'marchew',en:'carrot'},{pl:'Posiekaj drobno.',en:'Finely chopped.'});
  const all=[flour.content.recipe.ingredients[0],plain.content.recipe.ingredients[0],plain.content.recipe.ingredients[0],chopped.content.recipe.ingredients[0]];
  const missing=await missingIngredientKeys(getDb(),all);assert.equal(missing.size,2);
  const jobs=await Promise.all([job(plain,'Plain carrot','ingredient','pasta'),job(chopped,'Chopped carrot','ingredient','pasta')]);
  assert(jobs.every(item=>Number(item.reservedUsd)===0));assert.notEqual((await getJobForExecution(jobs[0].id)).ingredientKey,(await getJobForExecution(jobs[1].id)).ingredientKey);
  assert.equal((await missingIngredientKeys(getDb(),all)).size,0);
  for(const created of jobs)await cancelJob(created.id,actor);
});

test('an uncertain first product never authorizes a duplicate paid fallback for another recipe',async()=>{
  const first=await ingredientFixture({pl:'ziemniak',en:'potato'});const second=await ingredientFixture({pl:'ziemniaki',en:'potatoes'});
  const source=await job(first,'Potato first','ingredient','pasta');await claimSubmission(source.id);await failJob(source.id,{code:'UNKNOWN_ACCEPTANCE',message:'Unknown provider acceptance',uncertain:true});
  const follower=await job(second,'Potato again','ingredient','pasta');assert.equal(follower.reuseSourceJobId,source.id);assert.equal(follower.reservedUsd,'0.00000000');assert.equal((await claimSubmission(follower.id)).shouldSubmit,false);
  assert.equal(await resolveIngredientReuse(follower.id),true);assert.equal((await getJob(follower.id)).status,'uncertain');assert.equal((await getJob(follower.id)).providerRequestId,null);
  await attachProviderRequest(source.id,`mock-late-${source.id}`);await finishAsset(source.id,{blobPathname:`private/${source.id}.webp`,width:1024,height:1024,contentType:'image/webp',alt:first.content.recipe.ingredients[0].name,caption:{pl:'',en:''},hasTransparency:true,styleProfile:ingredientStyleProfile},{chargedUsd:'0.03'});
  await resumeJob(follower.id,actor);assert.equal(await resolveIngredientReuse(follower.id),true);assert.equal((await getJob(follower.id)).status,'ready');
});

test('legacy applied image read failure blocks new paid generation instead of silently falling back',async()=>{
  const first=await ingredientFixture({pl:'seler korzeniowy',en:'celeriac'});const second=await ingredientFixture({pl:'seler korzeniowy',en:'celeriac'});
  const source=await job(first,'Old celeriac photo','ingredient','pasta');await finishedIngredient(first,source,false);await applyJob(source.id,{expectedRevision:first.revision,acknowledgeStale:false},actor);
  const before=await isolatedPool.query('SELECT count(*)::int count FROM ai_job');const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error('Simulated private storage outage');};
  try{await assert.rejects(job(second,'Never regenerate available old photo','ingredient','pasta'),aiCode('INGREDIENT_IMAGE_CHECK_UNAVAILABLE'));}
  finally{globalThis.fetch=originalFetch;}
  const after=await isolatedPool.query('SELECT count(*)::int count FROM ai_job');assert.equal(after.rows[0].count,before.rows[0].count);
});

test('local step format correction is zero-cost even above budget and cannot bypass hero cutout billing',async()=>{
  const recipe=await fixture();const savedLimit=process.env.AI_DAILY_LIMIT_USD;const savedKey=process.env.FAL_KEY;
  process.env.AI_DAILY_LIMIT_USD='0.01';delete process.env.FAL_KEY;
  try{
    const cropped=await createJob({recipeId:recipe.id,expectedRevision:recipe.revision,kind:'step',targetId:recipe.content.recipe.steps[0].id,imageAction:'crop_step',brief:'Existing photo format only',requestKey:randomUUID()},actor);
    assert.equal(cropped.model,stepFormatModel);assert.equal(cropped.reservedUsd,'0.00000000');assert.equal((await claimSubmission(cropped.id)).shouldSubmit,true);await ensureSubmissionAllowed(cropped.id);
    await finishAsset(cropped.id,{blobPathname:`private/${cropped.id}.webp`,width:2100,height:900,contentType:'image/webp',alt:{pl:'Detal',en:'Detail'},caption:{pl:'Konsystencja',en:'Texture'}},{chargedUsd:'0',costBasis:'usage'});assert.equal((await getJob(cropped.id)).chargedUsd,'0.00000000');
    process.env.FAL_KEY=savedKey;
    const noCap=await createJob({recipeId:recipe.id,expectedRevision:recipe.revision,kind:'hero',imageAction:'remove_background',brief:'Existing dish cutout',requestKey:randomUUID()},actor);assert.equal(noCap.reservedUsd,'0.00000000');await cancelJob(noCap.id,actor);
    await assert.rejects(createJob({recipeId:recipe.id,expectedRevision:recipe.revision,kind:'ingredient',targetId:'pasta',imageAction:'crop_step',brief:'Invalid free operation',requestKey:randomUUID()},actor),aiCode('INVALID_IMAGE_ACTION'));
  }finally{process.env.AI_DAILY_LIMIT_USD=savedLimit;process.env.FAL_KEY=savedKey;}
  const cutout=await createJob({recipeId:recipe.id,expectedRevision:recipe.revision,kind:'hero',imageAction:'remove_background',brief:'Cut out existing hero',requestKey:randomUUID()},actor);assert.equal(cutout.model,heroCutoutModel);assert.equal(cutout.reservedUsd,'0.00000000');await cancelJob(cutout.id,actor);
});

test('provider terminal releases remote concurrency but reserves product identity through image validation',async()=>{
  const first=await ingredientFixture({pl:'karczoch',en:'artichoke'});const second=await ingredientFixture({pl:'karczoch',en:'artichoke'});
  const baseline=(await getConfiguration()).budget.activeJobs;
  const source=await job(first,'Artichoke original','ingredient','pasta');await claimSubmission(source.id);await attachProviderRequest(source.id,`mock-artichoke-${source.id}`);
  await markProviderTerminal(source.id);const captured=await getJobForExecution(source.id);
  assert.equal((await getConfiguration()).budget.activeJobs,baseline);assert(captured.providerFinishedAt);assert.equal(captured.ingredientResolvedAt,null);
  const follower=await job(second,'Artichoke during download','ingredient','pasta');assert.equal(follower.reservedUsd,'0.00000000');assert.equal(follower.reuseSourceJobId,source.id);
  assert.equal(await resolveIngredientReuse(follower.id),false);assert.equal((await getJob(follower.id)).status,'queued');
  await assert.rejects(isolatedPool.query('INSERT INTO ai_job(id,recipe_id,base_revision,kind,target_id,status,provider,model,brief,request_key,input_hash,input,created_by,created_by_name,reserved_usd,ingredient_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',[randomUUID(),second.id,second.revision,'ingredient','pasta','queued','fal',captured.model,'Forbidden duplicate',randomUUID(),randomUUID(),captured.input,actor.id,actor.name,'2',captured.ingredientKey]),{code:'23505'});
  await finishAsset(source.id,{blobPathname:`private/${source.id}.webp`,width:1024,height:1024,contentType:'image/webp',alt:first.content.recipe.ingredients[0].name,caption:{pl:'',en:''},hasTransparency:true,styleProfile:ingredientStyleProfile},{chargedUsd:'0.03'});
  assert((await getJobForExecution(source.id)).ingredientResolvedAt);assert.equal(await resolveIngredientReuse(follower.id),true);assert.equal((await getJob(follower.id)).status,'ready');
});

test('cancelled accepted products retain identity after provider terminal until a known invalid result',async()=>{
  const first=await ingredientFixture({pl:'kalafior',en:'cauliflower'});const second=await ingredientFixture({pl:'kalafior',en:'cauliflower'});
  const source=await job(first,'Cauliflower original','ingredient','pasta');await claimSubmission(source.id);await attachProviderRequest(source.id,`mock-cauliflower-${source.id}`);await cancelJob(source.id,actor);await markProviderTerminal(source.id);
  const follower=await job(second,'Cauliflower while validating','ingredient','pasta');assert.equal(follower.reuseSourceJobId,source.id);assert.equal(await resolveIngredientReuse(follower.id),false);
  await failJob(source.id,{code:'AI_IMAGE_INVALID',message:'Known invalid mock image',uncertain:false,providerFinished:true});assert((await getJobForExecution(source.id)).ingredientResolvedAt);
  assert.equal(await resolveIngredientReuse(follower.id),true);assert.equal((await getJob(follower.id)).status,'failed');
  const retry=await job(second,'New explicit generation after unusable result','ingredient','pasta');assert.equal(retry.reservedUsd,'0.00000000');assert.equal(retry.reuseSourceJobId,null);await cancelJob(retry.id,actor);
});

test('fill cutout captures only a same-recipe ready SAM source, costs zero and rejects changed food',async()=>{
  const recipe=await fixture();const foreign=await fixture();
  const cutout=await createJob({recipeId:recipe.id,expectedRevision:recipe.revision,kind:'hero',imageAction:'remove_background',brief:'Source SAM',requestKey:randomUUID()},actor);
  await claimSubmission(cutout.id);await attachProviderRequest(cutout.id,`mock-sam-${cutout.id}`);
  await finishAsset(cutout.id,{blobPathname:`private/${cutout.id}.webp`,originalBlobPathname:`private/${cutout.id}/original.png`,width:2560,height:1920,contentType:'image/webp',alt:recipe.content.recipe.title,caption:{pl:'',en:''}},{chargedUsd:'0.01'});
  const savedLimit=process.env.AI_DAILY_LIMIT_USD;const savedKey=process.env.FAL_KEY;process.env.AI_DAILY_LIMIT_USD='0.01';delete process.env.FAL_KEY;
  try{
    const input={recipeId:recipe.id,expectedRevision:recipe.revision,kind:'hero' as const,imageAction:'fill_cutout' as const,sourceJobId:cutout.id,brief:'Fill only existing silhouette',requestKey:randomUUID()};
    const admitted=await createJobAdmission(input,actor);assert(admitted.created);assert.equal(admitted.job.model,filledHeroModel);assert.equal(admitted.job.reservedUsd,'0.00000000');assert.equal(admitted.job.providerRequestId,null);
    const captured=await getJobForExecution(admitted.job.id);assert.equal(captured.input.recipe.image,`/media/${cutout.id}`);assert.equal(captured.baseRevision,recipe.revision);
    assert.equal((await getRecipe(recipe.id)).content.recipe.image,recipe.content.recipe.image);assert.equal((await getJobForExecution(cutout.id)).input.recipe.image,recipe.content.recipe.image);
    assert.equal((await createJobAdmission(input,actor)).created,false);
    await assert.rejects(createJob({...input,recipeId:foreign.id,expectedRevision:foreign.revision,requestKey:randomUUID()},actor),aiCode('INVALID_CORRECTION_SOURCE'));
    await assert.rejects(createJob({...input,kind:'step',targetId:recipe.content.recipe.steps[0].id,requestKey:randomUUID()},actor),aiCode('INVALID_IMAGE_ACTION'));
    await assert.rejects(createJob({...input,sourceJobId:admitted.job.id},actor),aiCode('REQUEST_KEY_REUSED'));
    assert.equal((await claimSubmission(admitted.job.id)).shouldSubmit,true);await ensureSubmissionAllowed(admitted.job.id);
    await finishAsset(admitted.job.id,{blobPathname:`private/${admitted.job.id}.webp`,originalBlobPathname:`private/${admitted.job.id}/original.png`,width:2560,height:1920,contentType:'image/webp',alt:recipe.content.recipe.title,caption:{pl:'',en:''}},{chargedUsd:'0',costBasis:'usage'});
    assert.equal((await getJob(admitted.job.id)).chargedUsd,'0.00000000');assert.equal((await getRecipe(recipe.id)).revision,recipe.revision);
    const changed=structuredClone(recipe.content);changed.recipe.ingredients[0].name={pl:'Makaron pełnoziarnisty, suchy',en:'Dried wholewheat pasta'};
    await registerFixturePhotos(changed,actor,recipe.revision);
    const saved=await saveRecipe(recipe.id,{expectedRevision:recipe.revision,content:changed},actor);
    await approveCompleteFixture(saved);
    await assert.rejects(createJob({...input,expectedRevision:saved.revision,requestKey:randomUUID()},actor),aiCode('CORRECTION_SOURCE_STALE'));
  }finally{process.env.AI_DAILY_LIMIT_USD=savedLimit;process.env.FAL_KEY=savedKey;}
});

test('glass mask admission captures the food-inclusive v2 prompt for new source and existing-photo corrections',async()=>{
  const original=await fixture();
  const content=structuredClone(original.content);
  content.recipe.heroPresentation={container:'glass',finalAppearance:{pl:'Gładki chłodnik w kieliszku z winogronami i migdałami.',en:'Smooth soup in a glass with grapes and almonds.'},evidenceStepIds:[content.recipe.steps.at(-1)!.id],profileVersion:heroPresentationProfile};
  await registerFixturePhotos(content,actor,original.revision);
  const recipe=await saveRecipe(original.id,{expectedRevision:original.revision,content},actor);
  await approveRecipeContent(recipe.id,recipe.revision,actor);
  const existing=await createJob({recipeId:recipe.id,expectedRevision:recipe.revision,kind:'hero',imageAction:'remove_background',brief:'Retain the glass and its food.',requestKey:randomUUID()},actor);
  assert.equal((await getJobForExecution(existing.id)).input.aiPhotography?.heroMaskPromptVersion,glassHeroMaskPromptVersion);
  await cancelJob(existing.id,actor);await confirmNotSubmitted(existing.id);
  const source=await job(recipe,'Completed opaque glass photograph','hero');
  await claimSubmission(source.id);await attachProviderRequest(source.id,`mock-${source.id}`);
  await failJob(source.id,{code:'AI_TRANSPARENCY_MISSING',message:'Opaque mock glass photograph',uncertain:false,providerFinished:true});
  const before=await getJobForExecution(source.id);
  const correction=await createJob({recipeId:recipe.id,expectedRevision:recipe.revision,kind:'hero',imageAction:'cutout_result',sourceJobId:source.id,brief:'Recover the glass and its food.',requestKey:randomUUID()},actor);
  assert.equal((await getJobForExecution(correction.id)).input.aiPhotography?.heroMaskPromptVersion,glassHeroMaskPromptVersion);
  assert.deepEqual(await getJobForExecution(source.id),before,'The accepted photograph capture remains immutable.');
  await cancelJob(correction.id,actor);await confirmNotSubmitted(correction.id);
});

test('cutout result reserves only SAM once, preserves the failed source and rejects changed food',async()=>{
  const recipe=await fixture();const foreign=await fixture();
  const source=await job(recipe,'Completed opaque hero','hero');await claimSubmission(source.id);await attachProviderRequest(source.id,`mock-${source.id}`);
  await markProviderTerminal(source.id);await failJob(source.id,{code:'AI_TRANSPARENCY_MISSING',message:'Opaque mock hero',uncertain:false,providerFinished:true});
  const originalSource=await getJobForExecution(source.id);
  const originalLedger=(await isolatedPool.query('SELECT entry,amount_usd,basis FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry',[source.id])).rows;
  const input={recipeId:recipe.id,expectedRevision:recipe.revision,kind:'hero' as const,imageAction:'cutout_result' as const,sourceJobId:source.id,brief:'Recover the completed photograph only',requestKey:randomUUID()};
  const admissions=await Promise.all([createJobAdmission(input,actor),createJobAdmission(input,actor)]);
  assert.equal(admissions.filter(item=>item.created).length,1);assert.equal(admissions[0].job.id,admissions[1].job.id);
  const recovered=admissions[0].job;
  assert.equal(recovered.model,heroCutoutModel);assert.equal(recovered.reservedUsd,'0.00000000');assert.equal(recovered.providerRequestId,null);
  assert.equal(recovered.baseRevision,recipe.revision);assert.equal((await getJobForExecution(recovered.id)).input.recipe.image,`${failedHeroSourcePrefix}${source.id}`);
  assert.deepEqual((await getRecipe(recipe.id)).content,recipe.content);
  await assert.rejects(createJob({...input,recipeId:foreign.id,expectedRevision:foreign.revision,requestKey:randomUUID()},actor),aiCode('INVALID_CORRECTION_SOURCE'));
  await assert.rejects(createJob({...input,kind:'step',targetId:recipe.content.recipe.steps[0].id,requestKey:randomUUID()},actor),aiCode('INVALID_IMAGE_ACTION'));
  await assert.rejects(createJob({...input,sourceJobId:randomUUID()},actor),aiCode('REQUEST_KEY_REUSED'));
  await assert.rejects(createJob({...input,imageAction:'remove_background',sourceJobId:undefined},actor),aiCode('REQUEST_KEY_REUSED'));
  // Source retrieval can fail before a paid SAM POST; only the new correction settles at zero.
  await claimSubmission(recovered.id);await failJob(recovered.id,{code:'AI_REFERENCE_UNAVAILABLE',message:'Mock expired source before submission',uncertain:false,chargedUsd:'0',providerFinished:true});
  assert.equal((await getJob(recovered.id)).chargedUsd,'0.00000000');
  assert.deepEqual(await getJobForExecution(source.id),originalSource);
  assert.deepEqual((await isolatedPool.query('SELECT entry,amount_usd,basis FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry',[source.id])).rows,originalLedger);
  assert.equal(originalSource.chargedUsd,null);assert.equal(originalSource.costBasis,'reservation');
  const changed=structuredClone(recipe.content);changed.recipe.ingredients[0].name={pl:'Makaron orkiszowy, suchy',en:'Dried spelt pasta'};
  await registerFixturePhotos(changed,actor,recipe.revision);
  const saved=await saveRecipe(recipe.id,{expectedRevision:recipe.revision,content:changed},actor);
  await approveCompleteFixture(saved);
  await assert.rejects(createJob({...input,expectedRevision:saved.revision,requestKey:randomUUID()},actor),aiCode('CORRECTION_SOURCE_STALE'));
});

test('one owner semantic retry repairs only a billed legacy empty hero mask and preserves the photograph',async()=>{
  const recipe=await fixture();
  const source=await createJob({recipeId:recipe.id,expectedRevision:recipe.revision,kind:'hero',brief:'Podaj potrawę w glinianym garnku.',requestKey:randomUUID()},actor);
  await claimSubmission(source.id);await attachProviderRequest(source.id,`mock-${source.id}`);
  await failJob(source.id,{code:'AI_TRANSPARENCY_MISSING',message:'Opaque photograph',uncertain:false,providerFinished:true,chargedUsd:'0.1671'});
  const original=await getJobForExecution(source.id);const originalLedger=(await isolatedPool.query('SELECT * FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry',[source.id])).rows;
  const legacyId=randomUUID();const legacyInput=structuredClone(original.input);
  legacyInput.recipe.image=`${failedHeroSourcePrefix}${source.id}`;
  delete legacyInput.aiPhotography!.regenerate;
  // Insert an historical capture once; immutable captures are never edited to manufacture compatibility.
  await isolatedPool.query(`INSERT INTO ai_job(id,recipe_id,base_revision,kind,provider,model,brief,request_key,input_hash,input,created_by,created_by_name,reserved_usd)
    VALUES($1,$2,$3,'hero','fal',$4,$5,$6,$7,$8,$9,$10,0)`,[legacyId,recipe.id,recipe.revision,heroCutoutModel,'Legacy verbose mask',randomUUID(),randomUUID(),legacyInput,original.createdBy,original.createdByName]);
  await claimSubmission(legacyId);await attachProviderRequest(legacyId,`mock-${legacyId}`);
  await failJob(legacyId,{code:'AI_MASK_NOT_FOUND',message:'Dostawca nie zwrócił maski wycięcia.',uncertain:false,providerFinished:true,chargedUsd:'0.005'});
  const input={recipeId:recipe.id,expectedRevision:recipe.revision,kind:'hero' as const,imageAction:'cutout_result' as const,sourceJobId:source.id,brief:heroCutoutSemanticRetryBrief,requestKey:randomUUID()};
  await isolatedPool.query("INSERT INTO auth_user(id,name,email,role) VALUES('mask-admin','Admin','mask-admin@example.invalid','admin')");
  await assert.rejects(createJobAdmission(input,{id:'mask-admin',name:'Admin',email:'mask-admin@example.invalid',role:'admin'}),aiCode('FORBIDDEN'));
  const retry=await createJobAdmission(input,actor);assert.equal(retry.created,true);assert.notEqual(retry.job.id,legacyId);
  const captured=await getJobForExecution(retry.job.id);
  assert.equal(captured.input.recipe.image,`${failedHeroSourcePrefix}${source.id}`);
  assert.equal(captured.input.aiPhotography?.heroMaskPromptVersion,heroMaskPromptVersion);
  assert.deepEqual(captured.input.aiPhotography?.heroPresentationOverride,original.input.aiPhotography?.heroPresentationOverride);
  assert.equal((await createJobAdmission({...input,requestKey:randomUUID()},actor)).job.id,retry.job.id);
  await claimSubmission(retry.job.id);await attachProviderRequest(retry.job.id,`mock-${retry.job.id}`);
  await failJob(retry.job.id,{code:'AI_MASK_NOT_FOUND',message:'Dostawca nie zwrócił maski wycięcia.',uncertain:false,providerFinished:true,chargedUsd:'0.005'});
  const stopped=await createJobAdmission({...input,requestKey:randomUUID()},actor);
  assert.equal(stopped.created,false);assert.equal(stopped.job.id,retry.job.id);
  assert.equal(Number((await isolatedPool.query("SELECT count(*) FROM ai_job WHERE recipe_id=$1 AND model=$2",[recipe.id,heroCutoutModel])).rows[0].count),2);
  assert.deepEqual(await getJobForExecution(source.id),original);
  assert.deepEqual((await isolatedPool.query('SELECT * FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry',[source.id])).rows,originalLedger);
  assert.deepEqual((await getRecipe(recipe.id)).content,recipe.content);
});

test('free-form manual heroes preserve the photograph without admitting an automatic vessel mask',async()=>{
  const recipe=await fixture();
  const source=await createJob({recipeId:recipe.id,expectedRevision:recipe.revision,kind:'hero',regenerate:true,brief:'Podaj gotową potrawę na deseczce z nożykiem.',requestKey:randomUUID()},actor);
  await claimSubmission(source.id);await attachProviderRequest(source.id,`mock-${source.id}`);
  await failJob(source.id,{code:'AI_TRANSPARENCY_MISSING',message:'Opaque photograph',uncertain:false,providerFinished:true,chargedUsd:'0.1671'});
  const original=await getJobForExecution(source.id);const sourceLedger=(await isolatedPool.query('SELECT * FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry',[source.id])).rows;
  assert.equal(original.input.aiPhotography?.heroRetakeVersion,'complete-composition-v1');
  assert.equal((await getJob(source.id)).manualPhotoComposition,true);
  await isolatedPool.query('UPDATE auth_user SET disabled=true WHERE id=$1',[actor.id]);
  try{await assert.rejects(admitManualHeroCutout(source.id,'automatic-owner'),aiCode('FORBIDDEN'));}
  finally{await isolatedPool.query('UPDATE auth_user SET disabled=false WHERE id=$1',[actor.id]);}
  const changed=structuredClone(recipe.content);changed.recipe.description.pl+=' Zmieniona treść wymagająca przeglądu.';
  const edited=await saveRecipe(recipe.id,{expectedRevision:recipe.revision,content:changed},actor);
  assert.equal(await admitManualHeroCutout(source.id,'automatic-owner'),null);
  assert.equal(Number((await isolatedPool.query('SELECT count(*) FROM ai_job WHERE recipe_id=$1 AND model=$2',[recipe.id,heroCutoutModel])).rows[0].count),0);
  const restored=await saveRecipe(recipe.id,{expectedRevision:edited.revision,content:recipe.content},actor);
  await approveRecipeContent(restored.id,restored.revision,actor);
  assert.equal(await admitManualHeroCutout(source.id,'automatic-owner'),null);
  const mediaOnly=structuredClone(restored.content);mediaOnly.recipe.imageAlt.pl+=' Nowy opis zdjęcia.';
  const current=await saveRecipe(recipe.id,{expectedRevision:restored.revision,content:mediaOnly},actor);
  const replays=await Promise.all([admitManualHeroCutout(source.id,'automatic-owner'),admitManualHeroCutout(source.id,'different-worker')]);
  assert.deepEqual(replays,[null,null]);
  await assert.rejects(createJobAdmission({recipeId:recipe.id,expectedRevision:current.revision,kind:'hero',imageAction:'cutout_result',sourceJobId:source.id,
    brief:'Wytnij całą ręczną kompozycję.',requestKey:randomUUID()},actor),aiCode('MANUAL_PHOTO_COMPOSITION'));
  assert.equal(Number((await isolatedPool.query('SELECT count(*) FROM ai_job WHERE recipe_id=$1 AND model=$2',[recipe.id,heroCutoutModel])).rows[0].count),0);
  assert.deepEqual(await getJobForExecution(source.id),original);
  assert.deepEqual((await isolatedPool.query('SELECT * FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry',[source.id])).rows,sourceLedger);
  assert.deepEqual((await getRecipe(recipe.id)).content,current.content);
});

test('a standard manual retake requires a cutout and permits correction of its retained or applied photo',async()=>{
  for(const applied of [false,true]){
    const recipe=await fixture();
    const source=await createJob({recipeId:recipe.id,expectedRevision:recipe.revision,kind:'hero',regenerate:true,brief:'Gotowa potrawa w misce.',requestKey:randomUUID()},actor);
    await claimSubmission(source.id);await attachProviderRequest(source.id,`mock-${source.id}`);
    const capture=await getJobForExecution(source.id);
    assert.equal(capture.input.aiPhotography?.heroRetakeVersion,'vessel-cutout-v1');
    assert.equal((await getJob(source.id)).manualPhotoComposition,undefined);
    let revision=recipe.revision;
    if(applied){
      await finishAsset(source.id,{blobPathname:`private/${source.id}.webp`,originalBlobPathname:`private/${source.id}/original.webp`,width:1600,height:1600,contentType:'image/webp',alt:recipe.content.recipe.title,caption:{pl:'',en:''},hasTransparency:false,styleProfile:heroPresentationProfile},{chargedUsd:'0.1671',costBasis:'usage'});
      revision=(await applyJob(source.id,{expectedRevision:revision,acknowledgeStale:false},actor)).recipe.revision;
    }else await failJob(source.id,{code:'AI_TRANSPARENCY_MISSING',message:'Opaque photograph',uncertain:false,providerFinished:true,chargedUsd:'0.1671'});
    const before=await getJobForExecution(source.id);
    const correction=await createJob({recipeId:recipe.id,expectedRevision:revision,kind:'hero',imageAction:applied?'remove_background':'cutout_result',...(!applied?{sourceJobId:source.id}:{}),brief:'Wytnij tło zachowanej fotografii.',requestKey:randomUUID()},actor);
    const corrected=await getJobForExecution(correction.id);
    assert.equal(corrected.model,heroCutoutModel);
    assert.equal(corrected.input.aiPhotography?.heroPresentationOverride?.container,'bowl','The retake vessel, rather than the original plate, is the mask target.');
    assert.equal(corrected.input.aiPhotography?.heroMaskPromptVersion,heroMaskPromptVersion);
    assert.equal(corrected.input.recipe.image,applied?`/media/${source.id}`:`${failedHeroSourcePrefix}${source.id}`);
    assert.deepEqual(await getJobForExecution(source.id),before,'The accepted photograph and its charge remain immutable.');
    await cancelJob(correction.id,actor);
  }
});

test('center-food rejected SAM resumes its same receipt and charge without another POST or automatic application',async()=>{
  const recipe=await fixture();
  const source=await createJob({recipeId:recipe.id,expectedRevision:recipe.revision,kind:'hero',brief:'Podaj gotową potrawę w glinianym garnku.',requestKey:randomUUID()},actor);
  await claimSubmission(source.id);await attachProviderRequest(source.id,`mock-${source.id}`);
  await failJob(source.id,{code:'AI_TRANSPARENCY_MISSING',message:'Opaque photograph',uncertain:false,providerFinished:true,chargedUsd:'0.1671'});
  const original=await getJobForExecution(source.id);
  const correction=await createJob({recipeId:recipe.id,expectedRevision:recipe.revision,kind:'hero',imageAction:'cutout_result',sourceJobId:source.id,brief:'Use the same photograph and vessel.',requestKey:randomUUID()},actor);
  await claimSubmission(correction.id);await attachProviderRequest(correction.id,`mock-${correction.id}`);
  await failJob(correction.id,{code:'AI_IMAGE_INVALID',message:heroCenterFoodRejectionMessage,uncertain:false,providerFinished:true,chargedUsd:'0.005'});
  const before=await getJobForExecution(correction.id);assert.equal(canRestoreHeroContents(before),true);
  assert.equal(canRestoreHeroContents({...before,errorMessage:'Unknown invalid image'}),false);
  assert.equal(canRestoreHeroContents({...before,errorCode:'AI_MASK_NOT_FOUND'}),false);
  assert.equal(canRestoreHeroContents({...before,input:{...before.input,aiPhotography:{...before.input.aiPhotography,heroMaskPromptVersion:undefined}}}),false);
  const ledger=(await isolatedPool.query('SELECT * FROM ai_cost_ledger WHERE job_id IN ($1,$2) ORDER BY job_id,entry',[source.id,correction.id])).rows;
  await isolatedPool.query('UPDATE auth_user SET disabled=true WHERE id=$1',[actor.id]);
  try{await assert.rejects(resumeJob(correction.id,actor),aiCode('FORBIDDEN'));}
  finally{await isolatedPool.query('UPDATE auth_user SET disabled=false WHERE id=$1',[actor.id]);}
  const changed=structuredClone(recipe.content);changed.recipe.description.pl+=' Zmieniona potrawa.';
  const edited=await saveRecipe(recipe.id,{expectedRevision:recipe.revision,content:changed},actor);
  await assert.rejects(resumeJob(correction.id,actor),aiCode('PHOTO_CONTENT_CHANGED'));
  const restored=await saveRecipe(recipe.id,{expectedRevision:edited.revision,content:recipe.content},actor);
  await approveRecipeContent(restored.id,restored.revision,actor);
  const resumed=await resumeJob(correction.id,actor);assert.equal(resumed.status,'generating');assert.equal(resumed.providerRequestId,before.providerRequestId);
  const reading=await getJobForExecution(correction.id);
  assert.equal(reading.chargedUsd,'0.00500000');assert.equal(reading.costBasis,'usage');assert.deepEqual(reading.providerFinishedAt,before.providerFinishedAt);
  assert.deepEqual(reading.input,before.input);assert.equal((await claimSubmission(correction.id)).shouldSubmit,false);
  await finishAsset(correction.id,{blobPathname:`private/${correction.id}.webp`,originalBlobPathname:`private/${correction.id}/source.webp`,width:1600,height:1600,contentType:'image/webp',alt:recipe.content.recipe.title,caption:{pl:'',en:''},hasTransparency:true,styleProfile:heroPresentationProfile},{chargedUsd:'0',costBasis:'usage'});
  const ready=await getJobForExecution(correction.id);assert.equal(ready.status,'ready');assert.equal(ready.providerRequestId,before.providerRequestId);assert.equal(ready.chargedUsd,'0.00500000');
  assert.equal(Number((await isolatedPool.query('SELECT count(*) FROM ai_job WHERE recipe_id=$1 AND model=$2',[recipe.id,heroCutoutModel])).rows[0].count),1);
  assert.deepEqual((await isolatedPool.query('SELECT * FROM ai_cost_ledger WHERE job_id IN ($1,$2) ORDER BY job_id,entry',[source.id,correction.id])).rows,ledger);
  assert.deepEqual(await getJobForExecution(source.id),original);
  assert.deepEqual((await getRecipe(recipe.id)).content,restored.content);
});

test('ingredient cutout preserves its target and source, bypasses library replacement and becomes reusable',async()=>{
  let recipe=await fixture();const foreign=await fixture();
  const content=structuredClone(recipe.content);const ingredient=content.recipe.ingredients[0];
  ingredient.name={pl:'Margaryna Palma',en:'Palma margarine'};ingredient.note={...recipeDietBaseNotes.margarine};delete content.photos.ingredients[ingredient.id];
  await registerFixturePhotos(content,actor,recipe.revision);
  recipe=await saveRecipe(recipe.id,{expectedRevision:recipe.revision,content},actor);
  await approveCompleteFixture(recipe);
  const source=await job(recipe,'Completed opaque margarine','ingredient',ingredient.id);
  await claimSubmission(source.id);await attachProviderRequest(source.id,`mock-${source.id}`);await markProviderTerminal(source.id);
  await failJob(source.id,{code:'AI_TRANSPARENCY_MISSING',message:'Opaque mock ingredient',uncertain:false,providerFinished:true});
  const originalSource=await getJobForExecution(source.id);
  const originalLedger=(await isolatedPool.query('SELECT entry,amount_usd,basis FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry',[source.id])).rows;
  // An available photograph must not silently replace the particular result being repaired.
  const library=await job(recipe,'Another validated library photograph','ingredient',ingredient.id);
  await claimSubmission(library.id);await attachProviderRequest(library.id,`mock-${library.id}`);
  await finishAsset(library.id,{blobPathname:`private/${library.id}.webp`,width:1024,height:1024,contentType:'image/webp',alt:ingredient.name,caption:{pl:'',en:''},hasTransparency:true,styleProfile:ingredientStyleProfile},{chargedUsd:'0',costBasis:'usage'});
  const input={recipeId:recipe.id,expectedRevision:recipe.revision,kind:'ingredient' as const,targetId:ingredient.id,imageAction:'cutout_result' as const,sourceJobId:source.id,brief:'Recover completed margarine only',requestKey:randomUUID()};
  const admissions=await Promise.all([createJobAdmission(input,actor),createJobAdmission({...input,requestKey:randomUUID(),brief:'Same completed photo from another click'},actor)]);
  assert.equal(admissions.filter(item=>item.created).length,1);assert.equal(admissions[0].job.id,admissions[1].job.id);
  const recovered=admissions[0].job;const captured=await getJobForExecution(recovered.id);
  assert.equal(recovered.kind,'ingredient');assert.equal(recovered.targetId,ingredient.id);assert.equal(recovered.model,heroCutoutModel);assert.equal(recovered.reservedUsd,'0.00000000');
  assert.equal(recovered.reuseSourceJobId,null);assert.equal(recovered.result,null);assert.equal(captured.ingredientKey,originalSource.ingredientKey);
  assert.equal(captured.input.recipe.image,recipe.content.recipe.image);assert.equal(captured.input.photos.ingredients[ingredient.id].src,`${failedHeroSourcePrefix}${source.id}`);
  await assert.rejects(createJob({...input,sourceJobId:randomUUID()},actor),aiCode('REQUEST_KEY_REUSED'));
  await assert.rejects(createJob({...input,recipeId:foreign.id,expectedRevision:foreign.revision,requestKey:randomUUID()},actor),aiCode('INVALID_CORRECTION_SOURCE'));
  await assert.rejects(createJob({...input,targetId:recipe.content.recipe.ingredients[1].id,requestKey:randomUUID()},actor),aiCode('INVALID_CORRECTION_SOURCE'));
  await assert.rejects(createJob({...input,kind:'hero',targetId:undefined,requestKey:randomUUID()},actor),aiCode('INVALID_CORRECTION_SOURCE'));
  assert.equal((await claimSubmission(recovered.id)).shouldSubmit,true,'queued recovery cannot substitute a library image');
  await attachProviderRequest(recovered.id,`mock-sam-${recovered.id}`);
  await finishAsset(recovered.id,{blobPathname:`private/${recovered.id}.webp`,originalBlobPathname:`private/${recovered.id}/original.png`,width:1024,height:1024,contentType:'image/webp',alt:ingredient.name,caption:{pl:'',en:''},hasTransparency:true,styleProfile:ingredientStyleProfile},{chargedUsd:'0.1',costBasis:'usage'});
  const registered=await isolatedPool.query('SELECT key,style_profile,eligibility FROM ingredient_image_catalog WHERE asset_id=$1',[recovered.id]);
  assert.equal(registered.rows.length,1);assert.equal(registered.rows[0].key,originalSource.ingredientKey);assert.equal(registered.rows[0].style_profile,ingredientStyleProfile);assert.equal(registered.rows[0].eligibility,'usable');
  const applied=await applyJob(recovered.id,{expectedRevision:recipe.revision,acknowledgeStale:false},actor);
  assert.equal(applied.recipe.content.photos.ingredients[ingredient.id].src,`/media/${recovered.id}`);assert.equal(applied.recipe.content.recipe.image,recipe.content.recipe.image);
  const repeat=await createJobAdmission({...input,expectedRevision:applied.recipe.revision,requestKey:randomUUID()},actor);
  assert.equal(repeat.created,false);assert.equal(repeat.job.id,recovered.id,'accepted source cannot buy another SAM after a photo revision');
  const reused=await job(applied.recipe,'Normal request reuses the corrected photo','ingredient',ingredient.id);
  assert.equal(reused.reservedUsd,'0.00000000');assert.equal(reused.result?.reusedPhoto?.src,`/media/${recovered.id}`);
  assert.deepEqual(await getJobForExecution(source.id),originalSource);
  assert.deepEqual((await isolatedPool.query('SELECT entry,amount_usd,basis FROM ai_cost_ledger WHERE job_id=$1 ORDER BY entry',[source.id])).rows,originalLedger);
  const changed=structuredClone(applied.recipe.content);changed.recipe.ingredients[0].name={pl:'Masło',en:'Butter'};delete changed.recipe.ingredients[0].note;
  await registerFixturePhotos(changed,actor,applied.recipe.revision);
  const saved=await saveRecipe(recipe.id,{expectedRevision:applied.recipe.revision,content:changed},actor);
  await approveRecipeContent(saved.id,saved.revision,actor);
  await assert.rejects(createJob({...input,expectedRevision:saved.revision,requestKey:randomUUID()},actor),aiCode('INVALID_CORRECTION_SOURCE'));
});

test('confirmed empty-mask legacy SAM permits one semantic v2, never another accepted v2',async()=>{
  let recipe=await fixture();const content=structuredClone(recipe.content);const target=content.recipe.ingredients[0];
  target.name={pl:'Spirytus',en:'Food-grade rectified spirit'};delete content.photos.ingredients[target.id];
  await registerFixturePhotos(content,actor,recipe.revision);
  recipe=await saveRecipe(recipe.id,{expectedRevision:recipe.revision,content},actor);
  await approveRecipeContent(recipe.id,recipe.revision,actor);
  const source=await job(recipe,'Existing opaque liquid bowl','ingredient',target.id);
  await claimSubmission(source.id);await attachProviderRequest(source.id,`mock-${source.id}`);
  await failJob(source.id,{code:'AI_TRANSPARENCY_MISSING',message:'Opaque original photo',uncertain:false,providerFinished:true});
  const original=await getJobForExecution(source.id);
  const legacyInput={recipeId:recipe.id,expectedRevision:recipe.revision,kind:'ingredient' as const,targetId:target.id,imageAction:'cutout_result' as const,sourceJobId:source.id,brief:'Legacy generic ingredient mask',requestKey:randomUUID()};
  const legacy=await createJob(legacyInput,actor);await claimSubmission(legacy.id);await attachProviderRequest(legacy.id,`mock-sam-${legacy.id}`);
  await failJob(legacy.id,{code:'AI_IMAGE_INVALID',message:'Dostawca nie zwrócił maski wycięcia.',uncertain:false,providerFinished:true});
  const arbitrary=await createJobAdmission({...legacyInput,brief:'Arbitrary changed prompt',requestKey:randomUUID()},actor);
  assert.equal(arbitrary.created,false);assert.equal(arbitrary.job.id,legacy.id);
  const input={...legacyInput,brief:ingredientCutoutRecoveryBrief,requestKey:randomUUID()};
  const admissions=await Promise.all([createJobAdmission(input,actor),createJobAdmission({...input,requestKey:randomUUID()},actor)]);
  assert.equal(admissions.filter(item=>item.created).length,1);assert.equal(admissions[0].job.id,admissions[1].job.id);
  const v2=admissions[0].job;assert.equal(v2.reservedUsd,'0.00000000');assert.notEqual(v2.id,legacy.id);
  assert.equal((await getJobForExecution(v2.id)).input.photos.ingredients[target.id].src,`${failedHeroSourcePrefix}${source.id}`);
  await claimSubmission(v2.id);await attachProviderRequest(v2.id,`mock-sam-${v2.id}`);
  await failJob(v2.id,{code:'POLL_TIMEOUT',message:'Unknown result',uncertain:true});
  assert.equal((await createJobAdmission({...input,requestKey:randomUUID()},actor)).job.id,v2.id);
  await markProviderTerminal(v2.id);await resumeJob(v2.id,actor);
  await failJob(v2.id,{code:'AI_MASK_NOT_FOUND',message:'Dostawca nie zwrócił maski wycięcia.',uncertain:false,providerFinished:true});
  const changed=structuredClone(recipe.content);changed.photos.ingredients[target.id]=structuredClone(changed.photos.ingredients[recipe.content.recipe.ingredients[1].id]);
  await registerFixturePhotos(changed,actor,recipe.revision);
  const saved=await saveRecipe(recipe.id,{expectedRevision:recipe.revision,content:changed},actor);
  const repeat=await createJobAdmission({...input,expectedRevision:saved.revision,requestKey:randomUUID()},actor);
  assert.equal(repeat.created,false);assert.equal(repeat.job.id,v2.id,'v2 cannot repeat after no mask or a photo-only revision');
  const ledger=(await isolatedPool.query('SELECT amount_usd FROM ai_cost_ledger WHERE job_id=$1 AND entry=$2',[v2.id,'reserve'])).rows;
  assert.equal(ledger.length,0);
  assert.deepEqual(await getJobForExecution(source.id),original);
});

test('trash cancels proven unsent jobs and blocks admission, request replay and result apply until restoration',async()=>{
  const recipe=await fixture();const baseline=(await getConfiguration()).budget;
  const requestKey=randomUUID();const input={recipeId:recipe.id,expectedRevision:recipe.revision,kind:'recipe' as const,brief:'Queued before trash',requestKey};
  const queued=await createJob(input,actor);
  const removed=await deleteRecipe(recipe.id,{expectedRevision:recipe.revision},actor);
  const cancelled=await getJob(queued.id);
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.chargedUsd,'0.00000000');assert.equal(cancelled.costBasis,'usage');
  assert.equal((await getConfiguration()).budget.pilotUsedUsd,baseline.pilotUsedUsd);
  assert.equal((await claimSubmission(queued.id)).shouldSubmit,false);
  await assert.rejects(ensureSubmissionAllowed(queued.id),aiCode('RECIPE_DELETED'));
  await assert.rejects(createJob(input,actor),aiCode('RECIPE_DELETED'));
  await assert.rejects(createJob({...input,expectedRevision:removed.revision,requestKey:randomUUID()},actor),aiCode('RECIPE_DELETED'));
  const ledger=await isolatedPool.query('SELECT sum(amount_usd)::text total FROM ai_cost_ledger WHERE job_id=$1',[queued.id]);assert.equal(Number(ledger.rows[0].total),0);

  const readyOwner=await fixture();const ready=await readyRecipe(readyOwner);
  const removedReady=await deleteRecipe(readyOwner.id,{expectedRevision:readyOwner.revision},actor);
  await assert.rejects(applyJob(ready.id,{expectedRevision:removedReady.revision,acknowledgeStale:true},actor),aiCode('RECIPE_DELETED'));
  assert.equal((await getJob(ready.id)).status,'ready');
  const restored=await performRecipeAction(readyOwner.id,{action:'restore_deleted',expectedRevision:removedReady.revision},actor);
  const applied=await applyJob(ready.id,{expectedRevision:restored.revision,acknowledgeStale:true},actor);
  assert.equal(applied.recipe.editorialStatus,'draft');assert.equal(applied.recipe.deletedAt,null);
});

test('trash preserves accepted and uncertain request costs, late receipts and assets without permitting another POST',async()=>{
  const recipe=await fixture();const baseline=Number((await getConfiguration()).budget.pilotUsedUsd);
  const accepted=await job(recipe,'Accepted before trash','hero');
  const sending=await job(recipe,'Submission still uncertain');
  await claimSubmission(accepted.id);await attachProviderRequest(accepted.id,`receipt-${accepted.id}`);
  await failJob(accepted.id,{code:'READ_TIMEOUT',message:'Existing receipt can be read again',uncertain:true});
  await claimSubmission(sending.id);
  const removed=await deleteRecipe(recipe.id,{expectedRevision:recipe.revision},actor);
  assert.equal((await getConfiguration()).budget.pilotUsedUsd,baseline.toFixed(8));
  assert.equal((await getConfiguration()).budget.activeJobs,2);
  assert.equal((await getJobForExecution(sending.id)).status,'submitting');
  await assert.rejects(ensureSubmissionAllowed(sending.id),aiCode('RECIPE_DELETED'));
  assert.equal((await claimSubmission(sending.id)).shouldSubmit,false);
  await resumeJob(accepted.id,actor);
  const receiptOnly=await claimSubmission(accepted.id);assert.equal(receiptOnly.shouldSubmit,false);assert.equal(receiptOnly.job.providerRequestId,`receipt-${accepted.id}`);
  // A transport response can arrive after trash was committed; keep its actual
  // receipt and finish it normally rather than pretending it was never charged.
  await attachProviderRequest(sending.id,`late-receipt-${sending.id}`);
  await finishRecipe(sending.id,recipe.content,{chargedUsd:'0.02',costBasis:'usage'});
  const finished=await finishAsset(accepted.id,{blobPathname:`private/${accepted.id}.webp`,width:1600,height:1600,contentType:'image/webp',alt:recipe.content.recipe.title,caption:{pl:'',en:''},hasTransparency:true},{chargedUsd:'0.05',costBasis:'usage'});
  assert.equal(finished.status,'ready');assert.ok(await getAssetForExecution(accepted.id));assert.equal(await isAssetPublic(accepted.id),false);
  assert.equal((await getConfiguration()).budget.pilotUsedUsd,(baseline+0.07).toFixed(8));
  assert.equal((await getConfiguration()).budget.activeJobs,0);
  await assert.rejects(applyJob(accepted.id,{expectedRevision:removed.revision,acknowledgeStale:true},actor),aiCode('RECIPE_DELETED'));
});

