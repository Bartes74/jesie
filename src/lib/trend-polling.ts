/** Shared packet and retry ceilings keep the durable run's event budget bounded. */
export const trendRunLimits = {
  photographs: 40,
  statusRetries: 4,
  admissionRetries: 60,
  billingAttempts: 6,
} as const;

export type TrendPollDelay = `${number}${'s' | 'm'}`;

// Fast feedback first; queued requests are then read at most every five minutes.
// Twenty reads retain a 64-minute window, longer than the previous 60 minutes.
export const trendJobPollDelays = [
  '10s', '10s', '20s', '20s', '30s', '30s', '1m', '1m',
  '5m', '5m', '5m', '5m', '5m', '5m',
  '5m', '5m', '5m', '5m', '5m', '5m',
] as const satisfies readonly TrendPollDelay[];

// Fourteen reads retain a 34-minute window for the search, previously 30 minutes.
export const trendSearchPollDelays = trendJobPollDelays.slice(0, 14);

/** Pure orchestration: callers supply Workflow sleep and receipt-only reads. */
export async function pollWithBackoff(
  delays: readonly TrendPollDelay[],
  pause: (delay: TrendPollDelay) => Promise<unknown>,
  readExistingRequest: () => Promise<boolean>,
): Promise<boolean> {
  for (const delay of delays) {
    await pause(delay);
    if (await readExistingRequest()) return true;
  }
  return false;
}
