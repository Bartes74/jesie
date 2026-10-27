import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import Decimal from 'decimal.js';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { AiPhotoBatch, AiPhotoKind, CreateAiPhotoBatch, ApplyAiPhotoBatchResult } from '@/lib/ai-photo-batch-types';
import { ingredientCutoutRecoveryBrief } from '@/lib/ai-types';
import type { EditorialActor, EditorialContent } from '@/lib/editorial-types';
import { heroPresentationIssue, heroPresentationProfile, resolveHeroPresentation, resolveHeroPresentationForBrief } from '@/lib/hero-presentation';
import { getDb } from '@/server/db';
import { editorialRecipes } from '@/server/db/schema';
import { getRecipeInTransaction } from '@/server/editorial/store';
import { requireRecipeContentApproval } from '@/server/editorial/content-approval';
import { aiSettings } from './config';
import { AiError } from './errors';
import { aiAssets, aiJobs, aiPhotoBatches, ingredientImages, type StoredPhotoBatchSlot } from './schema';
import { applyPhotoBatchJobsInTransaction, budgetLock, createJobAdmission, jobDto, resumeJob, trustedActor, type AiTransaction } from './store';
import { findIngredientProducer, findReusableIngredient, prepareLegacyIngredient } from './ingredient-reuse';
import { capturedIngredientStyleProfile, ingredientImageIdentity, ingredientStyleProfile, whiteIngredientStyleProfile, currentIngredientStyleProfile, paperIngredientStyleProfile, isOpaqueStudioIngredientProfile } from './ingredient-profile';
import { samePhotoSubject } from './photo-subject';
import { approvedImageModel, canRestoreHeroContents, heroCutoutModel, isRecoverablePhotoSource } from './image-actions';
import { preflightPhotoPrompts } from './photo-preflight';
import { isReviewedWrongStepPhoto } from '@/lib/recipe-photo-evidence';
import { isStepPhotoRequired, sameStepPhotoSelection } from '@/lib/step-photo-selection';

type BatchRow = typeof aiPhotoBatches.$inferSelect;
type JobRow = typeof aiJobs.$inferSelect;
const maximumPhotos = 201;
export const photoBatchDispatchGraceMs = 2 * 60 * 1000;

export function photoBatchSlotHasPhoto(content: EditorialContent, kind: AiPhotoKind, targetId: string | null) {
  return kind === 'hero' ? Boolean(content.recipe.image.trim()) : Boolean(content.photos[kind === 'ingredient' ? 'ingredients' : 'steps'][targetId ?? '']?.src);
}

function missingSlots(content: EditorialContent): StoredPhotoBatchSlot[] {
  return [
    ...content.recipe.ingredients.map(item => ({ kind: 'ingredient' as const, targetId: item.id, label: item.name.pl, jobId: null })),
    ...content.recipe.steps.flatMap((item, index) => isStepPhotoRequired(content, item.id) ? [{ kind: 'step' as const, targetId: item.id, label: `${index + 1}. ${item.title.pl}`, jobId: null }] : []),
    { kind: 'hero' as const, targetId: null, label: 'Zdjęcie gotowej potrawy', jobId: null },
  ].filter(slot => !photoBatchSlotHasPhoto(content, slot.kind, slot.targetId));
}

function snapshotHash(content: EditorialContent, slots?: StoredPhotoBatchSlot[]) {
  const { title, description, baseServings, ingredients, steps, storage } = content.recipe;
  return createHash('sha256').update(JSON.stringify({ title, description, baseServings, ingredients, steps, storage, heroPresentation: resolveHeroPresentation(content.recipe),
    photography: content.aiPhotography, replacements: slots?.filter(slot => 'replacePhoto' in slot).map(slot => ({targetId:slot.targetId,photo:slot.replacePhoto})), stepPhotoSelection: content.photos.omittedSteps })).digest('hex');
}

function usableResult(job: JobRow) { return Boolean(['ready', 'applied'].includes(job.status) && (job.result?.asset || job.result?.reusedPhoto)); }
function definiteFailure(job: JobRow) { return job.status === 'failed' || job.status === 'cancelled' && Boolean(job.providerFinishedAt); }
function retryablePreSubmission(job: JobRow) {
  return job.status === 'failed' && job.provider === 'fal' && job.kind !== 'recipe' && [approvedImageModel, heroCutoutModel].includes(job.model)
    && Boolean(job.providerFinishedAt) && !job.providerRequestId && !job.reuseSourceJobId && !job.result && job.appliedRevision === null
    && job.costBasis === 'usage' && job.chargedUsd !== null && new Decimal(job.chargedUsd).isZero()
    && ['AI_STORAGE_CAPACITY', 'AI_STORAGE_UNAVAILABLE', 'AI_REFERENCE_UNAVAILABLE'].includes(job.errorCode ?? '');
}
function unconfirmedAcceptance(job: JobRow) {
  return !job.result && !job.providerRequestId && !job.reuseSourceJobId
    && (['submitting', 'uncertain'].includes(job.status) || job.status === 'cancelled' && !job.providerFinishedAt);
}
function needsCutout(row: Pick<BatchRow, 'input' | 'recipeId'>, slot: StoredPhotoBatchSlot, job: JobRow) {
  if(slot.kind==='ingredient'&&isOpaqueStudioIngredientProfile(capturedIngredientStyleProfile(row.input)))return false;
  const ingredient = slot.kind === 'ingredient' ? row.input.recipe.ingredients.find(item => item.id === slot.targetId) : undefined;
  return !slot.recoverySourceJobId && slot.kind !== 'step' && isRecoverablePhotoSource(job, row.recipeId, slot.kind as 'hero' | 'ingredient', slot.targetId, ingredient);
}
/** Configuration follows outstanding provider work, independently of historical money fields. */
async function requiresPhotoProvider(tx: AiTransaction, packet: Pick<BatchRow, 'input' | 'recipeId'>, slots: readonly StoredPhotoBatchSlot[], jobs: readonly JobRow[]) {
  for (const slot of slots) {
    const job = jobs.find(item => item.id === slot.jobId);
    if (job) {
      if (retryablePreSubmission(job) || needsCutout(packet, slot, job)
        || job.status === 'queued' && !job.providerRequestId && !job.reuseSourceJobId && !job.result) return true;
      continue;
    }
    if (slot.recoverySourceJobId || slot.kind !== 'ingredient') return true;
    const ingredient = packet.input.recipe.ingredients.find(item => item.id === slot.targetId)!;
    const profile = capturedIngredientStyleProfile(packet.input);
    if (!await findReusableIngredient(tx, ingredient, profile) && !await findIngredientProducer(tx, ingredientImageIdentity(ingredient, profile).key)) return true;
  }
  return false;
}
function unfinishedSlot(row: BatchRow, slot: StoredPhotoBatchSlot, job: JobRow | undefined) {
  return !job || !usableResult(job) && (!definiteFailure(job) || needsCutout(row, slot, job));
}
function existingSlotJob(jobs: JobRow[], content: EditorialContent, slot: StoredPhotoBatchSlot) {
  const candidates = jobs.filter(job => job.kind === slot.kind && job.targetId === slot.targetId && samePhotoSubject(job.input, content, slot.kind, slot.targetId)
    && (slot.kind!=='step'||!job.result?.asset||!isReviewedWrongStepPhoto({src:job.result.asset.src,columns:1,rows:1,index:0}))
    && (slot.kind!=='hero'||job.input.aiPhotography?.heroStyleProfile===content.aiPhotography?.heroStyleProfile)
    && (slot.kind!=='ingredient'||capturedIngredientStyleProfile(job.input)===capturedIngredientStyleProfile(content)));
  return candidates.find(usableResult) ?? candidates.find(job => !job.providerFinishedAt && ['queued', 'submitting', 'generating', 'uncertain', 'cancelled'].includes(job.status));
}

async function lockedBatch(tx: AiTransaction, id: string) {
  const [row] = await tx.select().from(aiPhotoBatches).where(eq(aiPhotoBatches.id, id)).for('update');
  if (!row) throw new AiError(404, 'PHOTO_BATCH_NOT_FOUND', 'Nie znaleziono pakietu zdjęć.');
  return row;
}

async function dto(row: BatchRow, recipeDeleted?: boolean): Promise<AiPhotoBatch> {
  const ids = row.slots.flatMap(slot => slot.jobId ? [slot.jobId] : []);
  const jobs = ids.length ? await getDb().select().from(aiJobs).where(inArray(aiJobs.id, ids)) : [];
  if (recipeDeleted === undefined) {
    const [recipe] = await getDb().select({ deletedAt: editorialRecipes.deletedAt }).from(editorialRecipes).where(eq(editorialRecipes.id, row.recipeId));
    recipeDeleted = !recipe || Boolean(recipe.deletedAt);
  }
  const slots = row.slots.map(slot => {
    const job = jobs.find(item => item.id === slot.jobId);
    return { kind: slot.kind, targetId: slot.targetId, label: slot.label, status: job?.status ?? 'pending' as const, job: job ? jobDto(job) : null };
  });
  const completed = slots.filter(slot => slot.job && ['ready', 'applied'].includes(slot.job.status) && (slot.job.result?.asset || slot.job.result?.reusedPhoto)).length;
  const failed = row.slots.filter(slot => { const job = jobs.find(item => item.id === slot.jobId); return job && definiteFailure(job); }).length;
  const unfinished = row.slots.some(slot => unfinishedSlot(row, slot, jobs.find(job => job.id === slot.jobId)));
  const retryable = jobs.some(retryablePreSubmission);
  const restorable = jobs.some(canRestoreHeroContents);
  return { id: row.id, mode: row.input.aiPhotography?.photoBatchMode??'missing', recipeId: row.recipeId, recipeTitle: row.input.recipe.title.pl, baseRevision: row.baseRevision, sourceJobId: row.sourceJobId,
    status: row.status, generation: row.generation, slots, progress: { completed, failed, total: slots.length },
    canResume: !recipeDeleted && (row.status === 'blocked' || ['queued', 'generating', 'failed'].includes(row.status) && (unfinished || retryable || restorable)),
    canApply: !recipeDeleted && !retryable && (row.status === 'ready' || row.status === 'failed' && row.errorCode === 'PHOTO_BATCH_PARTIAL' && !unfinished && completed > 0),
    reservedUsd: row.reservedUsd, remainingReservedUsd: row.remainingReservedUsd, errorCode: row.errorCode, errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), appliedRevision: row.appliedRevision };
}

export async function getPhotoBatch(id: string): Promise<AiPhotoBatch> {
  const [row] = await getDb().select().from(aiPhotoBatches).where(eq(aiPhotoBatches.id, id));
  if (!row) throw new AiError(404, 'PHOTO_BATCH_NOT_FOUND', 'Nie znaleziono pakietu zdjęć.');
  return dto(row);
}

/** Server-only worker identity for an authoritative Workflow engine check. */
export async function getPhotoBatchRecoveryState(id: string) {
  const [row] = await getDb().select({ generation: aiPhotoBatches.generation, status: aiPhotoBatches.status, workflowRunId: aiPhotoBatches.workflowRunId, updatedAt: aiPhotoBatches.updatedAt })
    .from(aiPhotoBatches).where(eq(aiPhotoBatches.id, id));
  if (!row) throw new AiError(404, 'PHOTO_BATCH_NOT_FOUND', 'Nie znaleziono pakietu zdjęć.');
  return { ...row, updatedAt: row.updatedAt.toISOString() };
}

/** Attach the engine receipt before its first worker step, without reclaiming it. */
export async function recordPhotoBatchWorkflowDispatch(id: string, generation: number, runId: string): Promise<boolean> {
  if (!runId || runId.length > 500) throw new AiError(422, 'INVALID_WORKFLOW_ID', 'Nieprawidłowy identyfikator przygotowania zdjęć.');
  return getDb().transaction(async tx => {
    await budgetLock(tx); const row = await lockedBatch(tx, id);
    if (row.generation !== generation || !['queued', 'generating'].includes(row.status) || row.workflowRunId && row.workflowRunId !== runId) return false;
    await tx.update(aiPhotoBatches).set({ workflowRunId: runId, updatedAt: new Date() }).where(eq(aiPhotoBatches.id, id));
    return true;
  });
}

export async function listPhotoBatches(recipeId: string, sourceJobId?: string): Promise<AiPhotoBatch[]> {
  const rows = await getDb().select().from(aiPhotoBatches).where(eq(aiPhotoBatches.recipeId, recipeId)).orderBy(desc(aiPhotoBatches.createdAt)).limit(20);
  const [recipe] = await getDb().select({ deletedAt: editorialRecipes.deletedAt }).from(editorialRecipes).where(eq(editorialRecipes.id, recipeId));
  const recipeDeleted = !recipe || Boolean(recipe.deletedAt);
  if (!sourceJobId) return Promise.all(rows.map(row => dto(row, recipeDeleted)));
  const [source] = await getDb().select().from(aiJobs).where(eq(aiJobs.id, sourceJobId));
  if (!source || source.recipeId !== recipeId || source.kind !== 'recipe' || !source.result?.content) return [];
  return Promise.all(rows.filter(row => samePhotoSubject(row.input, source.result!.content!, 'hero', null)).map(row => dto(row, recipeDeleted)));
}

export async function createPhotoBatch(input: CreateAiPhotoBatch, actor: EditorialActor, options: {ingredientStyleProfile?:string} = {}): Promise<{ batch: AiPhotoBatch; created: boolean; generation: number }> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.recipeId) || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1 || !/^[A-Za-z0-9_-]{16,100}$/.test(input.requestKey)) throw new AiError(422, 'INVALID_INPUT', 'Wybierz zapisany szkic i poprawny identyfikator żądania.');
  const mode=input.mode??'missing'; const profile=mode==='ingredients-white'?whiteIngredientStyleProfile:mode==='ingredients-paper'?paperIngredientStyleProfile:options.ingredientStyleProfile===ingredientStyleProfile?ingredientStyleProfile:options.ingredientStyleProfile===whiteIngredientStyleProfile?whiteIngredientStyleProfile:currentIngredientStyleProfile;
  if(!['missing','ingredients-white','ingredients-paper'].includes(mode)||input.ingredientIds&& (mode==='missing'||!input.ingredientIds.length||input.ingredientIds.length>100||new Set(input.ingredientIds).size!==input.ingredientIds.length))throw new AiError(422,'INVALID_INPUT','Wybierz poprawny pakiet i składniki.');
  // Before admission, physically verify any legacy library candidate. Failed
  // retrieval never silently turns an existing photograph into a paid request.
  const snapshot = await getDb().transaction(async tx => {
    await trustedActor(tx, actor.id);
    const [row] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, input.recipeId));
    if (!row) throw new AiError(404, 'RECIPE_NOT_FOUND', 'Nie znaleziono przepisu.');
    if (row.deletedAt) throw new AiError(409, 'RECIPE_DELETED', 'Najpierw przywróć przepis z kosza.');
    return row;
  });
  for (const ingredient of snapshot.content.recipe.ingredients.filter(item => !photoBatchSlotHasPhoto(snapshot.content, 'ingredient', item.id))) {
    if (!await findReusableIngredient(getDb(), ingredient,profile)) await prepareLegacyIngredient(ingredient,profile);
  }
  const admission = await getDb().transaction(async tx => {
    await budgetLock(tx);
    const account = await trustedActor(tx, actor.id);
    const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, input.recipeId)).for('share');
    if (recipe?.deletedAt) throw new AiError(409, 'RECIPE_DELETED', 'Najpierw przywróć przepis z kosza.');
    const [existing] = await tx.select().from(aiPhotoBatches).where(and(eq(aiPhotoBatches.createdBy, account.id), eq(aiPhotoBatches.requestKey, input.requestKey)));
    if (existing) {
      if (existing.recipeId !== input.recipeId || existing.baseRevision !== input.expectedRevision || existing.sourceJobId !== (input.sourceJobId ?? null)|| (existing.input.aiPhotography?.photoBatchMode??'missing')!==mode
        ||input.ingredientIds&&JSON.stringify(existing.slots.filter(slot=>slot.kind==='ingredient').map(slot=>slot.targetId).sort())!==JSON.stringify([...input.ingredientIds].sort())) throw new AiError(409, 'REQUEST_KEY_REUSED', 'Ten identyfikator został użyty dla innego pakietu.');
      return { row: existing, created: false };
    }
    if (!recipe || recipe.revision !== input.expectedRevision) throw new AiError(409, 'REVISION_CONFLICT', 'Zapisz i odśwież bieżącą wersję szkicu przed generowaniem zdjęć.');
    if (recipe.editorialStatus === 'archived') throw new AiError(409, 'ARCHIVED', 'Najpierw przywróć przepis z archiwum.');
    await requireRecipeContentApproval(tx, recipe);
    if (!recipe.content.recipe.ingredients.length || mode==='missing'&&!recipe.content.recipe.steps.length) throw new AiError(422, 'RECIPE_STRUCTURE_REQUIRED', 'Najpierw sprawdź i zapisz szkic ze składnikami oraz krokami przygotowania.');
    if (Buffer.byteLength(JSON.stringify(recipe.content), 'utf8') > aiSettings().maxInputBytes) throw new AiError(422, 'INPUT_TOO_LARGE', 'Treść przepisu jest zbyt duża do generowania zdjęć.');
    if (input.sourceJobId) {
      const [source] = await tx.select().from(aiJobs).where(eq(aiJobs.id, input.sourceJobId));
      if (!source || source.recipeId !== recipe.id || source.kind !== 'recipe' || source.status !== 'applied' || !source.result?.content || !samePhotoSubject(source.result.content, recipe.content, 'hero', null)) throw new AiError(409, 'RECIPE_DRAFT_NOT_SAVED', 'Najpierw sprawdź i zapisz wskazany szkic w przepisie.');
    }
    const captured=structuredClone(recipe.content);captured.aiPhotography={ingredientStyleProfile:profile,heroStyleProfile:heroPresentationProfile,...(mode!=='missing'?{photoBatchMode:mode}:{})};
    if(mode==='missing'&&!captured.recipe.image.trim()){
      const presentation=resolveHeroPresentation(captured.recipe);
      const photographyPresentation=resolveHeroPresentationForBrief(captured.recipe,'');
      const issue=heroPresentationIssue(captured.recipe,presentation);
      if(issue||!presentation)throw new AiError(422,'HERO_PRESENTATION_REQUIRED',issue??'Uzupełnij ustawienia zdjęcia głównego.');
      captured.recipe.heroPresentation=structuredClone(presentation);
      // Freeze new photography direction beside the unchanged approved subject.
      // Preflight and the later hero admission must use this same package capture.
      if(photographyPresentation&&!isDeepStrictEqual(photographyPresentation,presentation))captured.aiPhotography.heroPresentationOverride=structuredClone(photographyPresentation);
    }
    const jobs = await tx.select().from(aiJobs).where(and(eq(aiJobs.recipeId, recipe.id), isNull(aiJobs.trendRunId))).orderBy(desc(aiJobs.createdAt));
    let slots:StoredPhotoBatchSlot[];
    if(mode!=='missing'){
      const targets=captured.recipe.ingredients.filter(item=>!input.ingredientIds||input.ingredientIds.includes(item.id));
      if(input.ingredientIds&&targets.length!==input.ingredientIds.length)throw new AiError(422,'TARGET_MISSING','Nie znaleziono wskazanego składnika.');
      const carry=missingSlots(captured).filter(slot=>slot.kind!=='ingredient').flatMap(slot=>{const job=existingSlotJob(jobs,captured,slot);return job&&usableResult(job)?[{...slot,jobId:job.id}]:[];});
      slots=[...targets.map(item=>({kind:'ingredient' as const,targetId:item.id,label:item.name.pl,jobId:null,replacePhoto:structuredClone(captured.photos.ingredients[item.id]??null)})),...carry];
    }else slots=missingSlots(captured);
    const inputHash = snapshotHash(captured,slots);
    const [duplicate] = await tx.select().from(aiPhotoBatches).where(and(eq(aiPhotoBatches.recipeId, recipe.id), eq(aiPhotoBatches.inputHash, inputHash), inArray(aiPhotoBatches.status, ['queued', 'generating', 'ready', 'blocked']))).orderBy(desc(aiPhotoBatches.createdAt)).limit(1);
    if (duplicate) return { row: duplicate, created: false };
    if(mode==='missing'){
      const active=await tx.select().from(aiPhotoBatches).where(and(eq(aiPhotoBatches.recipeId,recipe.id),inArray(aiPhotoBatches.status,['queued','generating','ready','blocked']))).orderBy(desc(aiPhotoBatches.createdAt));
      const compatible=active.find(row=>(row.input.aiPhotography?.photoBatchMode??'missing')==='missing'&&row.input.aiPhotography?.heroStyleProfile===captured.aiPhotography?.heroStyleProfile&&samePhotoSubject(row.input,captured,'hero',null)&&sameStepPhotoSelection(row.input,captured));
      if(compatible)return {row:compatible,created:false};
    }
    if(jobs.some(job=>job.kind==='ingredient'&&slots.some(slot=>slot.kind==='ingredient'&&slot.targetId===job.targetId)&&capturedIngredientStyleProfile(job.input)!==profile&&!job.providerFinishedAt&&['queued','submitting','generating','uncertain','cancelled'].includes(job.status)))throw new AiError(409,'INGREDIENT_JOB_UNCONFIRMED','Istniejące zlecenie składnika wymaga zakończenia lub potwierdzenia. Nie wysłano dodatkowej generacji.');
    if (slots.length > maximumPhotos) throw new AiError(422, 'PHOTO_BATCH_TOO_LARGE', `Pakiet może zawierać maksymalnie ${maximumPhotos} brakujących zdjęć.`);
    for (const slot of slots) {
      const existingJob = existingSlotJob(jobs, captured, slot);
      if (existingJob) { slot.jobId = existingJob.id; continue; }
      const ingredient = slot.kind === 'ingredient' ? recipe.content.recipe.ingredients.find(item => item.id === slot.targetId)! : undefined;
      const repair = slot.kind !== 'step'&&!(slot.kind==='ingredient'&&isOpaqueStudioIngredientProfile(profile)) ? jobs.find(job => samePhotoSubject(job.input, recipe.content, slot.kind, slot.targetId)
        && (slot.kind!=='hero'||job.input.aiPhotography?.heroStyleProfile===captured.aiPhotography?.heroStyleProfile)
        && isRecoverablePhotoSource(job, recipe.id, slot.kind as 'hero' | 'ingredient', slot.targetId, ingredient)) : undefined;
      if (repair) slot.recoverySourceJobId = repair.id;
    }
    preflightBatchPhotos(captured, slots.filter(slot => !slot.jobId && !slot.recoverySourceJobId));
    const settings = aiSettings();
    if ((!settings.fal || !settings.storage) && await requiresPhotoProvider(tx, { input: captured, recipeId: recipe.id }, slots, jobs))
      throw new AiError(503, 'PROVIDER_NOT_CONFIGURED', 'Tworzenie fotografii wymaga podłączenia usługi zdjęć i magazynu plików.');
    const [row] = await tx.insert(aiPhotoBatches).values({ id: randomUUID(), recipeId: recipe.id, baseRevision: recipe.revision, sourceJobId: input.sourceJobId ?? null,
      input: captured, inputHash, slots, status: slots.every(slot => slot.jobId && usableResult(jobs.find(job => job.id === slot.jobId)!)) ? 'ready' : 'queued',
      requestKey: input.requestKey, createdBy: account.id, createdByName: account.name, reservedUsd: '0', remainingReservedUsd: '0', createdAt: new Date() }).returning();
    return { row, created: true };
  });
  return { batch: await dto(admission.row), created: admission.created, generation: admission.row.generation };
}

export async function claimPhotoBatchWorkflow(id: string, generation: number, runId: string): Promise<boolean> {
  return getDb().transaction(async tx => {
    await budgetLock(tx);
    const row = await lockedBatch(tx, id);
    const [recipe] = await tx.select({ deletedAt: editorialRecipes.deletedAt }).from(editorialRecipes).where(eq(editorialRecipes.id, row.recipeId));
    if (!recipe || recipe.deletedAt) return false;
    if (row.generation !== generation || !['queued', 'generating'].includes(row.status) || row.workflowRunId && row.workflowRunId !== runId) return false;
    await tx.update(aiPhotoBatches).set({ workflowRunId: runId, status: 'generating', updatedAt: new Date() }).where(eq(aiPhotoBatches.id, id));
    return true;
  });
}

export async function stopPhotoBatch(id: string, generation: number, code: string, message: string, failed = false): Promise<AiPhotoBatch> {
  await getDb().transaction(async tx => {
    await budgetLock(tx); const row = await lockedBatch(tx, id);
    if (row.generation !== generation || ['ready', 'applied'].includes(row.status)) return;
    await tx.update(aiPhotoBatches).set({ status: failed ? 'failed' : 'blocked', ...(failed ? { remainingReservedUsd: '0' } : {}), errorCode: code.slice(0, 100), errorMessage: message.slice(0, 2000), updatedAt: new Date() }).where(eq(aiPhotoBatches.id, id));
  });
  return getPhotoBatch(id);
}

/** A failed dispatch response cannot pause an already attached worker. */
export async function stopPhotoBatchDispatchUnconfirmed(id: string, generation: number, message: string): Promise<AiPhotoBatch> {
  const row = await getDb().transaction(async tx => {
    await budgetLock(tx); const packet = await lockedBatch(tx, id);
    if (packet.generation !== generation || !['queued', 'generating'].includes(packet.status) || packet.workflowRunId !== null) return packet;
    const [paused] = await tx.update(aiPhotoBatches).set({ status: 'blocked', errorCode: 'PHOTO_BATCH_DISPATCH_UNCONFIRMED', errorMessage: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(aiPhotoBatches.id, id)).returning();
    return paused;
  });
  return dto(row);
}

export type PhotoBatchWorkflowEvidence = {
  generation: number;
  runId: string | null;
  status: 'completed' | 'failed' | 'cancelled' | 'missing';
};

function retryRequestKey(jobId: string) { return `photo_batch_retry_${jobId}`; }
function reviewedWineReplacement(packet: BatchRow, slot: StoredPhotoBatchSlot) {
  return slot.kind === 'ingredient' && slot.targetId === 'white_wine' && Boolean(slot.recoverySourceJobId) && isOpaqueStudioIngredientProfile(capturedIngredientStyleProfile(packet.input));
}
function hydratedSlots(packet: BatchRow, jobs: JobRow[]) {
  return packet.slots.map((slot, index) => {
    const original = jobs.find(job => job.id === slot.jobId) ?? (reviewedWineReplacement(packet, slot) ? undefined : jobs.find(job => job.requestKey === slotRequestKey(packet.id, index)));
    const sourceId = slot.recoverySourceJobId ?? (original && needsCutout(packet, slot, original) ? original.id : undefined);
    const correction = sourceId ? jobs.find(job => job.requestKey === slotRequestKey(packet.id, index, sourceId)) : undefined;
    let selected = correction ?? original;
    // A prior admission can have committed just before its slot link failed.
    // Follow that immutable attempt key before reserving or admitting a retry.
    for (let attempt = 0; selected && attempt < jobs.length; attempt++) {
      const next = jobs.find(job => job.requestKey === retryRequestKey(selected!.id));
      if (!next) break;
      selected = next;
    }
    return { ...slot, jobId: selected?.id ?? slot.jobId, ...(sourceId && correction ? { recoverySourceJobId: sourceId } : {}) };
  });
}

export async function resumePhotoBatch(id: string, actor: EditorialActor, workflowEvidence?: PhotoBatchWorkflowEvidence): Promise<{ batch: AiPhotoBatch; generation: number; dispatch: boolean }> {
  const resumed = await getDb().transaction(async tx => {
    await budgetLock(tx); await trustedActor(tx, actor.id); const packet = await lockedBatch(tx, id);
    const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, packet.recipeId));
    if (recipe?.deletedAt) throw new AiError(409, 'RECIPE_DELETED', 'Najpierw przywróć przepis z kosza.');
    if (['ready', 'applied'].includes(packet.status)) return { row: packet, dispatch: false };
    if (['queued', 'generating'].includes(packet.status)) {
      // A stalled-looking timestamp is not proof that its worker stopped.
      // Match the identity observed by the engine under the coordination lock so
      // simultaneous checks cannot restart a newly admitted generation twice.
      const terminalWorker = workflowEvidence && ['completed', 'failed', 'cancelled', 'missing'].includes(workflowEvidence.status)
        && workflowEvidence.generation === packet.generation && workflowEvidence.runId === packet.workflowRunId
        && (packet.workflowRunId !== null || workflowEvidence.status === 'missing' && Date.now() - packet.updatedAt.getTime() >= photoBatchDispatchGraceMs);
      if (!terminalWorker) return { row: packet, dispatch: false };
    }
    if (!recipe || recipe.editorialStatus === 'archived' || (!samePhotoSubject(packet.input, recipe.content, 'hero', null) || !sameStepPhotoSelection(packet.input, recipe.content))) throw new AiError(409, 'STALE_BATCH', 'Treść przepisu zmieniła się. Gotowe zdjęcia zachowano do porównania.');
    const attachedIds = packet.slots.flatMap(slot => slot.jobId ? [slot.jobId] : []);
    const attached = attachedIds.length ? await tx.select().from(aiJobs).where(inArray(aiJobs.id, attachedIds)) : [];
    const children = await tx.select().from(aiJobs).where(eq(aiJobs.photoBatchId, id));
    const jobs = [...attached, ...children.filter(child => !attached.some(job => job.id === child.id))];
    const slots = hydratedSlots(packet, jobs);
    const retries = slots.flatMap((slot, index) => {
      const job = jobs.find(item => item.id === slot.jobId);
      return job && retryablePreSubmission(job) && samePhotoSubject(job.input, recipe.content, slot.kind, slot.targetId) ? [{ index, job }] : [];
    });
    if (retries.length && jobs.some(unconfirmedAcceptance)) throw new AiError(409, 'SUBMISSION_UNCERTAIN', 'Nie potwierdzono przyjęcia innego zdjęcia w tym pakiecie. Zachowano jego zlecenie; nie przygotowano nowej płatnej próby.');
    if (packet.status === 'failed') {
      const active = await tx.select({ id: aiPhotoBatches.id }).from(aiPhotoBatches).where(and(eq(aiPhotoBatches.recipeId, packet.recipeId), eq(aiPhotoBatches.inputHash, packet.inputHash), inArray(aiPhotoBatches.status, ['queued', 'generating', 'ready', 'blocked'])));
      if (active.some(item => item.id !== id)) throw new AiError(409, 'PHOTO_BATCH_ALREADY_ACTIVE', 'Ten przepis ma już aktywny pakiet. Kontynuuj istniejący pakiet zdjęć.');
      const captured = { ...packet, slots };
      if (!retries.length && !slots.some(slot => unfinishedSlot(captured, slot, jobs.find(job => job.id === slot.jobId)))) {
        const complete = slots.every(slot => { const job = jobs.find(item => item.id === slot.jobId); return job && usableResult(job); });
        const [settled] = await tx.update(aiPhotoBatches).set({ slots, status: complete ? 'ready' : 'failed', remainingReservedUsd: '0', errorCode: complete ? null : 'PHOTO_BATCH_PARTIAL', errorMessage: complete ? null : 'Pakiet zakończył się z błędami. Gotowe zdjęcia możesz sprawdzić i zapisać w szkicu.', updatedAt: new Date() }).where(eq(aiPhotoBatches.id, id)).returning();
        return { row: settled, dispatch: false };
      }
    }
    const settings = aiSettings();
    if ((!settings.fal || !settings.storage) && await requiresPhotoProvider(tx, packet, slots, jobs))
      throw new AiError(503, 'PROVIDER_NOT_CONFIGURED', 'Tworzenie fotografii wymaga podłączenia usługi zdjęć i magazynu plików.');
    const [updated] = await tx.update(aiPhotoBatches).set({ slots, remainingReservedUsd: '0', generation: packet.generation + 1, workflowRunId: null, status: 'queued', errorCode: null, errorMessage: null, updatedAt: new Date() }).where(eq(aiPhotoBatches.id, id)).returning();
    return { row: updated, dispatch: true, retries: retries.map(retry => ({ index: retry.index, failedJobId: retry.job.id })), revision: recipe.revision };
  });
  if ('retries' in resumed && resumed.retries?.length) {
    try {
      for (const retry of resumed.retries) {
        const slot = resumed.row.slots[retry.index];
        await admitSlot(resumed.row, retry.index, resumed.revision!, slot.recoverySourceJobId, retryRequestKey(retry.failedJobId));
      }
    } catch (error) {
      const code = error instanceof AiError ? error.code : 'PHOTO_BATCH_RETRY_ADMISSION_UNCONFIRMED';
      const message = error instanceof AiError ? error.message : 'Nie potwierdzono przygotowania kontynuacji. Zachowano wcześniejsze zlecenia; ponownie sprawdź pakiet.';
      return { batch: await stopPhotoBatch(id, resumed.row.generation, code, message), generation: resumed.row.generation, dispatch: false };
    }
  }
  return { batch: await getPhotoBatch(id), generation: resumed.row.generation, dispatch: resumed.dispatch };
}

export type PhotoBatchChildOperation = { state: 'job'; jobId: string; status: JobRow['status']; submit: boolean; kind: AiPhotoKind; receipt: boolean };
export type PhotoBatchOperation = (PhotoBatchChildOperation | { state: 'done' } | { state: 'waiting' } | { state: 'blocked'; reason: string }) & { jobId?: string; reason?: string };
export type PhotoBatchWave = { state: 'jobs'; jobs: PhotoBatchChildOperation[]; blocked?: { code: string; message: string } } | { state: 'done' } | { state: 'waiting' } | { state: 'blocked'; reason: string };
const briefs: Record<AiPhotoKind, string> = {
  hero: 'Fotografia gotowej potrawy: premium cookbook editorial photography, natural daylight, warm ivory background, true ingredients and appetising natural texture.',
  ingredient: 'Fotografia pojedynczego składnika w postaci wymaganej przez przepis, spokojne światło dzienne i wspólny styl biblioteki składników.',
  step: 'Fotografia makro najważniejszego detalu tego kroku: prawidłowa konsystencja, stopień obróbki lub technika. Spójny styl światła i naczyń w całym przepisie.',
};

function preflightBatchPhotos(content: EditorialContent, slots: readonly (Pick<StoredPhotoBatchSlot, 'kind' | 'targetId'> & { brief?: string })[], override?: { kind: AiPhotoKind; targetId: string | null; brief: string }) {
  if (!slots.length) return;
  preflightPhotoPrompts(content, slots.map(slot => ({ ...slot, withoutHeroReference: slot.kind !== 'hero',
    brief: override && override.kind === slot.kind && override.targetId === slot.targetId ? override.brief : slot.brief ?? briefs[slot.kind] })), aiSettings().maxInputBytes);
}

function unsubmittedPromptSlots(packet: BatchRow, jobs: JobRow[]) {
  return hydratedSlots(packet, jobs).flatMap(slot => {
    const job = jobs.find(item => item.id === slot.jobId);
    const fresh = job ? job.status === 'queued' && !job.providerRequestId && !job.reuseSourceJobId && !job.providerFinishedAt && job.model !== heroCutoutModel : !slot.recoverySourceJobId;
    return fresh ? [{ ...slot, ...(job ? { brief: job.brief } : {}) }] : [];
  });
}

export type ReviewedIngredientReplacement = { generation: number; expectedRevision: number; targetId: 'white_wine'; replacedJobId: string; reviewNote: string; requestKey: string };
/** A reviewed wrong subject gets one new immutable attempt inside its original settled ceiling. */
export async function replaceReviewedBatchIngredient(id: string, input: ReviewedIngredientReplacement, actor: EditorialActor): Promise<{ batch: AiPhotoBatch; generation: number; dispatch: boolean }> {
  if (!/^[a-f0-9-]{36}$/i.test(id) || !/^[a-f0-9-]{36}$/i.test(input.replacedJobId) || input.targetId !== 'white_wine'
    || !Number.isSafeInteger(input.generation) || input.generation < 1 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
    || !/^[A-Za-z0-9_-]{16,100}$/.test(input.requestKey)
    || !input.reviewNote.trim() || input.reviewNote.length > 1000) throw new AiError(422, 'INVALID_INPUT', 'Wskaż sprawdzone błędne zdjęcie białego wina i bieżący pakiet.');
  const result = await getDb().transaction(async tx => {
    await budgetLock(tx); const account = await trustedActor(tx, actor.id); const packet = await lockedBatch(tx, id);
    if (packet.createdBy !== account.id) throw new AiError(403, 'PHOTO_BATCH_SCOPE', 'Ten pakiet należy do innego redaktora.');
    const replay = packet.slots.find(slot => slot.kind === 'ingredient' && slot.targetId === input.targetId && slot.recoverySourceJobId === input.replacedJobId && reviewedWineReplacement(packet, slot));
    if (replay) {
      const index = packet.slots.indexOf(replay);
      const [attempt] = await tx.select().from(aiJobs).where(and(eq(aiJobs.photoBatchId, packet.id), eq(aiJobs.requestKey, slotRequestKey(packet.id, index, input.replacedJobId))));
      if (attempt && attempt.brief !== input.reviewNote.trim() || packet.generation < input.generation + 1) throw new AiError(409, 'REQUEST_KEY_REUSED', 'Ta poprawka została przygotowana z inną instrukcją.');
      return { row: packet, dispatch: false };
    }
    if (packet.status !== 'ready' || packet.appliedRevision !== null || packet.generation !== input.generation) throw new AiError(409, 'PHOTO_BATCH_CORRECTION_SCOPE', 'Poprawka wymaga zakończonego, jeszcze niezapisanego pakietu we wskazanej generacji.');
    const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, packet.recipeId)).for('share');
    if (!recipe || recipe.deletedAt || recipe.editorialStatus === 'archived' || recipe.revision !== input.expectedRevision || (!samePhotoSubject(packet.input, recipe.content, 'hero', null) || !sameStepPhotoSelection(packet.input, recipe.content))) throw new AiError(409, 'REVISION_CONFLICT', 'Treść lub stan przepisu zmieniły się.');
    const index = packet.slots.findIndex(slot => slot.kind === 'ingredient' && slot.targetId === input.targetId && slot.jobId === input.replacedJobId);
    const children = await tx.select().from(aiJobs).where(eq(aiJobs.photoBatchId, id));
    const current = packet.slots.map(slot => children.find(job => job.id === slot.jobId));
    const source = children.find(job => job.id === input.replacedJobId);
    const profile = capturedIngredientStyleProfile(packet.input); const settings = aiSettings();
    if (index < 0 || current.some(job => !job || !usableResult(job)) || children.some(unconfirmedAcceptance)
      || !source || source.kind !== 'ingredient' || source.targetId !== input.targetId || source.status !== 'ready' || !source.providerRequestId || !source.providerFinishedAt
      || !source.result?.asset || !isOpaqueStudioIngredientProfile(profile) || settings.imageModel !== approvedImageModel
      || !samePhotoSubject(source.input, recipe.content, 'ingredient', input.targetId)) throw new AiError(409, 'PHOTO_BATCH_CORRECTION_SCOPE', 'Nie potwierdzono zakończenia i tożsamości istniejących zdjęć.');
    const [sourceAsset] = await tx.select().from(aiAssets).where(and(eq(aiAssets.id, source.result!.asset!.id), eq(aiAssets.jobId, source.id)));
    if (!sourceAsset || sourceAsset.recipeId !== packet.recipeId || sourceAsset.kind !== 'ingredient' || sourceAsset.targetId !== input.targetId) throw new AiError(409, 'PHOTO_BATCH_CORRECTION_SCOPE', 'Błędne zdjęcie nie jest zarejestrowanym wynikiem tego składnika.');
    if (!settings.fal || !settings.storage) throw new AiError(503, 'PROVIDER_NOT_CONFIGURED', 'Tworzenie fotografii wymaga podłączonej usługi i magazynu.');
    // A reviewed wrong photograph must not be selected by the library again
    // during admission or its later atomic claim. Keep its asset and paid job.
    if (source.ingredientKey) await tx.update(ingredientImages).set({ eligibility: 'rejected' }).where(and(eq(ingredientImages.assetId, sourceAsset.id), eq(ingredientImages.key, source.ingredientKey)));
    const slots = structuredClone(packet.slots); slots[index] = { ...slots[index], jobId: null, recoverySourceJobId: input.replacedJobId };
    const [updated] = await tx.update(aiPhotoBatches).set({ slots, remainingReservedUsd: '0', generation: packet.generation + 1,
      workflowRunId: null, status: 'queued', errorCode: null, errorMessage: null, updatedAt: new Date() }).where(eq(aiPhotoBatches.id, id)).returning();
    return { row: updated, dispatch: true, index, revision: recipe.revision };
  });
  if (result.dispatch && 'index' in result) {
    try { await admitSlot(result.row, result.index!, result.revision!, input.replacedJobId, undefined, input.reviewNote.trim()); }
    catch (error) { const code = error instanceof AiError ? error.code : 'PHOTO_BATCH_REPLACEMENT_ADMISSION_UNCONFIRMED';
      return { batch: await stopPhotoBatch(id, result.row.generation, code, 'Zachowano poprzednie zdjęcie i identyfikator poprawki. Wznów ten sam pakiet, aby odczytać przygotowaną próbę.'), generation: result.row.generation, dispatch: false }; }
  }
  return { batch: await getPhotoBatch(id), generation: result.row.generation, dispatch: result.dispatch };
}
function slotRequestKey(id: string, index: number, recoverySourceJobId?: string) {
  return `photo_batch_${id}_${index}${recoverySourceJobId ? `_cutout_${recoverySourceJobId}` : ''}`;
}

async function admitSlot(packet: BatchRow, index: number, revision: number, recoverySourceJobId?: string, requestKey?: string, briefOverride?: string): Promise<JobRow | undefined> {
  const slot = packet.slots[index];
  const replacingWine = reviewedWineReplacement(packet, slot) && recoverySourceJobId === slot.recoverySourceJobId;
  if (replacingWine) {
    const [source] = await getDb().select().from(aiJobs).where(eq(aiJobs.id, recoverySourceJobId!));
    if (!source || source.photoBatchId !== packet.id || source.recipeId !== packet.recipeId || source.kind !== 'ingredient' || source.targetId !== 'white_wine'
      || source.model !== approvedImageModel || !['ready', 'applied'].includes(source.status) || !source.result?.asset || !source.providerRequestId || !source.providerFinishedAt
      || !samePhotoSubject(source.input, packet.input, 'ingredient', 'white_wine')) throw new AiError(409, 'PHOTO_BATCH_CORRECTION_SCOPE', 'Nie potwierdzono źródła sprawdzonej poprawki białego wina.');
    const [existing] = await getDb().select().from(aiJobs).where(and(eq(aiJobs.photoBatchId, packet.id), eq(aiJobs.requestKey, requestKey ?? slotRequestKey(packet.id, index, recoverySourceJobId))));
    briefOverride ??= existing?.brief ?? 'Popraw sprawdzone błędne zdjęcie: wytrawne białe wino jest klarownym, jasnosłomkowym płynem w małym kompletnym szklanym naczyniu. Bez płatków, proszku, suszonych składników ani octu.';
  }
  if (!recoverySourceJobId || replacingWine) {
    const jobs = await getDb().select().from(aiJobs).where(eq(aiJobs.photoBatchId, packet.id));
    const planned = unsubmittedPromptSlots(packet, jobs);
    if (replacingWine && !planned.some(item => item.kind === slot.kind && item.targetId === slot.targetId)) planned.push(slot);
    preflightBatchPhotos(packet.input, planned, briefOverride ? { kind: slot.kind, targetId: slot.targetId, brief: briefOverride } : undefined);
  }
  const admitted = await createJobAdmission({ recipeId: packet.recipeId, expectedRevision: revision, kind: slot.kind,
    ...(slot.targetId ? { targetId: slot.targetId } : {}),
    brief: replacingWine ? briefOverride! : recoverySourceJobId ? slot.kind === 'ingredient' ? ingredientCutoutRecoveryBrief : 'Wytnij tło już zakończonej fotografii, zachowując całe naczynie i potrawę. Bez ponownego generowania zdjęcia.' : briefs[slot.kind],
    requestKey: requestKey ?? slotRequestKey(packet.id, index, recoverySourceJobId),
    ...(recoverySourceJobId && !replacingWine ? { imageAction: 'cutout_result' as const, sourceJobId: recoverySourceJobId } : {}) },
    { id: packet.createdBy, name: packet.createdByName, email: '', role: 'admin' }, undefined, { photoBatchId: packet.id });
  await getDb().transaction(async tx => {
    const latest = await lockedBatch(tx, packet.id);
    if (latest.generation !== packet.generation) return;
    const slots = structuredClone(latest.slots); slots[index].jobId = admitted.job.id;
    if (recoverySourceJobId) slots[index].recoverySourceJobId = recoverySourceJobId;
    await tx.update(aiPhotoBatches).set({ slots, updatedAt: new Date() }).where(eq(aiPhotoBatches.id, packet.id));
  });
  const [job] = await getDb().select().from(aiJobs).where(eq(aiJobs.id, admitted.job.id));
  return job;
}

/** Paid submissions are admitted only from the server's captured package. */
export async function nextPhotoBatchOperation(id: string, generation: number, excludedJobIds: readonly string[] = []): Promise<PhotoBatchOperation> {
  const [packet] = await getDb().select().from(aiPhotoBatches).where(eq(aiPhotoBatches.id, id));
  if (!packet || packet.generation !== generation || packet.status !== 'generating') return { state: 'done' };
  const [recipe] = await getDb().select().from(editorialRecipes).where(eq(editorialRecipes.id, packet.recipeId));
  if (!recipe || recipe.deletedAt || recipe.editorialStatus === 'archived' || (!samePhotoSubject(packet.input, recipe.content, 'hero', null) || !sameStepPhotoSelection(packet.input, recipe.content))) return { state: 'blocked', reason: 'Treść lub stan przepisu zmieniły się. Gotowe zdjęcia zachowano do porównania.' };
  const attachedIds = packet.slots.flatMap(slot => slot.jobId ? [slot.jobId] : []);
  const attached = attachedIds.length ? await getDb().select().from(aiJobs).where(inArray(aiJobs.id, attachedIds)) : [];
  const children = await getDb().select().from(aiJobs).where(eq(aiJobs.photoBatchId, id));
  const knownJobs = [...attached, ...children.filter(child => !attached.some(job => job.id === child.id))];
  if (knownJobs.some(unconfirmedAcceptance)) {
    // Check the whole captured package, including a child whose admission
    // committed before its slot link. Existing receipts may still be read.
    for (const slot of hydratedSlots(packet, knownJobs)) {
      const job = knownJobs.find(item => item.id === slot.jobId);
      if (!job || usableResult(job) || definiteFailure(job) || !job.providerRequestId && !job.reuseSourceJobId || excludedJobIds.includes(job.id)) continue;
      if (job.status === 'uncertain') await resumeJob(job.id, { id: packet.createdBy, name: packet.createdByName, email: '', role: 'admin' });
      return { state: 'job', jobId: job.id, status: job.status === 'uncertain' ? job.reuseSourceJobId ? 'queued' : 'generating' : job.status, submit: false, kind: slot.kind, receipt: true };
    }
    return { state: 'blocked', reason: 'Nie potwierdzono przyjęcia istniejącego zdjęcia w pakiecie. Nowa płatna generacja jest zablokowana; potwierdzone zlecenia można nadal odczytać.' };
  }
  let failed = 0; let inflight = false; let inflightKind: AiPhotoKind | null = null;
  // Keep each captured index: it is part of the immutable child request key,
  // including packages saved before the ingredient → step → hero sequence.
  const priority: Record<AiPhotoKind, number> = { ingredient: 0, step: 1, hero: 2 };
  const ordered = packet.slots.map((slot, index) => ({ slot, index })).sort((a, b) => priority[a.slot.kind] - priority[b.slot.kind] || a.index - b.index);
  for (const { slot, index } of ordered) {
    // A second child may share the current phase, never cross its boundary.
    if (inflightKind && slot.kind !== inflightKind) return { state: 'waiting' };
    let job = knownJobs.find(item => item.id === slot.jobId);
    if (job && usableResult(job)) continue;
    if (job && unconfirmedAcceptance(job)) return { state: 'blocked', reason: 'Nie potwierdzono przyjęcia istniejącego zdjęcia. Nowa płatna generacja jest zablokowana.' };
    if (job && excludedJobIds.includes(job.id) && !definiteFailure(job)) {
      inflight = true; inflightKind = slot.kind; continue;
    }
    if (!job) {
      job = await admitSlot(packet, index, recipe.revision, slot.recoverySourceJobId);
      if (job && usableResult(job)) continue;
    }
    if (!job) return { state: 'blocked', reason: 'Nie można odczytać zlecenia zdjęcia. Nie wysłano nowej generacji.' };
    const ingredient = slot.kind === 'ingredient' ? recipe.content.recipe.ingredients.find(item => item.id === slot.targetId) : undefined;
    if (!slot.recoverySourceJobId && slot.kind !== 'step' && !(slot.kind==='ingredient'&&isOpaqueStudioIngredientProfile(capturedIngredientStyleProfile(packet.input))) && isRecoverablePhotoSource(job, recipe.id, slot.kind as 'hero' | 'ingredient', slot.targetId, ingredient)) {
      const repaired = await admitSlot(packet, index, recipe.revision, job.id);
      if (!repaired) return { state: 'blocked', reason: 'Nie można odczytać korekty istniejącego zdjęcia.' };
      return { state: 'job', jobId: repaired.id, status: repaired.status, submit: repaired.status === 'queued' && repaired.photoBatchId === id, kind: slot.kind, receipt: Boolean(repaired.providerRequestId || repaired.reuseSourceJobId) };
    }
    if (unconfirmedAcceptance(job)) return { state: 'blocked', reason: 'Nie potwierdzono przyjęcia istniejącego zdjęcia. Nowa płatna generacja jest zablokowana.' };
    if (definiteFailure(job)) { failed++; continue; }
    if (job.status === 'uncertain' && (job.providerRequestId || job.reuseSourceJobId)) {
      await resumeJob(job.id, { id: packet.createdBy, name: packet.createdByName, email: '', role: 'admin' });
      return { state: 'job', jobId: job.id, status: job.reuseSourceJobId ? 'queued' : 'generating', submit: Boolean(job.reuseSourceJobId), kind: slot.kind, receipt: true };
    }
    if (job.status === 'queued' && job.photoBatchId === id && !job.providerRequestId && !job.reuseSourceJobId)
      preflightBatchPhotos(packet.input, unsubmittedPromptSlots(packet, knownJobs));
    return { state: 'job', jobId: job.id, status: job.status, submit: job.status === 'queued' && job.photoBatchId === id, kind: slot.kind, receipt: Boolean(job.providerRequestId || job.reuseSourceJobId) };
  }
  if (inflight) return { state: 'waiting' };
  await getDb().transaction(async tx => {
    await budgetLock(tx); const latest = await lockedBatch(tx, id);
    if (latest.generation !== generation || latest.status !== 'generating') return;
    await tx.update(aiPhotoBatches).set({ status: failed ? 'failed' : 'ready', remainingReservedUsd: '0', errorCode: failed ? 'PHOTO_BATCH_PARTIAL' : null,
      errorMessage: failed ? `Nie udało się przygotować ${failed} zdjęć. Pozostałe gotowe zdjęcia możesz sprawdzić i zapisać w szkicu.` : null, updatedAt: new Date() }).where(eq(aiPhotoBatches.id, id));
  });
  return { state: 'done' };
}

/** One worker selects at most two photos in one phase; the final hero is exclusive. */
export async function nextPhotoBatchWave(id: string, generation: number): Promise<PhotoBatchWave> {
  const first = await nextPhotoBatchOperation(id, generation);
  if (first.state !== 'job') return first;
  if (first.kind === 'hero') return { state: 'jobs', jobs: [first] };
  let second: PhotoBatchOperation;
  try { second = await nextPhotoBatchOperation(id, generation, [first.jobId]); }
  catch (error) {
    if (first.receipt && error instanceof AiError) return { state: 'jobs', jobs: [first], blocked: { code: error.code, message: error.message } };
    throw error;
  }
  if (second.state === 'blocked') return first.receipt ? { state: 'jobs', jobs: [first], blocked: { code: 'PHOTO_BATCH_BLOCKED', message: second.reason } } : second;
  return { state: 'jobs', jobs: second.state === 'job' ? [first, second] : [first] };
}

export async function applyPhotoBatch(id: string, expectedRevision: number, actor: EditorialActor): Promise<ApplyAiPhotoBatchResult> {
  const recipe = await getDb().transaction(async tx => {
    await budgetLock(tx); const row = await lockedBatch(tx, id); await trustedActor(tx, actor.id);
    const [current] = await tx.select({ deletedAt: editorialRecipes.deletedAt }).from(editorialRecipes).where(eq(editorialRecipes.id, row.recipeId));
    if (current?.deletedAt) throw new AiError(409, 'RECIPE_DELETED', 'Najpierw przywróć przepis z kosza.');
    if (row.status === 'applied') return getRecipeInTransaction(tx, row.recipeId);
    if (!['ready', 'failed'].includes(row.status) || row.status === 'failed' && row.errorCode !== 'PHOTO_BATCH_PARTIAL' || row.slots.some(slot => !slot.jobId)) throw new AiError(409, 'PHOTO_BATCH_NOT_READY', 'Najpierw zaczekaj na zakończenie wszystkich zdjęć i sprawdź pakiet.');
    const jobs = row.slots.length ? await tx.select().from(aiJobs).where(inArray(aiJobs.id, row.slots.flatMap(slot => slot.jobId ? [slot.jobId] : []))).for('update') : [];
    if (jobs.some(retryablePreSubmission) || row.slots.some(slot => unfinishedSlot(row, slot, jobs.find(job => job.id === slot.jobId)))) throw new AiError(409, 'PHOTO_BATCH_NOT_READY', 'Najpierw kontynuuj niedokończone zdjęcia i sprawdź pakiet.');
    const ready = jobs.filter(usableResult);
    if (row.status === 'failed' && !ready.length) throw new AiError(409, 'PHOTO_BATCH_NOT_READY', 'Pakiet nie zawiera gotowych zdjęć do zapisania.');
    const replacements=row.input.aiPhotography?.photoBatchMode&&['ingredients-white','ingredients-paper'].includes(row.input.aiPhotography.photoBatchMode)?new Map(row.slots.filter(slot=>slot.kind==='ingredient').map(slot=>[slot.targetId!,slot.replacePhoto??null])):undefined;
    const recipe = await applyPhotoBatchJobsInTransaction(tx, row.recipeId, ready.map(job => job.id), expectedRevision, actor, row.input,replacements);
    await tx.update(aiPhotoBatches).set({ status: 'applied', appliedRevision: recipe.revision, updatedAt: new Date() }).where(eq(aiPhotoBatches.id, id));
    return recipe;
  });
  return { batch: await getPhotoBatch(id), recipe };
}
