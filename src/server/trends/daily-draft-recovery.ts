import 'server-only';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { getRun } from 'workflow/api';
import { getDb } from '@/server/db';
import { editorialRecipes } from '@/server/db/schema';
import { aiJobs } from '@/server/ai/schema';
import { recipeResponses } from '@/server/ai/recipe-checkpoint-schema';
import { latestManualRecipeRepair, recipeResponseCheckpoint } from '@/server/ai/recipe-checkpoint';
import { resolveRecipeIngredients } from '@/server/ai/recipe-ingredient-resolution';
import { recipeRecoverySubmission } from '@/server/ai/recipe-recovery-state';
import { ProviderError } from '@/server/ai/provider-error';
import { applyTrendJobsInTransaction, budgetLock, finishRecipeInTransaction } from '@/server/ai/store';
import { pollText } from '@/server/ai/text-provider';
import { contentApprovalHash } from '@/server/editorial/content-approval';
import { manualEditorialReviewReason } from './manual-editorial-policy';
import { startPreparationWorkflow } from './daily-dispatch';
import { warsawDate } from './ranking';
import { trendRuns } from './schema';
import { admitTrendRun, trendAutomationGate, TrendError } from './store';

const staleMinutes = 90;
const recoveryDays = 14;
type Job = typeof aiJobs.$inferSelect;
type Run = typeof trendRuns.$inferSelect;

/** A replacement worker can claim only a row that has never reached provider submission. */
export async function retryDailyPreparationDispatch(now = new Date()) {
  const date = warsawDate(now);
  // No paid catch-up before the scheduled delivery or on the next Warsaw date.
  if (now.getUTCHours() < 12 || date !== now.toISOString().slice(0, 10)) return false;
  if (!(await trendAutomationGate()).enabled) return false;
  const db = getDb();
  const unstarted = () => sql`(${trendRuns.status} = 'queued' AND ${trendRuns.searchClaimedAt} IS NULL
    AND ${trendRuns.searchRequestId} IS NULL AND ${trendRuns.recipeId} IS NULL)
    OR (${trendRuns.status} = 'generating' AND ${trendRuns.searchFinishedAt} IS NOT NULL
      AND ${trendRuns.recipeId} IS NOT NULL AND ${trendRuns.searchDiagnostics}->'preparation' IS NULL
      AND NOT EXISTS (SELECT 1 FROM ai_job j WHERE j.recipe_id = ${trendRuns.recipeId}))`;
  const [run] = await db.select().from(trendRuns).where(and(eq(trendRuns.mode, 'daily'),
    eq(trendRuns.date, date), sql`(${unstarted()})`, lt(trendRuns.updatedAt, new Date(now.getTime() - 120_000)))).limit(1);
  if (!run) {
    const [today] = await db.select({ id: trendRuns.id }).from(trendRuns)
      .where(and(eq(trendRuns.date, date), isNull(trendRuns.manualRequestKey))).limit(1);
    if (today) return false;
    try {
      const admitted = await admitTrendRun('daily', undefined, now);
      return !('skipped' in admitted) && admitted.created && startPreparationWorkflow(admitted.run.id, admitted.generation);
    } catch (error) {
      if (error instanceof TrendError && error.code === 'TREND_ACTIVE') return false;
      throw error;
    }
  }
  let generation = run.generation;
  if (run.workflowId) {
    const status = await getRun(run.workflowId).status;
    if (!['completed', 'failed', 'cancelled'].includes(status)) return false;
    const [claimed] = await db.transaction(async tx => {
      await budgetLock(tx);
      return tx.update(trendRuns).set({ workflowId: null, generation: generation + 1, updatedAt: now })
        .where(and(eq(trendRuns.id, run.id), eq(trendRuns.generation, generation), eq(trendRuns.workflowId, run.workflowId!), sql`(${unstarted()})`)).returning();
    });
    if (!claimed) return false;
    generation = claimed.generation;
  }
  return startPreparationWorkflow(run.id, generation);
}

async function readRetainedDraft(job: Job) {
  const { ancestorRequestIds } = await recipeRecoverySubmission(job.id);
  return pollText(job.model, job.providerRequestId!, job.input, ancestorRequestIds,
    raw => resolveRecipeIngredients(job, raw, { localOnly: true }),
    recipeResponseCheckpoint(job.id), { draft: true, checkpointOnly: true });
}

function mayFinish(run: Run, now: Date) {
  return run.mode === 'daily' && run.searchFinishedAt && !run.searchDiagnostics?.preparation
    && (['failed', 'uncertain'].includes(run.status)
      || run.status === 'generating' && run.updatedAt.getTime() < now.getTime() - staleMinutes * 60_000);
}

/** Re-apply an already paid result using only durable local evidence. */
export async function recoverDailyRecipeDrafts(now = new Date()) {
  const db = getDb();
  const cutoff = new Date(now.getTime() - recoveryDays * 86_400_000);
  const stale = new Date(now.getTime() - staleMinutes * 60_000);
  const candidates = await db.select({ run: trendRuns, job: aiJobs }).from(trendRuns)
    .innerJoin(aiJobs, and(eq(aiJobs.trendRunId, trendRuns.id), eq(aiJobs.recipeId, trendRuns.recipeId)))
    .innerJoin(editorialRecipes, and(eq(editorialRecipes.id, aiJobs.recipeId), eq(editorialRecipes.revision, trendRuns.expectedRevision)))
    .leftJoin(recipeResponses, eq(recipeResponses.jobId, aiJobs.id))
    .where(and(eq(trendRuns.mode, 'daily'), isNotNull(trendRuns.searchFinishedAt),
      eq(aiJobs.kind, 'recipe'), eq(aiJobs.provider, 'openai'), isNotNull(aiJobs.providerRequestId),
      isNull(editorialRecipes.deletedAt),
      sql`${trendRuns.createdAt} >= ${cutoff.toISOString()} AND ${trendRuns.searchDiagnostics}->'preparation' IS NULL
        AND NOT EXISTS (SELECT 1 FROM ai_job newer WHERE newer.recipe_id = ${aiJobs.recipeId}
          AND (newer.created_at > ${aiJobs.createdAt} OR (newer.created_at = ${aiJobs.createdAt} AND newer.id < ${aiJobs.id})))`,
      sql`(${inArray(trendRuns.status, ['failed', 'uncertain'])} OR (${eq(trendRuns.status, 'generating')} AND ${lt(trendRuns.updatedAt, stale)}))`,
      sql`((${aiJobs.status} = 'applied' AND ${aiJobs.appliedRevision} = ${editorialRecipes.revision}) OR
        (${aiJobs.baseRevision} = ${editorialRecipes.revision} AND
          (${aiJobs.status} = 'ready' OR (${aiJobs.status} IN ('failed','uncertain','generating') AND ${recipeResponses.jobId} IS NOT NULL))))`))
    .orderBy(desc(trendRuns.createdAt), desc(aiJobs.createdAt)).limit(10);

  let recovered = 0;
  for (const { run, job } of candidates) {
    try {
      if (await recoverDraft(run, job, now)) recovered++;
    } catch (error) {
      const code = error instanceof ProviderError ? error.code : 'DAILY_DRAFT_RECOVERY_UNAVAILABLE';
      console.warn(JSON.stringify({ event: 'daily_draft_recovery_deferred', runId: run.id, jobId: job.id, code }));
    }
  }
  return { checked: candidates.length, recovered };
}

async function recoverDraft(snapshot: Run, candidate: Job, now: Date) {
  // An editorial correction uses the explicit review flow and cannot race this worker.
  const repair = await latestManualRecipeRepair(candidate.id);
  if (repair) return false;
  const alreadyApplied = candidate.status === 'applied';
  const expectedRevision = alreadyApplied ? candidate.appliedRevision : candidate.baseRevision;
  const result = candidate.status === 'ready' || alreadyApplied ? null : await readRetainedDraft(candidate);
  if (result && !result.done) return false;
  const applied = await getDb().transaction(async tx => {
    await budgetLock(tx);
    const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, snapshot.id)).for('update');
    if (!run || !mayFinish(run, now) || run.generation !== snapshot.generation || run.expectedRevision !== expectedRevision
      || run.recipeId !== candidate.recipeId || run.updatedAt.getTime() !== snapshot.updatedAt.getTime()) return false;
    const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, candidate.recipeId)).for('update');
    if (!recipe || recipe.deletedAt || recipe.editorialStatus !== 'draft' || recipe.revision !== expectedRevision
      || !alreadyApplied && contentApprovalHash(recipe.content) !== contentApprovalHash(candidate.input)) return false;
    const jobs = await tx.select().from(aiJobs).where(eq(aiJobs.recipeId, candidate.recipeId)).orderBy(desc(aiJobs.createdAt), asc(aiJobs.id)).for('update');
    const job = jobs[0];
    if (!job || job.id !== candidate.id || job.status !== candidate.status || job.updatedAt.getTime() !== candidate.updatedAt.getTime()
      || job.providerRequestId !== candidate.providerRequestId || await latestManualRecipeRepair(job.id, tx)) return false;
    if (jobs.slice(1).some(other => ['queued', 'submitting', 'generating', 'uncertain'].includes(other.status)
      || other.providerRequestId && !other.providerFinishedAt)) return false;
    if (!alreadyApplied) {
      await tx.update(trendRuns).set({ status: 'generating' }).where(eq(trendRuns.id, run.id));
      if (result) await finishRecipeInTransaction(tx, job, result.content, result.cost, result.notes, { verifiedResearchSources: true, retained: true });
      await applyTrendJobsInTransaction(tx, run.id, [job.id], recipe.revision, run.generation);
    }
    await tx.update(trendRuns).set({ status: 'awaiting_review', packetRemainingUsd: '0', error: manualEditorialReviewReason, updatedAt: new Date() })
      .where(eq(trendRuns.id, run.id));
    return true;
  });
  if (applied) console.info(JSON.stringify({ event: 'daily_draft_recovered', runId: snapshot.id, jobId: candidate.id }));
  return applied;
}
