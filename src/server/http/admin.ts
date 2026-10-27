import 'server-only';
import { ZodError, z } from 'zod';
import { requireAdmin, AdminAccessError, getAuthOrigin } from '@/server/auth';
import { EditorialError } from '@/server/editorial/store';
import type { EditorialActor } from '@/lib/editorial-types';
import { isDatabaseUnavailable } from './database-failure';

export async function adminActor(request: Request, mutation = false): Promise<EditorialActor> {
  const session = await requireAdmin(request.headers);
  if (mutation) {
    const origin = request.headers.get('origin');
    if (!origin || origin !== getAuthOrigin() || request.headers.get('sec-fetch-site') === 'cross-site') throw new AdminAccessError('Niedozwolone pochodzenie żądania.', 403);
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AdminAccessError('Wymagany format JSON.', 415);
  }
  return session.user;
}

export async function readJson(request: Request) {
  if (Number(request.headers.get('content-length') ?? 0) > 1_000_000) throw new AdminAccessError('Przepis jest zbyt duży.', 413);
  const source = await request.text();
  if (Buffer.byteLength(source, 'utf8') > 1_000_000) throw new AdminAccessError('Przepis jest zbyt duży.', 413);
  try { return JSON.parse(source) as unknown; }
  catch { throw new AdminAccessError('Nieprawidłowy JSON.', 400); }
}

export function adminResponse(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
}

export function adminFailure(error: unknown) {
  if (error instanceof AdminAccessError) {
    const codes: Record<number, string> = { 400: 'INVALID_JSON', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'RATE_LIMITED', 503: 'SERVICE_UNAVAILABLE' };
    return adminResponse({ code: codes[error.status] ?? 'ACCESS_DENIED', error: error.message }, error.status);
  }
  if (error instanceof EditorialError) return adminResponse({ code: error.code, error: error.message, latest: error.latest, issues: error.issues }, error.status);
  if (error instanceof ZodError) return adminResponse({ code: 'INVALID_INPUT', error: 'Sprawdź pola formularza.', issues: error.issues.map(item => ({ field: item.path.join('.'), message: item.message })) }, 400);
  if (isDatabaseUnavailable(error)) return adminResponse({ code: 'DATABASE_UNAVAILABLE', error: 'Baza danych jest chwilowo niedostępna. Spróbuj ponownie za chwilę.' }, 503);
  // Driver messages can contain query text or credentials; keep logs generic too.
  console.error('Editorial request failed: INTERNAL_ERROR');
  return adminResponse({ code: 'INTERNAL_ERROR', error: 'Nie udało się zapisać danych. Spróbuj ponownie.' }, 500);
}

export const createInput = z.object({ title: z.string().trim().min(1).max(200), originalText: z.string().max(100000).default('') }).strict();
export const saveInput = z.object({ expectedRevision: z.number().int().positive(), content: z.unknown() }).strict();
export const deleteInput = z.object({ expectedRevision: z.number().int().positive() }).strict();
export const actionInput = z.object({ action: z.enum(['review', 'approve', 'publish', 'unpublish', 'archive', 'restore', 'restore_deleted', 'duplicate', 'checks', 'approve_and_publish']), expectedRevision: z.number().int().positive(), checks: z.object({ pl: z.boolean(), en: z.boolean(), quantities: z.boolean(), method: z.boolean(), photos: z.boolean(), sources: z.boolean() }).strict().optional(), version: z.number().int().positive().optional() }).strict();
