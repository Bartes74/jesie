import type { TrendSearchDiagnostics } from '@/lib/trend-types';

export const manualEditorialReviewReason = 'Treść jest gotowa do ręcznej oceny. Po akceptacji treści zdecyduj osobno o fotografiach. Publikacja wymaga ręcznego działania w edytorze.';
export const manualPublicationReason = 'Publikacja jest ręczna. Codzienny harmonogram przygotowuje wyłącznie research i tekst do Twojej oceny.';

/** Approval and a separate, current photo request are both required. */
export function hasCurrentManualPhotoRequest(run: { generation: number; searchDiagnostics: TrendSearchDiagnostics | null }, contentHash: string): boolean {
  const request = run.searchDiagnostics?.preparation;
  return Boolean(request?.requestKey && request.generation === run.generation && request.approvedContentHash === contentHash);
}
