/** The preparation cron uses noon UTC; Warsaw's displayed hour follows DST. */
export function nextTrendSearchAt(now: Date) {
  const next = new Date(now); next.setUTCHours(12, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}
