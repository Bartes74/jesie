import type { TrendCandidate } from '@/lib/trend-types';
import { nextCalendarDate } from '@/lib/daily-publication';
import { rankCandidates } from './ranking';

export function automaticPublicationDate(researchDate: string) {
  return nextCalendarDate(researchDate);
}

/** A research fallback is an editorial draft, never evidence of social popularity. */
export function isVerifiedAutomaticTrend(candidate: TrendCandidate, runId: string, now = new Date()): boolean {
  if (candidate.runId !== runId || !candidate.selected || !candidate.eligible || candidate.editorChoice
    || candidate.automaticSelection || candidate.duplicateRecipeId || candidate.ambiguous) return false;
  const [checked] = rankCandidates([candidate], candidate.sources.map(source => source.url), [], runId, now);
  return Boolean(checked?.eligible);
}

export function isAutomaticPublicationRun(run: {
  id: string; date: string; mode: string; manualRequestKey: string | null;
  status: string; searchRequestId: string | null; searchFinishedAt: Date | null; searchChargedUsd: string | null;
  searchDiagnostics?: { preparation?: unknown } | null;
}, candidate: TrendCandidate, publicationDate: string, now = new Date(), manuallyTakenOver = false): boolean {
  return run.mode === 'daily' && run.manualRequestKey === null && run.status === 'awaiting_review'
    && !manuallyTakenOver && !run.searchDiagnostics?.preparation
    && Boolean(run.searchRequestId && run.searchFinishedAt && run.searchChargedUsd !== null)
    && automaticPublicationDate(run.date) === publicationDate
    && isVerifiedAutomaticTrend(candidate, run.id, now);
}
