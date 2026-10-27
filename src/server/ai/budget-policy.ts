import 'server-only';
import { eq, sql } from 'drizzle-orm';
import type { AiBudgetSettings, AiBudgetState } from '../../lib/ai-budget-types';
import { getDb } from '../db';
import { aiBudgetSettings } from './schema';

type Database = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type BudgetSettingsRow = typeof aiBudgetSettings.$inferSelect;

export function budgetState(row: BudgetSettingsRow): AiBudgetState {
  return {
    dailyLimitUsd: '0.00000000',
    monthlyLimitUsd: '0.00000000',
    pilotLimitUsd: '0.00000000',
    bypassUntil: null,
    source: row.dailyLimitUsd === null ? 'environment' : 'database',
  };
}
/** Re-evaluated at every admission, after its shared budget lock. DB wall time
 * includes time spent waiting for that lock; transaction now() would be stale. */
export async function readBudgetPolicy(db: Database | Transaction): Promise<AiBudgetSettings> {
  const [capture] = await db.select({ row: aiBudgetSettings, serverNow: sql<Date>`clock_timestamp()` })
    .from(aiBudgetSettings).where(eq(aiBudgetSettings.id, 'studio'));
  if (!capture) throw new Error('AI_BUDGET_SETTINGS_MISSING');
  return { ...budgetState(capture.row), revision: capture.row.revision, limitsEnforced: false,
    serverNow: new Date(capture.serverNow).toISOString(), updatedAt: capture.row.updatedAt.toISOString(), updatedByName: capture.row.updatedByName };
}
