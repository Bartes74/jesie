import 'server-only';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { AiJob } from '@/lib/ai-types';
import { getDb } from '@/server/db';
import { editorialRecipes } from '@/server/db/schema';
import { contentApprovalHash } from '@/server/editorial/content-approval';
import type { AiTransaction } from './store';
import { aiJobs, aiRecipeRecoveries } from './schema';
import { ProviderError } from './provider-error';
import { confirmedInvalidRecipe, hasUnrecognisedDietaryIngredient, recipeIssuesAllowAutomaticRepair, recipeReceiptCanBeRead, recipeRecoveryReason, recipeRepairLimit, recipeValidationIssues, type RecipeValidationIssue } from './recipe-recovery-policy';

type JobRow = typeof aiJobs.$inferSelect;
type Database = ReturnType<typeof getDb> | AiTransaction;
type RecoveryEntry = typeof aiRecipeRecoveries.$inferSelect;
type ReadableJob = Pick<JobRow, 'id' | 'kind' | 'provider' | 'status' | 'errorCode' | 'providerRequestId' | 'result' | 'input'>;

/** Only a deliberately blocked, unsent vocabulary repair may reveal its ancestor. */
function readableRecoveryEntry(chain: readonly RecoveryEntry[], latest: RecoveryEntry, jobs: readonly ReadableJob[]): RecoveryEntry {
  const blocked = jobs.find(job => job.id === latest.jobId);
  if (!blocked || blocked.status !== 'failed' || blocked.errorCode !== 'RECIPE_DIET_VOCABULARY_UNSUPPORTED'
    || blocked.providerRequestId || blocked.result) return latest;
  const capturedHash = contentApprovalHash(blocked.input);
  return [...chain].sort((a, b) => b.attempt - a.attempt).find(entry => {
    const candidate = jobs.find(job => job.id === entry.jobId);
    return entry.attempt < latest.attempt && candidate?.kind === 'recipe' && candidate.provider === 'openai'
      && Boolean(candidate.providerRequestId) && contentApprovalHash(candidate.input) === capturedHash
      && (recipeReceiptCanBeRead(candidate) || ['generating', 'ready', 'applied'].includes(candidate.status));
  }) ?? latest;
}

/** Shared by the dispatcher and recovery admission; it never submits a request. */
export async function recipeRecoveryReadableState(id: string, db: Database = getDb()) {
  const lineage = await recipeRecoveryLineage(id, db);
  const ids = lineage ? lineage.chain.map(entry => entry.jobId) : [id];
  const jobs = await db.select().from(aiJobs).where(inArray(aiJobs.id, ids));
  const entry = lineage ? readableRecoveryEntry(lineage.chain, lineage.latest, jobs) : null;
  return { lineage, entry, job: jobs.find(job => job.id === (entry?.jobId ?? id)) };
}

/** Only verified, charged terminal validation failures authorize a repair POST. */
export async function recordRecipeValidationFailure(tx: AiTransaction, job: JobRow, issues: readonly RecipeValidationIssue[], repairable: boolean) {
  if (!confirmedInvalidRecipe(job)) return;
  const safeIssues = recipeValidationIssues(issues);
  const canRepair = repairable && recipeIssuesAllowAutomaticRepair(issues) && safeIssues.length > 0;
  const blockedCode = hasUnrecognisedDietaryIngredient(issues) ? 'RECIPE_DIET_VOCABULARY_UNSUPPORTED' : null;
  const blockedMessage = blockedCode ? 'Aplikacja nie rozpoznaje składnika potrzebnego do klasyfikacji dania. Zachowano wynik; automatyczne płatne poprawki są wstrzymane.' : null;
  await tx.insert(aiRecipeRecoveries).values({ jobId: job.id, rootJobId: job.id, attempt: 0,
    failureIssues: safeIssues, repairable: canRepair, blockedCode, blockedMessage }).onConflictDoUpdate({ target: aiRecipeRecoveries.jobId,
    set: { failureIssues: safeIssues, repairable: canRepair, blockedCode, blockedMessage, updatedAt: new Date() } });
}

export async function recipeRecoveryLineage(id: string, db: Database = getDb()) {
  const [entry] = await db.select().from(aiRecipeRecoveries).where(eq(aiRecipeRecoveries.jobId, id));
  if (!entry) return null;
  const chain = await db.select().from(aiRecipeRecoveries).where(eq(aiRecipeRecoveries.rootJobId, entry.rootJobId)).orderBy(desc(aiRecipeRecoveries.attempt));
  return { entry, chain, latest: chain[0] };
}

/** The provider receives only receipts from this immutable, bounded lineage. */
export async function recipeRecoverySubmission(id: string, options: { forSubmission?: boolean } = {}) {
  const lineage = await recipeRecoveryLineage(id);
  if (!lineage) return { repair: null, ancestorRequestIds: [] as string[] };
  // A queued child admitted by an older build must not buy an ineffective repair.
  // Receipt reads still need the ancestor chain for an already accepted request.
  if (options.forSubmission && lineage.entry.attempt > 0 && hasUnrecognisedDietaryIngredient(lineage.entry.repairIssues)) {
    throw new ProviderError('RECIPE_DIET_VOCABULARY_UNSUPPORTED',
      'Aplikacja nie rozpoznaje składnika potrzebnego do klasyfikacji dania. Zachowano wynik; automatyczne płatne poprawki są wstrzymane.');
  }
  const ancestors = lineage.chain.filter(entry => entry.attempt < lineage.entry.attempt).sort((a, b) => a.attempt - b.attempt);
  const rows = ancestors.length ? await getDb().select({ id: aiJobs.id, receipt: aiJobs.providerRequestId }).from(aiJobs).where(inArray(aiJobs.id, ancestors.map(entry => entry.jobId))) : [];
  const ancestorRequestIds = ancestors.map(entry => rows.find(row => row.id === entry.jobId)?.receipt).filter((id): id is string => Boolean(id));
  if (ancestorRequestIds.length !== ancestors.length || ancestors.length !== lineage.entry.attempt) throw new Error('RECIPE_RECOVERY_LINEAGE_INVALID');
  return { repair: lineage.entry.attempt > 0 ? { previousResponseId: ancestorRequestIds.at(-1)!, issues: lineage.entry.repairIssues } : null, ancestorRequestIds };
}

/** Duplicate workflow starts lose ownership before reaching the paid submission. */
export async function claimRecipeRecoveryWorker(id: string, generation: number, workflowRunId: string) {
  return getDb().transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('jesie-ai-budget'))`);
    const [entry] = await tx.select().from(aiRecipeRecoveries).where(eq(aiRecipeRecoveries.jobId, id)).for('update');
    if (!entry) return true; // Ordinary first-generation jobs predate validation recovery.
    if (entry.generation !== generation || entry.workflowRunId && entry.workflowRunId !== workflowRunId) return false;
    if (!entry.workflowRunId) await tx.update(aiRecipeRecoveries).set({ workflowRunId, dispatchClaimedAt: entry.dispatchClaimedAt ?? new Date(), updatedAt: new Date() }).where(eq(aiRecipeRecoveries.jobId, id));
    const [job] = await tx.select().from(aiJobs).where(eq(aiJobs.id, id)).for('update');
    if (job?.kind === 'recipe' && job.status === 'uncertain' && job.errorCode === 'AI_RECOVERY_DISPATCH_UNCONFIRMED' && job.providerRequestId && !job.result)
      await tx.update(aiJobs).set({ status: 'generating', errorCode: null, errorMessage: null, updatedAt: new Date() }).where(eq(aiJobs.id, id));
    return true;
  });
}

export async function withRecipeRecovery(jobs: AiJob[], db: Database = getDb()): Promise<AiJob[]> {
  const ids = jobs.filter(job => job.kind === 'recipe').map(job => job.id);
  if (!ids.length) return jobs;
  const entries = await db.select().from(aiRecipeRecoveries).where(or(inArray(aiRecipeRecoveries.rootJobId, ids),
    sql`${aiRecipeRecoveries.rootJobId} IN (SELECT root_job_id FROM ai_recipe_recovery WHERE job_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)}))`));
  const latestByRoot = new Map<string, typeof aiRecipeRecoveries.$inferSelect>();
  for (const entry of entries) if (!latestByRoot.has(entry.rootJobId) || latestByRoot.get(entry.rootJobId)!.attempt < entry.attempt) latestByRoot.set(entry.rootJobId, entry);
  const lookupIds = [...new Set([...ids, ...entries.map(entry => entry.jobId)])];
  const rows = await db.select({ id: aiJobs.id, recipeId: aiJobs.recipeId, kind: aiJobs.kind, provider: aiJobs.provider, status: aiJobs.status,
    baseRevision: aiJobs.baseRevision, errorCode: aiJobs.errorCode, providerRequestId: aiJobs.providerRequestId, providerFinishedAt: aiJobs.providerFinishedAt,
    chargedUsd: aiJobs.chargedUsd, costBasis: aiJobs.costBasis, result: aiJobs.result, input: aiJobs.input,
    revision: editorialRecipes.revision, deletedAt: editorialRecipes.deletedAt, editorialStatus: editorialRecipes.editorialStatus }).from(aiJobs)
    .innerJoin(editorialRecipes, eq(editorialRecipes.id, aiJobs.recipeId)).where(inArray(aiJobs.id, lookupIds));
  return jobs.map(job => {
    if (job.kind !== 'recipe') return job;
    const entry = entries.find(entry => entry.jobId === job.id);
    const actualLatestEntry = entry ? latestByRoot.get(entry.rootJobId) : latestByRoot.get(job.id);
    const rootId = entry?.rootJobId ?? job.id;
    const latestEntry = actualLatestEntry ? readableRecoveryEntry(entries.filter(item => item.rootJobId === rootId), actualLatestEntry, rows) : undefined;
    const latest = rows.find(row => row.id === (latestEntry?.jobId ?? job.id));
    if (!latest || !latestEntry && !(latest.status === 'failed' && latest.errorCode === 'AI_RESULT_INVALID' || latest.status === 'uncertain')) return job;
    const attempt = actualLatestEntry?.attempt ?? 0;
    const stale = latest.baseRevision !== latest.revision || Boolean(latest.deletedAt) || latest.editorialStatus === 'archived';
    const ready = Boolean(latest.result && ['ready', 'applied'].includes(latest.status));
    const recovering = !stale && ['queued', 'submitting', 'generating'].includes(latest.status);
    const unsupportedVocabulary = !ready && !recovering && (latestEntry?.blockedCode === 'RECIPE_DIET_VOCABULARY_UNSUPPORTED'
      || rows.find(row => row.id === actualLatestEntry?.jobId)?.errorCode === 'RECIPE_DIET_VOCABULARY_UNSUPPORTED'
      || hasUnrecognisedDietaryIngredient(latestEntry?.failureIssues ?? []));
    const exhausted = !ready && !unsupportedVocabulary && latest.status === 'failed' && latest.errorCode === 'AI_RESULT_INVALID' && attempt >= recipeRepairLimit;
    const safeQueuedChild = Boolean(latestEntry && latestEntry.attempt > 0 && latest.status === 'queued' && !latest.providerRequestId && !latest.result);
    const canResume = !stale && (recipeReceiptCanBeRead(latest) || safeQueuedChild || latest.status === 'generating' && Boolean(latest.providerRequestId))
      && (latest.status !== 'failed' || Boolean(latest.providerFinishedAt));
    return { ...job, recovery: { status: ready ? 'ready' : exhausted ? 'exhausted' : recovering ? 'recovering' : 'blocked', attempt, maxAttempts: recipeRepairLimit,
      jobId: latest.id, canResume, code: stale ? 'STALE_RESULT' : unsupportedVocabulary ? 'RECIPE_DIET_VOCABULARY_UNSUPPORTED' : latestEntry?.blockedCode ?? latest.errorCode ?? undefined,
      issues: latestEntry?.failureIssues ?? [], reason: stale ? 'Przepis zmienił się od tego zlecenia. Zachowano wynik; rozpocznij opracowanie bieżącej wersji.'
        : unsupportedVocabulary ? 'Aplikacja nie rozpoznaje składnika potrzebnego do klasyfikacji dania. Zachowano wynik; automatyczne płatne poprawki są wstrzymane.'
        : exhausted ? canResume
          ? 'Wykorzystano dwie automatyczne poprawki. Możesz ponownie sprawdzić zapisany wynik bez kolejnej generacji. Jeśli błędy pozostaną, popraw wskazówki przed nowym opracowaniem.'
          : 'Dwie próby poprawy nie wystarczyły. Sprawdź wskazane pola i popraw wskazówki przed nowym opracowaniem.'
        : ready ? 'Przepis jest gotowy do Twojego sprawdzenia.' : recovering ? 'System odczytuje istniejący wynik lub poprawia wskazane pola. Nie trzeba ponownie zlecać generowania.'
        : latestEntry?.blockedMessage ?? (latest.errorCode === 'AI_RESULT_INVALID' ? 'Najpierw odczytamy i sprawdzimy istniejący wynik bez nowej generacji. W razie potrzeby system wykona najwyżej dwie rozliczane poprawki.' : recipeRecoveryReason(latest.errorCode)) } };
  });
}

export async function pauseRecipeRecovery(id: string, generation: number, code: string, message: string) {
  await getDb().update(aiRecipeRecoveries).set({ blockedCode: code.slice(0, 100), blockedMessage: message.slice(0, 1000), updatedAt: new Date() })
    .where(and(eq(aiRecipeRecoveries.jobId, id), eq(aiRecipeRecoveries.generation, generation)));
}
