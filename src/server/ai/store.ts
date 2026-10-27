import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import Decimal from 'decimal.js';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { heroCutoutSemanticRetryBrief, type AiAsset, type AiBudget, type AiConfiguration, type AiJob, type AiProvider, type AiResult, type ApplyAiJob, type ApplyAiResult, type CreateAiJob } from '../../lib/ai-types';
import type { EditorialActor, EditorialContent, EditorialRecord } from '../../lib/editorial-types';
import type { Localised } from '../../lib/recipes';
import { getDb } from '../db';
import { user } from '../db/auth-schema';
import { editorialRecipes } from '../db/schema';
import { applyAiProposalInTransaction, contentHash, EditorialError, getRecipeInTransaction } from '../editorial/store';
import { editorialContentSchema } from '../editorial/validation';
import { contentApprovalHash, hasRecipeContentApproval, requireRecipeContentApproval } from '../editorial/content-approval';
import { aiSettings, recipeGenerationReservationUsd } from './config';
import { readBudgetPolicy } from './budget-policy';
import { AiError } from './errors';
import { aiAssets, aiJobs, aiLedger, ingredientImages, aiPhotoBatches, aiRecipeRecoveries } from './schema';
import { capturedIngredientStyleProfile, ingredientImageIdentity, ingredientStyleProfile, whiteIngredientStyleProfile, currentIngredientStyleProfile, staticIngredientPhoto } from './ingredient-profile';
import { findReusableIngredient, findIngredientProducer, prepareLegacyIngredient, registerIngredientImage, reusableIngredientPhotoSourceCompatible, type ReusableIngredientImage } from './ingredient-reuse';
import { heroCutoutModel, heroMaskPromptVersion, glassHeroMaskPromptVersion, stepFormatModel, filledHeroModel, failedHeroSourcePrefix, isRecoverablePhotoSource, canRestoreHeroContents, canRetryMissingHeroMask, canRetryMissingIngredientMask } from './image-actions';
import { heroRetakeVersionForBrief, isCompleteHeroComposition } from './hero-retake';
import { recipes } from '@/lib/recipes';
import { heroPresentationIssue, heroPresentationProfile, resolveHeroPresentation, resolveHeroPresentationForBrief } from '@/lib/hero-presentation';
import type { MediaTile } from '@/lib/recipe-media';
import { requireTrendScope, trendWorker } from '../trends/actor';
import { samePhotoSubject } from './photo-subject';
import { sameStepPhotoSelection } from '@/lib/step-photo-selection';
import { trendRuns } from '../trends/schema';
import { hasManualAutomationTakeover } from '../trends/automation-takeover';
import { jobPresentationDto, jobPresentationSelection } from './job-presentation';
import { recordRecipeValidationFailure, withRecipeRecovery } from './recipe-recovery-state';
import { withPhotoRecovery, type PhotoRecoveryReadOptions } from './photo-recovery-readmodel';
import type { RecipeValidationIssue } from './recipe-recovery-policy';
import { getVerificationBudgetTotals } from './ingredient-dictionary-store';

type Database = ReturnType<typeof getDb>;
export type AiTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Transaction = AiTransaction;
type JobRow = typeof aiJobs.$inferSelect;
type AssetRow = typeof aiAssets.$inferSelect;
export type CostInformation = { chargedUsd?: string | null; costBasis?: 'usage' | 'reservation'; usage?: { inputTokens: number; outputTokens: number } | null };
export type AssetInput = { blobPathname: string; originalBlobPathname?: string | null; width: number; height: number; contentType: 'image/webp' | 'image/png' | 'image/jpeg'; alt: Localised; caption: Localised; hasTransparency?: boolean; styleProfile?: string };
const activeStatuses = ['queued', 'submitting', 'generating'] as const;
const dedupeStatuses = [...activeStatuses, 'uncertain'] as const;

export async function trustedActor(tx: Transaction, actorId: string, trendRunId?: string | null, recipeId?: string): Promise<EditorialActor> {
  if (actorId === trendWorker.id && trendRunId) { await requireTrendScope(tx, trendRunId, recipeId); return trendWorker; }
  const [account] = await tx.select().from(user).where(eq(user.id, actorId)).for('share');
  if (!account || account.disabled || !['owner','admin'].includes(account.role)) throw new AiError(403, 'FORBIDDEN', 'To konto nie ma uprawnień do generowania.');
  return { id: account.id, name: account.name, email: account.email, role: account.role as 'owner' | 'admin' };
}
export async function budgetLock(tx: Transaction) { await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('jesie-ai-budget'))`); }
async function lockedJob(tx: Transaction, id: string) {
  const [job] = await tx.select().from(aiJobs).where(eq(aiJobs.id,id)).for('update');
  if (!job) throw new AiError(404,'JOB_NOT_FOUND','Nie znaleziono generowania.');
  return job;
}
async function hasUnconfirmedBatchSubmission(tx: Transaction, packet: typeof aiPhotoBatches.$inferSelect, includeSubmitting = true) {
  const linkedIds = packet.slots.flatMap(slot => slot.jobId ? [slot.jobId] : []);
  const [unknown] = await tx.select({ id: aiJobs.id }).from(aiJobs).where(and(
    or(eq(aiJobs.photoBatchId, packet.id), linkedIds.length ? inArray(aiJobs.id, linkedIds) : undefined),
    isNull(aiJobs.providerRequestId), isNull(aiJobs.reuseSourceJobId), isNull(aiJobs.result),
    or(inArray(aiJobs.status, includeSubmitting ? ['submitting', 'uncertain'] : ['uncertain']), and(eq(aiJobs.status, 'cancelled'), isNull(aiJobs.providerFinishedAt))),
  )).limit(1);
  return Boolean(unknown);
}
/** A saved content review and an explicit photo request are independent decisions. */
async function manualTrendPhotoApproval(tx: Transaction, recipe: typeof editorialRecipes.$inferSelect, runId: string): Promise<string> {
  const run = await requireTrendScope(tx, runId, recipe.id);
  const hash = contentApprovalHash(recipe.content);
  const preparation = run.searchDiagnostics?.preparation;
  const [requester] = preparation?.requestedBy ? await tx.select({ id: user.id }).from(user)
    .where(and(eq(user.id, preparation.requestedBy), eq(user.role, 'owner'), eq(user.disabled, false))).for('share') : [];
  if (!preparation || preparation.generation !== run.generation || preparation.approvedContentHash !== hash
    || !requester || !await hasRecipeContentApproval(tx, recipe, 'manual') || !await hasManualAutomationTakeover(tx, run.id)) {
    throw new AiError(409, 'MANUAL_PHOTO_DECISION_REQUIRED', 'Najpierw sprawdź i zaakceptuj treść, a następnie jawnie zleć przygotowanie zdjęć.');
  }
  return hash;
}

function money(value: string) {
  if (!/^\d+(\.\d{1,8})?$/.test(value)) throw new AiError(422,'INVALID_COST','Nieprawidłowy koszt generowania.');
  return new Decimal(value).toFixed(8);
}
function safeNotes(notes: string[]) { return notes.filter(note => typeof note === 'string').slice(0,20).map(note => note.slice(0,2_000)); }
function assetDto(row: AssetRow): AiAsset {
  return { id:row.id, recipeId:row.recipeId, jobId:row.jobId, kind:row.kind, targetId:row.targetId, src:`/media/${row.id}`, width:row.width, height:row.height, alt:row.alt, caption:row.caption, model:row.model, createdAt:row.createdAt.toISOString() };
}
export function jobDto(row: JobRow): AiJob {
  return jobPresentationDto({ ...row, recipeTitle: row.input.recipe.title.pl,
    ingredientStyleProfile: row.input.aiPhotography?.ingredientStyleProfile ?? null,
    heroStyleProfile: row.input.aiPhotography?.heroStyleProfile ?? null,
    manualPhotoComposition: row.kind === 'hero' && row.input.aiPhotography?.regenerate === true,
    heroContainer: row.input.aiPhotography?.heroPresentationOverride?.container ?? row.input.recipe.heroPresentation?.container ?? null });
}

export async function budget(db: Database | Transaction): Promise<AiBudget> {
  const settings=aiSettings(); const policy=await readBudgetPolicy(db);
  const [row]=await db.select({
    daily:sql<string>`coalesce(sum(case when ${aiJobs.trendRunId} IS NULL AND ${aiJobs.costBasis}='usage' AND ${aiJobs.chargedUsd} IS NOT NULL AND ${aiJobs.createdAt} >= date_trunc('day',${policy.serverNow}::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' then ${aiJobs.chargedUsd} else 0 end),0)::text`,
    monthly:sql<string>`coalesce(sum(case when ${aiJobs.trendRunId} IS NULL AND ${aiJobs.costBasis}='usage' AND ${aiJobs.chargedUsd} IS NOT NULL AND ${aiJobs.createdAt} >= date_trunc('month',${policy.serverNow}::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' then ${aiJobs.chargedUsd} else 0 end),0)::text`,
    pilot:sql<string>`coalesce(sum(case when ${aiJobs.trendRunId} IS NULL AND ${aiJobs.costBasis}='usage' AND ${aiJobs.chargedUsd} IS NOT NULL then ${aiJobs.chargedUsd} else 0 end),0)::text`,
    pending:sql<number>`count(*) filter(where ${aiJobs.trendRunId} IS NULL AND (${aiJobs.costBasis} IS DISTINCT FROM 'usage' OR ${aiJobs.chargedUsd} IS NULL) AND (${aiJobs.providerRequestId} IS NOT NULL OR ${aiJobs.status} IN ('submitting','uncertain') OR (${aiJobs.status}='cancelled' AND ${aiJobs.providerFinishedAt} IS NULL)))::int`,
    active:sql<number>`count(*) filter(where ${aiJobs.reuseSourceJobId} IS NULL AND ${aiJobs.model} NOT IN (${stepFormatModel},${filledHeroModel}) AND ${aiJobs.status} in ('queued','submitting','generating','uncertain','cancelled') AND ${aiJobs.providerFinishedAt} IS NULL AND (${aiJobs.status}<>'queued' OR (${aiJobs.photoBatchId} IS NULL AND (${aiJobs.trendRunId} IS NULL OR EXISTS(SELECT 1 FROM trend_run tr WHERE tr.id=${aiJobs.trendRunId} AND tr.status='generating')))))::int`,
  }).from(aiJobs);
  const ingredients = await getVerificationBudgetTotals({ trendOnly: false }, db);
  const collectionCosts = await (await import('../collections/theme-budget')).collectionGenerationBudget(db);
  return { dailyLimitUsd:policy.dailyLimitUsd,monthlyLimitUsd:policy.monthlyLimitUsd,pilotLimitUsd:policy.pilotLimitUsd,limitsEnforced:false,bypassUntil:null,settingsRevision:policy.revision,serverNow:policy.serverNow,dailyReservedUsd:'0.00000000',monthlyReservedUsd:'0.00000000',pilotReservedUsd:'0.00000000',dailyUsedUsd:money(new Decimal(row.daily).plus(ingredients.daily).plus(collectionCosts.daily).toFixed(8)),monthlyUsedUsd:money(new Decimal(row.monthly).plus(ingredients.monthly).plus(collectionCosts.monthly).toFixed(8)),pilotUsedUsd:money(new Decimal(row.pilot).plus(ingredients.pilot).plus(collectionCosts.total).toFixed(8)),reservedUsd:'0.00000000',activeJobs:row.active + collectionCosts.active,concurrentLimit:settings.concurrentLimit,pendingCostCount:row.pending + ingredients.pendingCount + collectionCosts.pending };
}

export async function getConfiguration(): Promise<AiConfiguration> {
  const settings=aiSettings();
  return { openai:settings.openai,fal:settings.fal,storage:settings.storage,recipeModel:settings.recipeModel,imageModel:settings.imageModel,recipeReservationUsd:recipeGenerationReservationUsd(),imageReservationUsd:settings.imageReservationUsd,heroCutoutReservationUsd:'0.00000000',whiteIngredientReservationUsd:'0.00000000',paperIngredientReservationUsd:'0.00000000',budget:await budget(getDb()) };
}

function reuseResult(reusable:ReusableIngredientImage,source:'library'|'shared_generation'):AiResult{
  return {content:null,asset:reusable.asset?assetDto(reusable.asset):null,reusedPhoto:reusable.photo,reuse:{source,key:reusable.key},notes:['Wykorzystano pasujące zdjęcie składnika z biblioteki. Nie zlecono nowej płatnej generacji.']};
}
async function validateExistingImage(tx:Transaction,content:EditorialContent,action:'remove_background'|'crop_step',targetId:string|null){
  const src=action==='remove_background'?content.recipe.image:targetId?content.photos.steps[targetId]?.src:undefined;
  if(!src)throw new AiError(422,'IMAGE_REQUIRED','Najpierw wybierz istniejące zdjęcie.');
  const match=/^\/media\/([a-f0-9-]{36})$/.exec(src);
  if(match){const [asset]=await tx.select({kind:aiAssets.kind}).from(aiAssets).where(eq(aiAssets.id,match[1]));if(asset?.kind===(action==='remove_background'?'hero':'step'))return;}
  else if(action==='remove_background'&&recipes.some(recipe=>recipe.image===src))return;
  else if(action==='crop_step'){
    const photo=content.photos.steps[targetId!];const template=recipes.find(recipe=>`/images/steps-${recipe.id}.webp`===src);
    if(template&&photo.columns===2&&photo.rows===3&&photo.index>=0&&photo.index<template.steps.length)return;
  }
  throw new AiError(422,'IMAGE_NOT_REGISTERED','Wybrane zdjęcie nie znajduje się w zatwierdzonej bibliotece.');
}

async function checkedReusedIngredientPhoto(tx:Transaction,job:JobRow,current:EditorialContent):Promise<MediaTile>{
  const ingredient=current.recipe.ingredients.find(item=>item.id===job.targetId);
  const photo=job.result?.reusedPhoto;
  if(!ingredient||!photo||!job.ingredientKey||ingredientImageIdentity(ingredient,capturedIngredientStyleProfile(job.input)).key!==job.ingredientKey)throw new AiError(409,'INGREDIENT_FORM_CHANGED','Składnik lub jego postać zmieniły się. Zachowano zdjęcie w bibliotece.');
  const match=/^\/media\/([a-f0-9-]{36})$/.exec(photo.src);
  if(match){const [entry]=await tx.select().from(ingredientImages).where(and(eq(ingredientImages.key,job.ingredientKey),eq(ingredientImages.assetId,match[1]),inArray(ingredientImages.eligibility,['usable','approved'])));if(!entry||!await reusableIngredientPhotoSourceCompatible(tx,ingredient,photo))throw new AiError(409,'MISSING_ASSET','Zdjęcie nie jest dostępne dla tego produktu i postaci składnika.');}
  else{const candidate=staticIngredientPhoto(ingredient,capturedIngredientStyleProfile(job.input));if(!candidate||candidate.src!==photo.src||candidate.columns!==photo.columns||candidate.rows!==photo.rows||candidate.index!==photo.index)throw new AiError(409,'MISSING_ASSET','Fotografia nie pasuje do składnika.');}
  return {...photo,alt:ingredient.name};
}

export async function createJob(input: CreateAiJob, actor: EditorialActor): Promise<AiJob> {
  return (await createJobAdmission(input,actor)).job;
}

export async function createJobAdmission(input: CreateAiJob, actor: EditorialActor, trendRunId?: string, options: { forceNew?: boolean; generation?: number; photoBatchId?: string; ingredientStyleProfile?: string; transaction?: AiTransaction; recipeRepairParentId?: string; automaticHeroCutout?: { sourceJobId: string; workflowRunId: string } } = {}): Promise<{job:AiJob;created:boolean}> {
  const forceNew = options.forceNew === true;
  if (forceNew && (!trendRunId || actor.id !== trendWorker.id || input.kind === 'recipe' || input.imageAction || !input.requestKey.startsWith('trend_regen_'))) throw new AiError(422, 'INVALID_REGENERATION', 'Ponowne zdjęcie wymaga osobnego zlecenia z panelu przepisu.');
  if (input.regenerate !== undefined && typeof input.regenerate !== 'boolean'
    || input.regenerate && (input.kind === 'recipe' || input.imageAction || trendRunId || options.photoBatchId)) throw new AiError(422, 'INVALID_REGENERATION', 'Nowe zdjęcie z własnym opisem wymaga osobnego zlecenia fotografii.');
  const skipIngredientReuse = forceNew || input.regenerate === true;
  if(options.automaticHeroCutout&&(input.kind!=='hero'||input.imageAction!=='cutout_result'||input.sourceJobId!==options.automaticHeroCutout.sourceJobId||trendRunId||options.photoBatchId||!options.automaticHeroCutout.workflowRunId||options.automaticHeroCutout.workflowRunId.length>500))throw new AiError(422,'INVALID_PHOTO_RECOVERY','Automatyczna korekta wymaga zakończonej fotografii i zapisanego procesu.');
  if (!['recipe','hero','ingredient','step'].includes(input.kind) || typeof input.brief!=='string' || !input.brief.trim() || Buffer.byteLength(input.brief,'utf8')>8_000 || !/^[A-Za-z0-9_-]{16,100}$/.test(input.requestKey)) throw new AiError(422,'INVALID_INPUT','Dodaj instrukcję generowania i poprawny identyfikator żądania.');
  const settings=aiSettings();
  const image=input.kind!=='recipe';
  if(input.imageAction && !['remove_background','crop_step','fill_cutout','cutout_result'].includes(input.imageAction))throw new AiError(422,'INVALID_IMAGE_ACTION','Nieznana korekta fotografii.');
  if((input.imageAction==='remove_background'||input.imageAction==='fill_cutout')&&input.kind!=='hero'||input.imageAction==='cutout_result'&&!['hero','ingredient'].includes(input.kind)||input.imageAction==='crop_step'&&input.kind!=='step')throw new AiError(422,'INVALID_IMAGE_ACTION','Wybierz właściwy rodzaj fotografii do tej korekty.');
  if(input.imageAction==='fill_cutout'||input.imageAction==='cutout_result' ? !input.sourceJobId || !/^[a-f0-9-]{36}$/i.test(input.sourceJobId) : Boolean(input.sourceJobId))throw new AiError(422,'INVALID_CORRECTION_SOURCE','Wybierz właściwe zdjęcie źródłowe poprawki.');
  const targetId=(input.kind==='ingredient' || input.kind==='step') ? input.targetId ?? null : null;
  if ((input.kind==='ingredient' || input.kind==='step') && !targetId) throw new AiError(422,'TARGET_REQUIRED','Wybierz składnik lub krok.');
  const provider:AiProvider=image?'fal':'openai'; const model=input.imageAction==='remove_background'||input.imageAction==='cutout_result'?heroCutoutModel:input.imageAction==='crop_step'?stepFormatModel:input.imageAction==='fill_cutout'?filledHeroModel:image?settings.imageModel:settings.recipeModel;
  const defaultProfile=options.ingredientStyleProfile===currentIngredientStyleProfile?currentIngredientStyleProfile:options.ingredientStyleProfile===ingredientStyleProfile||trendRunId?ingredientStyleProfile:options.ingredientStyleProfile===whiteIngredientStyleProfile?whiteIngredientStyleProfile:currentIngredientStyleProfile;
  if(input.kind==='ingredient'&&input.imageAction!=='cutout_result'&&!skipIngredientReuse){
    const snapshot=await getDb().transaction(async tx=>{await trustedActor(tx,actor.id,trendRunId,input.recipeId);const [row]=await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id,input.recipeId));if(row?.deletedAt)throw new AiError(409,'RECIPE_DELETED','Najpierw przywróć przepis z kosza.');return row;});
    const ingredient=snapshot?.content.recipe.ingredients.find(item=>item.id===targetId);
    const [capturedPacket]=options.photoBatchId?await getDb().select({input:aiPhotoBatches.input}).from(aiPhotoBatches).where(eq(aiPhotoBatches.id,options.photoBatchId)):[];
    const profile=capturedPacket?capturedIngredientStyleProfile(capturedPacket.input):defaultProfile;
    if(ingredient&&!await findReusableIngredient(getDb(),ingredient,profile))await prepareLegacyIngredient(ingredient,profile);
  }
  const admit = async (tx: AiTransaction) => {
    await budgetLock(tx); const account=await trustedActor(tx,actor.id,trendRunId,input.recipeId);
    if (trendRunId && options.generation !== undefined) {
      const scope = await requireTrendScope(tx, trendRunId, input.recipeId);
      if (scope.generation !== options.generation) throw new AiError(409, 'TREND_SUPERSEDED', 'To przygotowanie zastąpiło nowe uruchomienie.');
    }
    const [recipe]=await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id,input.recipeId)).for('share');
    if (!recipe) throw new AiError(404,'RECIPE_NOT_FOUND','Nie znaleziono przepisu.');
    if (recipe.deletedAt) throw new AiError(409,'RECIPE_DELETED','Najpierw przywróć przepis z kosza.');
    const [packet] = options.photoBatchId ? await tx.select().from(aiPhotoBatches).where(eq(aiPhotoBatches.id, options.photoBatchId)).for('update') : [];
    const profile=packet?capturedIngredientStyleProfile(packet.input):defaultProfile;
    if (options.photoBatchId && (!packet || trendRunId || packet.createdBy !== account.id || packet.recipeId !== recipe.id || !['queued','generating'].includes(packet.status) || input.kind === 'recipe' || input.imageAction && input.imageAction !== 'cutout_result' || !packet.slots.some(slot => slot.kind === input.kind && slot.targetId === targetId) || (!samePhotoSubject(packet.input, recipe.content, 'hero', null) || !sameStepPhotoSelection(packet.input, recipe.content)))) throw new AiError(409,'PHOTO_BATCH_SCOPE','Pakiet zdjęć jest wstrzymany lub dotyczy innej treści.');
    const [existing]=await tx.select().from(aiJobs).where(and(eq(aiJobs.createdBy,account.id),eq(aiJobs.requestKey,input.requestKey)));
    if (existing) {
      if (existing.recipeId!==input.recipeId || (!packet && existing.baseRevision!==input.expectedRevision) || existing.kind!==input.kind || existing.targetId!==targetId || existing.brief!==input.brief.trim() || existing.model!==model || packet && input.kind!=='recipe' && !samePhotoSubject(existing.input,recipe.content,input.kind,targetId)) throw new AiError(409,'REQUEST_KEY_REUSED','Ten identyfikator żądania był użyty dla innego generowania.');
      if ((existing.input.aiPhotography?.regenerate === true) !== (input.regenerate === true)) throw new AiError(409, 'REQUEST_KEY_REUSED', 'Ten identyfikator był użyty dla innego sposobu przygotowania zdjęcia.');
      if(input.imageAction==='fill_cutout'){const [asset]=await tx.select({id:aiAssets.id,recipeId:aiAssets.recipeId,model:aiAssets.model,kind:aiAssets.kind}).from(aiAssets).where(eq(aiAssets.jobId,input.sourceJobId!));if(!asset||asset.recipeId!==recipe.id||asset.model!==heroCutoutModel||asset.kind!=='hero'||existing.input.recipe.image!==`/media/${asset.id}`)throw new AiError(409,'REQUEST_KEY_REUSED','Ten identyfikator był użyty dla innego zdjęcia źródłowego.');}
      const correctionSource=existing.kind==='ingredient'&&existing.targetId?existing.input.photos.ingredients[existing.targetId]?.src:existing.input.recipe.image;
      if((input.imageAction==='cutout_result'||correctionSource?.startsWith(failedHeroSourcePrefix))&&(input.imageAction!=='cutout_result'||correctionSource!==`${failedHeroSourcePrefix}${input.sourceJobId}`))throw new AiError(409,'REQUEST_KEY_REUSED','Ten identyfikator był użyty dla innego zdjęcia źródłowego.');
      return {job:jobDto(existing),created:false};
    }
    if (packet && await hasUnconfirmedBatchSubmission(tx, packet)) throw new AiError(409, 'SUBMISSION_UNCERTAIN', 'Nie potwierdzono przyjęcia innego zdjęcia w tym pakiecie. Nie przygotowano nowego płatnego zlecenia.');
    if (!Number.isInteger(input.expectedRevision) || recipe.revision!==input.expectedRevision) throw new AiError(409,'REVISION_CONFLICT','Zapisz i odśwież bieżącą wersję przepisu przed generowaniem.');
    if (recipe.editorialStatus==='archived') throw new AiError(409,'ARCHIVED','Najpierw przywróć przepis z archiwum.');
    const manualContentApprovalHash = image && account.id === trendWorker.id && trendRunId
      ? await manualTrendPhotoApproval(tx, recipe, trendRunId) : null;
    if (image && !trendRunId) await requireRecipeContentApproval(tx, recipe);
    if (input.kind==='ingredient' && !recipe.content.recipe.ingredients.some(item=>item.id===targetId)) throw new AiError(422,'TARGET_MISSING','Nie znaleziono wybranego składnika.');
    if (input.kind==='step' && !recipe.content.recipe.steps.some(item=>item.id===targetId)) throw new AiError(422,'TARGET_MISSING','Nie znaleziono wybranego kroku.');
    if (Buffer.byteLength(JSON.stringify(recipe.content),'utf8')>settings.maxInputBytes) throw new AiError(422,'INPUT_TOO_LARGE','Skróć treść przepisu przed generowaniem.');
    const captured=structuredClone(recipe.content);
    if(input.kind==='recipe') {
      if (options.recipeRepairParentId) {
        const [parent] = await tx.select().from(aiJobs).where(eq(aiJobs.id, options.recipeRepairParentId));
        if (!parent || parent.kind !== 'recipe' || parent.recipeId !== recipe.id || parent.baseRevision !== recipe.revision)
          throw new AiError(409, 'RECIPE_REPAIR_SCOPE', 'Poprawka nie dotyczy tej wersji przepisu.');
        // A repair continues the captured schema/research contract; it never
        // invents research or timing-plan requirements absent from its parent.
        if (parent.input.aiPhotography) captured.aiPhotography = structuredClone(parent.input.aiPhotography);
        else delete captured.aiPhotography;
      } else captured.aiPhotography={recipeProposalVersion:'finished-dish-v2',recipePresentationVersion:'required-finished-dish-v1',recipeResearchVersion:'web-recipe-v1',recipeTimingVersion:'dependency-timing-v1',recipeDietVersion:'ingredient-diet-v1',...(captured.aiPhotography?.recipeDietTarget ? { recipeDietTarget: captured.aiPhotography.recipeDietTarget } : {})};
    }
    if(input.kind==='ingredient'&&!input.imageAction)captured.aiPhotography={ingredientStyleProfile:profile};
    if(input.kind==='hero'&&!input.imageAction){
      const presentation=resolveHeroPresentation(recipe.content.recipe);
      const issue=heroPresentationIssue(recipe.content.recipe,presentation);
      if(issue||!presentation)throw new AiError(422,'HERO_PRESENTATION_REQUIRED',issue??'Uzupełnij ustawienia zdjęcia głównego.');
      captured.recipe.heroPresentation=structuredClone(presentation);
      const directedPresentation = packet
        ? packet.input.aiPhotography?.heroPresentationOverride ?? resolveHeroPresentation(packet.input.recipe)
        : resolveHeroPresentationForBrief(recipe.content.recipe, input.brief);
      captured.aiPhotography={heroStyleProfile:packet?packet.input.aiPhotography?.heroStyleProfile:heroPresentationProfile,
        ...(input.regenerate === true && !packet ? { heroRetakeVersion: heroRetakeVersionForBrief(input.brief) } : {}),
        ...(directedPresentation && !isDeepStrictEqual(directedPresentation, presentation) ? { heroPresentationOverride: structuredClone(directedPresentation) } : {})};
    }
    // The final dish is photographed last. Earlier phases use the full method
    // and fixed photography direction, without depending on a future hero.
    if (packet && input.kind !== 'hero' && !input.imageAction) captured.recipe.image = '';
    if(input.imageAction==='fill_cutout'){
      const [source]=await tx.select().from(aiJobs).where(eq(aiJobs.id,input.sourceJobId!)).for('share');
      const [asset]=source?await tx.select().from(aiAssets).where(and(eq(aiAssets.jobId,source.id),eq(aiAssets.id,source.result?.asset?.id??''))):[];
      if(!source||source.recipeId!==recipe.id||source.kind!=='hero'||source.model!==heroCutoutModel||source.status!=='ready'||!asset||asset.recipeId!==recipe.id||asset.kind!=='hero'||asset.model!==heroCutoutModel||!asset.originalBlobPathname)throw new AiError(422,'INVALID_CORRECTION_SOURCE','Źródło musi być gotowym wycięciem dania z tego samego przepisu, z zachowanym oryginałem.');
      if(!samePhotoSubject(source.input,recipe.content,'hero',null))throw new AiError(409,'CORRECTION_SOURCE_STALE','Potrawa lub jej prezentacja zmieniła się od przygotowania wycięcia. Porównaj źródłowe zdjęcie z bieżącym przepisem.');
      captured.aiPhotography={heroStyleProfile:source.input.aiPhotography?.heroStyleProfile, ...(source.input.aiPhotography?.heroPresentationOverride ? { heroPresentationOverride: structuredClone(source.input.aiPhotography.heroPresentationOverride) } : {})};
      captured.recipe.heroPresentation=structuredClone(source.input.recipe.heroPresentation);
      captured.recipe.image=`/media/${asset.id}`;captured.recipe.imageAlt=asset.alt;
    }else if(input.imageAction==='cutout_result'){
      const [source]=await tx.select().from(aiJobs).where(eq(aiJobs.id,input.sourceJobId!)).for('share');
      const ingredient=input.kind==='ingredient'?recipe.content.recipe.ingredients.find(item=>item.id===targetId):undefined;
      if(!isRecoverablePhotoSource(source,recipe.id,input.kind as 'hero'|'ingredient',targetId,ingredient))throw new AiError(422,'INVALID_CORRECTION_SOURCE','Źródło musi być potwierdzoną, zakończoną fotografią tego dania lub składnika, wymagającą wyłącznie poprawienia tła.');
      if(input.kind==='hero'&&isCompleteHeroComposition(source.input.aiPhotography?.regenerate,source.brief))throw new AiError(422,'MANUAL_PHOTO_COMPOSITION','Zachowano pełne zdjęcie wykonane według Twojego opisu. Wycinanie samego naczynia mogłoby usunąć wskazane rekwizyty lub powierzchnię podania.');
      if(!samePhotoSubject(source.input,recipe.content,input.kind as 'hero'|'ingredient',targetId))throw new AiError(409,'CORRECTION_SOURCE_STALE','Potrawa lub jej prezentacja zmieniła się od przygotowania zdjęcia. Zachowano istniejący wynik.');
      if(input.kind==='hero'){
        const directed=source.input.aiPhotography?.regenerate===true?resolveHeroPresentationForBrief(source.input.recipe,source.brief):source.input.aiPhotography?.heroPresentationOverride;
        captured.aiPhotography={heroStyleProfile:source.input.aiPhotography?.heroStyleProfile, heroMaskPromptVersion, ...(directed ? { heroPresentationOverride: structuredClone(directed) } : {})};
        captured.recipe.heroPresentation=structuredClone(source.input.recipe.heroPresentation);
      }
      const marker=`${failedHeroSourcePrefix}${source.id}`;
      if(input.kind==='ingredient')captured.photos.ingredients[targetId!]={src:marker,columns:1,rows:1,index:0,alt:ingredient!.name};
      else captured.recipe.image=marker;
      // A new request key or photo-only revision never buys another accepted SAM for this result.
      const sourceMatch=input.kind==='ingredient'?sql`${aiJobs.input}->'photos'->'ingredients'->${targetId}->>'src'=${marker}`:sql`${aiJobs.input}->'recipe'->>'image'=${marker}`;
      const targetMatch=input.kind==='ingredient'?eq(aiJobs.targetId,targetId!):sql`${aiJobs.targetId} IS NULL`;
      const corrections=await tx.select().from(aiJobs).where(and(eq(aiJobs.recipeId,recipe.id),eq(aiJobs.kind,input.kind),targetMatch,eq(aiJobs.model,heroCutoutModel),sourceMatch,sql`(${aiJobs.status} NOT IN ('failed','cancelled') OR ${aiJobs.providerRequestId} IS NOT NULL OR ${aiJobs.providerFinishedAt} IS NULL)`)).orderBy(desc(aiJobs.createdAt));
      const semanticHeroRetry=input.kind==='hero'&&input.brief.trim()===heroCutoutSemanticRetryBrief;
      if(semanticHeroRetry&&account.role!=='owner')throw new AiError(403,'FORBIDDEN','Tę jednorazową korektę maski może zlecić właściciel.');
      if(semanticHeroRetry&&!corrections.some(item=>item.brief===heroCutoutSemanticRetryBrief||canRetryMissingHeroMask(item,input.brief.trim(),source.id)))throw new AiError(409,'HERO_MASK_RETRY_SCOPE','Jednorazowa korekta wymaga potwierdzonej, rozliczonej pustej maski ze starszego zlecenia. Zachowano fotografię.');
      const correction=corrections.find(item=>!(account.role!=='trend_worker'&&source.ingredientKey&&canRetryMissingIngredientMask(item,input.brief.trim(),source.ingredientKey))&&!(semanticHeroRetry&&canRetryMissingHeroMask(item,input.brief.trim(),source.id)));
      if(correction)return {job:jobDto(correction),created:false};
    }else if(input.imageAction){
      await validateExistingImage(tx,captured,input.imageAction,targetId);
      if(input.imageAction==='remove_background'){
        const match=/^\/media\/([a-f0-9-]{36})$/.exec(captured.recipe.image);
        const [asset]=match?await tx.select().from(aiAssets).where(eq(aiAssets.id,match[1])):[];
        const [source]=asset?await tx.select().from(aiJobs).where(eq(aiJobs.id,asset.jobId)):[];
        if(source){
          if(isCompleteHeroComposition(source.input.aiPhotography?.regenerate,source.brief))throw new AiError(422,'MANUAL_PHOTO_COMPOSITION','To zdjęcie zachowuje całą ręcznie opisaną kompozycję. Wycinanie samego naczynia mogłoby usunąć wskazane rekwizyty lub powierzchnię podania.');
          if(!samePhotoSubject(source.input,recipe.content,'hero',null))throw new AiError(409,'CORRECTION_SOURCE_STALE','Potrawa lub jej prezentacja zmieniła się. Najpierw przygotuj nowe zdjęcie główne.');
          const directed=source.input.aiPhotography?.regenerate===true?resolveHeroPresentationForBrief(source.input.recipe,source.brief):source.input.aiPhotography?.heroPresentationOverride;
          captured.aiPhotography={heroStyleProfile:source.input.aiPhotography?.heroStyleProfile,
            ...(directed ? { heroPresentationOverride: structuredClone(directed) } : {})};
          captured.recipe.heroPresentation=structuredClone(source.input.recipe.heroPresentation);
        }
      }
    }
    if(input.kind==='hero'&&(input.imageAction==='cutout_result'||input.imageAction==='remove_background')){
      const presentation=captured.aiPhotography?.heroPresentationOverride??resolveHeroPresentation(captured.recipe);
      captured.aiPhotography={...captured.aiPhotography,heroMaskPromptVersion:presentation?.container==='glass'?glassHeroMaskPromptVersion:heroMaskPromptVersion};
    }
    if(options.automaticHeroCutout)captured.aiPhotography={...captured.aiPhotography,automaticHeroCutout:structuredClone(options.automaticHeroCutout)};
    if (input.regenerate) captured.aiPhotography = { ...captured.aiPhotography, regenerate: true };
    const inputHash=createHash('sha256').update([recipe.id,recipe.revision,contentHash(captured),input.kind,targetId??'',provider,model,input.brief.trim(), ...(forceNew ? [input.requestKey] : []), ...(options.recipeRepairParentId ? [`recipe-repair:${options.recipeRepairParentId}`] : [])].join('\n')).digest('hex');
    const [duplicate]=await tx.select().from(aiJobs).where(and(eq(aiJobs.inputHash,inputHash),inArray(aiJobs.status,[...dedupeStatuses])));
    if (duplicate) return {job:jobDto(duplicate),created:false};
    const ingredient=input.kind==='ingredient'?recipe.content.recipe.ingredients.find(item=>item.id===targetId):undefined;
    const identity=ingredient?ingredientImageIdentity(ingredient,input.imageAction==='cutout_result'?ingredientStyleProfile:profile):null;
    const reusable=ingredient&&input.imageAction!=='cutout_result'&&!skipIngredientReuse?await findReusableIngredient(tx,ingredient,profile):null;
    const pendingProducer=identity&&!reusable&&input.imageAction!=='cutout_result'?await findIngredientProducer(tx,identity.key):null;
    if (input.regenerate && pendingProducer) throw new AiError(409, 'INGREDIENT_GENERATION_PENDING', 'Trwa już generowanie tego składnika. Poczekaj na jego zakończenie przed zleceniem własnych zmian.');
    const producer=skipIngredientReuse?null:pendingProducer;
    const createValues={id:randomUUID(),manualContentApprovalHash,trendRunId:trendRunId??null,photoBatchId:packet?.id??null,recipeId:recipe.id,baseRevision:recipe.revision,kind:input.kind,targetId,provider,model,brief:input.brief.trim(),requestKey:input.requestKey,inputHash,input:captured,createdBy:account.id,createdByName:account.name,ingredientKey:identity?.key??null};
    if(reusable||producer){
      const [job]=await tx.insert(aiJobs).values({...createValues,reservedUsd:'0',chargedUsd:'0',costBasis:'usage',reuseSourceJobId:producer?.id??null,status:reusable?'ready':'queued',providerFinishedAt:reusable?new Date():null,result:reusable?reuseResult(reusable,'library'):null}).returning();
      await tx.insert(aiLedger).values({id:randomUUID(),jobId:job.id,entry:'reserve',amountUsd:'0',basis:'not_charged'});
      return {job:jobDto(job),created:true};
    }
    const localFormat=input.imageAction==='crop_step'||input.imageAction==='fill_cutout';
    if(!localFormat && (image ? (!settings.fal||!settings.storage):!settings.openai))throw new AiError(503,'PROVIDER_NOT_CONFIGURED',image?'Tworzenie fotografii wymaga podłączenia usługi zdjęć i magazynu plików.':'Tworzenie treści wymaga podłączenia usługi treści.');
    if(localFormat&&!settings.storage)throw new AiError(503,'PROVIDER_NOT_CONFIGURED','Korekta formatu wymaga podłączenia magazynu plików.');
    const limits=await budget(tx);
    if (!packet&&!localFormat&&limits.activeJobs>=limits.concurrentLimit) throw new AiError(429,'CONCURRENCY_LIMIT','Trwają już dwa generowania. Zaczekaj na zakończenie jednego z nich.');
    if (trendRunId) {
      const run = await requireTrendScope(tx, trendRunId, recipe.id);
      if (run.expectedRevision !== recipe.revision) throw new AiError(409, 'REVISION_CONFLICT', 'Ręczna edycja wstrzymała przygotowanie przepisu.');
    }
    // Capture admission time after waiting for the shared concurrency lock.
    const [job]=await tx.insert(aiJobs).values({...createValues,reservedUsd:'0',createdAt:trendRunId?undefined:new Date(limits.serverNow!)}).returning();
    return {job:jobDto(job),created:true};
  };
  return options.transaction ? admit(options.transaction) : getDb().transaction(admit);
}

export async function listJobs(recipeId?: string, options: PhotoRecoveryReadOptions = {}): Promise<AiJob[]> {
  const rows=await getDb().select(jobPresentationSelection).from(aiJobs).where(recipeId ? eq(aiJobs.recipeId,recipeId) : undefined).orderBy(desc(aiJobs.createdAt)).limit(100);
  return withPhotoRecovery(await withRecipeRecovery(rows.map(jobPresentationDto)), options);
}
export async function getJobForExecution(id:string):Promise<JobRow> {
  const [row]=await getDb().select().from(aiJobs).where(eq(aiJobs.id,id));
  if (!row) throw new AiError(404,'JOB_NOT_FOUND','Nie znaleziono generowania.');
  return row;
}
export async function getJob(id:string, options: PhotoRecoveryReadOptions = {}):Promise<AiJob> {return (await withPhotoRecovery(await withRecipeRecovery([jobDto(await getJobForExecution(id))]), options))[0];}
export async function getAssetForExecution(id:string):Promise<AssetRow|null> {const [asset]=await getDb().select().from(aiAssets).where(eq(aiAssets.id,id));return asset??null;}

async function settle(tx:Transaction,job:JobRow,cost:CostInformation,basisOverride?:'cancelled'|'not_charged') {
  // Receipt retries, cancellation and expiry cannot replace a verified bill
  // with an estimate (or a second interpretation of the same provider usage).
  if (job.costBasis === 'usage' && job.chargedUsd !== null) cost = { chargedUsd: job.chargedUsd, costBasis: 'usage', usage: job.usage };
  if (cost.usage && (!Number.isSafeInteger(cost.usage.inputTokens) || cost.usage.inputTokens<0 || !Number.isSafeInteger(cost.usage.outputTokens) || cost.usage.outputTokens<0)) throw new AiError(422,'INVALID_USAGE','Nieprawidłowe zużycie modelu.');
  if (cost.chargedUsd == null || cost.costBasis === 'reservation') {
    // Preserve legacy estimates without treating an unknown new bill as zero.
    return { chargedUsd: job.chargedUsd, costBasis: job.costBasis ?? 'reservation' as const, usage: cost.usage ?? job.usage };
  }
  const charged=money(cost.chargedUsd);
  const basis='usage' as const;
  const [entry]=await tx.select().from(aiLedger).where(and(eq(aiLedger.jobId,job.id),eq(aiLedger.entry,'settle')));
  // The first settlement remains immutable; a verified bill appends one final reconciliation delta.
  if (!entry) await tx.insert(aiLedger).values({id:randomUUID(),jobId:job.id,entry:'settle',amountUsd:new Decimal(charged).minus(job.reservedUsd).toFixed(8),basis:basisOverride??basis});
  else if (job.costBasis==='reservation' && basis==='usage') await tx.insert(aiLedger).values({id:randomUUID(),jobId:job.id,entry:'reconcile',amountUsd:new Decimal(charged).minus(job.chargedUsd??job.reservedUsd).toFixed(8),basis:basisOverride??'usage'}).onConflictDoNothing();
  return {chargedUsd:charged,costBasis:basis,usage:cost.usage??job.usage};
}

export async function claimSubmission(id:string):Promise<{job:JobRow;shouldSubmit:boolean}> {
  return getDb().transaction(async tx=>{
    await budgetLock(tx); const job=await lockedJob(tx,id);
    const [recipe]=await tx.select({deletedAt:editorialRecipes.deletedAt}).from(editorialRecipes).where(eq(editorialRecipes.id,job.recipeId));
    // A deleted recipe admits no POST. An accepted receipt may still be polled
    // and billed, including a result arriving after deletion.
    if (recipe?.deletedAt) return {job,shouldSubmit:false};
    // A captured provider ID grants receipt-only polling, even when its radar is
    // paused. It never grants a new POST; queued submissions still need scope.
    if(job.trendRunId && job.providerRequestId && job.createdBy===trendWorker.id){
      const [scope]=await tx.select().from(trendRuns).where(eq(trendRuns.id,job.trendRunId)).for('share');
      if(!scope || scope.recipeId!==job.recipeId)throw new AiError(403,'FORBIDDEN','To zlecenie nie należy do szkicu radaru.');
      return {job,shouldSubmit:false};
    }
    await trustedActor(tx,job.createdBy,job.trendRunId,job.recipeId);
    if (job.kind !== 'recipe' && job.createdBy === trendWorker.id && job.trendRunId && !job.providerRequestId && job.status === 'queued') {
      const [current] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, job.recipeId));
      if (!current || job.manualContentApprovalHash !== await manualTrendPhotoApproval(tx, current, job.trendRunId))
        throw new AiError(409, 'MANUAL_PHOTO_DECISION_REQUIRED', 'To zdjęcie wymaga aktualnej akceptacji treści i jawnego zlecenia.');
    }
    if(job.reuseSourceJobId)return {job,shouldSubmit:false};
    if (job.photoBatchId && job.status === 'queued') {
      const [packet] = await tx.select().from(aiPhotoBatches).where(eq(aiPhotoBatches.id,job.photoBatchId)).for('share');
      if (!packet || packet.recipeId !== job.recipeId || !['queued','generating'].includes(packet.status)) throw new AiError(409,'PHOTO_BATCH_SCOPE','Pakiet zdjęć został wstrzymany.');
      // Only atomically claimed batch work uses a provider slot.
      if (![stepFormatModel,filledHeroModel].includes(job.model) && (await budget(tx)).activeJobs >= aiSettings().concurrentLimit) return {job,shouldSubmit:false};
    }
    if(job.kind==='ingredient'&&job.model!==heroCutoutModel&&job.status==='queued'&&!job.requestKey.startsWith('trend_regen_')&&!job.input.aiPhotography?.regenerate){
      const ingredient=job.input.recipe.ingredients.find(item=>item.id===job.targetId);
      const reusable=ingredient?await findReusableIngredient(tx,ingredient,capturedIngredientStyleProfile(job.input)):null;
      if(reusable){await finish(tx,job,reuseResult(reusable,'library'),{chargedUsd:'0',costBasis:'usage'});return {job:await lockedJob(tx,id),shouldSubmit:false};}
    }
    if (job.status==='queued') {const [updated]=await tx.update(aiJobs).set({status:'submitting',updatedAt:new Date()}).where(eq(aiJobs.id,id)).returning();return {job:updated,shouldSubmit:true};}
    if([stepFormatModel,filledHeroModel].includes(job.model)&&job.status==='submitting'&&!job.providerRequestId)return {job,shouldSubmit:true};
    if (job.status==='submitting' && !job.providerRequestId) {
      const values=await settle(tx,job,{});
      const [updated]=await tx.update(aiJobs).set({...values,status:'uncertain',errorCode:'SUBMISSION_UNCERTAIN',errorMessage:'Nie można potwierdzić przyjęcia żądania. Koszt pozostaje nieznany; ponowne wysłanie jest zablokowane.',updatedAt:new Date()}).where(eq(aiJobs.id,id)).returning();
      return {job:updated,shouldSubmit:false};
    }
    return {job,shouldSubmit:false};
  });
}
export async function attachProviderRequest(id:string,requestId:string):Promise<JobRow> {
  if (!requestId || requestId.length>500) throw new AiError(422,'INVALID_PROVIDER_ID','Nieprawidłowy identyfikator dostawcy.');
  return getDb().transaction(async tx=>{
    const job=await lockedJob(tx,id);
    if (job.providerRequestId && job.providerRequestId!==requestId) throw new AiError(409,'PROVIDER_ID_CONFLICT','Generowanie ma już inny identyfikator dostawcy.');
    if (job.providerRequestId===requestId) return job;
    if (!['submitting','uncertain','cancelled'].includes(job.status)) throw new AiError(409,'JOB_STATE','Żądanie nie jest w trakcie wysyłania.');
    const [updated]=await tx.update(aiJobs).set({providerRequestId:requestId,status:job.status==='cancelled'?'cancelled':'generating',errorCode:null,errorMessage:null,updatedAt:new Date()}).where(eq(aiJobs.id,id)).returning();return updated;
  });
}
export async function markGenerating(id:string):Promise<JobRow> {
  return getDb().transaction(async tx=>{const job=await lockedJob(tx,id);if(job.status!=='submitting' || !job.providerRequestId)return job;const [updated]=await tx.update(aiJobs).set({status:'generating',updatedAt:new Date()}).where(eq(aiJobs.id,id)).returning();return updated;});
}

/** Worker-only preflight immediately before the paid POST, after any image preparation. */
export async function ensureSubmissionAllowed(id:string):Promise<void> {
  await getDb().transaction(async tx=>{
    await budgetLock(tx);
    const job=await lockedJob(tx,id);
    const [recipe]=await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id,job.recipeId));
    if(recipe?.deletedAt)throw new AiError(409,'RECIPE_DELETED','Przepis przeniesiono do kosza. Nie wysłano nowej generacji.');
    if (job.kind === 'recipe') {
      const [repair] = await tx.select({ attempt: aiRecipeRecoveries.attempt, trendGeneration: aiRecipeRecoveries.trendGeneration }).from(aiRecipeRecoveries).where(eq(aiRecipeRecoveries.jobId, id));
      if (repair && repair.attempt > 0 && (!recipe || recipe.editorialStatus === 'archived' || recipe.revision !== job.baseRevision
        || contentApprovalHash(recipe.content) !== contentApprovalHash(job.input)))
        throw new AiError(409, 'RECIPE_REPAIR_STALE', 'Przepis zmienił się od zlecenia poprawki. Nie wysłano starej generacji.');
      if (repair && repair.attempt > 0 && job.trendRunId) {
        const run = await requireTrendScope(tx, job.trendRunId, job.recipeId);
        if (run.generation !== repair.trendGeneration) throw new AiError(409, 'TREND_SUPERSEDED', 'Przygotowanie zostało zastąpione. Nie wysłano starej poprawki.');
      }
    }
    await trustedActor(tx,job.createdBy,job.trendRunId,job.recipeId);
    if (job.kind !== 'recipe' && job.createdBy === trendWorker.id && job.trendRunId) {
      if (!recipe || job.manualContentApprovalHash !== await manualTrendPhotoApproval(tx, recipe, job.trendRunId)
        || contentApprovalHash(job.input) !== job.manualContentApprovalHash)
        throw new AiError(409, 'MANUAL_PHOTO_DECISION_REQUIRED', 'Treść lub decyzja o zdjęciach zmieniła się. Nie wysłano nowego zlecenia.');
    }
    if (job.kind !== 'recipe' && !job.trendRunId && ![stepFormatModel,filledHeroModel].includes(job.model)) {
      if (!recipe) throw new AiError(404, 'RECIPE_NOT_FOUND', 'Nie znaleziono przepisu.');
      await requireRecipeContentApproval(tx, recipe);
      if (contentApprovalHash(job.input) !== contentApprovalHash(recipe.content)
        || !samePhotoSubject(job.input, recipe.content, job.kind, job.targetId)) {
        throw new AiError(409, 'PHOTO_CONTENT_CHANGED', 'Treść przepisu zmieniła się od zlecenia tego zdjęcia. Nie wysłano starego zlecenia; wygeneruj zdjęcia dla zaakceptowanej treści.');
      }
    }
    if(job.trendRunId){
      const run=await requireTrendScope(tx,job.trendRunId,job.recipeId);
      if(!recipe||recipe.revision!==run.expectedRevision)throw new AiError(409,'REVISION_CONFLICT','Ręczna edycja wstrzymała generowanie.');
    }
    if(job.photoBatchId){
      const [packet]=await tx.select().from(aiPhotoBatches).where(eq(aiPhotoBatches.id,job.photoBatchId));
      if(!packet||!recipe||!['queued','generating'].includes(packet.status)||job.kind==='recipe'
        ||(!samePhotoSubject(packet.input,recipe.content,'hero',null)||!sameStepPhotoSelection(packet.input,recipe.content))||!samePhotoSubject(job.input,recipe.content,job.kind,job.targetId)){
        throw new AiError(409,'PHOTO_BATCH_SCOPE','Przepis lub stan pakietu zmienił się. Nie wysłano nowej generacji.');
      }
      // Submitting siblings in this same valid wave are expected; a recorded
      // uncertain acceptance must stop any later POST, including a retry that
      // was selected just before the other child became uncertain.
      if (await hasUnconfirmedBatchSubmission(tx, packet, false)) throw new AiError(409, 'SUBMISSION_UNCERTAIN', 'Nie potwierdzono przyjęcia innego zdjęcia. Nie wysłano nowej płatnej generacji.');
    }
    if(job.status!=='submitting'||job.providerRequestId||job.providerFinishedAt||job.reuseSourceJobId){
      throw new AiError(409,'SUBMISSION_BLOCKED','Żądanie zostało anulowane lub ma już wynik wysyłania.');
    }
  });
}

/** Ingredient research belongs to the active text job and its unchanged captured draft. */
export async function ensureIngredientVerificationAllowed(id: string): Promise<void> {
  await getDb().transaction(async tx => {
    await budgetLock(tx);
    const job = await lockedJob(tx, id);
    const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, job.recipeId));
    await trustedActor(tx, job.createdBy, job.trendRunId, job.recipeId);
    if (job.kind !== 'recipe' || job.status !== 'generating' || !job.providerRequestId || job.result
      || !recipe || recipe.deletedAt || recipe.editorialStatus === 'archived' || recipe.revision !== job.baseRevision
      || contentApprovalHash(recipe.content) !== contentApprovalHash(job.input)) {
      throw new AiError(409, 'INGREDIENT_VERIFICATION_STALE', 'Szkic lub stan generowania zmienił się. Nie wysłano dodatkowej weryfikacji składnika.');
    }
    if (job.trendRunId) {
      const run = await requireTrendScope(tx, job.trendRunId, job.recipeId);
      if (run.expectedRevision !== recipe.revision) throw new AiError(409, 'INGREDIENT_VERIFICATION_STALE', 'Przygotowanie szkicu zostało zastąpione.');
    }
  });
}

export async function markIngredientVerificationPending(id: string, name: string): Promise<void> {
  await getDb().update(aiJobs).set({ errorCode: 'AI_INGREDIENT_VERIFICATION_PENDING',
    errorMessage: `Sprawdzamy w źródłach nieznany składnik: ${name.slice(0, 250)}. Gotowy tekst przepisu jest zachowany.`, updatedAt: new Date() })
    .where(and(eq(aiJobs.id, id), eq(aiJobs.kind, 'recipe'), eq(aiJobs.status, 'generating'), isNull(aiJobs.result)));
}

/** Worker-only proof: this invocation observed cancellation before any paid POST occurred. */
export async function confirmNotSubmitted(id:string):Promise<AiJob> {
  return getDb().transaction(async tx=>{await budgetLock(tx);const job=await lockedJob(tx,id);if(job.providerRequestId||job.status!=='cancelled')throw new AiError(409,'SUBMISSION_PROOF_REQUIRED','Nie można potwierdzić braku wysłania po zapisaniu żądania.');const values=await settle(tx,job,{chargedUsd:'0',costBasis:'usage'},'cancelled');const [updated]=await tx.update(aiJobs).set({...values,providerFinishedAt:new Date(),ingredientResolvedAt:new Date(),updatedAt:new Date()}).where(eq(aiJobs.id,id)).returning();return jobDto(updated);});
}

function preservedProposal(input:EditorialContent,proposal:EditorialContent,contract:EditorialContent=input,verifiedResearchSources=false):EditorialContent {
  const parsed=editorialContentSchema.safeParse(proposal);
  if(!parsed.success) throw new AiError(422,'INVALID_RESULT','Model zwrócił nieprawidłowy przepis.');
  const content=parsed.data as EditorialContent;
  content.originalText=input.originalText;content.author=input.author;
  // New researched results reach this function only after pollText verified
  // their URLs against provider web receipts. Legacy jobs retain old ownership.
  content.sources = structuredClone(input.sources);
  if (verifiedResearchSources) {
    const urls = new Set(content.sources.map(source => source.url));
    const ids = new Set(content.sources.map(source => source.id));
    for (const source of proposal.sources) {
      // Older recipe receipts can acquire independently verified ingredient
      // evidence while retaining their original recipe-research contract.
      if (contract.aiPhotography?.recipeResearchVersion !== 'web-recipe-v1' && !/^ingredient_[a-f0-9]{20}_\d+$/.test(source.id)) continue;
      if (urls.has(source.url)) continue;
      const appended = structuredClone(source);
      let suffix = 1;
      while (ids.has(appended.id)) appended.id = `research_${suffix++}`;
      content.sources.push(appended); ids.add(appended.id); urls.add(appended.url);
    }
  }
  content.photos=structuredClone(input.photos);
  content.recipe.id=input.recipe.id;content.recipe.image=input.recipe.image;content.recipe.imageAlt=structuredClone(input.recipe.imageAlt);content.recipe.featured=input.recipe.featured;
  content.recipe.collection=input.recipe.collection;content.recipe.trendConfirmedAt=input.recipe.trendConfirmedAt;
  content.recipe.provenance={type:'ai_draft',label:{pl:'Opracowanie redakcyjne · do przeglądu',en:'Editorial draft · review required'},note:{pl:'Propozycja oczekująca na przegląd redakcyjny.',en:'A proposal awaiting editorial review.'},kitchenTested:false};
  const ingredients=new Set(content.recipe.ingredients.map(item=>item.id));const steps=new Set(content.recipe.steps.map(item=>item.id));
  content.photos.ingredients=Object.fromEntries(Object.entries(content.photos.ingredients).filter(([id])=>ingredients.has(id)));
  content.photos.steps=Object.fromEntries(Object.entries(content.photos.steps).filter(([id])=>steps.has(id)));
  return content;
}
async function finish(tx:Transaction,job:JobRow,result:AiResult,cost:CostInformation) {
  const values=await settle(tx,job,cost);
  const [updated]=await tx.update(aiJobs).set({...values,status:job.status==='cancelled'?'cancelled':'ready',result,providerFinishedAt:new Date(),ingredientResolvedAt:new Date(),errorCode:null,errorMessage:null,updatedAt:new Date()}).where(eq(aiJobs.id,job.id)).returning();return jobDto(updated);
}
function completable(job:JobRow) {if(!['submitting','generating','uncertain'].includes(job.status) && !(job.status==='cancelled' && job.providerRequestId))throw new AiError(409,'JOB_STATE','Generowanie nie oczekuje na wynik.');}
export async function finishRecipe(id:string,content:EditorialContent,cost:CostInformation={},notes:string[]=[],options:{verifiedResearchSources?:boolean}={}):Promise<AiJob> {
  return getDb().transaction(async tx=>{await budgetLock(tx);const job=await lockedJob(tx,id);if(job.result)return jobDto(job);completable(job);if(job.kind!=='recipe')throw new AiError(409,'JOB_KIND','To generowanie nie dotyczy treści.');return finish(tx,job,{content:preservedProposal(job.input,content,job.input,options.verifiedResearchSources===true),asset:null,notes:safeNotes(notes)},cost);});
}
export async function finishAsset(id:string,input:AssetInput,cost:CostInformation={},notes:string[]=[]):Promise<AiJob> {
  if (!input.blobPathname || input.blobPathname.length>2_000 || input.blobPathname.includes('://') || (input.originalBlobPathname && (input.originalBlobPathname.length>2_000 || input.originalBlobPathname.includes('://'))) || !['image/webp','image/png','image/jpeg'].includes(input.contentType) || !Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width<1 || input.height<1 || input.width>10_000 || input.height>10_000 || !input.alt.pl.trim() || !input.alt.en.trim() || input.alt.pl.length>20_000 || input.alt.en.length>20_000 || input.caption.pl.length>20_000 || input.caption.en.length>20_000) throw new AiError(422,'INVALID_ASSET','Fotografia lub jej opis jest nieprawidłowy.');
  return getDb().transaction(async tx=>{await budgetLock(tx);const job=await lockedJob(tx,id);if(job.result)return jobDto(job);completable(job);if(job.kind==='recipe')throw new AiError(409,'JOB_KIND','To generowanie nie dotyczy fotografii.');const {hasTransparency,styleProfile,...stored}=input;const [asset]=await tx.insert(aiAssets).values({id:job.id,recipeId:job.recipeId,jobId:job.id,kind:job.kind,targetId:job.targetId,model:job.model,...stored}).returning();await registerIngredientImage(tx,job,asset,{hasTransparency,styleProfile});return finish(tx,job,{content:null,asset:{...assetDto(asset),...(styleProfile?{styleProfile}:{})},notes:safeNotes(notes)},cost);});
}

/** A follower observes the first producer; it can never send or retry its own provider request. */
export async function resolveIngredientReuse(id:string):Promise<boolean>{
  return getDb().transaction(async tx=>{
    await budgetLock(tx);const job=await lockedJob(tx,id);
    if(!job.reuseSourceJobId||job.result||job.status==='cancelled')return true;
    const ingredient=job.input.recipe.ingredients.find(item=>item.id===job.targetId);
    const reusable=ingredient?await findReusableIngredient(tx,ingredient,capturedIngredientStyleProfile(job.input)):null;
    if(reusable){await finish(tx,job,reuseResult(reusable,'shared_generation'),{chargedUsd:'0',costBasis:'usage'});return true;}
    const [source]=await tx.select().from(aiJobs).where(eq(aiJobs.id,job.reuseSourceJobId));
    if(!source||source.ingredientResolvedAt||['uncertain','failed'].includes(source.status)){
      const uncertain=source?.status==='uncertain'&&!source.ingredientResolvedAt;
      await tx.update(aiJobs).set({status:uncertain?'uncertain':'failed',providerFinishedAt:uncertain?null:new Date(),chargedUsd:'0',costBasis:'usage',errorCode:'INGREDIENT_SOURCE_UNAVAILABLE',errorMessage:'Pierwsze zdjęcie tego składnika nie zostało potwierdzone. Nowa płatna generacja nie została wysłana.',updatedAt:new Date()}).where(eq(aiJobs.id,id));return true;
    }
    return false;
  });
}

export async function failJob(id:string,input:{code:string;message:string;uncertain:boolean;chargedUsd?:string|null;providerFinished?:boolean;validation?:{issues:readonly RecipeValidationIssue[];repairable:boolean}}):Promise<AiJob> {
  return getDb().transaction(async tx=>{await budgetLock(tx);const job=await lockedJob(tx,id);if(['ready','applied','failed'].includes(job.status) || (job.status==='cancelled' && job.providerFinishedAt && (job.kind!=='ingredient'||job.ingredientResolvedAt||job.result))){if(input.validation)await recordRecipeValidationFailure(tx,job,input.validation.issues,input.validation.repairable);return jobDto(job);}
    const knownCost=job.costBasis==='usage'&&job.chargedUsd!==null;
    const costUncertain=!knownCost&&(input.uncertain || (job.providerRequestId!==null && input.chargedUsd==null));
    // Unknown acceptance or billing never invents a zero charge, even for a terminal error.
    const values=await settle(tx,job,{chargedUsd:knownCost?job.chargedUsd:costUncertain?null:(input.chargedUsd??'0'),costBasis:costUncertain?'reservation':'usage'},costUncertain?undefined:!knownCost&&input.chargedUsd==null?'not_charged':undefined);
    const [updated]=await tx.update(aiJobs).set({...values,status:job.status==='cancelled'?'cancelled':input.uncertain?'uncertain':'failed',providerFinishedAt:input.providerFinished || !input.uncertain ? new Date() : job.providerFinishedAt,ingredientResolvedAt:input.uncertain?job.ingredientResolvedAt:new Date(),errorCode:input.code.slice(0,100),errorMessage:input.message.slice(0,2_000),updatedAt:new Date()}).where(eq(aiJobs.id,id)).returning();if(input.validation)await recordRecipeValidationFailure(tx,updated,input.validation.issues,input.validation.repairable);return jobDto(updated);
  });
}
export async function cancelJob(id:string,actor:EditorialActor):Promise<AiJob> {
  return getDb().transaction(async tx=>{await budgetLock(tx);const job=await lockedJob(tx,id);await trustedActor(tx,actor.id);if(job.status==='cancelled')return jobDto(job);if(![...dedupeStatuses].includes(job.status as typeof dedupeStatuses[number]))throw new AiError(409,'CANNOT_CANCEL','Zakończone generowanie nie wymaga anulowania.');const values=job.status==='queued'?await settle(tx,job,{chargedUsd:'0',costBasis:'usage'},'cancelled'):await settle(tx,job,{});const [updated]=await tx.update(aiJobs).set({...values,status:'cancelled',providerFinishedAt:job.status==='queued'?new Date():job.providerFinishedAt,ingredientResolvedAt:job.status==='queued'?new Date():job.ingredientResolvedAt,updatedAt:new Date()}).where(eq(aiJobs.id,id)).returning();return jobDto(updated);});
}

export async function resumeJob(id:string,actor:EditorialActor):Promise<AiJob> {
  return getDb().transaction(async tx=>{
    await budgetLock(tx);const job=await lockedJob(tx,id);await trustedActor(tx,actor.id);
    if(job.reuseSourceJobId&&job.status==='uncertain'&&!job.result){const [updated]=await tx.update(aiJobs).set({status:'queued',errorCode:null,errorMessage:null,updatedAt:new Date()}).where(eq(aiJobs.id,id)).returning();return jobDto(updated);}
    const restoreContents=canRestoreHeroContents(job);
    if((job.status!=='uncertain'&&!restoreContents)||!job.providerRequestId||job.result)throw new AiError(409,'CANNOT_RESUME','Wznowienie wymaga potwierdzonego identyfikatora żądania dostawcy bez zapisanego wyniku. Żądanie nie zostanie wysłane ponownie.');
    if(restoreContents){
      const [recipe]=await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id,job.recipeId)).for('share');
      if(!recipe||recipe.deletedAt||recipe.editorialStatus==='archived')throw new AiError(409,'RECIPE_UNAVAILABLE','Najpierw przywróć przepis do edycji. Zachowano istniejącą maskę.');
      if(!samePhotoSubject(job.input,recipe.content,'hero',null)||contentApprovalHash(job.input)!==contentApprovalHash(recipe.content))throw new AiError(409,'PHOTO_CONTENT_CHANGED','Treść przepisu zmieniła się. Zachowano fotografię i istniejącą maskę.');
      await requireRecipeContentApproval(tx,recipe);
      const sourceId=job.input.recipe.image.slice(failedHeroSourcePrefix.length);
      const [source]=await tx.select().from(aiJobs).where(eq(aiJobs.id,sourceId)).for('share');
      if(!isRecoverablePhotoSource(source,recipe.id,'hero')||!samePhotoSubject(source.input,job.input,'hero',null)
        ||!isDeepStrictEqual(source.input.aiPhotography?.heroPresentationOverride??source.input.recipe.heroPresentation,job.input.aiPhotography?.heroPresentationOverride??job.input.recipe.heroPresentation))throw new AiError(409,'CORRECTION_SOURCE_STALE','Nie potwierdzono tego samego oryginału i naczynia. Zachowano istniejącą maskę.');
    }
    // Reading an already accepted receipt admits neither a paid request nor a
    // new remote slot. Submission concurrency stays enforced by claimSubmission.
    const [updated]=await tx.update(aiJobs).set({status:'generating',errorCode:null,errorMessage:null,updatedAt:new Date()}).where(eq(aiJobs.id,id)).returning();return jobDto(updated);});
}

/** A preparation may retrieve an existing receipt, including a manual Studio result, without repeating its POST. */
export async function resumeTrendJob(id: string, runId: string, generation: number): Promise<AiJob> {
  return getDb().transaction(async tx => {
    await budgetLock(tx);
    const run = await requireTrendScope(tx, runId);
    if (run.generation !== generation) throw new AiError(409, 'TREND_SUPERSEDED', 'To przygotowanie zastąpiło nowe uruchomienie.');
    const job = await lockedJob(tx, id);
    if (job.recipeId !== run.recipeId || (job.trendRunId !== null && job.trendRunId !== runId)) throw new AiError(403, 'FORBIDDEN', 'To zlecenie nie należy do tego przepisu.');
    if (job.status !== 'uncertain' || job.result) return jobDto(job);
    if (!job.providerRequestId && !job.reuseSourceJobId) throw new AiError(409, 'SUBMISSION_UNCERTAIN', 'Nie potwierdzono przyjęcia istniejącego zlecenia. Zachowano je bez ponownego wysłania.');
    const [updated] = await tx.update(aiJobs).set({ status: job.reuseSourceJobId ? 'queued' : 'generating', errorCode: null, errorMessage: null, updatedAt: new Date() }).where(eq(aiJobs.id, id)).returning();
    return jobDto(updated);
  });
}

/** Call only after the stored provider request was observed terminal. This releases a concurrency slot, never its unresolved cost. */
export async function markProviderTerminal(id:string):Promise<AiJob> {
  return getDb().transaction(async tx=>{await budgetLock(tx);const job=await lockedJob(tx,id);if(!job.providerRequestId)throw new AiError(409,'PROVIDER_ID_REQUIRED','Nie można potwierdzić zakończenia bez identyfikatora dostawcy.');if(job.providerFinishedAt)return jobDto(job);const [updated]=await tx.update(aiJobs).set({providerFinishedAt:new Date(),updatedAt:new Date()}).where(eq(aiJobs.id,id)).returning();return jobDto(updated);});
}

export async function applyJob(id:string,input:ApplyAiJob,actor:EditorialActor):Promise<ApplyAiResult> {
  return getDb().transaction(async tx=>{
    // Serialize with deletion before acquiring job or recipe row locks.
    await budgetLock(tx);
    const account=await trustedActor(tx,actor.id);const job=await lockedJob(tx,id);
    if(job.status!=='ready'||!job.result)throw new AiError(409,'RESULT_NOT_READY','Wynik nie jest gotowy do zastosowania.');
    const [current]=await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id,job.recipeId)).for('update');
    if(!current)throw new AiError(404,'RECIPE_NOT_FOUND','Nie znaleziono przepisu.');
    if(current.deletedAt)throw new AiError(409,'RECIPE_DELETED','Najpierw przywróć przepis z kosza.');
    if(current.revision!==input.expectedRevision)throw new EditorialError(409,'REVISION_CONFLICT','Przepis zmienił się w innym oknie. Odśwież wersję przed zastosowaniem wyniku.');
    if(job.kind==='hero'&&!samePhotoSubject(job.input,current.content,'hero',null))throw new AiError(409,'HERO_PRESENTATION_CHANGED','Potrawa lub jej prezentacja zmieniła się. Zachowano gotowe zdjęcie; przygotuj wynik dla bieżących ustawień.');
    if(job.baseRevision!==current.revision && !input.acknowledgeStale)throw new AiError(409,'STALE_RESULT','Przepis zmienił się od rozpoczęcia generowania. Porównaj wynik i świadomie potwierdź zastosowanie.');
    let content=structuredClone(current.content);
    if(job.kind==='recipe') {
      if(!job.result.content)throw new AiError(409,'MISSING_RESULT','Brak propozycji treści.');
      content=preservedProposal(current.content,job.result.content,job.input,true);
    } else if(job.kind==='ingredient'&&job.result.reusedPhoto){
      content.photos.ingredients[job.targetId!]=await checkedReusedIngredientPhoto(tx,job,content);
    } else {
      const asset=job.result.asset;
      if(!asset)throw new AiError(409,'MISSING_RESULT','Brak wygenerowanej fotografii.');
      const [registered]=await tx.select().from(aiAssets).where(and(eq(aiAssets.id,asset.id),eq(aiAssets.jobId,job.id)));
      if(!registered)throw new AiError(409,'MISSING_ASSET','Fotografia nie jest zarejestrowana.');
      if(job.kind==='hero') {content.recipe.image=asset.src;content.recipe.imageAlt=asset.alt;if(job.input.aiPhotography?.heroStyleProfile===heroPresentationProfile)content.recipe.heroPresentation=structuredClone(job.input.recipe.heroPresentation);}
      else {
        const stillPresent=job.kind==='ingredient'?content.recipe.ingredients.some(item=>item.id===job.targetId):content.recipe.steps.some(item=>item.id===job.targetId);
        if(!stillPresent || !job.targetId)throw new AiError(409,'TARGET_MISSING','Wybrany składnik lub krok został usunięty. Fotografia nie została zastosowana.');
        if(job.kind==='step'&&!samePhotoSubject(job.input,current.content,'step',job.targetId))throw new AiError(409,'STEP_CONTENT_CHANGED','Ilości, przygotowanie lub zatwierdzony wygląd potrawy zmieniły się. Zachowano gotowe zdjęcie; przygotuj krok dla bieżącej treści.');
        if(job.kind==='ingredient'&&job.ingredientKey&&ingredientImageIdentity(content.recipe.ingredients.find(item=>item.id===job.targetId)!,capturedIngredientStyleProfile(job.input)).key!==job.ingredientKey)throw new AiError(409,'INGREDIENT_FORM_CHANGED','Składnik lub jego postać zmieniły się. Zachowano zdjęcie w bibliotece.');
        const tile={src:asset.src,columns:1,rows:1,index:0,alt:asset.alt,caption:asset.caption,aspectRatio:asset.width/asset.height};
        if(job.kind==='ingredient')content.photos.ingredients[job.targetId]=tile;else content.photos.steps[job.targetId]=tile;
      }
    }
    const recipe=await applyAiProposalInTransaction(tx,job.recipeId,input.expectedRevision,content,account,job.kind==='recipe'?'Zastosowanie propozycji treści':'Zastosowanie wygenerowanej fotografii');
    const [updated]=await tx.update(aiJobs).set({status:'applied',appliedRevision:recipe.revision,updatedAt:new Date()}).where(eq(aiJobs.id,id)).returning();
    return {job:jobDto(updated),recipe};
  });
}

/** Studio packages are reviewed first and applied once, without publication. */
export async function applyPhotoBatchJobsInTransaction(tx:Transaction,recipeId:string,jobIds:string[],expectedRevision:number,actor:EditorialActor,snapshot:EditorialContent,replacements?:ReadonlyMap<string,MediaTile|null>):Promise<EditorialRecord> {
  const account=await trustedActor(tx,actor.id);
  const jobs:JobRow[]=[];
  for(const id of [...new Set(jobIds)].sort())jobs.push(await lockedJob(tx,id));
  const [current]=await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id,recipeId)).for('update');
  if(!current)throw new AiError(404,'RECIPE_NOT_FOUND','Nie znaleziono przepisu.');
  if(current.deletedAt)throw new AiError(409,'RECIPE_DELETED','Najpierw przywróć przepis z kosza.');
  if(current.revision!==expectedRevision)throw new EditorialError(409,'REVISION_CONFLICT','Przepis zmienił się w innym oknie. Odśwież wersję przed zastosowaniem pakietu.');
  if((!samePhotoSubject(snapshot,current.content,'hero',null)||!sameStepPhotoSelection(snapshot,current.content)))throw new AiError(409,'STALE_BATCH','Treść przepisu zmieniła się. Gotowe zdjęcia zachowano do porównania.');
  const content=structuredClone(current.content);const applied:string[]=[];
  for(const job of jobs){
    if(job.recipeId!==recipeId||job.kind==='recipe'||!['ready','applied'].includes(job.status)||!job.result||!samePhotoSubject(job.input,current.content,job.kind,job.targetId))throw new AiError(409,'PHOTO_BATCH_RESULT_NOT_READY','Jedno ze zdjęć nie jest gotowe lub dotyczy innej treści.');
    // Missing-photo packages preserve existing images. Explicit ingredient
    // replacements compare their captured old tile before changing it.
    const replacing=job.kind==='ingredient'&&replacements?.has(job.targetId!);
    if(replacing){
      if(!['ingredients-white','ingredients-paper'].includes(snapshot.aiPhotography?.photoBatchMode??'')||capturedIngredientStyleProfile(job.input)!==capturedIngredientStyleProfile(snapshot))throw new AiError(409,'PHOTO_REPLACEMENT_SCOPE','Pakiet nie dotyczy wymiany zdjęć składników.');
      if(!isDeepStrictEqual(content.photos.ingredients[job.targetId!]??null,replacements!.get(job.targetId!)))throw new AiError(409,'PHOTO_REPLACEMENT_CONFLICT','Zdjęcie składnika zmieniło się podczas generowania. Zachowano obie wersje do porównania.');
    }else if(job.kind==='hero'?Boolean(content.recipe.image.trim()):Boolean(content.photos[job.kind==='ingredient'?'ingredients':'steps'][job.targetId??'']?.src))continue;
    if(job.kind==='ingredient'&&job.result.reusedPhoto)content.photos.ingredients[job.targetId!]=await checkedReusedIngredientPhoto(tx,job,content);
    else {
      const asset=job.result.asset;
      if(!asset)throw new AiError(409,'MISSING_ASSET','Brak wygenerowanej fotografii.');
      const [registered]=await tx.select().from(aiAssets).where(and(eq(aiAssets.id,asset.id),eq(aiAssets.jobId,job.id)));
      if(!registered)throw new AiError(409,'MISSING_ASSET','Fotografia nie jest zarejestrowana.');
      if(job.kind==='hero'){content.recipe.image=asset.src;content.recipe.imageAlt=asset.alt;if(job.input.aiPhotography?.heroStyleProfile===heroPresentationProfile)content.recipe.heroPresentation=structuredClone(job.input.recipe.heroPresentation);}
      else {const tile={src:asset.src,columns:1,rows:1,index:0,alt:asset.alt,caption:asset.caption,aspectRatio:asset.width/asset.height};if(job.kind==='ingredient')content.photos.ingredients[job.targetId!]=tile;else content.photos.steps[job.targetId!]=tile;}
    }
    applied.push(job.id);
  }
  if(!applied.length)return getRecipeInTransaction(tx,recipeId);
  const recipe=await applyAiProposalInTransaction(tx,recipeId,expectedRevision,content,account,'Zastosowanie pakietu zdjęć');
  await tx.update(aiJobs).set({status:'applied',appliedRevision:recipe.revision,updatedAt:new Date()}).where(inArray(aiJobs.id,applied));
  return recipe;
}

/** Verified provider billing may reconcile a conservative reservation; no network or estimation happens here. */
export async function settleCost(id:string,cost:CostInformation):Promise<AiJob> {
  if(cost.chargedUsd==null || cost.costBasis==='reservation')return getJob(id);
  return getDb().transaction(async tx=>{
    await budgetLock(tx);return settleCostInTransaction(tx,id,cost);
  });
}

/** Caller holds budgetLock; keeps packet billing changes in one authenticated transaction. */
export async function settleCostInTransaction(tx:AiTransaction,id:string,cost:CostInformation):Promise<AiJob> {
  const job=await lockedJob(tx,id);
  if(cost.chargedUsd==null || cost.costBasis==='reservation')return jobDto(job);
  if(!['ready','applied','failed','uncertain','cancelled'].includes(job.status))throw new AiError(409,'JOB_STATE','Koszt zostanie rozliczony po zakończeniu żądania.');
  if(job.costBasis==='usage')return jobDto(job);
  const values=await settle(tx,job,cost);
  const [updated]=await tx.update(aiJobs).set({...values,updatedAt:new Date()}).where(eq(aiJobs.id,id)).returning();
  return jobDto(updated);
}

// A helper for controlled media authorization: only current immutable publications grant public visibility.
export async function isAssetPublic(id:string):Promise<boolean> {
  const src=`/media/${id}`;
  const [row]=await getDb().execute(sql`SELECT 1 FROM editorial_recipe r JOIN editorial_publication p ON p.id=r.published_id WHERE r.deleted_at IS NULL AND r.publication_status='published' AND (p.snapshot->'recipe'->>'image'=${src} OR EXISTS(SELECT 1 FROM jsonb_each(p.snapshot->'photos'->'ingredients') x WHERE x.value->>'src'=${src}) OR EXISTS(SELECT 1 FROM jsonb_each(p.snapshot->'photos'->'steps') x WHERE x.value->>'src'=${src})) LIMIT 1`).then(result=>result.rows);
  return Boolean(row);
}

/** Worker-only all-or-nothing application: sibling photographs share one base revision. */
export async function applyTrendJobsInTransaction(tx: Transaction, runId:string, jobIds:string[], expectedRevision:number, generation?: number):Promise<EditorialRecord> {
  const run=await requireTrendScope(tx,runId);if(!run.recipeId)throw new AiError(409,'TREND_SCOPE_BLOCKED','Brak szkicu.');
  if (generation !== undefined && run.generation !== generation) throw new AiError(409, 'TREND_SUPERSEDED', 'To przygotowanie zastąpiło nowe uruchomienie.');
  const [current]=await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id,run.recipeId)).for('update');
  if(current?.deletedAt)throw new AiError(409,'RECIPE_DELETED','Najpierw przywróć przepis z kosza.');
  if(!current||current.revision!==expectedRevision||run.expectedRevision!==expectedRevision)throw new EditorialError(409,'REVISION_CONFLICT','Ręczna edycja wstrzymała zastosowanie wyników.');
  const jobs:JobRow[]=[];for(const id of [...new Set(jobIds)].sort()){const job=await lockedJob(tx,id);if((job.trendRunId!==runId && !(generation !== undefined && job.trendRunId === null && job.kind !== 'recipe'))||job.recipeId!==run.recipeId||!['ready','applied'].includes(job.status)||!job.result)throw new AiError(409,'TREND_RESULT_NOT_READY','Pakiet nie jest kompletny lub należy do innej wersji.');jobs.push(job);}
  if(!jobs.length)throw new AiError(422,'EMPTY_BATCH','Brak wyników.');
  if(generation === undefined && jobs.every(job=>job.status==='applied')){if(jobs.some(job=>job.appliedRevision!==current.revision))throw new EditorialError(409,'REVISION_CONFLICT','Szkic zmienił się po zastosowaniu pakietu.');return getRecipeInTransaction(tx,run.recipeId);}
  if(jobs.some(job => job.kind === 'recipe' ? job.status !== 'ready' || job.baseRevision !== expectedRevision : generation === undefined ? job.status !== 'ready' || job.baseRevision !== expectedRevision : !samePhotoSubject(job.input, current.content, job.kind, job.targetId)))throw new AiError(409,'STALE_BATCH','Materiał dotyczy innej treści lub postaci składnika. Zachowano wynik.');let content=structuredClone(current.content);
  for(const job of jobs){if(job.kind==='recipe'){if(!job.result?.content||jobs.length!==1)throw new AiError(422,'INVALID_BATCH','Treść jest stosowana osobno.');content=preservedProposal(content,job.result.content,job.input,true);continue;}
    if(job.kind==='ingredient'&&job.result?.reusedPhoto){content.photos.ingredients[job.targetId!]=await checkedReusedIngredientPhoto(tx,job,content);continue;}
    const asset=job.result?.asset;if(!asset)throw new AiError(409,'MISSING_ASSET','Brak fotografii.');const [registered]=await tx.select().from(aiAssets).where(and(eq(aiAssets.id,asset.id),eq(aiAssets.jobId,job.id)));if(!registered)throw new AiError(409,'MISSING_ASSET','Niezarejestrowana fotografia.');
    if(job.kind==='hero'){content.recipe.image=asset.src;content.recipe.imageAlt=asset.alt;if(job.input.aiPhotography?.heroStyleProfile===heroPresentationProfile)content.recipe.heroPresentation=structuredClone(job.input.recipe.heroPresentation);}else{const target=job.targetId;if(!target||!(job.kind==='ingredient'?content.recipe.ingredients:content.recipe.steps).some(item=>item.id===target))throw new AiError(409,'TARGET_MISSING','Brak składnika lub kroku.');const tile={src:asset.src,columns:1,rows:1,index:0,alt:asset.alt,caption:asset.caption,aspectRatio:asset.width/asset.height};if(job.kind==='ingredient')content.photos.ingredients[target]=tile;else content.photos.steps[target]=tile;}}
  const recipe=await applyAiProposalInTransaction(tx,run.recipeId,expectedRevision,content,trendWorker,'Przygotowanie pakietu przepisu',runId);
  await tx.update(aiJobs).set({status:'applied',appliedRevision:recipe.revision,updatedAt:new Date()}).where(inArray(aiJobs.id,jobs.map(job=>job.id)));
  await tx.update(trendRuns).set({expectedRevision:recipe.revision,updatedAt:new Date()}).where(eq(trendRuns.id,runId));return recipe;
}

/** Rejection proves a queued child was never claimed or sent; charged requests remain untouched. */
export async function cancelUnsubmittedTrendJobsInTransaction(tx: Transaction, runId:string):Promise<void> {
  const queued=await tx.select().from(aiJobs).where(and(eq(aiJobs.trendRunId,runId),eq(aiJobs.status,'queued'),isNull(aiJobs.providerRequestId))).orderBy(aiJobs.id).for('update');
  for(const job of queued){
    const values=await settle(tx,job,{chargedUsd:'0',costBasis:'usage'},'cancelled');
    await tx.update(aiJobs).set({...values,status:'cancelled',providerFinishedAt:new Date(),ingredientResolvedAt:new Date(),updatedAt:new Date()}).where(and(eq(aiJobs.id,job.id),eq(aiJobs.status,'queued')));
  }
}
