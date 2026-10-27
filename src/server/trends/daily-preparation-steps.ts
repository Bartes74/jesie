import { FatalError, RetryableError } from 'workflow';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/server/db';
import { createJobAdmission, getJobForExecution } from '@/server/ai/store';
import { isRecoverableHeroSource } from '@/server/ai/image-actions';
import { trendWorker } from './actor';
import { getTrendExecution } from './store';
import { trendRuns } from './schema';

/** Duplicate workflow delivery cannot become a second preparation worker. */
export async function claimDailyPreparation(id: string, generation: number, workflowId: string) {
  'use step';
  return getDb().transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('jesie-ai-budget'))`);
    const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id)).for('update');
    if (!run || run.generation !== generation || !['queued', 'searching', 'generating'].includes(run.status)
      || run.workflowId && run.workflowId !== workflowId) return false;
    await tx.update(trendRuns).set({ workflowId, updatedAt: new Date() }).where(and(eq(trendRuns.id, id), eq(trendRuns.generation, generation)));
    return true;
  });
}

/** Correct a confirmed opaque hero once, using its stored pixels, never another image generation. */
export async function repairDailyHero(id: string, generation: number, sourceJobId: string) {
  'use step';
  const run = await getTrendExecution(id);
  if (run.generation !== generation || run.status !== 'generating' || !run.recipeId || !run.expectedRevision) throw new FatalError('TREND_SUPERSEDED');
  const source = await getJobForExecution(sourceJobId);
  if (source.trendRunId !== id || !isRecoverableHeroSource(source, run.recipeId)) return null;
  try {
    return (await createJobAdmission({
      recipeId: run.recipeId, expectedRevision: run.expectedRevision, kind: 'hero',
      imageAction: 'cutout_result', sourceJobId,
      brief: 'Popraw przezroczystość istniejącej fotografii głównej, zachowując całą potrawę, naczynie i naturalne krawędzie.',
      requestKey: `trend_${id}_hero_cutout`,
    }, trendWorker, id, { generation })).job;
  } catch (error) {
    if ((error as { code?: string }).code === 'CONCURRENCY_LIMIT') throw new RetryableError('TREND_WAITING_FOR_SLOT', { retryAfter: '30s' });
    throw error;
  }
}
repairDailyHero.maxRetries = 60;
