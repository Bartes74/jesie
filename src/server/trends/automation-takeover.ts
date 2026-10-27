import 'server-only';
import { sql } from 'drizzle-orm';
import type { EditorialTransaction } from '@/server/editorial/store';

/** Immutable ownership history survives worker writes and diagnostic replacement. */
export async function hasManualAutomationTakeover(tx: EditorialTransaction, runId: string): Promise<boolean> {
  const result = await tx.execute(sql`SELECT EXISTS (
    SELECT 1 FROM trend_run r WHERE r.id=${runId} AND (
      (r.search_diagnostics->'preparation' IS NOT NULL AND r.search_diagnostics->'preparation'<>'null'::jsonb)
      OR EXISTS (SELECT 1 FROM trend_automation_takeover t WHERE t.run_id=r.id OR t.recipe_id=r.recipe_id)
    )
  ) AS taken_over`);
  return Boolean((result.rows[0] as { taken_over: boolean }).taken_over);
}
