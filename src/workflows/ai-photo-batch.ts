import { getWorkflowMetadata, sleep } from 'workflow';
import { claimPhotoBatchStep, nextPhotoBatchWaveStep, photoBatchChildState, resumePhotoBatchChildReadStep, stopPhotoBatchStep } from '@/server/ai/photo-batch-steps';
import { expireGeneration, pollGeneration, reconcileGeneration, submitGeneration } from '@/server/ai/steps';

/** Ingredients and steps share at most two slots per phase; the final hero is exclusive. */
export async function aiPhotoBatch(id: string, generation: number) {
  'use workflow';
  console.info('Studio photo package workflow started', { batchId: id, generation });
  if (!await claimPhotoBatchStep(id, generation, getWorkflowMetadata().workflowRunId)) return;
  // A new step call gets a fresh retry budget after a temporary outage. Only
  // captured request reads use this recovery; a paid submit never enters it.
  async function retryRead<T>(read: () => Promise<T>): Promise<T> {
    const delays = ['30s', '1m', '2m'] as const;
    for (const delay of delays) {
      try { return await read(); }
      catch { await sleep(delay); }
    }
    return read();
  }
  try {
    for (let photograph = 0; photograph < 403; photograph++) {
      const wave = await nextPhotoBatchWaveStep(id, generation);
      if (wave.state === 'done') return;
      if (wave.state === 'waiting') { await sleep('10s'); continue; }
      if (wave.state === 'blocked') {
        await stopPhotoBatchStep(id, generation, 'PHOTO_BATCH_BLOCKED', wave.reason);
        return;
      }
      let allowSubmissions = !wave.blocked;
      type BlockedOutcome = { code: string; message: string };
      const block = (code: string, message: string): BlockedOutcome => {
        allowSubmissions = false;
        return { code, message };
      };
      const outcomes = await Promise.allSettled(wave.jobs.map(async operation => {
        const jobId = operation.jobId;
        type ChildState = Awaited<ReturnType<typeof photoBatchChildState>>;
        const readState = () => retryRead(() => photoBatchChildState(jobId));
        const pollExisting = async () => {
          await retryRead(() => pollGeneration(jobId));
          return readState();
        };
        const reconcileReceipt = async (state: Pick<ChildState, 'receipt'>) => {
          if (!state.receipt) return;
          try { await reconcileGeneration(jobId); }
          catch {
            // The recorded reservation remains. A billing outage must not
            // discard a ready photo or prevent the next independent wave.
            console.info('Studio photo billing reconciliation deferred', { jobId });
          }
        };
        const blockChild = async (state: ChildState, code: string, message: string) => {
          allowSubmissions = false;
          await reconcileReceipt(state);
          return block(state.errorCode ?? code, state.errorMessage ?? message);
        };
        try {
          // A busy global slot leaves a reserved child queued. A sibling's
          // uncertainty prevents every later paid submission in this wave.
          for (let queueWait = 0; queueWait < 60; queueWait++) {
            const queued = await readState();
            if (queued.status !== 'queued') break;
            if (operation.submit) {
              if (!allowSubmissions && !operation.receipt) return block('PHOTO_BATCH_BLOCKED', 'Pakiet został wstrzymany przed wysłaniem kolejnego zdjęcia. Zachowano istniejące zlecenia.');
              try { await submitGeneration(jobId); }
              catch {
                // The POST may have been accepted before its step failed.
                // Inspect its identity once; recover only through GETs.
                allowSubmissions = false;
                const submitted = await readState();
                if (!submitted.hasResult && !submitted.receipt) return blockChild(submitted, 'SUBMISSION_UNCERTAIN', 'Nie potwierdzono przyjęcia zdjęcia. Zachowano zlecenie bez ponownego wysyłania.');
                if (!submitted.hasResult && await retryRead(() => resumePhotoBatchChildReadStep(jobId))) await pollExisting();
                break;
              }
            } else await pollExisting();
            const submitted = await readState();
            if (submitted.status !== 'queued') break;
            await sleep('30s');
          }
          let state = await readState();
          if (state.status === 'queued') return block('CONCURRENCY_LIMIT', 'Zaczekaj na zakończenie aktywnych generowań i kontynuuj pakiet. Zlecenie nie zostało wysłane.');
          if (['submitting', 'uncertain'].includes(state.status) && !state.receipt) return blockChild(state, 'SUBMISSION_UNCERTAIN', 'Nie potwierdzono przyjęcia zdjęcia. Nowa płatna generacja jest zablokowana.');
          if (state.status === 'failed' && ['AI_STORAGE_UNAVAILABLE', 'AI_STORAGE_CAPACITY', 'AI_REFERENCE_UNAVAILABLE', 'AI_SUBMISSION_BLOCKED', 'AI_CONFIGURATION_REQUIRED', 'AI_PROVIDER_REJECTED'].includes(state.errorCode ?? '')) {
            return blockChild(state, 'PHOTO_BATCH_BLOCKED', 'Usuń przyczynę zatrzymania i kontynuuj pakiet. Zachowano istniejące zdjęcia i zlecenia.');
          }
          if (state.status === 'cancelled' && state.receipt && !state.hasResult && !state.providerFinished) {
            state = await pollExisting();
            if (state.status === 'cancelled' && !state.hasResult && !state.providerFinished) return blockChild(state, 'AI_CANCELLED_RESULT_UNCONFIRMED', 'Anulowane zdjęcie nadal oczekuje na potwierdzenie zakończenia u dostawcy. Kontynuacja sprawdzi zapisane zlecenie bez nowej generacji.');
          }
          const delays = ['10s', '10s', '20s', '20s', '30s', '30s', '1m', '1m', '5m', '5m', '5m', '5m', '5m', '5m', '5m', '5m', '5m', '5m', '5m', '5m'] as const;
          for (const delay of delays) {
            if (state.hasResult || ['failed', 'uncertain', 'cancelled'].includes(state.status)) break;
            await sleep(delay);
            state = await pollExisting();
          }
          if (!state.hasResult && !['failed', 'cancelled'].includes(state.status)) {
            if (state.status !== 'uncertain') {
              await expireGeneration(jobId);
              state = await readState();
            }
            return blockChild(state, 'AI_RESULT_UNCONFIRMED', 'Nie potwierdzono ukończenia zdjęcia. Kontynuacja odczyta istniejące zlecenie i nie wyśle go ponownie.');
          }
          // Definite failed slots are repaired once or skipped by the next
          // selector. A successful sibling always completes before we stop.
          await reconcileReceipt(state);
          return null;
        } catch {
          allowSubmissions = false;
          try {
            let state = await photoBatchChildState(jobId);
            if (state.hasResult) { await reconcileReceipt(state); return null; }
            if (!['failed', 'cancelled', 'uncertain', 'queued'].includes(state.status)) {
              await expireGeneration(jobId);
              state = await photoBatchChildState(jobId);
            }
            return blockChild(state, 'PHOTO_BATCH_UNCONFIRMED', 'Nie potwierdzono postępu zdjęcia. Zachowano istniejące zlecenie; kontynuacja odczyta je bez ponownego wysyłania.');
          } catch { /* The captured request identity still forbids another POST. */ }
          // Even an unavailable child read must not suppress settlement of a
          // receipt already captured by the selector. This port never submits.
          await reconcileReceipt(operation);
          return block('PHOTO_BATCH_UNCONFIRMED', 'Nie potwierdzono postępu zdjęcia. Zachowano istniejące zlecenie; kontynuacja odczyta je bez ponownego wysyłania.');
        }
      }));
      // allSettled preserves every sibling's receipt/result before stopping
      // an uncertain wave. No new wave starts after a blocking outcome.
      const blocked = outcomes.find(outcome => outcome.status === 'rejected' || outcome.value !== null);
      if (blocked || wave.blocked) {
        const reason = wave.blocked ?? (blocked?.status === 'fulfilled' ? blocked.value : null);
        await stopPhotoBatchStep(id, generation, reason?.code ?? 'PHOTO_BATCH_UNCONFIRMED', reason?.message ?? 'Nie potwierdzono postępu pakietu. Zachowano istniejące zlecenia i gotowe zdjęcia.');
        return;
      }
    }
    await stopPhotoBatchStep(id, generation, 'PHOTO_BATCH_LIMIT', 'Pakiet przekroczył limit etapów. Gotowe zdjęcia zachowano.');
  } catch {
    await stopPhotoBatchStep(id, generation, 'PHOTO_BATCH_UNCONFIRMED', 'Nie potwierdzono dalszego postępu pakietu. Zachowano zlecenia i gotowe zdjęcia; kontynuacja nie powtórzy wysłanego żądania.');
  }
}
