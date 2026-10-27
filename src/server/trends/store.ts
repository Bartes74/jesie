import { isStepPhotoRequired } from '@/lib/step-photo-selection';
import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { EditorialActor, EditorialRecord } from '@/lib/editorial-types';
import type { TrendBudget, TrendCandidate, TrendConfiguration, TrendDashboard, TrendPlatform, TrendPreparation, TrendResearchHint, TrendRun, TrendRunAction, TrendSearchDiagnostics, TrendSettings } from '@/lib/trend-types';
import { getDb } from '@/server/db';
import { user } from '@/server/db/auth-schema';
import { editorialPublications, editorialRecipes } from '@/server/db/schema';
import { getRecipeDiet } from '@/lib/recipe-diet';
import { aiJobs } from '@/server/ai/schema';
import { getVerificationCosts } from '@/server/ai/ingredient-dictionary-store';
import { aiSettings } from '@/server/ai/config';
import { trendRecipeGenerationBrief } from '@/server/ai/recipe-method';
import { currentIngredientStyleProfile } from '@/server/ai/ingredient-profile';
import { heroCutoutModel } from '@/server/ai/image-actions';
import { createJobAdmission, applyTrendJobsInTransaction, cancelUnsubmittedTrendJobsInTransaction, getJob } from '@/server/ai/store';
import { createTrendDraftInTransaction, getRecipe, getRecipeInTransaction, performRecipeActionInTransaction, verifiedPublicationIssues } from '@/server/editorial/store';
import { trendCandidates, trendRuns, trendSettings, trendSettingAudit } from './schema';
import { normaliseDish, rankCandidates, trendPlatforms, warsawDate, type RawCandidate } from './ranking';
import { selectRecipeCandidate } from './selection';
import { candidateDiet, dietBalanceRecentWindow, type TrendDietBalance } from './diet-balance';
import { approvedSourceUrl } from './evidence';
import { legacyTrendPhotoBriefs, preflightTrendPhotos } from './photo-preflight';
import { contentApprovalHash, hasRecipeContentApproval } from '@/server/editorial/content-approval';
import { hasCurrentManualPhotoRequest, manualEditorialReviewReason } from './manual-editorial-policy';
import { trendWorker } from './actor';
import { pollTrendSearch, trendSearchPolicyVersion, trendSearchReservationUsd, type TrendSearchExcludedDish } from './search';
type Database = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Run = typeof trendRuns.$inferSelect;
export class TrendError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
const running = ['queued', 'searching', 'generating'] as const;
const emptySources = () => Object.fromEntries(trendPlatforms.map(platform => [platform, { status: 'no_evidence', count: 0 }])) as Run['sources'];
function fingerprint() { const settings = aiSettings(); return createHash('sha256').update(['daily-preparation-1', currentIngredientStyleProfile, trendSearchPolicyVersion, settings.trendModel, settings.recipeModel, settings.imageModel, process.env.OPENAI_API_KEY, process.env.FAL_KEY || process.env.FAL_API_KEY, process.env.BLOB_READ_WRITE_TOKEN, process.env.CRON_SECRET].join('\n')).digest('hex'); }
async function lock(tx: Tx) { await tx.execute(sql `SELECT pg_advisory_xact_lock(hashtext('jesie-ai-budget'))`); }
async function account(tx: Tx, actor: EditorialActor) { const [row] = await tx.select().from(user).where(eq(user.id, actor.id)).for('share'); if (!row || row.disabled || !['owner', 'admin'].includes(row.role))
    throw new TrendError(403, 'FORBIDDEN', 'To konto nie ma uprawnień do redakcji.'); return row; }
async function settingsRow(db: Database | Tx) { const [row] = await db.select().from(trendSettings).where(eq(trendSettings.id, 'global')); if (!row)
    throw new TrendError(503, 'TREND_SCHEMA_REQUIRED', 'Radar wymaga aktualizacji bazy.'); return row; }
export async function trendBudget(db: Database | Tx = getDb()): Promise<TrendBudget> {
    const [row] = await db.execute(sql `SELECT coalesce(sum(coalesce(r.search_charged_usd,0)+coalesce(j.used,0)+coalesce(v.used,0)),0)::text used,
 coalesce(sum(CASE WHEN r.search_claimed_at IS NOT NULL AND r.search_charged_usd IS NULL THEN 1 ELSE 0 END+coalesce(j.pending,0)+coalesce(v.pending,0)),0)::int pending
 FROM trend_run r LEFT JOIN LATERAL (SELECT sum(charged_usd) FILTER(WHERE cost_basis='usage') used,
 count(*) FILTER(WHERE (charged_usd IS NULL OR cost_basis IS DISTINCT FROM 'usage') AND (provider_request_id IS NOT NULL OR status IN('submitting','generating','uncertain') OR (status='cancelled' AND provider_finished_at IS NULL))) pending FROM ai_job WHERE trend_run_id=r.id) j ON true
 LEFT JOIN LATERAL (SELECT sum(v.charged_usd) FILTER(WHERE v.cost_basis='usage') used,
 count(*) FILTER(WHERE v.charged_usd IS NULL OR v.cost_basis IS DISTINCT FROM 'usage') pending FROM ai_ingredient_verification v JOIN ai_job a ON a.id=v.origin_job_id WHERE a.trend_run_id=r.id) v ON true
 WHERE r.created_at >= date_trunc('month',now() AT TIME ZONE 'Europe/Warsaw') AT TIME ZONE 'Europe/Warsaw'`).then(result => result.rows as {
        used: string;
        pending: number;
    }[]);
    const used = new Decimal(row.used);
    // Compatibility fields no longer represent a cap or permission to spend.
    return { limitUsd: '0.00000000', usedUsd: used.toFixed(8), reservedUsd: '0.00000000', remainingUsd: '0.00000000', pendingCostCount: row.pending };
}
function configuration(row: Awaited<ReturnType<typeof settingsRow>>): TrendConfiguration { const value = aiSettings(); const cron = Boolean(process.env.CRON_SECRET); return { configured: value.openai && cron, search: value.openai, text: value.openai, photos: value.fal, storage: value.storage, cron, controlRequired: !row.lastControlAt || row.controlFingerprint !== fingerprint(), recipeModel: value.recipeModel, imageModel: value.imageModel, trendModel: value.trendModel }; }
function settingsDto(row: Awaited<ReturnType<typeof settingsRow>>): TrendSettings { return { enabled: row.enabled, monthlyLimitUsd: row.monthlyLimitUsd, lastControlAt: row.lastControlAt?.toISOString() ?? null, timezone: 'Europe/Warsaw', scheduleUtc: '12:00', autoPauseReason: row.autoPauseReason, autoPauseToken: row.autoPauseToken }; }
/** Fresh persisted authorization gates only automation, never a stale client role. */
export async function trendAutomationGate(db: Database | Tx = getDb()) {
    const row = await settingsRow(db); const config = configuration(row);
    const [owner] = row.publicationAuthorizedBy ? await db.select().from(user).where(eq(user.id, row.publicationAuthorizedBy)) : [];
    const authorized = Boolean(owner && !owner.disabled && owner.role === 'owner');
    const canEnable = config.configured;
    const reason = !config.configured ? 'Podłącz usługę researchu i tekstu oraz harmonogram.'
      : row.autoPauseReason ? row.autoPauseReason
      : !row.enabled ? 'Codzienny research i opracowanie tekstu są wyłączone.'
      : !authorized ? 'Aktywny właściciel musi ponownie zatwierdzić harmonogram.' : null;
    return { enabled: row.enabled && canEnable && !row.autoPauseReason && authorized, canEnable,
      authorizedOwnerId: authorized ? owner!.id : null, reason };
}
export function searchModelForRun(run: { searchModel: string | null }) { return run.searchModel || 'gpt-6-astra'; }
async function runDto(row: Run, db: Database | Tx): Promise<TrendRun> {
    const jobs = await db.select().from(aiJobs).where(eq(aiJobs.trendRunId, row.id));
    const [candidate] = row.candidateId ? await db.select().from(trendCandidates).where(eq(trendCandidates.id, row.candidateId)) : [];
    const [recipe] = row.recipeId ? await db.select().from(editorialRecipes).where(eq(editorialRecipes.id, row.recipeId)) : [];
    const content = recipe?.content;
    const plannedSteps = content?.recipe.steps.filter(item => isStepPhotoRequired(content, item.id) || content.photos.steps[item.id]?.src) ?? [];
    const total = content ? 1 + content.recipe.ingredients.length + plannedSteps.length : 0;
    const ready = content ? Number(Boolean(content.recipe.image)) + Object.keys(content.photos.ingredients).length + Object.keys(content.photos.steps).length : 0;
    const slots = new Set(content ? ['hero', ...content.recipe.ingredients.map(item => `ingredient:${item.id}`), ...plannedSteps.map(item => `step:${item.id}`)] : []);
    const generated = new Set<string>();
    if (content?.recipe.image) generated.add('hero');
    for (const item of content?.recipe.ingredients ?? []) if (content!.photos.ingredients[item.id]) generated.add(`ingredient:${item.id}`);
    for (const item of content?.recipe.steps ?? []) if (content!.photos.steps[item.id]) generated.add(`step:${item.id}`);
    for (const job of jobs) {
        if(['ready','applied'].includes(job.status)&&job.kind==='ingredient'&&job.recipeId===row.recipeId&&job.targetId&&job.result?.reusedPhoto){const slot=`ingredient:${job.targetId}`;if(slots.has(slot))generated.add(slot);continue;}
        const asset = job.result?.asset;
        if (!['ready', 'applied'].includes(job.status) || job.kind === 'recipe' || job.recipeId !== row.recipeId || !asset || asset.recipeId !== row.recipeId || asset.kind !== job.kind || asset.targetId !== job.targetId || !asset.id || !asset.src) continue;
        const slot = job.kind === 'hero' ? 'hero' : `${job.kind}:${job.targetId}`;
        if (slots.has(slot)) generated.add(slot);
    }
    const verification = await getVerificationCosts({ trendRunId: row.id }, db);
    const settled = jobs.reduce((sum, job) => job.costBasis === 'usage' && job.chargedUsd !== null ? sum.plus(job.chargedUsd) : sum, new Decimal(row.searchChargedUsd ?? 0).plus(verification.chargedUsd));
    const pendingCostCount = verification.pendingCount + Number(row.searchClaimedAt !== null && row.searchChargedUsd === null) + jobs.filter(job => (job.chargedUsd === null || job.costBasis !== 'usage') && (job.providerRequestId !== null || ['submitting', 'generating', 'uncertain'].includes(job.status) || job.status === 'cancelled' && job.providerFinishedAt === null)).length;
    const selectionBasis = candidate?.data.editorChoice ? 'editor' as const : candidate?.data.automaticSelection?.basis === 'research' ? 'inspiration' as const : candidate?.data.automaticSelection?.basis ?? 'trend' as const;
    const photoJobs = new Map<string, NonNullable<TrendRun['photos']['jobs']>[number]>();
    for (const job of [...jobs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
        if (job.kind === 'recipe') continue;
        const key = job.kind === 'hero' ? 'hero' : `${job.kind}:${job.targetId}`;
        if (slots.has(key) && !photoJobs.has(key)) photoJobs.set(key, { id: job.id, kind: job.kind, targetId: job.targetId, status: job.status, errorMessage: job.errorMessage });
    }
    return { id: row.id, date: row.date, mode: row.mode, manual: row.manualRequestKey !== null, ...(candidate ? { selectionBasis } : {}), status: row.status, recipeId: row.recipeId, expectedRevision: row.expectedRevision, candidateId: row.candidateId, selectedTitle: candidate?.data.title ?? content?.recipe.title ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), error: row.error, workflowId: row.workflowId, reservedUsd: '0.00000000', chargedUsd: settled.toFixed(8), settledUsd: settled.toFixed(8), pendingCostCount, photos: { ready, total, generated: generated.size, jobs: [...photoJobs.values()] }, sources: row.sources, searchModel: searchModelForRun(row), diagnostics: row.searchDiagnostics ?? null, preparation: row.searchDiagnostics?.preparation };
}
function currentCandidate(candidate: TrendCandidate, run: Pick<Run, 'searchDiagnostics'>) { const generation = run.searchDiagnostics?.reverification?.generation; return generation === undefined || candidate.verificationGeneration === generation; }
export async function getTrendDashboard(actor?: EditorialActor): Promise<TrendDashboard> { const db = getDb(); const row = await settingsRow(db); const runs = await db.select().from(trendRuns).orderBy(desc(trendRuns.createdAt)).limit(31); const ids = runs.map(run => run.id); const candidates = ids.length ? await db.select().from(trendCandidates).where(inArray(trendCandidates.runId, ids)) : []; const byId = new Map(runs.map(run => [run.id, run])); return { settings: settingsDto(row), automation: await (await import('./automated-publication')).getCanonicalTrendAutomation(actor), configuration: configuration(row), budget: await trendBudget(db), runs: await Promise.all(runs.map(run => runDto(run, db))), candidates: candidates.filter(candidate => currentCandidate(candidate.data, byId.get(candidate.runId)!)).map(candidate => candidate.data) }; }
export async function getTrendRun(id: string) { const db = getDb(); const [row] = await db.select().from(trendRuns).where(eq(trendRuns.id, id)); if (!row)
    throw new TrendError(404, 'TREND_NOT_FOUND', 'Nie znaleziono przebiegu.'); const candidates = await db.select().from(trendCandidates).where(eq(trendCandidates.runId, id)); return { run: await runDto(row, db), candidates: candidates.filter(candidate => currentCandidate(candidate.data, row)).map(candidate => candidate.data), recipe: row.recipeId ? await getRecipe(row.recipeId) : null }; }
function diagnosticsFor(run: Run, diagnostics: TrendSearchDiagnostics, selected: boolean, candidates?: TrendCandidate[]): TrendSearchDiagnostics {
    const count = (value: number) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0;
    const discoveredCandidates = count(diagnostics.discoveredCandidates);
    const verifiedSources = count(candidates ? candidates.reduce((sum, candidate) => sum + candidate.sources.length, 0) : diagnostics.verifiedSources);
    const issues = { ...diagnostics.issueCounts };
    const finalIssues: Record<string, number> = {};
    for (const candidate of candidates ?? []) for (const issue of candidate.research?.issues ?? []) finalIssues[issue.reason] = (finalIssues[issue.reason] ?? 0) + 1;
    for (const [reason, amount] of Object.entries(finalIssues)) issues[reason] = Math.max(count(issues[reason] ?? 0), amount);
    const discoveryOutcome = discoveredCandidates === 0 ? 'empty_discovery' as const : verifiedSources === 0 ? 'unverified_sources' as const : candidates?.some(candidate => candidate.eligible) ? 'qualified' as const : 'insufficient_evidence' as const;
    return { version: 1, model: searchModelForRun(run), toolCalls: count(diagnostics.toolCalls), queries: diagnostics.queries.filter(query => typeof query === 'string').slice(0, 48).map(query => query.replace(/[\u0000-\u001f]/g, ' ').slice(0, 500)), retrievedUrls: count(diagnostics.retrievedUrls), discoveredCandidates, submittedSources: count(diagnostics.submittedSources), verifiedSources, issueCounts: Object.fromEntries(Object.entries(issues).filter(([key]) => /^[a-z0-9_]{1,80}$/i.test(key)).slice(0, 40).map(([key, value]) => [key, count(value)])), discoveryOutcome, outcome: selected ? 'selected' : discoveredCandidates === 0 ? 'empty_discovery' : verifiedSources === 0 ? 'unverified_sources' : 'insufficient_evidence' };
}
/** Read an existing receipt only; historical selection, cost and publication stay unchanged. */
export async function refreshTrendDiagnostics(id: string, actor: EditorialActor) {
    const snapshot = await getDb().transaction(async tx => {
        await account(tx, actor);
        const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id));
        if (!run?.searchRequestId || !run.searchFinishedAt) throw new TrendError(409, 'TREND_DIAGNOSTICS_UNAVAILABLE', 'Brak zakończonego wyszukiwania do odczytu.');
        return run;
    });
    const result = await pollTrendSearch(searchModelForRun(snapshot), snapshot.searchRequestId!);
    if (!result.done || !result.diagnostics) throw new TrendError(409, 'TREND_DIAGNOSTICS_UNAVAILABLE', 'Diagnostyka wyniku nie jest jeszcze dostępna.');
    return getDb().transaction(async tx => {
        await lock(tx);
        await account(tx, actor);
        const [current] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id)).for('update');
        if (!current || current.generation !== snapshot.generation || current.searchRequestId !== snapshot.searchRequestId || current.status !== snapshot.status || current.searchModel !== snapshot.searchModel) throw new TrendError(409, 'TREND_SUPERSEDED', 'Przebieg zmienił się podczas odczytu diagnostyki.');
        const [selected] = current.candidateId ? await tx.select().from(trendCandidates).where(eq(trendCandidates.id, current.candidateId)) : [];
        const diagnostics = diagnosticsFor(current, result.diagnostics, Boolean(current.candidateId));
        const [updated] = await tx.update(trendRuns).set({ searchDiagnostics: { ...diagnostics, discoveryOutcome: current.searchDiagnostics?.discoveryOutcome ?? (selected?.data.eligible ? 'qualified' : diagnostics.discoveryOutcome), ...(current.searchDiagnostics?.reverification ? { reverification: current.searchDiagnostics.reverification } : {}) } }).where(eq(trendRuns.id, id)).returning();
        return runDto(updated, tx);
    });
}
/** Incomplete research is context for a fresh search, never qualifying evidence by itself. */
export async function getTrendResearchHints(now = new Date()): Promise<TrendResearchHint[]> {
    const recent = await getDb().select({ data: trendCandidates.data }).from(trendCandidates).innerJoin(trendRuns, eq(trendCandidates.runId, trendRuns.id)).where(and(gte(trendRuns.date, warsawDate(new Date(now.getTime() - 14 * 86400000))), lte(trendRuns.date, warsawDate(now)), eq(trendCandidates.selected, false), sql`(${trendRuns.searchDiagnostics}->'reverification'->>'generation' IS NULL OR ${trendCandidates.data}->>'verificationGeneration' = ${trendRuns.searchDiagnostics}->'reverification'->>'generation')`)).orderBy(desc(trendRuns.date)).limit(168);
    const seen = new Set<string>();
    const hints: TrendResearchHint[] = [];
    let urlsLeft = 12;
    for (const { data } of recent) {
        const key = normaliseDish(data.dishKey);
        if (!key || data.eligible || data.duplicateRecipeId || seen.has(key)) continue;
        const sourceUrls = [...new Set([...data.sources.map(source => source.url), ...(data.research?.issues ?? []).map(issue => issue.url)].map(approvedSourceUrl).filter((url): url is string => Boolean(url && url.length <= 2048)))].slice(0, urlsLeft);
        urlsLeft -= sourceUrls.length;
        hints.push({ dishKey: data.dishKey.slice(0, 150), title: { pl: data.title.pl.slice(0, 150), en: data.title.en.slice(0, 150) }, sourceUrls });
        seen.add(key);
        if (hints.length === 12) break;
    }
    return hints;
}
/** Give discovery the catalogue before spending its bounded search calls on known dishes. */
export async function getTrendSearchExclusions(): Promise<TrendSearchExcludedDish[]> {
    const existing = await getDb().select({ id: editorialRecipes.id, title: sql<TrendSearchExcludedDish['title']>`${editorialRecipes.content}->'recipe'->'title'` }).from(editorialRecipes).where(and(isNull(editorialRecipes.deletedAt), sql`${editorialRecipes.editorialStatus} <> 'archived'`)).orderBy(desc(editorialRecipes.updatedAt)).limit(80);
    const prior = existing.length ? await getDb().select({ recipeId: trendRuns.recipeId, data: trendCandidates.data }).from(trendCandidates).innerJoin(trendRuns, eq(trendCandidates.runId, trendRuns.id)).where(and(eq(trendCandidates.selected, true), inArray(trendRuns.recipeId, existing.map(recipe => recipe.id)))) : [];
    return existing.map(recipe => ({ title: recipe.title, aliases: prior.filter(candidate => candidate.recipeId === recipe.id).flatMap(candidate => [candidate.data.dishKey, ...candidate.data.aliases]).slice(0, 6) }));
}
/** Count current public snapshots once; history, archived recipes and discarded drafts are not votes. */
export async function getTrendDietBalance(db: Database | Tx = getDb()): Promise<TrendDietBalance> {
    const publications = await db.select({ id: editorialRecipes.id, content: editorialPublications.snapshot,
        at: sql<string>`(SELECT min(history.published_at)::text FROM editorial_publication history WHERE history.recipe_id = ${editorialRecipes.id})` })
        .from(editorialRecipes).innerJoin(editorialPublications, eq(editorialPublications.id, editorialRecipes.publishedId))
        .where(and(eq(editorialRecipes.publicationStatus, 'published'), isNull(editorialRecipes.deletedAt), sql`${editorialRecipes.editorialStatus} <> 'archived'`));
    const prepared = await db.select({ id: editorialRecipes.id, content: editorialRecipes.content, at: trendRuns.createdAt })
        .from(trendRuns).innerJoin(editorialRecipes, eq(editorialRecipes.id, trendRuns.recipeId))
        .where(and(inArray(trendRuns.status, ['generating', 'awaiting_review']), eq(editorialRecipes.publicationStatus, 'never_published'), isNull(editorialRecipes.deletedAt), sql`${editorialRecipes.editorialStatus} <> 'archived'`));
    const seen = new Set<string>();
    const time = (value: Date | string) => typeof value === 'string' ? Date.parse(value) : value.getTime();
    const recent = [...publications, ...prepared.filter(row => row.content.recipe.ingredients.length > 0 && row.content.recipe.steps.length > 0)]
        .toSorted((a, b) => time(b.at) - time(a.at) || a.id.localeCompare(b.id))
        .flatMap(row => {
            if (seen.has(row.id)) return [];
            seen.add(row.id);
            return [getRecipeDiet(row.content.recipe)];
        }).slice(0, dietBalanceRecentWindow);
    return { catalog: publications.map(row => getRecipeDiet(row.content.recipe)), recent };
}
export async function updateTrendSettings(enabled: boolean, actor: EditorialActor, acknowledgeAutoPause = false, expectedAutoPauseToken?: string, monthlyLimitUsd?: unknown) { return getDb().transaction(async (tx) => {
    await lock(tx);
    const owner = await account(tx, actor);
    if (owner.role !== 'owner') throw new TrendError(403, 'OWNER_REQUIRED', 'Tylko właściciel może zmienić harmonogram.');
    const row = await settingsRow(tx);
    if (monthlyLimitUsd !== undefined) throw new TrendError(410, 'BUDGETS_REMOVED', 'Limity wydatków zostały usunięte. Dostępne są wyłącznie rzeczywiste koszty.');
    const scheduleChange = true;
    const config = configuration(row);
    if (scheduleChange && enabled && !config.configured) throw new TrendError(422, 'TREND_NOT_CONFIGURED', 'Podłącz usługi generowania, bibliotekę zdjęć i harmonogram przed włączeniem automatu.');
    if (scheduleChange && enabled && row.autoPauseReason && !acknowledgeAutoPause) throw new TrendError(422, 'TREND_AUTO_PAUSE_REVIEW_REQUIRED', 'Przejrzyj diagnostykę dwóch pustych przebiegów i potwierdź ponowne włączenie.');
    if (scheduleChange && enabled && row.autoPauseReason && (!expectedAutoPauseToken || expectedAutoPauseToken !== row.autoPauseToken)) throw new TrendError(409, 'TREND_AUTO_PAUSE_CHANGED', 'Wstrzymanie zmieniło się. Odśwież diagnostykę przed ponownym włączeniem.');
    const result = await tx.execute(sql`SELECT clock_timestamp() AS now`);
    const now = new Date((result.rows[0] as { now: Date | string }).now);
    const [updated] = await tx.update(trendSettings).set({ enabled, publicationAuthorizedBy: enabled ? owner.id : null, updatedBy: owner.id, updatedAt: now, ...(enabled && row.autoPauseReason && acknowledgeAutoPause ? { autoPauseReason: null, autoPauseToken: null, autoPauseReviewedAt: now } : {}) }).where(eq(trendSettings.id, 'global')).returning();
    const auditState = (value: typeof row) => ({ enabled: value.enabled, monthlyLimitUsd: value.monthlyLimitUsd, publicationAuthorizedBy: value.publicationAuthorizedBy });
    await tx.insert(trendSettingAudit).values({ id: randomUUID(), actorId: owner.id, actorName: owner.name,
      before: auditState(row), after: auditState(updated), createdAt: now });
    return settingsDto(updated);
}); }
async function pauseAfterEmptyRuns(tx: Tx) {
    const row = await settingsRow(tx);
    const recent = await tx.select({ id: trendRuns.id, status: trendRuns.status }).from(trendRuns).where(and(isNotNull(trendRuns.searchRequestId), isNotNull(trendRuns.searchFinishedAt), isNotNull(trendRuns.searchChargedUsd), row.autoPauseReviewedAt ? gt(trendRuns.searchFinishedAt, row.autoPauseReviewedAt) : undefined)).orderBy(desc(trendRuns.searchFinishedAt), desc(trendRuns.createdAt)).limit(2);
    if (recent.length === 2 && recent.every(run => run.status === 'no_candidate')) {
        const token = createHash('sha256').update(recent.map(run => run.id).join('\n')).digest('hex');
        if (row.autoPauseToken !== token || row.enabled) await tx.update(trendSettings).set({ enabled: false, autoPauseReason: 'Dwa kolejne przebiegi nie znalazły wystarczających dowodów. Harmonogram wstrzymano, aby ograniczyć koszty. Przejrzyj diagnostykę przed ponownym włączeniem.', autoPauseToken: token, updatedAt: new Date() }).where(eq(trendSettings.id, 'global'));
    }
}
export async function admitTrendRun(mode: 'daily' | 'control', actor?: EditorialActor, now = new Date(), retryRejectedControl = false, manualRequestKey?: string): Promise<{
    run: TrendRun;
    created: boolean;
    restarted: boolean;
    generation: number;
} | {
    skipped: true;
}> {
    return getDb().transaction(async (tx) => {
        await lock(tx);
        const manual = manualRequestKey !== undefined;
        if (manual && (mode !== 'control' || retryRejectedControl || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(manualRequestKey!)))
            throw new TrendError(422, 'TREND_MANUAL_INVALID', 'Ręczne uruchomienie wymaga osobnego identyfikatora żądania i trybu kontrolnego.');
        if (mode === 'control' && !actor)
            throw new TrendError(403, 'FORBIDDEN', 'Przebieg kontrolny wymaga zalogowanego konta redakcji.');
        if (actor) {
            const authenticated = await account(tx, actor);
            if (manual && authenticated.role !== 'owner') throw new TrendError(403, 'OWNER_REQUIRED', 'Tylko właściciel może uruchomić dodatkowy płatny przebieg.');
        }
        if (manual) {
            const [replayed] = await tx.select().from(trendRuns).where(eq(trendRuns.manualRequestKey, manualRequestKey!)).for('update');
            if (replayed) return { run: await runDto(replayed, tx), created: false, restarted: false, generation: replayed.generation };
        }
        if (mode === 'daily') await pauseAfterEmptyRuns(tx);
        const row = await settingsRow(tx);
        const config = configuration(row);
        if (mode === 'daily' && !(await trendAutomationGate(tx)).enabled)
            return { skipped: true };
        if (!config.configured)
            throw new TrendError(503, 'TREND_NOT_CONFIGURED', 'Podłącz usługę researchu i tekstu oraz harmonogram przed uruchomieniem.');
        const date = warsawDate(now);
        const searchModel = aiSettings().trendModel;
        const searchReserve = trendSearchReservationUsd(searchModel);
        const [existing] = manual ? [] : await tx.select().from(trendRuns).where(and(eq(trendRuns.date, date), isNull(trendRuns.manualRequestKey))).for('update');
        if (existing) {
            if (!(retryRejectedControl && mode === 'control' && existing.status === 'failed'))
                return { run: await runDto(existing, tx), created: false, restarted: false, generation: existing.generation };
            const [candidate] = await tx.select({ id: trendCandidates.id }).from(trendCandidates).where(eq(trendCandidates.runId, existing.id)).limit(1);
            const [job] = await tx.select({ id: aiJobs.id }).from(aiJobs).where(eq(aiJobs.trendRunId, existing.id)).limit(1);
            // This is an explicit new control attempt after a confirmed rejection,
            // never recovery of a potentially accepted paid request.
            if (existing.mode !== 'control' || existing.searchRequestId || !existing.searchClaimedAt || !existing.searchFinishedAt || existing.searchChargedUsd === null || !new Decimal(existing.searchChargedUsd).isZero() || existing.recipeId || existing.candidateId || existing.expectedRevision !== null || candidate || job)
                throw new TrendError(409, 'TREND_RETRY_UNSAFE', 'Ten przebieg ma zlecenie, wynik lub niewyjaśniony koszt. Nie można ponowić wyszukiwania.');
            const [active] = await tx.select({ id: trendRuns.id }).from(trendRuns).where(inArray(trendRuns.status, [...running, 'uncertain'])).limit(1);
            if (active)
                throw new TrendError(409, 'TREND_ACTIVE', 'Najpierw zakończ lub wyjaśnij aktywny przebieg.');
            const [restarted] = await tx.update(trendRuns).set({ status: 'queued', generation: existing.generation + 1, workflowId: null, searchRequestId: null, searchClaimedAt: null, searchFinishedAt: null, searchReservedUsd: searchReserve, searchChargedUsd: null, packetRemainingUsd: '0', searchModel, searchDiagnostics: null, configurationFingerprint: fingerprint(), sources: emptySources(), error: null, updatedAt: new Date() }).where(eq(trendRuns.id, existing.id)).returning();
            return { run: await runDto(restarted, tx), created: false, restarted: true, generation: restarted.generation };
        }
        const [active] = await tx.select().from(trendRuns).where(inArray(trendRuns.status, [...running, 'uncertain'])).limit(1);
        if (active)
            throw new TrendError(409, 'TREND_ACTIVE', 'Najpierw zakończ lub wyjaśnij aktywny przebieg.');
        const [run] = await tx.insert(trendRuns).values({ id: randomUUID(), date, mode, manualRequestKey: manualRequestKey ?? null, searchModel, searchReservedUsd: searchReserve, packetRemainingUsd: '0', configurationFingerprint: fingerprint(), sources: emptySources() }).returning();
        return { run: await runDto(run, tx), created: true, restarted: false, generation: run.generation };
    });
}
export async function attachTrendWorkflow(id: string, workflowId: string, generation?: number) { await getDb().update(trendRuns).set({ workflowId, updatedAt: new Date() }).where(and(eq(trendRuns.id, id), generation === undefined ? undefined : eq(trendRuns.generation, generation), sql`(${trendRuns.workflowId} IS NULL OR ${trendRuns.workflowId} = ${workflowId})`)); }
export async function failTrendRun(id: string, message: string, uncertain = false, generation?: number) { await getDb().transaction(async (tx) => { await lock(tx); const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id)).for('update'); if (!run || (generation !== undefined && run.generation !== generation) || ['awaiting_review', 'published', 'rejected', 'no_candidate', 'paused'].includes(run.status))
    return; await cancelUnsubmittedTrendJobsInTransaction(tx, id);
    const [pending] = await tx.select({ id: aiJobs.id }).from(aiJobs).where(and(eq(aiJobs.trendRunId, id), sql`(${aiJobs.status} IN ('submitting','generating','uncertain') OR (${aiJobs.status}='cancelled' AND ${aiJobs.providerFinishedAt} IS NULL) OR (${aiJobs.providerRequestId} IS NOT NULL AND ${aiJobs.providerFinishedAt} IS NULL))`)).limit(1);
    await tx.update(trendRuns).set({ status: uncertain || pending ? 'uncertain' : 'failed', error: message.slice(0, 2000), packetRemainingUsd: '0', updatedAt: new Date() }).where(eq(trendRuns.id, id)); }); }
export async function claimTrendSearch(id: string, generation?: number) {
    return getDb().transaction(async tx => {
        await lock(tx);
        const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id)).for('update');
        if (!run) throw new TrendError(404, 'TREND_NOT_FOUND', 'Brak przebiegu.');
        if (generation !== undefined && run.generation !== generation)
            throw new TrendError(409, 'TREND_SUPERSEDED', 'Ten przebieg zastąpiło nowe uruchomienie.');
        // An existing receipt permits retrieval only. A late claim must never
        // overwrite a paused, rejected, or already completed run.
        if (run.searchRequestId || !['queued', 'searching'].includes(run.status)) return { run, submit: false };
        if (run.searchClaimedAt) {
            const [updated] = await tx.update(trendRuns).set({ status: 'uncertain', error: 'Nie potwierdzono wysłania wyszukiwania. Żądanie nie będzie powtórzone.', updatedAt: new Date() }).where(eq(trendRuns.id, id)).returning();
            return { run: updated, submit: false };
        }
        if (run.status !== 'queued') return { run, submit: false };
        const [updated] = await tx.update(trendRuns).set({ status: 'searching', searchClaimedAt: new Date(), updatedAt: new Date() }).where(eq(trendRuns.id, id)).returning();
        return { run: updated, submit: true };
    });
}
export async function beforeTrendSearch(id: string, generation?: number) { const [run] = await getDb().select().from(trendRuns).where(eq(trendRuns.id, id)); if (run && generation !== undefined && run.generation !== generation)
    throw new TrendError(409, 'TREND_SUPERSEDED', 'Ten przebieg zastąpiło nowe uruchomienie.'); if (!run || run.status !== 'searching' || run.searchRequestId)
    throw new TrendError(409, 'TREND_PAUSED', 'Wyszukiwanie zostało wstrzymane.'); }
export async function attachSearchRequest(id: string, requestId: string, generation?: number) { await getDb().update(trendRuns).set({ searchRequestId: requestId, updatedAt: new Date() }).where(and(eq(trendRuns.id, id), generation === undefined ? undefined : eq(trendRuns.generation, generation))); }
export async function getTrendExecution(id: string) { const [run] = await getDb().select().from(trendRuns).where(eq(trendRuns.id, id)); if (!run)
    throw new TrendError(404, 'TREND_NOT_FOUND', 'Brak przebiegu.'); return run; }
export async function settleSearchFailure(id: string, cost: string | null, uncertain: boolean, generation?: number) {
    await getDb().transaction(async tx => {
        await lock(tx);
        const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id)).for('update');
        if (!run) throw new TrendError(404, 'TREND_NOT_FOUND', 'Brak przebiegu.');
        if (generation !== undefined && run.generation !== generation) return;
        const unknownCost = uncertain || Boolean(run.searchRequestId && cost === null);
        await tx.update(trendRuns).set({ searchChargedUsd: unknownCost ? null : (cost ?? '0'), searchFinishedAt: uncertain ? null : new Date(), sources: Object.fromEntries(trendPlatforms.map(platform => [platform, { status: 'unavailable', count: 0 }])) as Run['sources'], updatedAt: new Date() }).where(eq(trendRuns.id, id));
    });
}
/** A failed search still picks a dish, without repeating a potentially accepted POST. */
export async function finishTrendSearchFailure(id: string, cost: string | null, uncertain: boolean, generation?: number): Promise<boolean> {
    return getDb().transaction(async tx => {
        await lock(tx);
        const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id)).for('update');
        if (!run || (generation !== undefined && run.generation !== generation)) return false;
        if (run.searchFinishedAt) return run.status === 'generating' && Boolean(run.recipeId);
        const now = new Date();
        const unknownCost = uncertain || Boolean(run.searchRequestId && cost === null);
        const settlement = { searchChargedUsd: unknownCost ? null : cost ?? '0', searchFinishedAt: uncertain ? null : now, sources: Object.fromEntries(trendPlatforms.map(platform => [platform, { status: 'unavailable', count: 0 }])) as Run['sources'], updatedAt: now };
        if (run.candidateId) {
            // A late terminal failure can reconcile its original bill, but must
            // not replace the fallback or resume an uncertain run.
            if (!uncertain && run.searchRequestId) await tx.update(trendRuns).set(settlement).where(eq(trendRuns.id, id));
            return run.status === 'generating' && Boolean(run.recipeId);
        }
        if (!['queued', 'searching'].includes(run.status) && !(uncertain && run.status === 'uncertain')) {
            await tx.update(trendRuns).set(settlement).where(eq(trendRuns.id, id));
            return false;
        }
        const existing = await tx.select({ id: editorialRecipes.id, content: editorialRecipes.content, revision: editorialRecipes.revision, editorialStatus: editorialRecipes.editorialStatus }).from(editorialRecipes).where(isNull(editorialRecipes.deletedAt));
        const prior = await tx.select({ recipeId: trendRuns.recipeId, data: trendCandidates.data }).from(trendCandidates).innerJoin(trendRuns, eq(trendCandidates.runId, trendRuns.id)).where(eq(trendCandidates.selected, true));
        const dishes = existing.filter(recipe => recipe.editorialStatus !== 'archived').map(recipe => ({ id: recipe.id, title: recipe.content.recipe.title, ...(recipe.content.recipe.ingredients.length ? { diet: getRecipeDiet(recipe.content.recipe) } : {}), aliases: prior.filter(candidate => candidate.recipeId === recipe.id).flatMap(candidate => [candidate.data.dishKey, ...candidate.data.aliases]) }));
        const { candidates, selected } = selectRecipeCandidate([], dishes, id, now, await getTrendDietBalance(tx));
        const [updated] = await tx.update(trendRuns).set({ ...settlement, status: 'generating', candidateId: selected.id, error: null }).where(eq(trendRuns.id, id)).returning();
        for (const candidate of candidates) await tx.insert(trendCandidates).values({ id: candidate.id, runId: id, dishKey: candidate.dishKey, data: candidate, selected: candidate.selected });
        if (uncertain) {
            // Persist the dish and its draft, but retain the search commitment and
            // stop before admitting any text or photograph while acceptance is unknown.
            const draft = selected.automaticSelection?.basis === 'catalog' ? null : await createTrendDraftInTransaction(tx, id, selected.title.pl, `Potrawa: ${selected.title.pl} / ${selected.title.en}\n${selected.rationale}\nWybrano lokalną inspirację po niepotwierdzonym wyszukiwaniu. Nie potwierdzono aktualnej popularności.`, [], false, candidateDiet(selected));
            const reused = selected.duplicateRecipeId ? existing.find(recipe => recipe.id === selected.duplicateRecipeId) : null;
            await tx.update(trendRuns).set({ status: 'uncertain', recipeId: draft?.id ?? reused?.id ?? null, expectedRevision: draft?.revision ?? reused?.revision ?? null, error: 'Wybrano przepis rezerwowy. Przygotowanie czeka na wyjaśnienie przyjęcia wyszukiwania; istniejące żądanie nie zostanie wysłane ponownie.', packetRemainingUsd: '0', updatedAt: now }).where(eq(trendRuns.id, id));
            return false;
        }
        await prepareSelectedDraft(tx, updated, selected);
        const [finished] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id));
        return finished.status === 'generating' && Boolean(finished.recipeId);
    });
}
/** Compatibility entry point: check captured generation without allocating money. */
export async function reserveTrendPreparationAmount(id: string, amount: string, generation: number) {
    return getDb().transaction(async tx => {
        await lock(tx);
        await reserveTrendPreparationAmountInTransaction(tx, id, amount, generation);
    });
}
/** Recovery callers retain their atomic generation guard; the legacy amount is ignored. */
export async function reserveTrendPreparationAmountInTransaction(tx: Tx, id: string, amount: string, generation: number) {
    void amount;
    const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id)).for('update');
    if (!run || run.generation !== generation || run.status !== 'generating') throw new TrendError(409, 'TREND_SUPERSEDED', 'To przygotowanie zastąpiło nowe uruchomienie.');
}
async function prepareSelectedDraft(tx: Tx, run: Run, selected: TrendCandidate) {
    if (selected.automaticSelection?.basis === 'catalog' && selected.duplicateRecipeId) {
        const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, selected.duplicateRecipeId)).for('share');
        if (!recipe || recipe.deletedAt || recipe.editorialStatus === 'archived') throw new TrendError(409, 'TREND_CATALOG_CHANGED', 'Wybrany przepis z katalogu wymaga ponownego sprawdzenia.');
        await tx.update(trendRuns).set({ recipeId: recipe.id, expectedRevision: recipe.revision, status: 'awaiting_review', packetRemainingUsd: '0', updatedAt: new Date() }).where(eq(trendRuns.id, run.id));
        return recipe.id;
    }
    if (!configuration(await settingsRow(tx)).configured) {
        await tx.update(trendRuns).set({ status: 'paused', error: 'Podłącz usługę researchu i tekstu oraz harmonogram przed opracowaniem przepisu.', updatedAt: new Date() }).where(eq(trendRuns.id, run.id));
        return null;
    }
    const material = selected.sources.map(source => `${source.title}\n${source.url}\n${source.excerpt}`).join('\n\n');
    const selectionNote = selected.editorChoice ? 'Inspiracja wybrana przez właściciela; materiał nie spełnia kryteriów potwierdzonego trendu.' : selected.automaticSelection ? `Automatycznie wybrana inspiracja; nie potwierdzono aktualnej popularności. ${selected.automaticSelection.reason}` : '';
    const draft = await createTrendDraftInTransaction(tx, run.id, selected.title.pl, `Potrawa: ${selected.title.pl} / ${selected.title.en}\n${selected.rationale}\n${selectionNote}\nPrywatne źródła zainteresowania (nie kopiować przepisu):\n${material}`, selected.sources.map((source, index) => ({ id: `source_${index + 1}`, title: source.title, url: source.url })), selected.eligible && !selected.editorChoice && !selected.automaticSelection, candidateDiet(selected));
    await tx.update(trendRuns).set({ recipeId: draft.id, expectedRevision: 1, packetRemainingUsd: '0', updatedAt: new Date() }).where(eq(trendRuns.id, run.id));
    return draft.id;
}
export async function finishTrendSearch(id: string, raw: RawCandidate[], urls: string[], chargedUsd: string | null, unavailable: TrendPlatform[] = [], generation?: number, diagnostics?: TrendSearchDiagnostics) {
    return getDb().transaction(async (tx) => {
        await lock(tx);
        const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id)).for('update');
        if (!run || (generation !== undefined && run.generation !== generation) || run.searchFinishedAt)
            return run?.recipeId ?? null;
        const existing = await tx.select({ id: editorialRecipes.id, content: editorialRecipes.content, editorialStatus: editorialRecipes.editorialStatus }).from(editorialRecipes).where(isNull(editorialRecipes.deletedAt));
        const prior = await tx.select({ recipeId: trendRuns.recipeId, data: trendCandidates.data }).from(trendCandidates).innerJoin(trendRuns, eq(trendCandidates.runId, trendRuns.id)).where(eq(trendCandidates.selected, true));
        const dishes = existing.filter(r => r.editorialStatus !== 'archived').map(r => ({ id: r.id, title: r.content.recipe.title, ...(r.content.recipe.ingredients.length ? { diet: getRecipeDiet(r.content.recipe) } : {}), aliases: prior.filter(candidate => candidate.recipeId === r.id).flatMap(candidate => [candidate.data.dishKey, ...candidate.data.aliases]) }));
        const now = new Date();
        const ranked = rankCandidates(raw, urls, dishes, id, now);
        if (run.candidateId) {
            // A receipt arriving after the uncertainty fallback settles only its
            // original search. Keep the selected dish, draft and stop in place.
            const sources = emptySources();
            for (const platform of unavailable) sources[platform].status = 'unavailable';
            for (const candidate of ranked) for (const source of candidate.sources) { sources[source.platform].status = 'available'; sources[source.platform].count++; }
            await tx.update(trendRuns).set({ searchChargedUsd: chargedUsd, searchFinishedAt: now, sources, ...(diagnostics ? { searchDiagnostics: diagnosticsFor(run, diagnostics, true, ranked) } : {}), updatedAt: now }).where(eq(trendRuns.id, id));
            for (const [index, candidate] of ranked.entries()) {
                const evaluated = { ...candidate, id: `${id}-late-${run.generation}-${index}`, selected: false };
                await tx.insert(trendCandidates).values({ id: evaluated.id, runId: id, dishKey: evaluated.dishKey, data: evaluated, selected: false });
            }
            return run.recipeId;
        }
        const { candidates, selected } = selectRecipeCandidate(ranked, dishes, id, now, await getTrendDietBalance(tx));
        const sources = emptySources();
        for (const platform of unavailable)
            sources[platform].status = 'unavailable';
        for (const candidate of candidates)
            for (const source of candidate.sources) {
                sources[source.platform].status = 'available';
                sources[source.platform].count++;
            }
        await tx.update(trendRuns).set({ searchChargedUsd: chargedUsd, searchFinishedAt: now, sources, status: ['queued', 'searching', 'generating'].includes(run.status) ? 'generating' : run.status, candidateId: selected.id, ...(diagnostics ? { searchDiagnostics: diagnosticsFor(run, diagnostics, true, candidates) } : {}), updatedAt: now }).where(eq(trendRuns.id, id));
        for (const candidate of candidates)
            await tx.insert(trendCandidates).values({ id: candidate.id, runId: id, dishKey: candidate.dishKey, data: candidate, selected: candidate.selected });
        await pauseAfterEmptyRuns(tx);
        if (!['queued', 'searching', 'generating'].includes(run.status))
            return null;
        const refreshed = { ...run, status: 'generating' as const, searchChargedUsd: chargedUsd, searchFinishedAt: new Date() };
        return prepareSelectedDraft(tx, refreshed, selected);
    });
}
async function recoverableSearch(tx: Tx, id: string) {
    const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id)).for('update');
    if (!run || run.status !== 'no_candidate' || !run.searchRequestId || !run.searchFinishedAt || run.searchChargedUsd === null || new Decimal(run.searchChargedUsd).isNegative() || run.recipeId || run.candidateId || run.expectedRevision !== null)
        throw new TrendError(409, 'TREND_REVERIFY_UNAVAILABLE', 'Ponownie zweryfikować można wyłącznie zakończone, rozliczone wyszukiwanie bez szkicu.');
    const [job] = await tx.select({ id: aiJobs.id }).from(aiJobs).where(eq(aiJobs.trendRunId, id)).limit(1);
    const [selected] = await tx.select({ id: trendCandidates.id }).from(trendCandidates).where(and(eq(trendCandidates.runId, id), eq(trendCandidates.selected, true))).limit(1);
    if (job || selected) throw new TrendError(409, 'TREND_REVERIFY_UNAVAILABLE', 'Przebieg ma już wybrany materiał lub zlecenia.');
    const [active] = await tx.select({ id: trendRuns.id }).from(trendRuns).where(inArray(trendRuns.status, [...running, 'uncertain'])).limit(1);
    if (active) throw new TrendError(409, 'TREND_ACTIVE', 'Najpierw zakończ lub wyjaśnij aktywny przebieg.');
    return run;
}
/** Reconcile existing evidence only. Never resubmit search or replace its settled bill. */
export async function reverifyTrendSearch(id: string, actor: EditorialActor): Promise<{ run: TrendRun; recipe: null; resume: boolean; generation: number }> {
    const snapshot = await getDb().transaction(async tx => {
        await lock(tx);
        if ((await account(tx, actor)).role !== 'owner') throw new TrendError(403, 'OWNER_REQUIRED', 'Tylko właściciel może wznowić opracowanie po ponownej weryfikacji.');
        return recoverableSearch(tx, id);
    });
    // Retrieval includes the original search sources; verification makes only bounded public GETs.
    const result = await pollTrendSearch(searchModelForRun(snapshot), snapshot.searchRequestId!);
    if (!result.done || !result.diagnostics) throw new TrendError(409, 'TREND_REVERIFY_UNAVAILABLE', 'Brak zakończonego wyniku do ponownej weryfikacji.');
    return getDb().transaction(async tx => {
        await lock(tx);
        if ((await account(tx, actor)).role !== 'owner') throw new TrendError(403, 'OWNER_REQUIRED', 'Tylko właściciel może wznowić opracowanie po ponownej weryfikacji.');
        const [current] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id)).for('update');
        if (!current || current.generation !== snapshot.generation || current.status !== snapshot.status || current.searchRequestId !== snapshot.searchRequestId || current.searchChargedUsd !== snapshot.searchChargedUsd || current.searchFinishedAt?.getTime() !== snapshot.searchFinishedAt?.getTime() || current.searchModel !== snapshot.searchModel)
            throw new TrendError(409, 'TREND_SUPERSEDED', 'Przebieg zmienił się podczas odczytu. Odśwież panel.');
        const run = await recoverableSearch(tx, id);
        const existing = await tx.select({ id: editorialRecipes.id, content: editorialRecipes.content, editorialStatus: editorialRecipes.editorialStatus }).from(editorialRecipes).where(isNull(editorialRecipes.deletedAt));
        const prior = await tx.select({ recipeId: trendRuns.recipeId, data: trendCandidates.data }).from(trendCandidates).innerJoin(trendRuns, eq(trendCandidates.runId, trendRuns.id)).where(eq(trendCandidates.selected, true));
        const generation = run.generation + 1;
        const now = new Date();
        const dishes = existing.filter(recipe => recipe.editorialStatus !== 'archived').map(recipe => ({ id: recipe.id, title: recipe.content.recipe.title, ...(recipe.content.recipe.ingredients.length ? { diet: getRecipeDiet(recipe.content.recipe) } : {}), aliases: prior.filter(candidate => candidate.recipeId === recipe.id).flatMap(candidate => [candidate.data.dishKey, ...candidate.data.aliases]) }));
        const selection = selectRecipeCandidate(rankCandidates(result.candidates, result.allowedUrls, dishes, id, now), dishes, id, now, await getTrendDietBalance(tx));
        const candidates = selection.candidates.map((candidate, index) => ({ ...candidate, id: `${id}-reverify-${generation}-${index}`, verificationGeneration: generation }));
        const selected = candidates.find(candidate => candidate.selected)!;
        const sources = emptySources();
        for (const platform of result.unavailable) sources[platform].status = 'unavailable';
        for (const candidate of candidates) for (const source of candidate.sources) { sources[source.platform].status = 'available'; sources[source.platform].count++; }
        const original = run.searchDiagnostics?.reverification ? run.searchDiagnostics.reverification.original : run.searchDiagnostics;
        const searchDiagnostics = { ...diagnosticsFor(run, result.diagnostics, Boolean(selected), candidates), reverification: { generation, at: now.toISOString(), original } };
        const [updated] = await tx.update(trendRuns).set({ generation, status: 'generating', candidateId: selected.id, sources, searchDiagnostics, error: null, workflowId: null, updatedAt: now }).where(eq(trendRuns.id, id)).returning();
        // Append evaluations: earlier uncited/invalid evidence remains available for audit.
        for (const candidate of candidates) await tx.insert(trendCandidates).values({ id: candidate.id, runId: id, dishKey: candidate.dishKey, data: candidate, selected: candidate.selected });
        await prepareSelectedDraft(tx, updated, selected);
        const [finished] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id));
        return { run: await runDto(finished, tx), recipe: null, resume: finished.status === 'generating' && Boolean(finished.recipeId), generation };
    });
}
/** An explicit owner choice prepares an inspiration, never qualifying it as a trend. */
export async function prepareTrendInspiration(id: string, candidateId: string, actor: EditorialActor): Promise<{ run: TrendRun; recipe: null; resume: boolean; generation: number }> {
    return getDb().transaction(async tx => {
        await lock(tx);
        const owner = await account(tx, actor);
        if (owner.role !== 'owner') throw new TrendError(403, 'OWNER_REQUIRED', 'Tylko właściciel może wybrać inspirację do opracowania.');
        const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id)).for('update');
        const [candidate] = await tx.select().from(trendCandidates).where(and(eq(trendCandidates.id, candidateId), eq(trendCandidates.runId, id))).for('update');
        if (!run || run.mode !== 'control' || !run.manualRequestKey || !candidate || !currentCandidate(candidate.data, run))
            throw new TrendError(409, 'TREND_INSPIRATION_UNAVAILABLE', 'Wybierz aktualną propozycję z zakończonego ręcznego wyszukiwania.');
        // The same admission may be replayed after transport failure without launching a second workflow.
        if (run.candidateId === candidateId && candidate.selected && candidate.data.editorChoice)
            return { run: await runDto(run, tx), recipe: null, resume: false, generation: run.generation };
        await recoverableSearch(tx, id);
        if (candidate.selected || candidate.data.selected || candidate.data.eligible || candidate.data.ambiguous || candidate.data.duplicateRecipeId || candidate.data.editorChoice)
            throw new TrendError(409, 'TREND_INSPIRATION_UNAVAILABLE', 'Ta propozycja jest już wybrana, kwalifikuje się jako trend albo wymaga wyjaśnienia podobieństwa.');
        if (!candidate.data.sources.some(source => approvedSourceUrl(source.url)))
            throw new TrendError(422, 'TREND_INSPIRATION_SOURCE_REQUIRED', 'Inspiracja wymaga co najmniej jednego zweryfikowanego materiału z dozwolonego źródła.');
        const [unknownSearch] = await tx.select({ id: trendRuns.id }).from(trendRuns).where(and(isNotNull(trendRuns.searchClaimedAt), isNull(trendRuns.searchFinishedAt), isNull(trendRuns.searchChargedUsd))).limit(1);
        const [unknownJob] = await tx.select({ id: aiJobs.id }).from(aiJobs).where(and(inArray(aiJobs.status, ['submitting', 'generating', 'uncertain', 'cancelled']), isNull(aiJobs.providerFinishedAt))).limit(1);
        if (unknownSearch || unknownJob) throw new TrendError(409, 'TREND_UNCERTAIN', 'Najpierw wyjaśnij przyjęte lub niepotwierdzone zlecenia.');
        if (!configuration(await settingsRow(tx)).configured) throw new TrendError(503, 'TREND_NOT_CONFIGURED', 'Podłącz wszystkie usługi przed opracowaniem inspiracji.');
        const existing = await tx.select({ id: editorialRecipes.id, content: editorialRecipes.content, editorialStatus: editorialRecipes.editorialStatus }).from(editorialRecipes).where(isNull(editorialRecipes.deletedAt));
        const prior = await tx.select({ recipeId: trendRuns.recipeId, data: trendCandidates.data }).from(trendCandidates).innerJoin(trendRuns, eq(trendCandidates.runId, trendRuns.id)).where(eq(trendCandidates.selected, true));
        const [checked] = rankCandidates([candidate.data], candidate.data.sources.map(source => source.url), existing.filter(recipe => recipe.editorialStatus !== 'archived').map(recipe => ({ id: recipe.id, title: recipe.content.recipe.title, ...(recipe.content.recipe.ingredients.length ? { diet: getRecipeDiet(recipe.content.recipe) } : {}), aliases: prior.filter(item => item.recipeId === recipe.id).flatMap(item => [item.data.dishKey, ...item.data.aliases]) })), id);
        if (!checked || checked.duplicateRecipeId || checked.ambiguous) throw new TrendError(409, 'TREND_DUPLICATE', 'Potrawa lub podobny przepis znajduje się już w książce.');
        const now = new Date();
        const selected: TrendCandidate = { ...candidate.data, selected: true, editorChoice: { by: owner.id, at: now.toISOString() } };
        await tx.update(trendCandidates).set({ selected: true, data: selected }).where(eq(trendCandidates.id, candidateId));
        const [updated] = await tx.update(trendRuns).set({ status: 'generating', candidateId, generation: run.generation + 1, error: null, workflowId: null, updatedAt: now }).where(eq(trendRuns.id, id)).returning();
        await prepareSelectedDraft(tx, updated, selected);
        const [finished] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id));
        return { run: await runDto(finished, tx), recipe: null, resume: finished.status === 'generating' && Boolean(finished.recipeId), generation: finished.generation };
    });
}
export async function trendJob(id: string, kind: 'recipe' | 'hero' | 'ingredient' | 'step', targetId?: string, generation?: number) {
    const run = await getTrendExecution(id);
    if (generation !== undefined && run.generation !== generation) throw new TrendError(409, 'TREND_SUPERSEDED', 'To przygotowanie zastąpiło nowe uruchomienie.');
    if (run.status !== 'generating')
        throw new TrendError(409, 'TREND_PAUSED', 'Przygotowanie wstrzymano.');
    const [selected] = run.candidateId ? await getDb().select().from(trendCandidates).where(eq(trendCandidates.id, run.candidateId)) : [];
    if (selected?.data.automaticSelection?.basis === 'catalog') throw new TrendError(409, 'TREND_CATALOG_REUSE', 'Przepis z katalogu jest już opracowany. Ten wybór nie uruchamia nowych zleceń.');
    const key = `trend_${id}_${kind}_${createHash('sha256').update(targetId ?? 'all').digest('hex').slice(0, 20)}`;
    const [existing] = await getDb().select().from(aiJobs).where(and(eq(aiJobs.trendRunId, id), eq(aiJobs.requestKey, key)));
    if (existing) {
        if (['failed', 'uncertain', 'cancelled'].includes(existing.status))
            throw new TrendError(409, 'TREND_JOB_REQUIRES_REVIEW', 'Istniejące zlecenie wymaga wyjaśnienia w Studio.');
        if (existing.kind !== 'recipe' && existing.model !== heroCutoutModel && existing.status === 'queued' && !existing.providerRequestId && !existing.reuseSourceJobId)
            preflightTrendPhotos(existing.input, aiSettings().maxInputBytes, { kind: existing.kind, targetId: existing.targetId, brief: existing.brief }, legacyTrendPhotoBriefs);
        return { job: await getJob(existing.id), created: false };
    }
    if (run.status !== 'generating' || !run.recipeId || !run.expectedRevision)
        throw new TrendError(409, 'TREND_PAUSED', 'Przygotowanie wstrzymano.');
    const recipe = await getRecipe(run.recipeId);
    if (recipe.deletedAt) throw new TrendError(409, 'RECIPE_DELETED', 'Przepis jest w Koszu. Przywróć go przed przygotowaniem.');
    if (recipe.revision !== run.expectedRevision) {
        await getDb().update(trendRuns).set({ status: 'paused', error: 'Ręczna edycja wstrzymała przygotowanie. Zachowano wszystkie wyniki.', updatedAt: new Date() }).where(and(eq(trendRuns.id, id), eq(trendRuns.generation, run.generation), eq(trendRuns.status, 'generating'), eq(trendRuns.expectedRevision, run.expectedRevision)));
        throw new TrendError(409, 'REVISION_CONFLICT', 'Ręczna edycja wstrzymała przygotowanie.');
    }
    if (kind !== 'recipe') await getDb().transaction(tx => requireManualTrendPhotoRequest(tx, run, recipe));
    const brief = kind === 'recipe' ? trendRecipeGenerationBrief : kind === 'hero' ? 'Fotografia gotowej potrawy: premium cookbook editorial photography, natural daylight, warm ivory background, true ingredients and appetising natural texture.' : kind === 'ingredient' ? 'Fotografia pojedynczego składnika w postaci wymaganej przez przepis, spokojne światło dzienne i styl zgodny ze zdjęciem głównym.' : 'Fotografia makro najważniejszego detalu tego kroku: prawidłowa konsystencja, stopień obróbki lub technika. Styl zgodny ze zdjęciem głównym.';
    if (kind !== 'recipe') preflightTrendPhotos(recipe.content, aiSettings().maxInputBytes, { kind, targetId, brief }, legacyTrendPhotoBriefs);
    return createJobAdmission({ recipeId: run.recipeId, expectedRevision: run.expectedRevision, kind, ...(targetId ? { targetId } : {}), brief, requestKey: key }, trendWorker, id, { generation, ingredientStyleProfile: currentIngredientStyleProfile });
}
export async function applyTrendBatch(id: string, jobIds: string[], generation?: number) { return getDb().transaction(async (tx) => { await lock(tx); const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id)).for('update'); if (generation !== undefined && run?.generation !== generation) throw new TrendError(409, 'TREND_SUPERSEDED', 'To przygotowanie zastąpiło nowe uruchomienie.'); if (!run?.expectedRevision)
    throw new TrendError(409, 'TREND_PAUSED', 'Brak bieżącej wersji.'); return applyTrendJobsInTransaction(tx, id, jobIds, run.expectedRevision, generation); }); }
export async function reserveTrendPhotos(id: string, generation?: number) {
  return getDb().transaction(async tx => {
    await lock(tx);
    const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id)).for('update');
    if (generation !== undefined && run?.generation !== generation) throw new TrendError(409, 'TREND_SUPERSEDED', 'To przygotowanie zastąpiło nowe uruchomienie.');
    if (!run || run.status !== 'generating' || !run.recipeId) throw new TrendError(409, 'TREND_PAUSED', 'Przygotowanie wstrzymano.');
    const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, run.recipeId)).for('share');
    if (recipe?.deletedAt) throw new TrendError(409, 'RECIPE_DELETED', 'Przepis jest w Koszu. Przywróć go przed przygotowaniem.');
    if (!recipe || recipe.revision !== run.expectedRevision) throw new TrendError(409, 'REVISION_CONFLICT', 'Przepis zmienił się.');
    await requireManualTrendPhotoRequest(tx, run, recipe);
    preflightTrendPhotos(recipe.content, aiSettings().maxInputBytes);
    return { ingredients: recipe.content.recipe.ingredients.map(item => item.id), steps: recipe.content.recipe.steps.filter(item => isStepPhotoRequired(recipe.content, item.id)).map(item => item.id) };
  });
}
/** A manual approval alone never starts photographs; a separate request captures its hash. */
export async function requireManualTrendPhotoRequest(tx: Tx, run: Pick<Run, 'generation' | 'searchDiagnostics'>, recipe: Pick<EditorialRecord, 'id' | 'revision' | 'content' | 'editorialStatus'> & { deletedAt?: string | Date | null }) {
    if (!hasCurrentManualPhotoRequest(run, contentApprovalHash(recipe.content))) throw new TrendError(409, 'MANUAL_PHOTO_REQUEST_REQUIRED', 'Fotografie wymagają osobnego zlecenia po ręcznej akceptacji bieżącej treści.');
    if (!await hasRecipeContentApproval(tx, recipe, 'manual')) throw new TrendError(409, 'CONTENT_APPROVAL_REQUIRED', 'Najpierw ręcznie sprawdź i zaakceptuj treść przepisu.');
}
export async function completeTrendRun(id: string, generation?: number) { await getDb().transaction(async (tx) => { await lock(tx); const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id)).for('update'); if (generation !== undefined && run?.generation !== generation) throw new TrendError(409, 'TREND_SUPERSEDED', 'To przygotowanie zastąpiło nowe uruchomienie.'); if (run?.status === 'awaiting_review')
    return; if (!run || run.status !== 'generating' || !run.recipeId)
    throw new TrendError(409, 'TREND_PAUSED', 'Przygotowanie wstrzymano.'); const recipe = await getRecipeInTransaction(tx, run.recipeId); if (recipe.revision !== run.expectedRevision)
    throw new TrendError(409, 'REVISION_CONFLICT', 'Przepis zmienił się.');
    if (!hasCurrentManualPhotoRequest(run, contentApprovalHash(recipe.content))) {
      await tx.update(trendRuns).set({ status: 'awaiting_review', packetRemainingUsd: '0', error: manualEditorialReviewReason, updatedAt: new Date() }).where(eq(trendRuns.id, id));
      return;
    }
    await requireManualTrendPhotoRequest(tx, run, recipe);
    const tested = structuredClone(recipe.content); for (const substitution of tested.recipe.substitutions ?? [])
    substitution.status = 'approved'; const contentIssues = await verifiedPublicationIssues(tested, tx); if (contentIssues.length)
    throw new TrendError(422, 'TREND_INCOMPLETE', 'Treść lub fotografie wymagają uzupełnienia.'); if (!recipe.content.recipe.image || recipe.content.recipe.ingredients.some(i => !recipe.content.photos.ingredients[i.id]) || recipe.content.recipe.steps.some(s => isStepPhotoRequired(recipe.content, s.id) && !recipe.content.photos.steps[s.id]))
    throw new TrendError(422, 'TREND_INCOMPLETE', 'Brakuje fotografii w pakiecie.'); await tx.update(trendRuns).set({ status: 'awaiting_review', packetRemainingUsd: '0', error: null, updatedAt: new Date() }).where(eq(trendRuns.id, id)); const [candidate] = run.candidateId ? await tx.select().from(trendCandidates).where(eq(trendCandidates.id, run.candidateId)) : []; if (run.mode === 'control' && candidate && (candidate.data.eligible || candidate.data.automaticSelection) && candidate.data.automaticSelection?.basis !== 'catalog' && !candidate.data.editorChoice && run.configurationFingerprint === fingerprint())
    await tx.update(trendSettings).set({ lastControlAt: new Date(), controlFingerprint: fingerprint(), updatedAt: new Date() }).where(eq(trendSettings.id, 'global')); }); }

export async function admitTrendPreparation(id: string, input: TrendRunAction, actor: EditorialActor) {
    if (!['repair', 'regenerate_photo'].includes(input.action) || !input.requestKey || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestKey) || !Number.isInteger(input.expectedRevision) || !input.expectedRevision || input.expectedRevision < 1) throw new TrendError(422, 'INVALID_PREPARATION', 'Odśwież przepis i wybierz poprawne działanie przygotowania.');
    if (input.action === 'regenerate_photo' && (!['hero', 'ingredient', 'step'].includes(input.kind ?? '') || (input.kind === 'hero' ? Boolean(input.targetId) : !input.targetId || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.targetId)))) throw new TrendError(422, 'TARGET_MISSING', 'Wybierz fotografię dania, składnika lub kroku.');
    return getDb().transaction(async tx => {
        await lock(tx);
        const authenticated = await account(tx, actor);
        if (authenticated.role !== 'owner') throw new TrendError(403, 'OWNER_REQUIRED', 'Tylko właściciel może wznowić przygotowanie lub zlecić nowe zdjęcie w Radarze.');
        const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id)).for('update');
        if (!run?.recipeId) throw new TrendError(409, 'TREND_DRAFT_REQUIRED', 'Najpierw wybierz przepis do przygotowania.');
        const regenerate = input.action === 'regenerate_photo' ? { kind: input.kind!, ...(input.targetId ? { targetId: input.targetId } : {}) } : undefined;
        const previous = run.searchDiagnostics?.preparation;
        if (previous && previous.requestKey === input.requestKey) {
            if (previous.expectedRevision !== input.expectedRevision || JSON.stringify(previous.regenerate) !== JSON.stringify(regenerate)) throw new TrendError(409, 'REQUEST_KEY_REUSED', 'To zgłoszenie dotyczyło innej operacji. Odśwież panel.');
            return { run: await runDto(run, tx), recipe: null, resume: false, generation: run.generation };
        }
        if (running.includes(run.status as typeof running[number])) throw new TrendError(409, 'TREND_ACTIVE', 'Przygotowanie już trwa. Panel pokaże gotowe materiały.');
        if (['rejected', 'no_candidate'].includes(run.status)) throw new TrendError(409, 'TREND_FINAL', 'Ten przebieg został zakończony.');
        const [other] = await tx.select({ id: trendRuns.id }).from(trendRuns).where(and(inArray(trendRuns.status, [...running]), sql`${trendRuns.id} <> ${id}`)).limit(1);
        if (other) throw new TrendError(409, 'TREND_ACTIVE', 'Zaczekaj na zakończenie bieżącego przygotowania.');
        if (!run.searchFinishedAt && run.searchClaimedAt && !run.searchRequestId) throw new TrendError(409, 'TREND_SEARCH_UNCERTAIN', 'Nie potwierdzono przyjęcia istniejącego wyszukiwania. Nowe zlecenie nie zostanie wysłane.');
        const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, run.recipeId)).for('update');
        if (recipe?.deletedAt) throw new TrendError(409, 'RECIPE_DELETED', 'Przepis jest w Koszu. Przywróć go przed przygotowaniem.');
        if (!recipe || recipe.revision !== input.expectedRevision) throw new TrendError(409, 'REVISION_CONFLICT', 'Przepis zmienił się. Zapisz teksty i odśwież panel przed przygotowaniem.');
        if (recipe.editorialStatus === 'archived') throw new TrendError(409, 'ARCHIVED', 'Przywróć przepis z archiwum przed przygotowaniem.');
        if (!await hasRecipeContentApproval(tx, recipe, 'manual')) throw new TrendError(409, 'CONTENT_APPROVAL_REQUIRED', 'Najpierw ręcznie sprawdź i zaakceptuj treść, a następnie osobno zleć fotografie.');
        if (regenerate && regenerate.kind !== 'hero' && !(regenerate.kind === 'ingredient' ? recipe.content.recipe.ingredients : recipe.content.recipe.steps).some(item => item.id === regenerate.targetId)) throw new TrendError(422, 'TARGET_MISSING', 'Wybrany składnik lub krok nie znajduje się już w przepisie.');
        const config = aiSettings();
        if (!config.fal || !config.storage) throw new TrendError(503, 'TREND_NOT_CONFIGURED', 'Podłącz usługę fotografii i magazyn plików przed zleceniem zdjęć.');
        const generation = run.generation + 1;
        const now = new Date();
        const preparation: TrendPreparation = { requestKey: input.requestKey!, expectedRevision: input.expectedRevision!, generation, startedAt: now.toISOString(), approvedContentHash: contentApprovalHash(recipe.content), requestedBy: authenticated.id, ...(regenerate ? { regenerate } : {}) };
        const diagnostics: TrendSearchDiagnostics = { ...(run.searchDiagnostics ?? { version: 1, model: searchModelForRun(run), toolCalls: 0, queries: [], retrievedUrls: 0, discoveredCandidates: 0, submittedSources: 0, verifiedSources: 0, issueCounts: {} }), preparation };
        await cancelUnsubmittedTrendJobsInTransaction(tx, id);
        const [updated] = await tx.update(trendRuns).set({ status: 'generating', generation, expectedRevision: recipe.revision, workflowId: null, error: null, searchDiagnostics: diagnostics, updatedAt: now }).where(eq(trendRuns.id, id)).returning();
        return { run: await runDto(updated, tx), recipe: null, resume: true, generation };
    });
}
export async function actOnTrendRun(id: string, input: TrendRunAction, actor: EditorialActor): Promise<{
    run: TrendRun;
    recipe: EditorialRecord | null;
    resume: boolean;
    generation?: number;
}> {
    if (input.action === 'repair' || input.action === 'regenerate_photo') return admitTrendPreparation(id, input, actor);
    if (input.action === 'reverify') return reverifyTrendSearch(id, actor);
    if (input.action === 'prepare_inspiration') {
        if (!input.candidateId) throw new TrendError(422, 'TREND_CANDIDATE_REQUIRED', 'Wybierz propozycję do opracowania.');
        return prepareTrendInspiration(id, input.candidateId, actor);
    }
    if (input.action === 'approve_and_publish')
        return getDb().transaction(async (tx) => {
            await lock(tx);
            await account(tx, actor);
            const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id)).for('update');
            if (!run?.recipeId || !['awaiting_review', 'paused', 'failed'].includes(run.status))
                throw new TrendError(409, 'TREND_REVIEW_REQUIRED', 'Najpierw ukończ przygotowanie przepisu.');
            if (!input.expectedRevision || !input.checks)
                throw new TrendError(422, 'REVIEW_REQUIRED', 'Potwierdź bieżącą wersję i wszystkie obszary.');
            const [pending] = await tx.select({ id: aiJobs.id }).from(aiJobs).where(and(eq(aiJobs.recipeId, run.recipeId), inArray(aiJobs.status, ['queued', 'submitting', 'generating', 'uncertain']), isNull(aiJobs.providerFinishedAt))).limit(1);
            if (pending) throw new TrendError(409, 'TREND_REVIEW_REQUIRED', 'Najpierw ukończ lub wyjaśnij trwające przygotowanie zdjęć.');
            const recipe = await performRecipeActionInTransaction(tx, run.recipeId, { action: 'approve_and_publish', expectedRevision: input.expectedRevision, checks: input.checks }, actor);
            const [updated] = await tx.update(trendRuns).set({ status: 'published', expectedRevision: recipe.revision, packetRemainingUsd: '0', updatedAt: new Date() }).where(eq(trendRuns.id, id)).returning();
            return { run: await runDto(updated, tx), recipe, resume: false };
        });
    await getDb().transaction(async (tx) => {
        await account(tx, actor);
        await lock(tx);
        const [run] = await tx.select().from(trendRuns).where(eq(trendRuns.id, id)).for('update');
        if (!run)
            throw new TrendError(404, 'TREND_NOT_FOUND', 'Brak przebiegu.');
        if (['published', 'rejected', 'no_candidate'].includes(run.status))
            throw new TrendError(409, 'TREND_FINAL', 'Ten przebieg został zakończony.');
        if (input.action === 'resume') {
            if (run.status !== 'paused')
                throw new TrendError(409, 'TREND_CANNOT_RESUME', 'Można wznowić wstrzymany przebieg.');
            if (!run.recipeId) {
                if (run.searchFinishedAt && run.candidateId) {
                    const [candidate] = await tx.select().from(trendCandidates).where(eq(trendCandidates.id, run.candidateId));
                    if (!candidate)
                        throw new TrendError(409, 'TREND_CANNOT_RESUME', 'Brak kandydata.');
                    const [continued] = await tx.update(trendRuns).set({ status: 'generating', generation: run.generation + 1, error: null, updatedAt: new Date() }).where(eq(trendRuns.id, id)).returning();
                    await prepareSelectedDraft(tx, continued, candidate.data);
                    return;
                }
                if (run.searchRequestId && !run.searchFinishedAt) {
                    await tx.update(trendRuns).set({ status: 'searching', generation: run.generation + 1, error: null, updatedAt: new Date() }).where(eq(trendRuns.id, id));
                    return;
                }
                if (!run.searchClaimedAt) {
                    await tx.update(trendRuns).set({ status: 'queued', generation: run.generation + 1, error: null, updatedAt: new Date() }).where(eq(trendRuns.id, id));
                    return;
                }
                throw new TrendError(409, 'TREND_SEARCH_UNCERTAIN', 'Nie można potwierdzić przyjęcia wyszukiwania. Żądanie nie będzie wysłane ponownie. Odrzuć przebieg, aby odblokować kolejny dzień.');
            }
            const [recipe] = await tx.select().from(editorialRecipes).where(eq(editorialRecipes.id, run.recipeId));
            if (recipe?.deletedAt) throw new TrendError(409, 'RECIPE_DELETED', 'Przepis jest w Koszu. Przywróć go przed przygotowaniem.');
            if (!recipe || recipe.revision !== run.expectedRevision)
                throw new TrendError(409, 'REVISION_CONFLICT', 'Szkic był edytowany. Zastosuj zachowane wyniki ręcznie w Studio.');
            const [candidate] = run.candidateId ? await tx.select().from(trendCandidates).where(eq(trendCandidates.id, run.candidateId)) : [];
            if (candidate?.data.automaticSelection?.basis === 'catalog') {
                await tx.update(trendRuns).set({ status: 'awaiting_review', generation: run.generation + 1, error: null, updatedAt: new Date() }).where(eq(trendRuns.id, id));
                return;
            }
            const jobs = await tx.select().from(aiJobs).where(eq(aiJobs.trendRunId, id));
            if (jobs.some(job => ['failed', 'uncertain', 'cancelled'].includes(job.status)))
                throw new TrendError(409, 'TREND_UNCERTAIN', 'Najpierw wyjaśnij niepotwierdzone zlecenie w Studio.');
            await tx.update(trendRuns).set({ status: 'generating', generation: run.generation + 1, error: null, updatedAt: new Date() }).where(eq(trendRuns.id, id));
        }
        else {
            const rejected = input.action === 'reject';
            if (rejected) await cancelUnsubmittedTrendJobsInTransaction(tx, id);
            const unsubmittedSearch = rejected && !run.searchClaimedAt && !run.searchRequestId;
            await tx.update(trendRuns).set({
                status: rejected ? 'rejected' : 'paused',
                error: input.action === 'pause' ? 'Proces wstrzymano w panelu.' : null,
                packetRemainingUsd: rejected ? '0' : run.packetRemainingUsd,
                searchChargedUsd: unsubmittedSearch ? '0' : run.searchChargedUsd,
                searchFinishedAt: unsubmittedSearch ? new Date() : run.searchFinishedAt,
                updatedAt: new Date(),
            }).where(eq(trendRuns.id, id));
        }
    });
    const updated = (await getTrendRun(id)).run;
    return { run: updated, recipe: null, resume: input.action === 'resume' && running.includes(updated.status as typeof running[number]) };
}
export async function trendJobDone(id: string) { const job = await getJob(id); return job.status === 'ready' || job.status === 'applied'; }
