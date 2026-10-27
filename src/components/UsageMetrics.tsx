'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { parseUsageEvent, usagePath, usageSource, type UsageEventName } from '@/lib/usage-metrics';

let metricsEnabled = false;

/** Best-effort counts do not use cookies, browser storage or visitor identifiers. */
export function recordUsage(name: UsageEventName, path?: string): void {
  if (!metricsEnabled || typeof window === 'undefined') return;
  const privacy = navigator as Navigator & { globalPrivacyControl?: boolean };
  const legacyWindow = window as Window & { doNotTrack?: string };
  if (privacy.doNotTrack === '1' || legacyWindow.doNotTrack === '1' || privacy.globalPrivacyControl === true) return;
  if (new URLSearchParams(window.location.search).has('preview') || new URLSearchParams(window.location.search).has('draft')) return;
  const event = parseUsageEvent({ name, path: path ?? window.location.pathname, source: usageSource(document.referrer, window.location.origin) });
  if (!event) return;
  // Omit even existing application cookies and the current URL's Referer header.
  void fetch('/api/analytics', { method: 'POST', credentials: 'omit', keepalive: true,
    referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) }).catch(() => {});
}

export function UsageMetrics({ enabled }: { enabled: boolean }) {
  const pathname = usePathname();
  const lastPath = useRef<string | null>(null);
  useEffect(() => {
    metricsEnabled = enabled;
    const path = usagePath(pathname);
    if (enabled && path && path !== lastPath.current) {
      lastPath.current = path;
      recordUsage('page_view', path);
    }
    return () => { metricsEnabled = false; };
  }, [enabled, pathname]);
  return null;
}
