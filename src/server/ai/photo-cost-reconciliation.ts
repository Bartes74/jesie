import 'server-only';
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import type { EditorialActor } from '@/lib/editorial-types';
import type { PhotoCostReconciliationReport } from '@/lib/photo-cost-reconciliation-types';
import { getDb } from '@/server/db';
import { AiError } from './errors';
import { aiJobs } from './schema';
import { budget, budgetLock, settleCostInTransaction, trustedActor, type AiTransaction } from './store';
import { readPhotoBills, type PhotoBillingRead } from './photo-billing-reader';

export const photoCostReconciliationLimit = 500;
const automatedTrendReconciliationLimit = 50;
type ReconciliationScope = 'studio' | 'trends';
const finishedStatuses = ['ready', 'applied', 'failed', 'cancelled', 'uncertain'] as const;
const candidateFields = {
  id: aiJobs.id, recipeId: aiJobs.recipeId, kind: aiJobs.kind, targetId: aiJobs.targetId,
  provider: aiJobs.provider, providerRequestId: aiJobs.providerRequestId, model: aiJobs.model,
  trendRunId: aiJobs.trendRunId, status: aiJobs.status, providerFinishedAt: aiJobs.providerFinishedAt,
  reservedUsd: aiJobs.reservedUsd, chargedUsd: aiJobs.chargedUsd, costBasis: aiJobs.costBasis, createdAt: aiJobs.createdAt,
};
function eligibleJobs(scope: ReconciliationScope) {
  return and(scope === 'studio' ? isNull(aiJobs.trendRunId) : isNotNull(aiJobs.trendRunId), eq(aiJobs.provider, 'fal'), inArray(aiJobs.kind, ['hero', 'ingredient', 'step']),
    inArray(aiJobs.status, [...finishedStatuses]), isNotNull(aiJobs.providerFinishedAt), isNotNull(aiJobs.providerRequestId),
    sql`${aiJobs.providerRequestId} ~ '^[A-Za-z0-9_-]{1,100}$'`, or(isNull(aiJobs.costBasis), ne(aiJobs.costBasis, 'usage')));
}

async function scopeBudget(scope: ReconciliationScope, tx: AiTransaction) {
  if (scope === 'studio') {
    const value = await budget(tx);
    return { checkedAt: value.serverNow!, usedUsd: value.pilotUsedUsd, reservedUsd: value.reservedUsd };
  }
  const { trendBudget } = await import('../trends/store');
  const value = await trendBudget(tx);
  const clock = await tx.execute(sql`SELECT clock_timestamp() AS now`);
  return { checkedAt: new Date((clock.rows[0] as { now: Date | string }).now).toISOString(), usedUsd: value.usedUsd, reservedUsd: value.reservedUsd };
}

/** Reject ambiguous/malformed billing data before any cost can be changed. */
function verifiedRead(read: PhotoBillingRead, requestIds: ReadonlySet<string>): PhotoBillingRead {
  if (!['verified', 'pending'].includes(read.status)) return { ...read, costs: {} };
  if (Object.entries(read.costs).some(([id, amount]) => !requestIds.has(id) || !/^\d+(?:\.\d{1,8})?$/.test(amount))) {
    return { status: 'invalid', httpStatus: read.httpStatus, costs: {} };
  }
  return read;
}

/** Studio history only: captured receipts, billing GETs and exact ledger settlement. Never submits a generator request. */
export async function reconcilePhotoCosts(actor: EditorialActor, reader: typeof readPhotoBills = readPhotoBills): Promise<PhotoCostReconciliationReport> {
  return reconcileScopedPhotoCosts('studio', reader, actorAuthorizer(actor));
}

/** Trend receipts use their own monthly budget; this never admits or resumes a run. */
export async function reconcileTrendPhotoCosts(actor: EditorialActor, reader: typeof readPhotoBills = readPhotoBills): Promise<PhotoCostReconciliationReport> {
  return reconcileScopedPhotoCosts('trends', reader, actorAuthorizer(actor));
}

/** Only the owner's currently enabled automation may reconcile its captured receipts. */
export async function reconcileAutomatedTrendPhotoCosts(reader: typeof readPhotoBills = readPhotoBills): Promise<PhotoCostReconciliationReport> {
  return reconcileScopedPhotoCosts('trends', reader, async tx => {
    const { trendAutomationGate } = await import('../trends/store');
    const gate = await trendAutomationGate(tx);
    if (!gate.enabled || !gate.authorizedOwnerId) throw new AiError(403, 'TREND_AUTOMATION_DISABLED', 'Aktywny właściciel musi zatwierdzić włączony harmonogram przed uzgodnieniem rachunków.');
  }, automatedTrendReconciliationLimit);
}

function actorAuthorizer(actor: EditorialActor) {
  return async (tx: AiTransaction) => {
    if (!['owner', 'admin'].includes(actor.role)) throw new AiError(403, 'FORBIDDEN', 'To konto nie ma dostępu do rozliczeń.');
    await trustedActor(tx, actor.id);
  };
}

async function reconcileScopedPhotoCosts(scope: ReconciliationScope, reader: typeof readPhotoBills, authorize: (tx: AiTransaction) => Promise<void>, limit = photoCostReconciliationLimit): Promise<PhotoCostReconciliationReport> {
  const capture = await getDb().transaction(async tx => {
    await budgetLock(tx); await authorize(tx);
    const rows = await tx.select(candidateFields).from(aiJobs).where(eligibleJobs(scope)).orderBy(asc(aiJobs.createdAt), asc(aiJobs.id)).limit(limit + 1);
    const before = await scopeBudget(scope, tx);
    return { jobs: rows.slice(0, limit), limited: rows.length > limit,
      before: { usedUsd: before.usedUsd, reservedUsd: before.reservedUsd } };
  });
  const requests = capture.jobs.map(job => ({ requestId: job.providerRequestId!, createdAt: job.createdAt }));
  // The existing reader groups at most 50 exact request IDs and performs GETs
  // outside database locks. Missing bills and HTTP 403 preserve every estimate.
  let read: PhotoBillingRead;
  try { read = verifiedRead(await reader(requests), new Set(requests.map(request => request.requestId))); }
  catch { read = { status: 'unavailable', httpStatus: null, costs: {} }; }
  return getDb().transaction(async tx => {
    await budgetLock(tx); await authorize(tx);
    const jobs = capture.jobs.length ? await tx.select(candidateFields).from(aiJobs)
      .where(inArray(aiJobs.id, capture.jobs.map(job => job.id))).orderBy(asc(aiJobs.id)).for('update') : [];
    let reconciledJobs = 0; let pendingJobs = 0; let alreadySettledJobs = 0;
    let verifiedCost = new Decimal(0);
    for (const source of capture.jobs) {
      const current = jobs.find(job => job.id === source.id);
      if (!current || current.recipeId !== source.recipeId || current.kind !== source.kind || current.targetId !== source.targetId
        || current.provider !== source.provider || current.model !== source.model || current.trendRunId !== source.trendRunId
        || current.providerRequestId !== source.providerRequestId) {
        throw new AiError(409, 'PHOTO_BILLING_RECEIPT_CHANGED', 'Identyfikator rachunku zmienił się. Zachowano dotychczasowe szacunki.');
      }
      if (current.costBasis === 'usage') { alreadySettledJobs++; continue; }
      const cost = read.costs[source.providerRequestId!];
      if (cost === undefined || !current.providerFinishedAt || !finishedStatuses.includes(current.status as typeof finishedStatuses[number])) {
        pendingJobs++; continue;
      }
      await settleCostInTransaction(tx, current.id, { chargedUsd: cost, costBasis: 'usage' });
      reconciledJobs++; verifiedCost = verifiedCost.plus(cost);
    }
    const [remaining] = await tx.select({ count: sql<number>`count(*)::int` }).from(aiJobs).where(eligibleJobs(scope));
    const after = await scopeBudget(scope, tx);
    return {
      checkedAt: after.checkedAt, scannedJobs: capture.jobs.length, reconciledJobs, pendingJobs, alreadySettledJobs,
      remainingJobs: remaining.count, limited: capture.limited,
      estimatedCostBeforeUsd: capture.jobs.reduce((total, job) => total.plus(job.chargedUsd ?? job.reservedUsd), new Decimal(0)).toFixed(8),
      verifiedCostUsd: verifiedCost.toFixed(8), before: capture.before, after: { usedUsd: after.usedUsd, reservedUsd: after.reservedUsd },
      read: { status: read.status, httpStatus: read.httpStatus },
    };
  });
}
