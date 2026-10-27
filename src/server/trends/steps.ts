import { RetryableError, FatalError } from 'workflow';
import { trendRunLimits } from '@/lib/trend-polling';
import { ProviderError } from '@/server/ai/provider-error';
import { AiError } from '@/server/ai/errors';
import { getJob } from '@/server/ai/store';
import { getDb } from '@/server/db';
import { aiJobs } from '@/server/ai/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { submitTrendSearch, pollTrendSearch } from './search';
import { claimTrendSearch, beforeTrendSearch, attachSearchRequest, getTrendExecution, getTrendResearchHints, getTrendSearchExclusions, getTrendDietBalance, searchModelForRun, finishTrendSearch, finishTrendSearchFailure, failTrendRun, trendJob, applyTrendBatch, reserveTrendPhotos, completeTrendRun } from './store';
async function currentGeneration(id: string, generation?: number) { const run = await getTrendExecution(id); if (generation !== undefined && run.generation !== generation)
    throw new FatalError('TREND_SUPERSEDED'); return run; }
export async function submitRadar(id: string, generation?: number) {
    'use step';
    const state = await currentGeneration(id, generation);
    const hints = !state.searchRequestId && ['queued', 'searching'].includes(state.status) ? await getTrendResearchHints() : [];
    const exclusions = !state.searchRequestId && ['queued', 'searching'].includes(state.status) ? await getTrendSearchExclusions() : [];
    const dietBalance = !state.searchRequestId && ['queued', 'searching'].includes(state.status) ? await getTrendDietBalance() : undefined;
    const claimed = await claimTrendSearch(id, generation);
    if (claimed.run.searchRequestId)
        return true;
    if (!claimed.submit) {
        if (claimed.run.status === 'uncertain' && !claimed.run.candidateId) await finishTrendSearchFailure(id, null, true, generation);
        return false;
    }
    try {
        const requestId = await submitTrendSearch(searchModelForRun(claimed.run), claimed.run.date, () => beforeTrendSearch(id, generation), hints, exclusions, dietBalance);
        await attachSearchRequest(id, requestId, generation);
        return true;
    }
    catch (error) {
        await currentGeneration(id, generation);
        const failure = error instanceof ProviderError ? error : new ProviderError('TREND_SEARCH_UNCERTAIN', 'Nie potwierdzono wyszukiwania.', true);
        return finishTrendSearchFailure(id, failure.chargedUsd ?? null, failure.uncertain, generation);
    }
}
submitRadar.maxRetries = 0;
export async function pollRadar(id: string, generation?: number) {
    'use step';
    const run = await currentGeneration(id, generation);
    if (!run.searchRequestId || run.searchFinishedAt)
        return true;
    try {
        const result = await pollTrendSearch(searchModelForRun(run), run.searchRequestId);
        if (!result.done)
            return false;
        await finishTrendSearch(id, result.candidates, result.allowedUrls, result.chargedUsd, result.unavailable, generation, result.diagnostics);
        return true;
    }
    catch (error) {
        if (error instanceof ProviderError) {
            await finishTrendSearchFailure(id, error.chargedUsd ?? null, error.uncertain, generation);
            return true;
        }
        throw new RetryableError('TREND_SEARCH_STATUS_UNAVAILABLE', { retryAfter: '30s' });
    }
}
export async function radarState(id: string, generation?: number) {
    'use step';
    return currentGeneration(id, generation);
}
export async function admitRadarJob(id: string, kind: 'recipe' | 'hero' | 'ingredient' | 'step', targetId?: string, generation?: number) {
    'use step';
    await currentGeneration(id, generation);
    try {
        return (await trendJob(id, kind, targetId, generation)).job;
    }
    catch (error) {
        if ((error as {
            code?: string;
        }).code === 'CONCURRENCY_LIMIT')
            throw new RetryableError('TREND_WAITING_FOR_SLOT', { retryAfter: '30s' });
        throw error;
    }
}
admitRadarJob.maxRetries = trendRunLimits.admissionRetries;
export async function radarJobState(id: string) {
    'use step';
    return getJob(id);
}
export async function applyRadarJobs(id: string, jobs: string[], generation?: number) {
    'use step';
    await currentGeneration(id, generation);
    await applyTrendBatch(id, jobs, generation);
}
export async function reserveRadarPhotos(id: string, generation?: number) {
    'use step';
    await currentGeneration(id, generation);
    try { return { ...await reserveTrendPhotos(id, generation), blocked: false as const }; }
    catch (error) {
        if ((error instanceof AiError || error instanceof Error && 'code' in error)
            && ['PHOTO_INPUT_TOO_LARGE', 'PHOTO_PROMPT_INVALID', 'TREND_PACKET_TOO_LARGE'].includes(String(error.code))) {
            await failTrendRun(id, error.message, false, generation);
            return { blocked: true as const };
        }
        throw error;
    }
}
export async function completeRadar(id: string, generation?: number) {
    'use step';
    await currentGeneration(id, generation);
    await completeTrendRun(id, generation);
}
export async function stopRadar(id: string, message: string, uncertain = false, generation?: number) {
    'use step';
    const run = await getTrendExecution(id);
    if (generation !== undefined && run.generation !== generation)
        return;
    if (!run.candidateId && ['queued', 'searching'].includes(run.status)) {
        if (run.searchClaimedAt) {
            await finishTrendSearchFailure(id, null, true, generation);
            return;
        }
        await finishTrendSearchFailure(id, '0', false, generation);
    }
    await failTrendRun(id, message, uncertain, generation);
}

/** Safe receipt-only reconciliation: never submits a provider request. */
export async function pendingRadarBills(id:string){
 'use step';
 const rows=await getDb().select({id:aiJobs.id}).from(aiJobs).where(and(eq(aiJobs.trendRunId,id),eq(aiJobs.provider,'fal'),eq(aiJobs.costBasis,'reservation'),isNotNull(aiJobs.providerRequestId)));
 return rows.map(row=>row.id);
}
