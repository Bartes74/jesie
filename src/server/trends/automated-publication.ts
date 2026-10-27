import { isStepPhotoRequired } from '@/lib/step-photo-selection';
import 'server-only';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { EditorialActor, EditorialRecord } from '@/lib/editorial-types';
import type { TrendAutomation, TrendCandidate, TrendPublicationResult, TrendPublicationState, TrendRunStatus } from '@/lib/trend-types';
import { publicationTime, warsawPublicationDate } from '@/lib/daily-publication';
import { nextTrendSearchAt } from '@/lib/trend-search-budget';
import { getDb } from '@/server/db';
import { user } from '@/server/db/auth-schema';
import { editorialPublications, editorialRecipes } from '@/server/db/schema';
import { aiJobs } from '@/server/ai/schema';
import { hasRecipeContentApproval } from '@/server/editorial/content-approval';
import { contentHash, verifiedPublicationIssues } from '@/server/editorial/store';
import { trendCandidates, trendPublicationDays, trendRuns, trendSettings } from './schema';
import { isAutomaticPublicationRun } from './automation-policy';
import { hasManualAutomationTakeover } from './automation-takeover';
import { trendAutomationGate, TrendError } from './store';
import { manualPublicationReason } from './manual-editorial-policy';

type Database = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Day = typeof trendPublicationDays.$inferSelect;
const graceMs = 3_600_000;
async function lock(tx: Tx) { await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('jesie-ai-budget'))`); }
async function wallTime(tx: Database | Tx) {
  const result = await tx.execute(sql`SELECT clock_timestamp() AS now`);
  return new Date((result.rows[0] as { now: string | Date }).now);
}
function dayDto(row: Day) { return { date: row.date, dueAt: row.dueAt.toISOString(), status: row.status, generation: row.generation, workflowId: row.workflowId }; }
function timing(row: Day, now: Date) {
  if (now.getTime() < row.dueAt.getTime()) return 'early';
  return warsawPublicationDate(now) !== row.date || now.getTime() >= row.dueAt.getTime() + graceMs ? 'expired' : 'due';
}

/** Compatibility gate for old publisher callers. Research has its own enabled gate. */
export async function dailyAutomationGate(_db?: Database | Tx) {
  void _db;
  return { enabled: false, canEnable: false, authorizedOwnerId: null as string | null, reason: manualPublicationReason };
}

/** Only yesterday's new, verified daily search can supply this morning's slot. */
export async function automaticRecipeForDay(tx: Tx, date: string, now: Date, locking = true) {
  if (!(await dailyAutomationGate(tx)).enabled) return null;
  const query = tx.select({ run: trendRuns, recipe: editorialRecipes, candidate: trendCandidates }).from(trendRuns)
    .innerJoin(editorialRecipes, eq(editorialRecipes.id, trendRuns.recipeId))
    .innerJoin(trendCandidates, eq(trendCandidates.id, trendRuns.candidateId))
    .where(and(eq(trendRuns.mode, 'daily'), isNull(trendRuns.manualRequestKey), eq(trendRuns.status, 'awaiting_review'),
      sql`${trendRuns.date}::date = ${date}::date - 1`, isNull(editorialRecipes.deletedAt),
      eq(editorialRecipes.publicationStatus, 'never_published'), isNull(editorialRecipes.publishedId)));
  // Dashboards inspect eligibility without row locks; publication keeps the
  // authoritative locked read inside its existing guarded transaction.
  const rows = locking ? await query.for('update', { of: [trendRuns, editorialRecipes] }) : await query;
  for (const row of rows) {
    const { recipe, run, candidate } = row;
    if (!candidate.selected || candidate.runId !== run.id || !isAutomaticPublicationRun(run, candidate.data, date, now, await hasManualAutomationTakeover(tx, run.id))
      || run.expectedRevision !== recipe.revision || recipe.updatedBy !== 'jesie-trend-worker'
      || recipe.editorialStatus === 'archived' || contentHash(recipe.content) !== recipe.contentHash
      || !await hasRecipeContentApproval(tx, recipe, 'automated')) continue;
    const [pending] = await tx.select({ id: aiJobs.id }).from(aiJobs).where(and(eq(aiJobs.recipeId, recipe.id),
      sql`(${aiJobs.status} IN ('queued','submitting','generating','uncertain') OR (${aiJobs.status}='cancelled' AND ${aiJobs.providerFinishedAt} IS NULL) OR (${aiJobs.providerRequestId} IS NOT NULL AND ${aiJobs.providerFinishedAt} IS NULL))`)).limit(1);
    const content = structuredClone(recipe.content);
    for (const substitution of content.recipe.substitutions ?? []) substitution.status = 'approved';
    if (pending || !content.recipe.image || content.recipe.ingredients.some(item => !content.photos.ingredients[item.id])
      || content.recipe.steps.some(item => isStepPhotoRequired(content, item.id) && !content.photos.steps[item.id]) || (await verifiedPublicationIssues(content, tx)).length) continue;
    return row;
  }
  return null;
}

async function state(tx: Tx, row: Day, now: Date): Promise<TrendPublicationState> {
  const gate = await dailyAutomationGate(tx);
  const time = timing(row, now);
  const ready = row.status === 'pending' && gate.enabled && time !== 'expired' ? await automaticRecipeForDay(tx, row.date, now, false) : null;
  const reason = row.status === 'published' ? null : row.status === 'expired' || time === 'expired' ? 'Minęło dzisiejsze okno publikacji. Nie publikujemy zaległych przepisów.'
    : !gate.enabled ? gate.reason : time === 'early' ? 'Automatyczna publikacja czeka na 06:00 w Warszawie.'
    : ready ? null : 'Brak gotowego, potwierdzonego trendu z wczorajszego wyszukiwania. Ręczne szkice pozostają do Twojej decyzji.';
  return { ...dayDto(row), serverNow: now.toISOString(), canPublish: Boolean(ready && time === 'due'), reason };
}

export async function automatedPublicationState(date: string): Promise<TrendPublicationState> {
  publicationTime(date);
  return getDb().transaction(async tx => {
    await lock(tx);
    const [row] = await tx.select().from(trendPublicationDays).where(eq(trendPublicationDays.date, date));
    if (!row) throw new TrendError(404, 'PUBLICATION_DAY_NOT_FOUND', 'Nie przygotowano dzisiejszej publikacji.');
    return state(tx, row, await wallTime(tx));
  });
}

export async function publishVerifiedDailyRecipeInTransaction(tx: Tx, date: string, now: Date, generation?: number, freshClock: () => Promise<Date> = async () => now): Promise<TrendPublicationResult> {
  await lock(tx);
  publicationTime(date);
  void freshClock;
  const [row] = await tx.select().from(trendPublicationDays).where(eq(trendPublicationDays.date, date)).for('update');
  if (!row) throw new TrendError(404, 'PUBLICATION_DAY_NOT_FOUND', 'Nie przygotowano dawnego terminu publikacji.');
  if (generation !== undefined && row.generation !== generation) throw new TrendError(409, 'PUBLICATION_SUPERSEDED', 'Ten zegar publikacji zastąpiono.');
  return { status: 'disabled', state: await state(tx, row, now) };

}

export async function publishVerifiedDailyRecipe(date: string, generation?: number) {
  return getDb().transaction(async tx => { await lock(tx); return publishVerifiedDailyRecipeInTransaction(tx, date, await wallTime(tx), generation, () => wallTime(tx)); });
}

/** Research history can lag behind a later human action on its recipe. */
export function projectLatestResearch(
  run: Pick<typeof trendRuns.$inferSelect, 'id' | 'date' | 'recipeId' | 'status' | 'error'>,
  candidate: Pick<TrendCandidate, 'title' | 'eligible' | 'automaticSelection' | 'editorChoice'> | null,
  recipe: { title: EditorialRecord['content']['recipe']['title']; publicationStatus: EditorialRecord['publicationStatus']; editorialStatus: EditorialRecord['editorialStatus']; deleted: boolean } | null,
  takenOver: boolean,
) {
  let status: TrendRunStatus | 'deleted' | 'archived' = run.status;
  let reason = run.error ?? (takenOver ? 'Przepis został przejęty do ręcznego dokończenia. Publikacja nastąpi wyłącznie po kliknięciu „Publikuj” w edytorze.' : null);
  if (recipe?.deleted) { status = 'deleted'; reason = 'Przepis znajduje się w Koszu i nie oczekuje na ocenę.'; }
  else if (recipe?.editorialStatus === 'archived') { status = 'archived'; reason = 'Przepis znajduje się w archiwum i nie oczekuje na ocenę.'; }
  else if (recipe?.publicationStatus === 'published') { status = 'published'; reason = 'Przepis został już opublikowany.'; }
  return { runId: run.id, date: run.date, recipeId: run.recipeId, title: recipe?.title.pl ?? candidate?.title.pl ?? null, status,
    confirmedTrend: Boolean(candidate?.eligible && !candidate.automaticSelection && !candidate.editorChoice), reason };
}

export async function getDailyAutomationDashboard(actor?: EditorialActor) {
  return getDb().transaction(async tx => {
    await lock(tx);
    const now = await wallTime(tx);
    const gate = await trendAutomationGate(tx);
    const [settings] = await tx.select().from(trendSettings).where(eq(trendSettings.id, 'global'));
    const reviewRows = await tx.select({ run: trendRuns, recipe: editorialRecipes }).from(trendRuns)
      .innerJoin(editorialRecipes, eq(editorialRecipes.id, trendRuns.recipeId))
      .where(and(eq(trendRuns.status, 'awaiting_review'), isNull(editorialRecipes.deletedAt), ne(editorialRecipes.editorialStatus, 'archived'), eq(editorialRecipes.publicationStatus, 'never_published')))
      .orderBy(desc(trendRuns.createdAt)).limit(20);
    const [account] = actor ? await tx.select().from(user).where(eq(user.id, actor.id)) : [];
    const [published] = await tx.select({ publication: editorialPublications, day: trendPublicationDays }).from(trendPublicationDays)
      .innerJoin(editorialPublications, eq(editorialPublications.id, trendPublicationDays.publicationId))
      .where(and(eq(trendPublicationDays.status, 'published'), eq(editorialPublications.approvalOrigin, 'automated'))).orderBy(desc(trendPublicationDays.date)).limit(1);
    const [latest] = await tx.select({ run: trendRuns, candidate: trendCandidates, recipe: editorialRecipes }).from(trendRuns).leftJoin(trendCandidates, eq(trendCandidates.id, trendRuns.candidateId))
      .leftJoin(editorialRecipes, eq(editorialRecipes.id, trendRuns.recipeId))
      .where(and(eq(trendRuns.mode, 'daily'), isNull(trendRuns.manualRequestKey))).orderBy(desc(trendRuns.date)).limit(1);
    const takenOver = latest ? await hasManualAutomationTakeover(tx, latest.run.id) : false;
    return { enabled: Boolean(settings?.enabled), operational: gate.enabled, serverNow: now.toISOString(), autoPauseToken: settings?.autoPauseToken ?? null, reason: gate.reason, canEnable: gate.canEnable && (!actor || Boolean(account && !account.disabled && account.role === 'owner')),
      nextSearchAt: nextTrendSearchAt(now),
      reviewQueue: reviewRows.map(({ run, recipe }) => ({ runId: run.id, recipeId: recipe.id, title: recipe.content.recipe.title.pl, date: run.date, status: run.status })),
      lastPublication: published ? { recipeId: published.day.recipeId!, title: published.publication.snapshot.recipe.title.pl, publishedAt: published.day.publishedAt!.toISOString() } : null,
      latestResearch: latest ? projectLatestResearch(latest.run, latest.candidate?.data ?? null, latest.recipe ? {
        title: latest.recipe.content.recipe.title, publicationStatus: latest.recipe.publicationStatus,
        editorialStatus: latest.recipe.editorialStatus, deleted: Boolean(latest.recipe.deletedAt),
      } : null, takenOver) : null };
  });
}

export type DailyAutomationDashboard = Awaited<ReturnType<typeof getDailyAutomationDashboard>>;

/** Compatibility projection for Radar using the daily research and review queue. */
export async function getCanonicalTrendAutomation(actor?: EditorialActor): Promise<TrendAutomation> {
  const dashboard = await getDailyAutomationDashboard(actor);
  const published = dashboard.lastPublication;
  return { enabled: dashboard.operational, timezone: 'Europe/Warsaw', serverNow: dashboard.serverNow,
    nextSearchAt: dashboard.nextSearchAt, readyCount: dashboard.reviewQueue.length,
    publishedToday: published && warsawPublicationDate(new Date(published.publishedAt)) === warsawPublicationDate(new Date(dashboard.serverNow))
      ? { ...published, title: { pl: published.title, en: published.title } } : null,
    reason: dashboard.reason, canEnable: dashboard.canEnable };
}
