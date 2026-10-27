'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** A tab left open across Warsaw midnight updates its seasonal promotion. */
export function CollectionPromotionRefresh({ nextBoundary }: { nextBoundary: number }) {
  const router = useRouter();
  useEffect(() => {
    let refreshed = false;
    let lastRefresh = Date.now();
    function refreshWhenDue() {
      if (!refreshed && Date.now() >= nextBoundary) { refreshed = true; lastRefresh = Date.now(); router.refresh(); }
    }
    function refreshOnReturn() {
      if (document.visibilityState !== 'visible') return;
      refreshWhenDue();
      if (Date.now() - lastRefresh >= 60_000) { lastRefresh = Date.now(); router.refresh(); }
    }
    const timer = window.setTimeout(refreshWhenDue, Math.max(0, Math.min(2_147_483_647, nextBoundary - Date.now() + 100)));
    document.addEventListener('visibilitychange', refreshOnReturn);
    window.addEventListener('focus', refreshOnReturn);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', refreshOnReturn); window.removeEventListener('focus', refreshOnReturn); };
  }, [nextBoundary, router]);
  return null;
}
