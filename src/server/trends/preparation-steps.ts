import { FatalError, RetryableError } from 'workflow';
import { trendRunLimits } from '@/lib/trend-polling';
import { getJobForExecution } from '@/server/ai/store';
import { getDb } from '@/server/db';
import { eq, sql } from 'drizzle-orm';
import { editorialRecipes } from '@/server/db/schema';
import { contentApprovalHash, hasRecipeContentApproval } from '@/server/editorial/content-approval';
import { trendRuns } from './schema';
import { hasCurrentManualPhotoRequest, manualEditorialReviewReason } from './manual-editorial-policy';
import { completeTrendRun, getTrendExecution } from './store';
import { advancePreparedPhoto, advancePreparedText, getPreparationPlan, preparePhotoSlot, prepareRecipeText,
    type PreparationOperation, type PreparationSlot } from './preparation';

async function ensureCurrent(runId: string, generation: number) {
    const run = await getTrendExecution(runId);
    if (run.generation !== generation) throw new FatalError('TREND_SUPERSEDED');
    if (run.status !== 'generating') throw new FatalError('TREND_PAUSED');
    return run;
}

function failedOperation(error: unknown): PreparationOperation {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'CONCURRENCY_LIMIT') throw new RetryableError('TREND_WAITING_FOR_SLOT', { retryAfter: '30s' });
    if (['TREND_SUPERSEDED', 'TREND_PAUSED', 'REVISION_CONFLICT'].includes(code)) throw new FatalError(code);
    if (['PHOTO_INPUT_TOO_LARGE', 'PHOTO_PROMPT_INVALID', 'TREND_PACKET_TOO_LARGE'].includes(code) && error instanceof Error)
        return { state: 'failed', reason: error.message };
    if (code === 'INGREDIENT_IMAGE_CHECK_UNAVAILABLE')
        return { state: 'failed', reason: 'Istniejące zdjęcie składnika jest chwilowo niedostępne. Nie zlecono zastępczej płatnej fotografii.' };
    if (code === 'PROVIDER_NOT_CONFIGURED')
        return { state: 'failed', reason: 'Przygotowanie zdjęć wymaga skonfigurowanych usług i biblioteki plików.' };
    return { state: 'blocked', reason: 'Nie potwierdzono stanu przygotowania. Zachowano gotowe materiały i dotychczasowe zlecenia.' };
}

export async function planRadarPreparation(runId: string, generation: number) {
    'use step';
    return getPreparationPlan(runId, generation);
}

/** Every ordinary run stops here; only a separate human photo request may continue. */
export async function approveRadarContent(runId: string, generation: number) {
    'use step';
    return getDb().transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('jesie-ai-budget'))`);
        const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, runId)).for('update');
        if (!run || run.generation !== generation || run.status !== 'generating' || !run.recipeId) throw new FatalError('TREND_SUPERSEDED');
        const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, run.recipeId)).for('update');
        if (!recipe || recipe.revision !== run.expectedRevision) throw new FatalError('REVISION_CONFLICT');
        if (hasCurrentManualPhotoRequest(run, contentApprovalHash(recipe.content)) && await hasRecipeContentApproval(tx, recipe, 'manual')) return true;
        await tx.update(trendRuns).set({ status: 'awaiting_review', packetRemainingUsd: '0',
            error: manualEditorialReviewReason, updatedAt: new Date() }).where(eq(trendRuns.id, run.id));
        return false;
    });
}

export async function prepareRadarText(runId: string, generation: number) {
    'use step';
    try { return await prepareRecipeText(runId, generation); }
    catch (error) { return failedOperation(error); }
}
prepareRadarText.maxRetries = trendRunLimits.admissionRetries;

export async function prepareRadarPhoto(runId: string, generation: number, slot: PreparationSlot) {
    'use step';
    try { return await preparePhotoSlot(runId, generation, slot); }
    catch (error) { return failedOperation(error); }
}
prepareRadarPhoto.maxRetries = trendRunLimits.admissionRetries;

export async function advanceRadarText(runId: string, generation: number, jobId: string, observe = false) {
    'use step';
    try { return await advancePreparedText(runId, generation, jobId, observe); }
    catch (error) { return failedOperation(error); }
}

export async function advanceRadarPhoto(runId: string, generation: number, slot: PreparationSlot, jobId: string, observe = false) {
    'use step';
    try { return await advancePreparedPhoto(runId, generation, slot, jobId, observe); }
    catch (error) { return failedOperation(error); }
}

export async function preparationJobState(runId: string, generation: number, jobId: string) {
    'use step';
    await ensureCurrent(runId, generation);
    const job = await getJobForExecution(jobId);
    return { status: job.status, providerRequestId: job.providerRequestId, providerFinished: Boolean(job.providerFinishedAt),
        hasResult: Boolean(job.result), reuseSourceJobId: job.reuseSourceJobId };
}

export async function finishRadarPreparation(runId: string, generation: number) {
    'use step';
    await ensureCurrent(runId, generation);
    await completeTrendRun(runId, generation);
}
