import 'server-only';
import { eq } from 'drizzle-orm';
import type { EditorialActor } from '@/lib/editorial-types';
import type { EditorialTransaction } from '@/server/editorial/store';
import { trendRuns } from './schema';
export const trendWorker: EditorialActor = { id: 'jesie-trend-worker', name: 'Radar przepisów', email: '', role: 'trend_worker' };
/** No user account or HTTP payload can grant this scope. Scope is a stored run and its own immutable recipe ID. */
export async function requireTrendScope(tx: EditorialTransaction, runId: string, recipeId?: string, allowNew = false) {
    const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, runId)).for('update');
    if (!run || run.status !== 'generating' || (recipeId && run.recipeId !== recipeId) || (!allowNew && !run.recipeId))
        throw new Error('TREND_SCOPE_BLOCKED');
    return run;
}
