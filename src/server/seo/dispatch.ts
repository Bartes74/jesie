import 'server-only';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { getRun, start } from 'workflow/api';
import { isProductionIndexable } from '@/lib/seo';
import { getDb } from '@/server/db';
import { editorialOutbox } from '@/server/db/schema';
import { attachDiscoveryWorkflow, reserveDiscoveryWorkflow, type DiscoveryDispatchLease } from './discovery';
import { notifyDiscoveryEvent } from '@/workflows/seo-discovery';

type DispatchDependencies = {
  production: () => boolean;
  start: (lease: DiscoveryDispatchLease) => Promise<{ runId: string }>;
  state: (id: string) => Promise<string>;
  cancel: (id: string) => Promise<unknown>;
};
const defaults: DispatchDependencies = {
  production: isProductionIndexable,
  start: lease => start(notifyDiscoveryEvent,[lease.eventId,lease.generation,lease.token],{region:'fra1'}),
  state: async id => { const run=getRun(id);return await run.exists ? await run.status : 'missing'; },
  cancel: id => getRun(id).cancel(),
};

/** An event starts one active worker; failed dispatches retain a ten-minute recovery lease. */
export async function dispatchDiscoveryWorkflows(options: {
  recipeId?: string; eventId?: string; limit?: number;
  continueFrom?: { id: string; generation: number };
  dependencies?: Partial<DispatchDependencies>;
} = {}) {
  const dependencies={...defaults,...options.dependencies};
  const result={enabled:dependencies.production(),started:0,active:0,locked:0,failed:0};
  if (!result.enabled) return result;
  const rows=await getDb().select().from(editorialOutbox).where(and(isNull(editorialOutbox.processedAt),
    ...(options.recipeId?[eq(editorialOutbox.recipeId,options.recipeId)]:[]),
    ...(options.eventId?[eq(editorialOutbox.id,options.eventId)]:[])))
    .orderBy(sql`CASE WHEN ${editorialOutbox.discoveryWorkflowId} IS NULL AND (${editorialOutbox.discoveryDispatchExpiresAt} IS NULL OR ${editorialOutbox.discoveryDispatchExpiresAt} <= now()) THEN 0 WHEN ${editorialOutbox.discoveryWorkflowId} IS NOT NULL THEN 1 ELSE 2 END`,asc(editorialOutbox.createdAt)).limit(Math.max(1,Math.min(50,options.limit??10)));
  for (const row of rows) {
    let previous: {id:string;generation:number}|undefined;
    if (row.discoveryWorkflowId) {
      if (options.continueFrom?.id===row.discoveryWorkflowId && options.continueFrom.generation===row.discoveryGeneration) previous=options.continueFrom;
      else {
        try {
          const status=await dependencies.state(row.discoveryWorkflowId);
          if (!['failed','cancelled','completed','missing'].includes(status)) { result.active++;continue; }
          previous={id:row.discoveryWorkflowId,generation:row.discoveryGeneration};
        } catch { result.locked++;continue; }
      }
    }
    const lease=await reserveDiscoveryWorkflow(row.id,previous);
    if (!lease) {result.locked++;continue;}
    try {
      const run=await dependencies.start(lease);
      if (await attachDiscoveryWorkflow(lease.eventId,lease.generation,lease.token,run.runId)) result.started++;
      else { await dependencies.cancel(run.runId);result.locked++; }
    } catch {
      // A lost response can hide an accepted start. Its startup step can attach
      // itself; do not discard the lease or immediately create a second worker.
      result.failed++;
    }
  }
  return result;
}
