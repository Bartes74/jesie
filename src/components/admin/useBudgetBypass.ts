'use client';

import { useEffect, useState } from 'react';

type BudgetStatus = { limitsEnforced?: boolean; bypassUntil?: string | null; serverNow?: string };

/** Expiry only updates the preview; the server always decides paid admission. */
export function useBudgetBypass(budget?: BudgetStatus | null) {
  const until = budget?.bypassUntil ?? null;
  const serverNow = budget?.serverNow;
  const enabled = budget?.limitsEnforced === false && until !== null;
  const key = until + ':' + (serverNow ?? '');
  const [expiredKey, setExpiredKey] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !until) return;
    const serverTime = serverNow ? Date.parse(serverNow) : NaN;
    const remaining = Date.parse(until) - (Number.isFinite(serverTime) ? serverTime : Date.now());
    const timer = setTimeout(() => setExpiredKey(key), Number.isFinite(remaining) ? Math.max(0, remaining) : 0);
    return () => clearTimeout(timer);
  }, [enabled, until, serverNow, key]);

  return enabled && expiredKey !== key;
}
