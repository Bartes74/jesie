import { getWorkflowMetadata, sleep } from 'workflow';
import { pollWithBackoff, trendJobPollDelays, trendSearchPollDelays, trendRunLimits } from '@/lib/trend-polling';
import { submitGeneration, pollGeneration, expireGeneration, reconcileGeneration, advanceGenerationRecovery, claimGenerationRecovery } from '@/server/ai/steps';
import { recipeRepairBackoff } from '@/server/ai/recipe-recovery-policy';
import { submitRadar, pollRadar, radarState, stopRadar, pendingRadarBills, reserveRadarPhotos } from '@/server/trends/steps';
import { advanceRadarPhoto, advanceRadarText, approveRadarContent, finishRadarPreparation, planRadarPreparation, preparationJobState,
    prepareRadarPhoto, prepareRadarText } from '@/server/trends/preparation-steps';
import type { PreparationOperation, PreparationSlot } from '@/server/trends/preparation';

async function waitForPreparedJob(runId: string, generation: number, operation: PreparationOperation) {
    const id = operation.jobId!;
    if (operation.submit) await submitGeneration(id);
    let job = await preparationJobState(runId, generation, id);
    if (job.hasResult || ['ready', 'applied', 'failed', 'uncertain'].includes(job.status)
        || job.status === 'cancelled' && job.providerFinished) return;
    // Reads of stored receipts and ingredient followers are safe to resume.
    if (!job.providerRequestId && !job.reuseSourceJobId) return;
    if (!await pollGeneration(id) && !await pollWithBackoff(trendJobPollDelays, sleep, () => pollGeneration(id))) await expireGeneration(id);
    await reconcileGeneration(id);
    job = await preparationJobState(runId, generation, id);
    if (job.status === 'generating' && !job.hasResult) await expireGeneration(id);
}

export async function prepareText(runId: string, generation: number) {
    let operation = await prepareRadarText(runId, generation);
    const workflowRunId = getWorkflowMetadata().workflowRunId;
    let recoveryGeneration = 1;
    for (let attempt = 0; attempt < 7 && operation.state === 'job'; attempt++) {
        if (!await claimGenerationRecovery(operation.jobId!, recoveryGeneration, workflowRunId)) return { state: 'blocked' as const, reason: 'Istniejący proces poprawia już ten przepis. Zachowano jego zlecenie.' };
        await waitForPreparedJob(runId, generation, operation);
        const recovery = await advanceGenerationRecovery(operation.jobId!, recoveryGeneration, workflowRunId, generation);
        if (recovery.continue && recovery.jobId !== operation.jobId) {
            await sleep(recipeRepairBackoff[Math.min(recovery.attempt - 1, recipeRepairBackoff.length - 1)]);
            operation = { state: 'job', jobId: recovery.jobId, submit: true };
            recoveryGeneration = recovery.generation;
            continue;
        }
        operation = await advanceRadarText(runId, generation, operation.jobId!, operation.observe);
    }
    return operation.state === 'job' ? { state: 'blocked' as const, reason: 'Istniejące opracowanie treści wymaga ponownego odczytu.' } : operation;
}

export async function preparePhoto(runId: string, generation: number, slot: PreparationSlot) {
    let operation = await prepareRadarPhoto(runId, generation, slot);
    // A slot can observe one receipt, create its photograph and repair its alpha.
    // Every stage has a stored idempotency key; no transport failure repeats POST.
    for (let attempt = 0; attempt < 6 && operation.state === 'job'; attempt++) {
        await waitForPreparedJob(runId, generation, operation);
        operation = await advanceRadarPhoto(runId, generation, slot, operation.jobId!, operation.observe);
    }
    return operation.state === 'job' ? { state: 'blocked' as const, reason: 'Istniejące zdjęcie wymaga ponownego odczytu.' } : operation;
}

export async function dailyTrends(runId: string, generation = 1) {
    'use workflow';
    try {
        let state = await radarState(runId, generation);
        if (!state.searchFinishedAt) {
            if (!await submitRadar(runId, generation)) return;
            const done = await pollWithBackoff(trendSearchPollDelays, sleep, () => pollRadar(runId, generation));
            if (!done) { await stopRadar(runId, 'Nie potwierdzono zakończenia wyszukiwania.', true, generation); return; }
        }
        state = await radarState(runId, generation);
        if (state.status !== 'generating' || !state.recipeId) return;
        const text = await prepareText(runId, generation);
        if (text.state !== 'complete') { await stopRadar(runId, text.reason ?? 'Treść przepisu wymaga uzupełnienia.', text.state === 'blocked', generation); return; }
        if (!await approveRadarContent(runId, generation)) return;
        if ((await reserveRadarPhotos(runId, generation))?.blocked) return;
        const plan = await planRadarPreparation(runId, generation);
        let failed = false;
        let failureReason = '';
        for (const slot of plan.slots) {
            const result = await preparePhoto(runId, generation, slot);
            if (result.state === 'blocked') {
                await stopRadar(runId, result.reason ?? 'Nie potwierdzono istniejącego zlecenia fotografii.', true, generation);
                return;
            }
            if (result.state !== 'complete') {
                failed = true;
                failureReason ||= result.reason ?? 'Jedno zdjęcie wymaga poprawy. Pozostałe gotowe materiały zachowano.';
                break;
            }
        }
        if (failed) { await stopRadar(runId, failureReason, false, generation); return; }
        await finishRadarPreparation(runId, generation);
    } catch {
        await stopRadar(runId, 'Pakiet wymaga dokończenia. Zachowano gotową treść, fotografie i istniejące zlecenia.', false, generation);
    } finally {
        // Late bills replace reservations without repeating paid requests.
        for (let attempt = 0; attempt < trendRunLimits.billingAttempts; attempt++) {
            const ids = await pendingRadarBills(runId);
            if (!ids.length) break;
            for (const id of ids) await reconcileGeneration(id);
            if (attempt < trendRunLimits.billingAttempts - 1) await sleep('5m');
        }
    }
}
