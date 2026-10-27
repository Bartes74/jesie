'use client';

import { useEffect } from 'react';
import { previewReviewChannel, recipePreviewReadyMessage, type RecipePreviewScope } from '@/lib/recipe-preview';
import type { Locale } from '@/lib/recipes';

/** Rendered only after the authenticated, current, complete preview is available. */
export function RecipePreviewReady({ scope, locale }: { scope: RecipePreviewScope; locale: Locale }) {
  const { recipeId, revision, token } = scope;
  useEffect(() => {
    const message = recipePreviewReadyMessage({ recipeId, revision, token }, locale);
    if (window.parent !== window) window.parent.postMessage(message, window.location.origin);
    // Full previews retain noopener; the scoped same-origin channel connects their editor.
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel(previewReviewChannel(token));
      channel.postMessage(message);
    } catch { /* The embedded preview also has its load/document fallback. */ }
    return () => channel?.close();
  }, [recipeId, revision, token, locale]);
  return null;
}
