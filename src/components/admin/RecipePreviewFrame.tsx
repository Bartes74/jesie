'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react';
import { inspectRecipePreview, previewTimeoutAction, readRecipePreviewReady, recipePreviewUrl } from '@/lib/recipe-preview';
import type { Locale } from '@/lib/recipes';

type Props = { recipeId: string; revision: number; locale: Locale; reviewToken?: string; onReady?: (locale: Locale, revision: number) => void; onLocaleChange?: (locale: Locale) => void };

export function RecipePreviewFrame(props: Props) {
  // A language or revision change owns a fresh bounded navigation session.
  return <PreviewSession key={`${props.recipeId}:${props.revision}:${props.locale}:${props.reviewToken ?? ''}`} {...props} />;
}

function PreviewSession({ recipeId, revision, locale, reviewToken, onReady, onLocaleChange }: Props) {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const frame = useRef<HTMLIFrameElement>(null);
  const attemptRef = useRef(0);
  const src = recipePreviewUrl(recipeId, revision, locale, reviewToken, attempt);
  const inspect = useCallback((element: HTMLIFrameElement): ReturnType<typeof inspectRecipePreview> => {
    try {
      const document = element.contentDocument;
      if (!document) return 'pending';
      const marker = document.querySelector('[data-preview-recipe]');
      return inspectRecipePreview({ url: document.URL, recipeId: marker?.getAttribute('data-preview-recipe') ?? null,
        revision: marker?.getAttribute('data-preview-revision') ?? null, locale: marker?.getAttribute('data-preview-locale') ?? null,
        hasContent: Boolean(marker?.textContent?.trim()) },
      { url: new URL(src, window.location.href).href, recipeId, revision, locale });
    } catch { return 'error'; }
  }, [locale, recipeId, revision, src]);

  useEffect(() => {
    if (!reviewToken) return;
    const ready = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      const message = readRecipePreviewReady(event.data, { recipeId, revision, token: reviewToken });
      if (!message) return;
      setStatus('ready');
      onReady?.(message.locale, message.revision);
      if (message.locale !== locale) onLocaleChange?.(message.locale);
    };
    window.addEventListener('message', ready);
    return () => window.removeEventListener('message', ready);
  }, [recipeId, revision, reviewToken, locale, onReady, onLocaleChange]);

  useEffect(() => {
    if (status !== 'loading') return;
    const currentFrame = frame.current;
    const timer = setTimeout(() => {
      // An event or timeout belonging to an old frame cannot affect this one.
      if (!currentFrame || frame.current !== currentFrame || attemptRef.current !== attempt) return;
      if (inspect(currentFrame) === 'ready') { setStatus('ready'); onReady?.(locale, revision); return; }
      if (previewTimeoutAction(attempt) === 'retry') {
        const next = attemptRef.current + 1;
        attemptRef.current = next;
        setAttempt(next);
      }
      else setStatus('error');
    }, 15_000);
    return () => clearTimeout(timer);
  }, [attempt, inspect, status, locale, revision, onReady]);

  return <div>
    {status === 'loading' && <div className="guided-working" role="status"><LoaderCircle size={19} className="admin-spinner" /><p>{attempt === 0 ? 'Wczytuję podgląd bieżącej wersji przepisu…' : 'Ponownie wczytuję podgląd bieżącej wersji przepisu…'}</p></div>}
    {status === 'error' && <div className="admin-notice is-error" role="alert"><AlertCircle size={19} /><div><p>Nie udało się potwierdzić podglądu w tym oknie. Ponów wczytanie lub otwórz pełny podgląd powyżej. Po wczytaniu pełnego podglądu panel zaliczy jego język. Jeśli zobaczysz logowanie albo informację o nowszej wersji, wróć do panelu i odśwież stan przepisu.</p><button type="button" className="admin-button is-secondary" onClick={() => { const next = attemptRef.current + 1; attemptRef.current = next; setStatus('loading'); setAttempt(next); }}><RefreshCw size={16} />Ponów wczytanie</button></div></div>}
    <iframe ref={frame} className="admin-preview-frame guided-preview-frame" src={src} loading="eager" hidden={status === 'error'} title={locale === 'pl' ? 'Podgląd przepisu po polsku' : 'Recipe preview in English'} onLoad={event => {
      if (frame.current !== event.currentTarget || attemptRef.current !== attempt) return;
      const result = inspect(event.currentTarget);
      if (result === 'ready') onReady?.(locale, revision);
      if (result !== 'pending') setStatus(result);
    }} />
  </div>;
}
