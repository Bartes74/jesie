import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiJob } from '@/lib/ai-types';
import type { EditorialContent, EditorialStatus } from '@/lib/editorial-types';
import { recipes } from '@/lib/recipes';
import type { aiJobs, aiRecipeRecoveries } from './schema';
import { withRecipeRecovery } from './recipe-recovery-state';

type Recovery = typeof aiRecipeRecoveries.$inferSelect;
type JobRow = Pick<typeof aiJobs.$inferSelect, 'id' | 'recipeId' | 'kind' | 'provider' | 'status' | 'baseRevision' | 'errorCode'
  | 'providerRequestId' | 'providerFinishedAt' | 'chargedUsd' | 'costBasis' | 'result' | 'input'>
  & { revision: number; deletedAt: Date | null; editorialStatus: EditorialStatus };
const vocabularyIssue = { field: 'ingredients.leaf.name', code: 'DIET_INGREDIENT_UNRECOGNISED', message: 'Historical alias conflict fixture.' };
const vocabularyCode = 'RECIPE_DIET_VOCABULARY_UNSUPPORTED';
const vocabularyMessage = 'A historical ingredient lookup failed.';
const content: EditorialContent = { recipe: structuredClone(recipes[0]), originalText: 'Synthetic private fixture', author: 'Test',
  sources: [], photos: { ingredients: {}, steps: {} } };

function job(change: Partial<JobRow> = {}): JobRow {
  return { id: 'parent', recipeId: 'recipe', kind: 'recipe', provider: 'openai', status: 'failed', baseRevision: 1, revision: 1,
    deletedAt: null, editorialStatus: 'draft', errorCode: 'AI_RESULT_INVALID', providerRequestId: 'resp_existing',
    providerFinishedAt: new Date('2026-10-28T00:00:00Z'), chargedUsd: '0.05000000', costBasis: 'usage', result: null,
    input: structuredClone(content), ...change };
}

function recovery(change: Partial<Recovery> = {}): Recovery {
  return { jobId: 'parent', rootJobId: 'parent', parentJobId: null, attempt: 0, generation: 2, trendGeneration: null,
    repairIssues: [], failureIssues: [vocabularyIssue], repairable: false, blockedCode: vocabularyCode, blockedMessage: vocabularyMessage,
    workflowRunId: null, dispatchClaimedAt: null, createdAt: new Date('2026-10-28T00:00:00Z'), updatedAt: new Date('2026-10-28T00:01:00Z'),
    ...change };
}

async function present(rows: JobRow[], entries: Recovery[], requested = rows[0].id) {
  let queries = 0;
  const database = { select() {
    const index = ++queries;
    const query = { from() { return query; }, innerJoin() { return query; }, async where() { return index === 1 ? entries : rows; } };
    return query;
  } };
  const selected = rows.find(row => row.id === requested)!;
  const input = [{ id: requested, recipeId: selected.recipeId, kind: selected.kind, status: selected.status,
    errorCode: selected.errorCode, result: selected.result }] as AiJob[];
  const before = structuredClone({ rows, entries });
  const [result] = await withRecipeRecovery(input, database as never);
  assert.deepEqual({ rows, entries }, before, 'Presentation must retain the saved historical failure.');
  assert(result.recovery);
  return result.recovery;
}

test('a current invalid recipe still reports its ingredient failure and retained receipt action', async () => {
  const state = await present([job()], [recovery()]);
  assert.equal(state.status, 'blocked'); assert.equal(state.code, vocabularyCode);
  assert.deepEqual(state.issues, [vocabularyIssue]); assert.equal(state.canResume, true);
  assert.match(state.reason!, /nie rozpoznaje składnika/);
});

test('rereading an accepted receipt suppresses old ingredient issues and blocked labels', async () => {
  const state = await present([job({ status: 'generating', errorCode: null })], [recovery()]);
  assert.equal(state.status, 'recovering'); assert.equal(state.code, undefined); assert.deepEqual(state.issues, []);
  assert.match(state.reason!, /odczytuje istniejący wynik/); assert.doesNotMatch(state.reason!, /składnika|alias/);
});

test('a new dispatch error cannot be masked by historical ingredient validation', async () => {
  for (const blockedCode of [vocabularyCode, 'AI_RECOVERY_DISPATCH_UNCONFIRMED']) {
    const currentMessage = 'The current read could not be dispatched.';
    const state = await present([job({ status: 'uncertain', errorCode: 'AI_RECOVERY_DISPATCH_UNCONFIRMED' })], [recovery({ blockedCode,
      blockedMessage: blockedCode === vocabularyCode ? vocabularyMessage : currentMessage })]);
    assert.equal(state.status, 'blocked'); assert.equal(state.code, 'AI_RECOVERY_DISPATCH_UNCONFIRMED');
    assert.deepEqual(state.issues, []); assert.doesNotMatch(state.reason!, /nie rozpoznaje składnika|historical ingredient/);
    if (blockedCode === 'AI_RECOVERY_DISPATCH_UNCONFIRMED') assert.equal(state.reason, currentMessage);
    else assert.match(state.reason!, /Nie potwierdzono przyjęcia żądania/);
  }
});

test('a new provider error replaces a previous ingredient failure without exposing its old issues', async () => {
  const state = await present([job({ status: 'uncertain', errorCode: 'AI_PROVIDER_STATUS_UNAVAILABLE' })], [recovery()]);
  assert.equal(state.code, 'AI_PROVIDER_STATUS_UNAVAILABLE'); assert.deepEqual(state.issues, []);
  assert.match(state.reason!, /Zachowano istniejące zlecenie/); assert.doesNotMatch(state.reason!, /składnika/);
});

test('successful retained results no longer expose historical validation issues', async () => {
  for (const status of ['ready', 'applied'] as const) {
    const state = await present([job({ status, errorCode: null, result: { content, asset: null, notes: [] } })], [recovery()]);
    assert.equal(state.status, 'ready'); assert.equal(state.code, undefined); assert.deepEqual(state.issues, []);
    assert.match(state.reason!, /gotowy do Twojego sprawdzenia/);
  }
});

test('current non-vocabulary validation errors remain reviewable', async () => {
  const issues = [{ field: 'steps', message: 'Current missing steps fixture.' }];
  const state = await present([job()], [recovery({ failureIssues: issues, blockedCode: null, blockedMessage: null })]);
  assert.equal(state.code, 'AI_RESULT_INVALID'); assert.deepEqual(state.issues, issues);
  assert.doesNotMatch(state.reason!, /nie rozpoznaje składnika/);
});

test('an unsent legacy vocabulary repair still points to its accepted parent and keeps the paid repair cap', async () => {
  const parent = job(), child = job({ id: 'child', status: 'failed', errorCode: vocabularyCode, providerRequestId: null, result: null });
  const state = await present([parent, child], [recovery(), recovery({ jobId: 'child', parentJobId: 'parent', attempt: 1 })], 'child');
  assert.equal(state.jobId, 'parent'); assert.equal(state.status, 'blocked'); assert.equal(state.code, vocabularyCode);
  assert.equal(state.attempt, 1); assert.equal(state.maxAttempts, 2); assert.equal(state.canResume, true);
  assert.deepEqual(state.issues, [vocabularyIssue]);
});
