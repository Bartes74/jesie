import test from 'node:test';
import assert from 'node:assert/strict';
import type { AiPhotoBatch } from '@/lib/ai-photo-batch-types';
import { createPhotoBatchDispatcher } from './photo-batch-dispatch';

const packet = { id: 'packet', status: 'generating' } as AiPhotoBatch;

test('an accepted dispatch records its receipt once and returns the current packet', async () => {
  const calls: unknown[] = [];
  const dispatch = createPhotoBatchDispatcher({
    start: async (...args) => { calls.push(['start', ...args]); return { runId: 'wrun_existing' }; },
    record: async (...args) => { calls.push(['record', ...args]); return true; },
    state: async id => { calls.push(['state', id]); return packet; },
    unconfirmed: async () => assert.fail('Dispatch was accepted'),
  });
  assert.equal(await dispatch('packet', 2), packet);
  assert.deepEqual(calls, [['start', 'packet', 2], ['record', 'packet', 2, 'wrun_existing'], ['state', 'packet']]);
});

test('a receipt persistence outage never restarts or stops an already accepted worker', async () => {
  let starts = 0;
  const dispatch = createPhotoBatchDispatcher({
    start: async () => { starts++; return { runId: 'wrun_accepted' }; },
    record: async () => { throw new Error('Temporary database outage'); },
    state: async () => packet,
    unconfirmed: async () => assert.fail('Accepted engine run must not be paused'),
  });
  assert.equal(await dispatch('packet', 2), packet); assert.equal(starts, 1);
});

test('an ambiguous dispatch uses the atomic pause guard without submitting a second workflow', async () => {
  let starts = 0; const pauses: unknown[] = [];
  const dispatch = createPhotoBatchDispatcher({
    start: async () => { starts++; throw new Error('Accepted status unknown'); },
    record: async () => assert.fail('There is no engine receipt'),
    state: async () => assert.fail('Pause returns the guarded current packet'),
    unconfirmed: async (id, generation, message) => { pauses.push([id, generation, message]); return packet; },
  });
  assert.equal(await dispatch('packet', 2), packet); assert.equal(starts, 1);
  assert.equal(pauses.length, 1); assert.deepEqual(pauses[0], ['packet', 2, 'Nie potwierdzono uruchomienia pakietu. Zachowano rezerwację i istniejące zlecenia; sprawdź i wznów ten sam pakiet.']);
});

test('a replaced generation returns its current state without pausing the replacement worker', async () => {
  const newer = { ...packet, status: 'ready' } as AiPhotoBatch;
  const dispatch = createPhotoBatchDispatcher({ start: async () => ({ runId: 'wrun_old' }),
    record: async () => false, state: async () => newer,
    unconfirmed: async () => assert.fail('A superseded run cannot pause the replacement') });
  assert.equal(await dispatch('packet', 2), newer);
});
