'use client';

import Link from 'next/link';
import { useEffect, type ComponentProps } from 'react';

function fragmentTarget(hash: string): HTMLElement | null {
  if (!hash || hash === '#') return null;
  try { return document.getElementById(decodeURIComponent(hash.slice(1))); } catch { return null; }
}
function revealSection(target: HTMLElement, focus: boolean) {
  if (focus) {
    const temporaryTabIndex = !target.hasAttribute('tabindex');
    if (temporaryTabIndex) {
      target.setAttribute('tabindex', '-1');
      target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
    }
    target.focus({ preventScroll: true });
  }
  target.scrollIntoView({ block: 'start', behavior: 'auto' });
}

/** Also restore an initial fragment after the client-side kitchen state hydrates. */
export function useSectionNavigation() {
  useEffect(() => {
    let frame = 0;
    const restore = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const target = fragmentTarget(window.location.hash);
        if (target) revealSection(target, false);
      });
    };
    restore();
    window.addEventListener('hashchange', restore);
    window.addEventListener('popstate', restore);
    window.addEventListener('load', restore);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('hashchange', restore);
      window.removeEventListener('popstate', restore);
      window.removeEventListener('load', restore);
    };
  }, []);
}

/** Next handles route changes; an existing page always scrolls even to its current hash. */
export function SectionLink({ href, onClick, replace, ...props }: Omit<ComponentProps<typeof Link>, 'href'> & { href: string }) {
  return <Link {...props} href={href} replace={replace} onClick={event => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
      || event.currentTarget.hasAttribute('download') || event.currentTarget.target && event.currentTarget.target !== '_self') return;
    const destination = new URL(event.currentTarget.href, window.location.href);
    if (destination.origin !== window.location.origin || destination.pathname !== window.location.pathname) return;
    const target = fragmentTarget(destination.hash);
    if (!target) return;
    event.preventDefault();
    const next = `${destination.pathname}${destination.search}${destination.hash}`;
    // Native history is integrated with Next's useSearchParams: ?saved=1 and
    // every other explicitly supplied filter remain part of the navigation.
    if (destination.href !== window.location.href) {
      if (replace) window.history.replaceState(null, '', next); else window.history.pushState(null, '', next);
    }
    requestAnimationFrame(() => revealSection(target, true));
  }} />;
}
