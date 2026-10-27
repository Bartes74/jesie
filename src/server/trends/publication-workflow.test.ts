import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { TrendPublicationResult, TrendPublicationState } from '@/lib/trend-types';

// Use the shipped timer control flow with offline steps; no engine, HTTP or providers.
const source = ts.transpileModule(readFileSync(new URL('../../workflows/daily-publication.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const date = '2026-03-29';
const dueAt = '2026-03-29T04:00:00.000Z';
function state(values: Partial<TrendPublicationState> = {}): TrendPublicationState {
  return { date, dueAt, status:'pending', generation:1, workflowId:'offline-publisher', serverNow:dueAt, canPublish:true, reason:null, ...values };
}
function result(status: TrendPublicationResult['status']): TrendPublicationResult { return { status, state:state() }; }
function harness(options: { claim?: boolean; states?: TrendPublicationState[]; results?: TrendPublicationResult[] } = {}) {
  const events: string[] = []; const sleeps: Array<string | Date> = [];
  let stateReads = 0, releases = 0;
  const imports: Record<string, unknown> = {
    workflow: { getWorkflowMetadata:() => ({ workflowRunId:'offline-publisher' }), sleep:async (value: string | Date) => { sleeps.push(value); events.push('sleep'); } },
    '@/server/trends/publication-steps': {
      claimDailyPublisher:async (day: string,generation: number,id: string) => { assert.equal(day,date); assert.equal(generation,1); assert.equal(id,'offline-publisher'); events.push('claim'); return options.claim ?? true; },
      dailyPublicationState:async () => { events.push('state'); const states=options.states ?? [state()]; return states[Math.min(stateReads++,states.length-1)]; },
      releaseDailyRecipe:async (day: string,generation: number) => { assert.equal(day,date); assert.equal(generation,1); events.push('release'); const results=options.results ?? [result('published')]; return results[Math.min(releases++,results.length-1)]; },
    },
  };
  const exports: { publishDailyRecipe?: (day: string,generation: number) => Promise<TrendPublicationResult | undefined> } = {};
  runInNewContext(source,{ exports,Date,require:(name: string) => { assert.ok(Object.hasOwn(imports,name),`Unexpected workflow dependency: ${name}`); return imports[name]; } });
  assert.equal(typeof exports.publishDailyRecipe,'function');
  return { run:() => exports.publishDailyRecipe!(date,1), events,sleeps, releases:() => releases };
}

test('duplicate timer that loses its persisted lease does no publication work', async () => {
  const workflow=harness({ claim:false }); await workflow.run();
  assert.deepEqual(workflow.events,['claim']); assert.equal(workflow.releases(),0);
});
test('already published date and obsolete generation stop before releasing', async () => {
  for (const current of [state({status:'published'}),state({generation:2})]) {
    const workflow=harness({ states:[current] }); await workflow.run();
    assert.deepEqual(workflow.events,['claim','state']); assert.equal(workflow.releases(),0);
  }
});
test('early preparation sleeps until the exact captured Warsaw due instant', async () => {
  const workflow=harness({ states:[state({serverNow:'2026-03-28T12:00:00.000Z'}),state()] });
  assert.equal((await workflow.run())?.status,'published');
  assert.equal(workflow.sleeps.length,1); assert.equal((workflow.sleeps[0] as Date).toISOString(),dueAt);
  assert.deepEqual(workflow.events,['claim','state','sleep','state','release']);
});
test('unfinished preparation gets bounded five-minute reads before one successful release', async () => {
  const workflow=harness({ results:[result('waiting'),result('waiting'),result('published')] });
  assert.equal((await workflow.run())?.status,'published'); assert.deepEqual(workflow.sleeps,['5m','5m']); assert.equal(workflow.releases(),3);
});
test('disabled automation stops without a repeated release or timed retry', async () => {
  const workflow=harness({ results:[result('disabled')] });
  assert.equal((await workflow.run())?.status,'disabled'); assert.equal(workflow.releases(),1); assert.deepEqual(workflow.sleeps,[]);
});
test('expired delivery stops without attempting a different publication date', async () => {
  const workflow=harness({ results:[result('expired')] });
  assert.equal((await workflow.run())?.status,'expired'); assert.equal(workflow.releases(),1); assert.deepEqual(workflow.sleeps,[]);
});
test('persistent waiting is limited to thirteen attempts and twelve sleeps', async () => {
  const workflow=harness({ results:[result('waiting')] }); await workflow.run();
  assert.equal(workflow.releases(),13); assert.equal(workflow.sleeps.length,12); assert(workflow.sleeps.every(value => value==='5m'));
});
test('recovery replacement observed after sleeping stops the obsolete timer', async () => {
  const workflow=harness({ states:[state({serverNow:'2026-03-28T12:00:00.000Z'}),state({generation:2})] });
  await workflow.run(); assert.equal(workflow.releases(),0); assert.equal(workflow.sleeps.length,1);
});
test('an early database response sleeps again to its authoritative due time', async () => {
  const workflow=harness({ results:[result('early'),result('published')] });
  assert.equal((await workflow.run())?.status,'published'); assert.equal(workflow.releases(),2);
  assert.equal(workflow.sleeps.length,1); assert.equal((workflow.sleeps[0] as Date).toISOString(),dueAt);
});
