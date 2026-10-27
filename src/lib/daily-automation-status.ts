export function dailyAutomationStatus(value: { enabled: boolean; operational: boolean; reason: string | null; reviewQueue: readonly unknown[]; latestResearch: { status: string } | null }) {
  if (!value.enabled) return { label: 'Codzienne wyszukiwanie jest wyłączone.', state: 'disabled' as const };
  if (!value.operational) return { label: 'Codzienne przygotowanie wymaga uwagi.', state: 'blocked' as const };
  if (value.latestResearch && ['failed', 'uncertain', 'paused'].includes(value.latestResearch.status)) return { label: 'Przygotowanie wymaga sprawdzenia.', state: 'attention' as const };
  if (value.latestResearch && ['queued', 'searching', 'generating'].includes(value.latestResearch.status)) return { label: 'Wyszukiwanie i opracowanie tekstu trwają.', state: 'working' as const };
  if (value.reviewQueue.length || value.latestResearch?.status === 'awaiting_review') return { label: 'Szkic czeka na Twoją ocenę.', state: 'review' as const };
  return { label: 'Codzienne wyszukiwanie jest włączone. Czeka na kolejny termin.', state: 'running' as const };
}
