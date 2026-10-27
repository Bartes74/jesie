import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/server/db';
import { collectionThemeJobs as jobs } from './theme-schema';
import type { CollectionTransaction } from './store';

/** Kept independent from provider/workflow modules so ordinary AI admission can read totals. */
export async function collectionGenerationBudget(db: ReturnType<typeof getDb> | CollectionTransaction = getDb()) {
  const [row] = await db.select({ active: sql<number>`count(*) filter (where ${jobs.status} IN ('submitting','generating','uncertain') AND ${jobs.providerFinishedAt} IS NULL)::int`,
    pending: sql<number>`count(*) filter(where ${jobs.chargedUsd} IS NULL AND ${jobs.providerRequestId} IS NOT NULL)::int`,
    daily: sql<string>`coalesce(sum(${jobs.chargedUsd}) filter(where ${jobs.createdAt} >= date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::text`,
    monthly: sql<string>`coalesce(sum(${jobs.chargedUsd}) filter(where ${jobs.createdAt} >= date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::text`,
    total: sql<string>`coalesce(sum(${jobs.chargedUsd}),0)::text`,
  }).from(jobs);
  return row;
}
