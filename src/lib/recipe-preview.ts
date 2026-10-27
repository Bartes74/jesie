export type PreviewDocument = {
  url: string;
  recipeId: string | null;
  revision: string | null;
  locale: string | null;
  hasContent: boolean;
};

export type RecipePreviewScope = { recipeId: string; revision: number; token: string };
type PreviewLocale = 'pl' | 'en';

export function validPreviewReviewToken(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function previewReviewChannel(token: string): string {
  return `jesie:preview-review:v1:${token}`;
}

export function recipePreviewReadyMessage(scope: RecipePreviewScope, locale: PreviewLocale) {
  return { type: 'jesie:preview-ready:v1' as const, recipeId: scope.recipeId, revision: scope.revision, token: scope.token, locale };
}

/** A ready event belongs to one editor's exact recipe revision and review session. */
export function readRecipePreviewReady(value: unknown, expected: RecipePreviewScope): { locale: PreviewLocale; revision: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validPreviewReviewToken(expected.token)
    || !Number.isSafeInteger(expected.revision) || expected.revision < 1 || !expected.recipeId) return null;
  const message = value as Record<string, unknown>;
  if (message.type !== 'jesie:preview-ready:v1' || message.recipeId !== expected.recipeId || message.revision !== expected.revision
    || message.token !== expected.token || !validPreviewReviewToken(message.token) || (message.locale !== 'pl' && message.locale !== 'en')) return null;
  return { locale: message.locale, revision: expected.revision };
}

export function recipePreviewUrl(recipeId: string, revision: number, locale: PreviewLocale, token?: string, attempt?: number): string {
  const params = new URLSearchParams({ revision: String(revision) });
  if (validPreviewReviewToken(token)) params.set('previewReview', token);
  if (attempt !== undefined && Number.isSafeInteger(attempt) && attempt >= 0) params.set('previewAttempt', String(attempt));
  return `/${locale}/preview/${encodeURIComponent(recipeId)}?${params}`;
}

function canonicalPreviewUrl(value: string): string | null {
  try { const url = new URL(value); url.searchParams.delete('previewAttempt'); return url.href; }
  catch { return null; }
}

/** The read-only navigation nonce may differ; recipe, revision and locale may not. */
export function inspectRecipePreview(document: PreviewDocument, expected: { url: string; recipeId: string; revision: number; locale: string }): 'pending' | 'ready' | 'error' {
  if (!document.url || document.url === 'about:blank') return 'pending';
  const actualUrl = canonicalPreviewUrl(document.url);
  const expectedUrl = canonicalPreviewUrl(expected.url);
  if (!actualUrl || !expectedUrl || actualUrl !== expectedUrl || document.recipeId !== expected.recipeId || document.revision !== String(expected.revision)
    || document.locale !== expected.locale || !document.hasContent) return 'error';
  return 'ready';
}

/** One new navigation may recover an iframe that missed its initial src load. */
export function previewTimeoutAction(attempt: number): 'retry' | 'error' {
  return attempt === 0 ? 'retry' : 'error';
}
