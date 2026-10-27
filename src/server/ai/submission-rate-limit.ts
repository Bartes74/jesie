import { ProviderError } from './provider-error';

export const maximumRateLimitRetries = 2;
export const maximumRateLimitDelayMs = 10_000;

/** Only an explicit rate-limit rejection grants another submission attempt. */
export function isConfirmedRateLimit(status: number | undefined, code: unknown, type?: unknown) {
  if (status !== 429) return false;
  const values = [code, type].filter((value): value is string => typeof value === 'string');
  if (values.some(value => /quota|billing|credit|payment|balance/i.test(value))) return false;
  return ['rate_limit_exceeded', 'rate_limited', 'slow_down', 'rate_limit_error'].includes(String(code))
    || (code == null && type === 'rate_limit_error');
}

export class ConfirmedRateLimitError extends Error {
  constructor(readonly retryAfter: string | null, readonly retryAfterMs: string | null = null) {
    super('CONFIRMED_RATE_LIMIT'); this.name = 'ConfirmedRateLimitError';
  }
}

function serverDelay(error: ConfirmedRateLimitError, now: number): number | null {
  const delays: number[] = [];
  if (error.retryAfter !== null) {
    const text = error.retryAfter.trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) delays.push(Number(text) * 1000);
    else if (/^[A-Za-z]{3},/.test(text)) { const date = Date.parse(text); if (Number.isFinite(date)) delays.push(Math.max(0, date - now)); }
  }
  if (error.retryAfterMs !== null && /^\d+(?:\.\d+)?$/.test(error.retryAfterMs.trim())) delays.push(Number(error.retryAfterMs));
  return delays.length ? Math.max(...delays) : null;
}

/** This loop runs before settlement, retaining one admission and reservation.
 * Process/transport uncertainty is never retried; the durable caller handles it. */
export async function retryConfirmedRateLimit<T>(submit: () => Promise<T>, beforeSubmit?: () => Promise<void>, options: {
  wait?: (milliseconds: number) => Promise<void>; random?: () => number; now?: () => number;
} = {}): Promise<T> {
  const wait = options.wait ?? (milliseconds => milliseconds === 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; ; attempt++) {
    await beforeSubmit?.();
    try { return await submit(); }
    catch (error) {
      if (!(error instanceof ConfirmedRateLimitError)) throw error;
      const hint = serverDelay(error, (options.now ?? Date.now)());
      // A long provider hint is a stop, never permission to retry sooner.
      if (attempt >= maximumRateLimitRetries || hint !== null && (!Number.isFinite(hint) || hint > maximumRateLimitDelayMs)) {
        throw new ProviderError('AI_PROVIDER_RATE_LIMITED', 'Chwilowy limit usługi nie ustąpił w czasie bezpiecznych prób. Nie przyjęto nowego zlecenia.');
      }
      const minimum = Math.max(hint ?? 0, 1000 * 2 ** attempt);
      const sampled = (options.random ?? Math.random)();
      const random = Number.isFinite(sampled) ? Math.max(0, Math.min(1, sampled)) : 0;
      const delay = Math.min(maximumRateLimitDelayMs, Math.ceil(minimum + random * Math.min(250, maximumRateLimitDelayMs - minimum)));
      await wait(delay);
    }
  }
}

/** Read only a small error envelope; unknown/malformed errors grant no retry. */
export async function confirmedFalRateLimit(response: Response): Promise<ConfirmedRateLimitError | null> {
  if (response.status !== 429 || !response.body) return null;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > 8192) { await reader.cancel(); return null; }
      chunks.push(item.value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const raw = body as Record<string, unknown>;
    const nested = raw.error ?? raw.detail ?? raw;
    const error = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : raw;
    return isConfirmedRateLimit(429, error.code, error.type)
      ? new ConfirmedRateLimitError(response.headers.get('retry-after'), response.headers.get('retry-after-ms')) : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}
