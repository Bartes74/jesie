import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { PhotoBatchChildOperation, PhotoBatchWave } from './photo-batch';

type ChildState = { status: string; receipt: boolean; hasResult: boolean; providerFinished?: boolean; errorCode?: string | null; errorMessage?: string | null };
type Ports = {
  waves: PhotoBatchWave[];
  state: (id: string) => ChildState | Promise<ChildState>;
  poll?: (id: string) => void | Promise<void>;
  submit?: (id: string) => void | Promise<void>;
  resume?: (id: string) => boolean | Promise<boolean>;
  reconcile?: (id: string) => void | Promise<void>;
};

// Execute the shipped control flow with offline ports. Loading its real step
// imports would start the Workflow engine or read the configured provider keys.
const workflowSource = ts.transpileModule(readFileSync(new URL('../../workflows/ai-photo-batch.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

function job(jobId: string, status = 'generating', receipt = true): PhotoBatchChildOperation {
  return { state: 'job', jobId, status: status as PhotoBatchChildOperation['status'], receipt, submit: status === 'queued', kind: 'ingredient' };
}

function harness(ports: Ports) {
  const events: string[] = [];
  const stops: { code: string; message: string }[] = [];
  const sleeps: string[] = [];
  let waveCount = 0;
  const imports: Record<string, unknown> = {
    workflow: { getWorkflowMetadata: () => ({ workflowRunId: 'offline-run' }), sleep: async (delay: string) => { sleeps.push(delay); } },
    '@/server/ai/photo-batch-steps': {
      claimPhotoBatchStep: async () => true,
      nextPhotoBatchWaveStep: async () => {
        waveCount++;
        return ports.waves.shift() ?? { state: 'done' };
      },
      photoBatchChildState: ports.state,
      resumePhotoBatchChildReadStep: async (id: string) => ports.resume ? ports.resume(id) : true,
      stopPhotoBatchStep: async (_id: string, _generation: number, code: string, message: string) => {
        events.push(`stop:${code}`); stops.push({ code, message });
      },
    },
    '@/server/ai/steps': {
      expireGeneration: async (id: string) => { events.push(`expire:${id}`); },
      pollGeneration: async (id: string) => { events.push(`poll:${id}`); await ports.poll?.(id); },
      reconcileGeneration: async (id: string) => { events.push(`reconcile:${id}`); await ports.reconcile?.(id); },
      submitGeneration: async (id: string) => { events.push(`submit:${id}`); await ports.submit?.(id); },
    },
  };
  const exports: { aiPhotoBatch?: (id: string, generation: number) => Promise<void> } = {};
  runInNewContext(workflowSource, {
    exports, console: { info() {} },
    require: (name: string) => {
      assert.ok(Object.hasOwn(imports, name), `Unexpected workflow dependency: ${name}`);
      return imports[name];
    },
  });
  assert.equal(typeof exports.aiPhotoBatch, 'function');
  return { run: () => exports.aiPhotoBatch!('offline-batch', 1), events, stops, sleeps, waveCount: () => waveCount };
}

test('an uncertain child waits for its accepted sibling before stopping and never starts another wave', { timeout: 3000 }, async () => {
  const enteredPoll = deferred(); const releasePoll = deferred();
  let siblingReady = false;
  const workflow = harness({
    waves: [{ state: 'jobs', jobs: [job('uncertain', 'uncertain', false), job('accepted')] }],
    state: id => id === 'uncertain' ? { status: 'uncertain', receipt: false, hasResult: false }
      : { status: siblingReady ? 'ready' : 'generating', receipt: true, hasResult: siblingReady },
    poll: async () => { enteredPoll.resolve(); await releasePoll.promise; siblingReady = true; },
  });
  const running = workflow.run();
  await enteredPoll.promise;
  assert.deepEqual(workflow.stops, []);
  releasePoll.resolve(); await running;
  assert.deepEqual(workflow.events, ['poll:accepted', 'reconcile:accepted', 'stop:SUBMISSION_UNCERTAIN']);
  assert.equal(workflow.waveCount(), 1);
});

test('a queued sibling does not submit after another child makes the wave uncertain', { timeout: 3000 }, async () => {
  const uncertainRead = deferred(); const releaseQueued = deferred();
  let uncertainReads = 0; let submitted = false;
  const workflow = harness({
    waves: [{ state: 'jobs', jobs: [job('uncertain', 'uncertain', false), job('queued', 'queued', false)] }],
    state: async id => {
      if (id === 'uncertain') {
        if (++uncertainReads === 2) uncertainRead.resolve();
        return { status: 'uncertain', receipt: false, hasResult: false };
      }
      await releaseQueued.promise;
      return { status: submitted ? 'ready' : 'queued', receipt: submitted, hasResult: submitted };
    },
    submit: () => { submitted = true; },
  });
  const running = workflow.run();
  await uncertainRead.promise; await flush(); releaseQueued.resolve(); await running;
  assert.equal(submitted, false);
  assert.deepEqual(workflow.events, ['stop:SUBMISSION_UNCERTAIN']);
  assert.equal(workflow.waveCount(), 1);
});

test('a child poll exception preserves its receipt and waits for the successful sibling', { timeout: 3000 }, async () => {
  const enteredPoll = deferred(); const releasePoll = deferred();
  let ready = false;
  const workflow = harness({
    waves: [{ state: 'jobs', jobs: [job('unconfirmed'), job('accepted')] }],
    state: id => ({ status: id === 'accepted' && ready ? 'ready' : 'generating', receipt: true, hasResult: id === 'accepted' && ready }),
    poll: async id => {
      if (id === 'unconfirmed') throw new Error('Offline status read failed.');
      enteredPoll.resolve(); await releasePoll.promise; ready = true;
    },
  });
  const running = workflow.run();
  await enteredPoll.promise; await flush();
  assert.deepEqual(workflow.stops, []);
  releasePoll.resolve(); await running;
  assert.equal(workflow.events.filter(event => event === 'expire:unconfirmed').length, 1);
  assert.ok(workflow.events.indexOf('reconcile:accepted') < workflow.events.indexOf('stop:PHOTO_BATCH_UNCONFIRMED'));
  assert.equal(workflow.events.some(event => event.startsWith('submit:')), false);
  assert.equal(workflow.waveCount(), 1);
});

test('a definite failed child lets independent ready photos and later waves finish', { timeout: 3000 }, async () => {
  const workflow = harness({
    waves: [
      { state: 'jobs', jobs: [job('failed', 'failed'), job('ready', 'ready')] },
      { state: 'jobs', jobs: [job('later', 'ready')] },
      { state: 'done' },
    ],
    state: id => ({ status: id === 'failed' ? 'failed' : 'ready', receipt: true, hasResult: id !== 'failed' }),
  });
  await workflow.run();
  assert.deepEqual(workflow.events, ['reconcile:failed', 'reconcile:ready', 'reconcile:later']);
  assert.deepEqual(workflow.stops, []);
  assert.equal(workflow.waveCount(), 3);
});

test('a selector block preserves and reconciles the first accepted receipt before stopping', { timeout: 3000 }, async () => {
  const enteredPoll = deferred(); const releasePoll = deferred();
  let ready = false;
  const workflow = harness({
    waves: [{ state: 'jobs', jobs: [job('accepted')], blocked: { code: 'PHOTO_BATCH_BLOCKED', message: 'Second child is uncertain.' } }],
    state: () => ({ status: ready ? 'ready' : 'generating', receipt: true, hasResult: ready }),
    poll: async () => { enteredPoll.resolve(); await releasePoll.promise; ready = true; },
  });
  const running = workflow.run();
  await enteredPoll.promise;
  assert.deepEqual(workflow.stops, []);
  releasePoll.resolve(); await running;
  assert.deepEqual(workflow.events, ['poll:accepted', 'reconcile:accepted', 'stop:PHOTO_BATCH_BLOCKED']);
  assert.deepEqual(workflow.stops, [{ code: 'PHOTO_BATCH_BLOCKED', message: 'Second child is uncertain.' }]);
  assert.equal(workflow.waveCount(), 1);
});

test('a blocked wave never submits a queued child without an existing receipt', { timeout: 3000 }, async () => {
  const workflow = harness({
    waves: [{ state: 'jobs', jobs: [job('queued', 'queued', false)], blocked: { code: 'PHOTO_BATCH_BLOCKED', message: 'Second child is uncertain.' } }],
    state: () => ({ status: 'queued', receipt: false, hasResult: false }),
  });
  await workflow.run();
  assert.deepEqual(workflow.events, ['stop:PHOTO_BATCH_BLOCKED']);
  assert.equal(workflow.waveCount(), 1);
});

test('a blocked wave may resolve a receipt-only ingredient follower before stopping', { timeout: 3000 }, async () => {
  let ready = false;
  const workflow = harness({
    waves: [{ state: 'jobs', jobs: [job('shared-follower', 'queued', true)], blocked: { code: 'PHOTO_BATCH_BLOCKED', message: 'Another child is uncertain.' } }],
    state: () => ({ status: ready ? 'ready' : 'queued', receipt: true, hasResult: ready }),
    // The real submitGeneration port resolves reuseSourceJobId without a POST.
    submit: () => { ready = true; },
  });
  await workflow.run();
  assert.deepEqual(workflow.events, ['submit:shared-follower', 'reconcile:shared-follower', 'stop:PHOTO_BATCH_BLOCKED']);
  assert.equal(workflow.waveCount(), 1);
});

test('a direct selector block makes no child or provider calls', { timeout: 3000 }, async () => {
  const workflow = harness({
    waves: [{ state: 'blocked', reason: 'Unknown existing receipt.' }],
    state: () => { assert.fail('A blocked selector must not read or submit a child.'); },
  });
  await workflow.run();
  assert.deepEqual(workflow.events, ['stop:PHOTO_BATCH_BLOCKED']);
  assert.equal(workflow.waveCount(), 1);
});

test('temporary provider reads recover automatically using only the captured request', { timeout: 3000 }, async () => {
  let polls = 0; let ready = false;
  const workflow = harness({
    waves: [{ state: 'jobs', jobs: [job('existing-receipt')] }, { state: 'done' }],
    state: () => ({ status: ready ? 'ready' : 'generating', receipt: true, hasResult: ready }),
    poll: () => { if (++polls < 3) throw new Error('Temporary read outage'); ready = true; },
  });
  await workflow.run();
  assert.equal(polls, 3);
  assert.deepEqual(workflow.sleeps, ['10s', '30s', '1m']);
  assert.deepEqual(workflow.events, ['poll:existing-receipt', 'poll:existing-receipt', 'poll:existing-receipt', 'reconcile:existing-receipt']);
  assert.deepEqual(workflow.stops, []);
  assert.equal(workflow.waveCount(), 2);
});

test('temporary child state reads recover without claiming another submission', { timeout: 3000 }, async () => {
  let reads = 0;
  const workflow = harness({
    waves: [{ state: 'jobs', jobs: [job('ready', 'ready')] }, { state: 'done' }],
    state: () => { if (++reads < 3) throw new Error('Temporary DB read outage'); return { status: 'ready', receipt: true, hasResult: true }; },
  });
  await workflow.run();
  assert.deepEqual(workflow.sleeps, ['30s', '1m']);
  assert.deepEqual(workflow.events, ['reconcile:ready']);
  assert.deepEqual(workflow.stops, []);
});

test('persistent read outage is bounded, preserves the existing job and does not select another wave', { timeout: 3000 }, async () => {
  let polls = 0;
  const workflow = harness({
    waves: [{ state: 'jobs', jobs: [job('existing-receipt')] }, { state: 'jobs', jobs: [job('later', 'queued', false)] }],
    state: () => ({ status: 'generating', receipt: true, hasResult: false }),
    poll: () => { polls++; throw new Error('Persistent GET outage'); },
  });
  await workflow.run();
  assert.equal(polls, 4);
  assert.deepEqual(workflow.sleeps, ['10s', '30s', '1m', '2m']);
  assert.equal(workflow.events.filter(event => event === 'expire:existing-receipt').length, 1);
  assert.equal(workflow.events.filter(event => event === 'reconcile:existing-receipt').length, 1);
  assert.equal(workflow.events.some(event => event.startsWith('submit:')), false);
  assert.equal(workflow.stops[0].code, 'PHOTO_BATCH_UNCONFIRMED');
  assert.equal(workflow.waveCount(), 1);
});

test('an unavailable child state still reconciles a previously captured receipt before blocking', { timeout: 3000 }, async () => {
  let reads = 0;
  const workflow = harness({
    waves: [{ state: 'jobs', jobs: [job('known-receipt')] }],
    state: () => { reads++; throw new Error('Persistent DB outage'); },
  });
  await workflow.run();
  assert.equal(reads, 5);
  assert.deepEqual(workflow.sleeps, ['30s', '1m', '2m']);
  assert.deepEqual(workflow.events, ['reconcile:known-receipt', 'stop:PHOTO_BATCH_UNCONFIRMED']);
  assert.equal(workflow.waveCount(), 1);
});

test('a completed provider result blocked by storage retains its actionable stored cause', { timeout: 3000 }, async () => {
  let storageBlocked = false;
  const message = 'Wynik jest gotowy. Po odblokowaniu magazynu ponów zapis bez nowej generacji.';
  const workflow = harness({
    waves: [{ state: 'jobs', jobs: [job('completed-result')] }],
    state: () => ({ status: storageBlocked ? 'uncertain' : 'generating', receipt: true, hasResult: false,
      errorCode: storageBlocked ? 'AI_RESULT_STORAGE_UNAVAILABLE' : null, errorMessage: storageBlocked ? message : null }),
    poll: () => { storageBlocked = true; },
  });
  await workflow.run();
  assert.deepEqual(workflow.events, ['poll:completed-result', 'reconcile:completed-result', 'stop:AI_RESULT_STORAGE_UNAVAILABLE']);
  assert.deepEqual(workflow.stops, [{ code: 'AI_RESULT_STORAGE_UNAVAILABLE', message }]);
  assert.deepEqual(workflow.sleeps, ['10s']);
});

test('storage preflight failure stops the package before selecting more paid work', { timeout: 3000 }, async () => {
  let failed = false;
  const message = 'Magazyn jest niedostępny. Nie wysłano płatnego zlecenia.';
  const workflow = harness({
    waves: [{ state: 'jobs', jobs: [job('unsent', 'queued', false)] }, { state: 'jobs', jobs: [job('later', 'queued', false)] }],
    state: () => ({ status: failed ? 'failed' : 'queued', receipt: false, hasResult: false,
      errorCode: failed ? 'AI_STORAGE_UNAVAILABLE' : null, errorMessage: failed ? message : null }),
    submit: () => { failed = true; },
  });
  await workflow.run();
  assert.deepEqual(workflow.events, ['submit:unsent', 'stop:AI_STORAGE_UNAVAILABLE']);
  assert.deepEqual(workflow.stops, [{ code: 'AI_STORAGE_UNAVAILABLE', message }]);
  assert.equal(workflow.waveCount(), 1);
});

test('billing read failure does not block saved photos or the next independent wave', { timeout: 3000 }, async () => {
  const workflow = harness({
    waves: [{ state: 'jobs', jobs: [job('first', 'ready')] }, { state: 'jobs', jobs: [job('later', 'ready')] }, { state: 'done' }],
    state: () => ({ status: 'ready', receipt: true, hasResult: true }),
    reconcile: () => { throw new Error('Temporary billing DB outage'); },
  });
  await workflow.run();
  assert.deepEqual(workflow.events, ['reconcile:first', 'reconcile:later']);
  assert.deepEqual(workflow.stops, []);
  assert.equal(workflow.waveCount(), 3);
});

test('a submit step exception after capturing its receipt recovers by GET without a second submit', { timeout: 3000 }, async () => {
  let submitted = false; let ready = false; let resumes = 0;
  const workflow = harness({
    waves: [{ state: 'jobs', jobs: [job('accepted-once', 'queued', false)] }, { state: 'done' }],
    state: () => ({ status: ready ? 'ready' : submitted ? 'uncertain' : 'queued', receipt: submitted, hasResult: ready }),
    submit: () => { submitted = true; throw new Error('Step response lost after receipt capture'); },
    resume: () => { resumes++; return true; },
    poll: () => { ready = true; },
  });
  await workflow.run();
  assert.deepEqual(workflow.events, ['submit:accepted-once', 'poll:accepted-once', 'reconcile:accepted-once']);
  assert.equal(resumes, 1);
  assert.deepEqual(workflow.stops, []);
  assert.equal(workflow.waveCount(), 2);
});

test('a thrown submit with unknown acceptance is never repeated or polled without a receipt', { timeout: 3000 }, async () => {
  let attempted = false;
  const workflow = harness({
    waves: [{ state: 'jobs', jobs: [job('unknown-acceptance', 'queued', false)] }],
    state: () => ({ status: attempted ? 'uncertain' : 'queued', receipt: false, hasResult: false }),
    submit: () => { attempted = true; throw new Error('Unknown POST outcome'); },
    resume: () => { assert.fail('Unknown acceptance must not enter receipt recovery'); },
    poll: () => { assert.fail('No provider identity exists to read'); },
  });
  await workflow.run();
  assert.deepEqual(workflow.events, ['submit:unknown-acceptance', 'stop:SUBMISSION_UNCERTAIN']);
  assert.equal(workflow.waveCount(), 1);
});

test('an accepted cancelled child is read once then blocks without a 403-wave loop', { timeout: 3000 }, async () => {
  const workflow = harness({
    waves: [{ state: 'jobs', jobs: [job('cancelled-request', 'cancelled')] }, { state: 'jobs', jobs: [job('cancelled-request', 'cancelled')] }],
    state: () => ({ status: 'cancelled', receipt: true, hasResult: false, providerFinished: false }),
  });
  await workflow.run();
  assert.deepEqual(workflow.events, ['poll:cancelled-request', 'reconcile:cancelled-request', 'stop:AI_CANCELLED_RESULT_UNCONFIRMED']);
  assert.equal(workflow.waveCount(), 1);
  assert.deepEqual(workflow.sleeps, []);
});

test('a cancelled accepted request may still recover its completed result through GET', { timeout: 3000 }, async () => {
  let ready = false;
  const workflow = harness({
    waves: [{ state: 'jobs', jobs: [job('cancelled-request', 'cancelled')] }, { state: 'done' }],
    state: () => ({ status: ready ? 'ready' : 'cancelled', receipt: true, hasResult: ready, providerFinished: ready }),
    poll: () => { ready = true; },
  });
  await workflow.run();
  assert.deepEqual(workflow.events, ['poll:cancelled-request', 'reconcile:cancelled-request']);
  assert.deepEqual(workflow.stops, []);
  assert.equal(workflow.waveCount(), 2);
});
