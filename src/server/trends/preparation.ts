import { isStepPhotoRequired } from '@/lib/step-photo-selection';
import 'server-only';
import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { AiKind } from '@/lib/ai-types';
import { ingredientCutoutRecoveryBrief } from '@/lib/ai-types';
import type { EditorialContent, EditorialRecord, PublicationIssue } from '@/lib/editorial-types';
import { trendRunLimits } from '@/lib/trend-polling';
import { getDb } from '@/server/db';
import { aiSettings, recipeGenerationReservationUsd } from '@/server/ai/config';
import { aiJobs } from '@/server/ai/schema';
import { trendRecipeGenerationBrief } from '@/server/ai/recipe-method';
import { createJobAdmission, getJobForExecution, resumeTrendJob } from '@/server/ai/store';
import { heroCutoutModel, heroCutoutReservationUsd, isRecoverablePhotoSource } from '@/server/ai/image-actions';
import { capturedIngredientStyleProfile, currentIngredientStyleProfile, paperIngredientReservationUsd } from '@/server/ai/ingredient-profile';
import { photoSubjectSnapshot, samePhotoSubject } from '@/server/ai/photo-subject';
import { heroPresentationProfile, resolveHeroPresentation } from '@/lib/hero-presentation';
import { getRecipe } from '@/server/editorial/store';
import { publicationIssues } from '@/server/editorial/validation';
import { trendWorker } from './actor';
import { applyTrendBatch, getTrendExecution, requireManualTrendPhotoRequest, reserveTrendPreparationAmount, TrendError } from './store';
import { contentApprovalHash } from '@/server/editorial/content-approval';
import { hasCurrentManualPhotoRequest } from './manual-editorial-policy';
import { preparationPhotoBriefs as photoBriefs, preflightTrendPhotos } from './photo-preflight';
import type { VerifiedIngredientDictionary } from '@/lib/recipe-diet';
import { getRecipeVerifiedAliases } from '@/server/ai/recipe-ingredient-dictionary';

type Job = typeof aiJobs.$inferSelect;
export type PreparationSlot = { kind: 'hero' | 'ingredient' | 'step'; targetId?: string };
export type PreparationOperation = {
    state: 'complete' | 'job' | 'blocked' | 'failed';
    jobId?: string;
    submit?: boolean;
    observe?: boolean;
    reason?: string;
};
export type PreparationPlan = { textRequired: boolean; slots: PreparationSlot[] };

/** Photos may survive photo-only revisions, but never changes to the food. */
export function preparationFoodSnapshot(content: EditorialContent) {
    return photoSubjectSnapshot(content);
}

export function compatiblePreparationPhoto(job: Pick<Job, 'kind' | 'targetId' | 'input'>, content: EditorialContent, slot: PreparationSlot) {
    return job.kind === slot.kind && job.targetId === (slot.targetId ?? null)
        && (slot.kind !== 'hero' || !content.recipe.heroPresentation || job.input.aiPhotography?.heroStyleProfile === heroPresentationProfile)
        && samePhotoSubject(job.input, content, slot.kind, slot.targetId ?? null);
}

export function hasPreparedCookingText(content: EditorialContent, verifiedAliases?: VerifiedIngredientDictionary) {
    const tested = structuredClone(content);
    for (const alternative of tested.recipe.substitutions ?? []) alternative.status = 'approved';
    return publicationIssues(tested, undefined, undefined, verifiedAliases).every(issue => isPhotoIssue(issue.field));
}

function isPhotoIssue(field: string) {
    return field === 'image' || field === 'heroPresentation' || field.startsWith('heroPresentation.') || field.startsWith('imageAlt.') || /^(?:ingredients|steps)\..+\.photo(?:\.|$)/.test(field);
}

export function preparationSlotHasPhoto(content: EditorialContent, slot: PreparationSlot, issues: PublicationIssue[] = []) {
    if (slot.kind === 'hero') return Boolean(content.recipe.image && content.recipe.imageAlt.pl.trim() && content.recipe.imageAlt.en.trim())
        && !issues.some(issue => issue.field === 'image' || issue.field.startsWith('imageAlt.'));
    const photo = content.photos[slot.kind === 'ingredient' ? 'ingredients' : 'steps'][slot.targetId ?? ''];
    const prefix = `${slot.kind === 'ingredient' ? 'ingredients' : 'steps'}.${slot.targetId}.photo`;
    return Boolean(photo?.src && photo.alt.pl.trim() && photo.alt.en.trim()
        && (slot.kind !== 'step' || photo.caption?.pl.trim() && photo.caption.en.trim()))
        && !issues.some(issue => issue.field === prefix || issue.field.startsWith(prefix + '.'));
}

export function preparationSlots(content: EditorialContent): PreparationSlot[] {
    return [...content.recipe.ingredients.map(item => ({ kind: 'ingredient' as const, targetId: item.id })),
        ...content.recipe.steps.filter(item => isStepPhotoRequired(content, item.id)).map(item => ({ kind: 'step' as const, targetId: item.id })), { kind: 'hero' }];
}

function currentKey(runId: string, generation: number, slot: Pick<PreparationSlot, 'targetId'> & { kind: AiKind }, stage = 'photo', force = false) {
    const hash = createHash('sha256').update(`${slot.kind}:${slot.targetId ?? ''}:${stage}`).digest('hex').slice(0, 20);
    return `${force ? 'trend_regen' : 'trend_prep'}_${runId}_${generation}_${hash}`;
}

function isCurrentAttempt(job: Job, runId: string, generation: number) {
    return job.requestKey.startsWith(`trend_prep_${runId}_${generation}_`) || job.requestKey.startsWith(`trend_regen_${runId}_${generation}_`);
}

export function preparationUnknownAcceptance(job: Pick<Job, 'status' | 'providerRequestId' | 'providerFinishedAt' | 'result' | 'reuseSourceJobId'>) {
    return !job.result && !job.reuseSourceJobId && !job.providerFinishedAt
        && ['submitting', 'generating', 'uncertain', 'cancelled'].includes(job.status) && !job.providerRequestId;
}

function terminal(job: Job) {
    return Boolean(job.providerFinishedAt && ['failed', 'cancelled'].includes(job.status));
}

function photoResult(job: Job) {
    return Boolean(job.result?.asset || job.result?.reusedPhoto);
}

async function context(runId: string, generation: number) {
    const run = await getTrendExecution(runId);
    if (run.generation !== generation) throw new TrendError(409, 'TREND_SUPERSEDED', 'Ten przebieg zastąpiono nowszym przygotowaniem.');
    if (run.status !== 'generating' || !run.recipeId) throw new TrendError(409, 'TREND_PAUSED', 'Przygotowanie jest wstrzymane.');
    const recipe = await getRecipe(run.recipeId);
    if (recipe.revision !== run.expectedRevision) throw new TrendError(409, 'REVISION_CONFLICT', 'Przepis zmienił się. Zachowano gotowe wyniki.');
    return { run, recipe };
}

async function listJobsForRecipe(recipeId: string, runId: string) {
    const jobs = await getDb().select().from(aiJobs).where(eq(aiJobs.recipeId, recipeId)).orderBy(desc(aiJobs.createdAt));
    return jobs.filter(job => job.trendRunId === null || job.trendRunId === runId)
        .toSorted((a, b) => Number(b.trendRunId === runId) - Number(a.trendRunId === runId));
}

async function preparationContext(runId: string, generation: number) {
    const value = await context(runId, generation);
    return { ...value, jobs: await listJobsForRecipe(value.recipe.id, runId) };
}

export async function getPreparationPlan(runId: string, generation: number): Promise<PreparationPlan> {
    const { recipe, run } = await preparationContext(runId, generation);
    const verifiedAliases = await getRecipeVerifiedAliases(recipe.content.recipe.ingredients);
    if (!hasCurrentManualPhotoRequest(run, contentApprovalHash(recipe.content))) return { textRequired: !hasPreparedCookingText(recipe.content, verifiedAliases), slots: [] };
    await getDb().transaction(tx => requireManualTrendPhotoRequest(tx, run, recipe));
    const allSlots = preparationSlots(recipe.content);
    if (allSlots.length > trendRunLimits.photographs) throw new TrendError(422, 'TREND_PACKET_TOO_LARGE', 'Pakiet ma zbyt wiele fotografii.');
    const regenerate = run.searchDiagnostics?.preparation?.regenerate;
    const slots = regenerate ? allSlots.filter(slot => slot.kind === regenerate.kind && slot.targetId === regenerate.targetId) : allSlots;
    return { textRequired: !hasPreparedCookingText(recipe.content, verifiedAliases), slots };
}

async function existingOperation(job: Job, runId: string, generation: number, observe = false): Promise<PreparationOperation> {
    if (job.result && ['ready', 'applied'].includes(job.status)) return { state: 'job', jobId: job.id, submit: false, observe };
    if (preparationUnknownAcceptance(job)) return { state: 'blocked', reason: 'Nie potwierdzono przyjęcia istniejącego zlecenia. Gotowe materiały zachowano; nie wysłano kolejnej generacji.' };
    if (job.status === 'uncertain' && (job.providerRequestId || job.reuseSourceJobId)) {
        await resumeTrendJob(job.id, runId, generation);
        return { state: 'job', jobId: job.id, submit: false, observe };
    }
    if (job.providerRequestId && !job.providerFinishedAt && !terminal(job)) return { state: 'job', jobId: job.id, submit: false, observe };
    if (job.reuseSourceJobId && !terminal(job)) return { state: 'job', jobId: job.id, submit: false, observe };
    if (job.status === 'queued' && isCurrentAttempt(job, runId, generation)) {
        if (job.kind !== 'recipe' && job.model !== heroCutoutModel)
            preflightTrendPhotos(job.input, aiSettings().maxInputBytes, { kind: job.kind, targetId: job.targetId, brief: job.brief });
        return { state: 'job', jobId: job.id, submit: true, observe };
    }
    if (['queued', 'submitting', 'generating', 'uncertain', 'cancelled'].includes(job.status) && !terminal(job))
        return { state: 'blocked', reason: 'Istniejące zlecenie wymaga odczytu lub potwierdzenia. Nie rozpoczęto drugiego generowania.' };
    return { state: 'failed', reason: 'Jednego z materiałów nie udało się przygotować. Gotowe wyniki pozostają w przepisie.' };
}

async function blockers(jobs: Job[], runId: string, generation: number): Promise<PreparationOperation | null> {
    const unknown = jobs.find(preparationUnknownAcceptance);
    if (unknown) return existingOperation(unknown, runId, generation, true);
    const inflight = jobs.find(job => !job.result && !job.providerFinishedAt
        && (job.providerRequestId || job.reuseSourceJobId || ['queued', 'submitting', 'generating', 'uncertain'].includes(job.status)));
    return inflight ? existingOperation(inflight, runId, generation, true) : null;
}

async function newPhoto(runId: string, generation: number, recipe: EditorialRecord, slot: PreparationSlot, force: boolean, source?: Job): Promise<PreparationOperation> {
    const stage = source ? `cutout:${source.id}` : 'photo';
    const requestKey = currentKey(runId, generation, slot, stage, force);
    const prior = await getDb().select().from(aiJobs).where(and(eq(aiJobs.createdBy, trendWorker.id), eq(aiJobs.requestKey, requestKey))).limit(1);
    if (prior[0]) return existingOperation(prior[0], runId, generation);
    if (!source) preflightTrendPhotos(recipe.content, aiSettings().maxInputBytes, slot);
    await reserveTrendPreparationAmount(runId, source ? heroCutoutReservationUsd : slot.kind === 'ingredient' ? paperIngredientReservationUsd : aiSettings().imageReservationUsd, generation);
    const { job, created } = await createJobAdmission({ recipeId: recipe.id, expectedRevision: recipe.revision, kind: slot.kind,
        ...(slot.targetId ? { targetId: slot.targetId } : {}), requestKey,
        brief: source ? slot.kind === 'ingredient' ? ingredientCutoutRecoveryBrief : 'Wytnij tło już zakończonej fotografii, zachowując całe naczynie i potrawę. Bez ponownego generowania zdjęcia.' : photoBriefs[slot.kind],
        ...(source ? { imageAction: 'cutout_result' as const, sourceJobId: source.id } : {}) }, trendWorker, runId, { forceNew: force && !source, generation,
            ingredientStyleProfile: source ? capturedIngredientStyleProfile(source.input) : currentIngredientStyleProfile });
    if (!created) return existingOperation(await getJobForExecution(job.id), runId, generation);
    return { state: 'job', jobId: job.id, submit: job.status === 'queued' };
}

export async function prepareRecipeText(runId: string, generation: number): Promise<PreparationOperation> {
    const { recipe, jobs } = await preparationContext(runId, generation);
    const verifiedAliases = await getRecipeVerifiedAliases(recipe.content.recipe.ingredients);
    if (hasPreparedCookingText(recipe.content, verifiedAliases)) return { state: 'complete' };
    const existing = jobs.find(job => job.kind === 'recipe' && (job.baseRevision === recipe.revision
        || preparationFoodSnapshot(job.input) === preparationFoodSnapshot(recipe.content))
        && (job.status === 'ready' && job.result?.content || !terminal(job) && ['queued', 'submitting', 'generating', 'uncertain'].includes(job.status)));
    if (existing) return existingOperation(existing, runId, generation);
    const blocked = await blockers(jobs, runId, generation);
    if (blocked) return blocked;
    const requestKey = currentKey(runId, generation, { kind: 'recipe' }, 'text');
    const current = jobs.find(job => job.requestKey === requestKey);
    if (current) return existingOperation(current, runId, generation);
    await reserveTrendPreparationAmount(runId, recipeGenerationReservationUsd(), generation);
    const { job, created } = await createJobAdmission({ recipeId: recipe.id, expectedRevision: recipe.revision, kind: 'recipe', requestKey,
        brief: trendRecipeGenerationBrief }, trendWorker, runId, { generation });
    return created ? { state: 'job', jobId: job.id, submit: job.status === 'queued' } : existingOperation(await getJobForExecution(job.id), runId, generation);
}

export async function preparePhotoSlot(runId: string, generation: number, slot: PreparationSlot): Promise<PreparationOperation> {
    const { run, recipe, jobs } = await preparationContext(runId, generation);
    await getDb().transaction(tx => requireManualTrendPhotoRequest(tx, run, recipe));
    if (!preparationSlots(recipe.content).some(item => item.kind === slot.kind && item.targetId === slot.targetId))
        return { state: 'failed', reason: 'Wybrany składnik lub krok nie występuje już w przepisie.' };
    const regeneration = run.searchDiagnostics?.preparation?.regenerate;
    const force = regeneration?.kind === slot.kind && regeneration.targetId === slot.targetId;
    const compatible = jobs.filter(job => compatiblePreparationPhoto(job, recipe.content, slot));
    const regenerated = compatible.some(job => isCurrentAttempt(job, runId, generation) && job.status === 'applied' && photoResult(job));
    if ((!force || regenerated) && preparationSlotHasPhoto(recipe.content, slot, recipe.issues)) return { state: 'complete' };
    if(slot.kind==='hero'&&!resolveHeroPresentation(recipe.content.recipe))return {state:'blocked',reason:'Uzupełnij naczynie i wygląd gotowej potrawy w ustawieniach zdjęcia głównego.'};
    const ready = compatible.find(job => ['ready', 'applied'].includes(job.status) && photoResult(job)
        && (!force || isCurrentAttempt(job, runId, generation)));
    if (ready) {
        await applyTrendBatch(runId, [ready.id], generation);
        return { state: 'complete' };
    }
    const pending = compatible.find(job => !terminal(job) && ['queued', 'submitting', 'generating', 'uncertain', 'cancelled'].includes(job.status));
    if (pending) return existingOperation(pending, runId, generation, force && !isCurrentAttempt(pending, runId, generation));
    const blocked = await blockers(jobs, runId, generation);
    if (blocked) return blocked;
    const ingredient = slot.kind === 'ingredient' ? recipe.content.recipe.ingredients.find(item => item.id === slot.targetId) : undefined;
    const source = slot.kind !== 'step' ? compatible.find(job => (!force || isCurrentAttempt(job, runId, generation))
        && isRecoverablePhotoSource(job, recipe.id, slot.kind as 'hero' | 'ingredient', slot.targetId ?? null, ingredient)) : undefined;
    if (source) return newPhoto(runId, generation, recipe, slot, force, source);
    const failedCurrent = compatible.find(job => isCurrentAttempt(job, runId, generation) && terminal(job));
    if (failedCurrent) return { state: 'failed', reason: 'Nie udało się ukończyć tego zdjęcia. Pozostałe gotowe fotografie zachowano.' };
    return newPhoto(runId, generation, recipe, slot, force);
}

/** Apply every ready photograph before attempting the next slot. */
export async function advancePreparedPhoto(runId: string, generation: number, slot: PreparationSlot, jobId: string, observe = false): Promise<PreparationOperation> {
    const job = await getJobForExecution(jobId);
    if (observe) {
        if (!job.result && !terminal(job)) return { state: 'blocked', reason: 'Nie potwierdzono zakończenia istniejącego zlecenia. Nie rozpoczęto kolejnej generacji.' };
        return preparePhotoSlot(runId, generation, slot);
    }
    const { recipe, run } = await preparationContext(runId, generation);
    await getDb().transaction(tx => requireManualTrendPhotoRequest(tx, run, recipe));
    if (!compatiblePreparationPhoto(job, recipe.content, slot)) return { state: 'failed', reason: 'Przepis zmienił się od przygotowania zdjęcia. Gotowy plik zachowano w bibliotece.' };
    if (['ready', 'applied'].includes(job.status) && photoResult(job)) {
        await applyTrendBatch(runId, [job.id], generation);
        return { state: 'complete' };
    }
    if (!terminal(job)) return { state: 'blocked', reason: 'Nie potwierdzono ukończenia zdjęcia. Zachowano zlecenie i jego rozliczenie.' };
    return preparePhotoSlot(runId, generation, slot);
}

export async function advancePreparedText(runId: string, generation: number, jobId: string, observe = false): Promise<PreparationOperation> {
    const job = await getJobForExecution(jobId);
    if (observe) {
        if (!job.result && !terminal(job)) return { state: 'blocked', reason: 'Nie potwierdzono istniejącego zlecenia.' };
        return prepareRecipeText(runId, generation);
    }
    if (job.status === 'ready' && job.result?.content) {
        await applyTrendBatch(runId, [job.id], generation);
        return { state: 'complete' };
    }
    if (job.status === 'applied') return { state: 'complete' };
    return { state: terminal(job) ? 'failed' : 'blocked', reason: 'Nie ukończono opracowania treści. Zachowano dotychczasowy przepis.' };
}
