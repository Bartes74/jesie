import 'server-only';
import { ApiError, ValidationError } from '@fal-ai/client';
import { BlobError } from '@vercel/blob';
import { ProviderError } from './provider-error';
import { PhotoFormatError } from './photo-format';

export type PhotoReadStage = 'provider-backup' | 'provider-status' | 'terminal-record' | 'provider-result' | 'result-schema' | 'mask-selection' | 'source-read' | 'mask-download' | 'mask-apply' | 'cutout-fill' | 'cutout-validation' | 'photo-encode' | 'photo-save' | 'photo-archive-read' | 'photo-archive-upload' | 'photo-web-read' | 'photo-web-upload';
export type PhotoReadContext = { jobId: string; requestId: string; stage: PhotoReadStage };
export type PhotoReadDiagnostic = {
  event: 'photo_result_read_failed'; stage: PhotoReadStage; jobId?: string; providerRequestId?: string;
  errorClass: 'ProviderError' | 'BlobError' | 'PhotoFormatError' | 'ApiError' | 'ValidationError' | 'AbortError' | 'TimeoutError' | 'TypeError' | 'Error';
  code?: string; httpStatus?: number;
  httpDisposition?: 'access-denied' | 'request-rejected' | 'retryable-response' | 'other-response';
  bundleFrames?: { file: string; line: number; column: number }[];
  messageFingerprint?: 'fetch-failed' | 'terminated' | 'invalid-url' | 'illegal-invocation';
  notAFunction?: true;
  networkCodes?: string[];
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const codes = new Set(['AI_REFERENCE_UNAVAILABLE', 'AI_IMAGE_INVALID', 'AI_IMAGE_URL_INVALID', 'AI_IMAGE_DOWNLOAD_UNAVAILABLE', 'AI_IMAGE_TOO_LARGE', 'AI_IMAGE_EMPTY', 'AI_MASK_NOT_FOUND', 'AI_CONFIGURATION_REQUIRED', 'AI_ALREADY_HAS_CUTOUT', 'AI_ASSET_CONFLICT', 'AI_HERO_PRESENTATION_REQUIRED', 'PHOTO_SOURCE_INVALID', 'PHOTO_TILE_INVALID', 'PHOTO_MASK_INVALID', 'PHOTO_CUTOUT_INVALID', 'LOCAL_RECOVERY_MANIFEST_INVALID', 'LOCAL_RECOVERY_FILE_INVALID', '08000', '08001', '08003', '08004', '08006', '08007', '08P01', '28000', '28P01', '40001', '40P01', '42501', '42703', '42P01', '53000', '53100', '53200', '53300', '53400', '55000', '57014', '57P01', '57P02', '57P03', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET']);
for (const code of ['ERR_INVALID_ARG_TYPE', 'ERR_INVALID_THIS', 'ERR_INVALID_URL', 'UND_ERR_INVALID_ARG', 'UND_ERR_NOT_SUPPORTED', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']) codes.add(code);
const networkCodes = new Set(['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);
for (const code of networkCodes) codes.add(code);
const messageFingerprints = new Map<string, NonNullable<PhotoReadDiagnostic['messageFingerprint']>>([
  ['fetch failed', 'fetch-failed'], ['terminated', 'terminated'], ['Invalid URL', 'invalid-url'], ['Illegal invocation', 'illegal-invocation'],
]);

// Only generated chunk identifiers are retained, never arbitrary filenames or
// function names. Numeric names are Next's webpack chunk IDs.
const bundleName = /^(?:\[(?:root-of-the-server|turbopack|project)\]__(?:[a-z0-9_]{7,16}|[a-f0-9]{17,64})\._|_[a-z0-9_]{7,16}\._|[a-f0-9]{6,64}|\d{1,12}(?:\.[a-f0-9]{6,64})?)\.js$/;
function appendBundleFrames(stack: unknown, frames: NonNullable<PhotoReadDiagnostic['bundleFrames']>) {
  if (typeof stack !== 'string' || frames.length >= 2) return;
  for (const entry of stack.slice(0, 16_384).split('\n').slice(0, 64)) {
    const frame = /^\s*at (?:[^()\r\n]+\()?((?:\/|\.next\/|file:\/\/\/var\/task\/)[^()\r\n]*):([0-9]{1,9}):([0-9]{1,9})\)?\s*$/.exec(entry);
    if (!frame) continue;
    const location = frame[1].startsWith('file:///var/task/.next/server/chunks/') ? frame[1].slice('file://'.length) : frame[1];
    const path = /^(?:\/(?:[^:\r\n/\\?#]+\/)*)?\.next\/server\/chunks\/(?:ssr\/)?([^/\\?#:]+)$/.exec(location);
    if (!path || !bundleName.test(path[1])) continue;
    const line = Number(frame[2]); const column = Number(frame[3]);
    if (line < 1 || column < 1) continue;
    if (!frames.some(item => item.file === path[1] && item.line === line && item.column === column)) frames.push({ file: path[1], line, column });
    if (frames.length === 2) return;
  }
}

/** Aggregate children contribute only known network codes, never messages or stack data. */
function appendAggregateNetworkCodes(error: unknown, found: Set<string>) {
  if (found.size >= 3 || !error || typeof error !== 'object' || !('name' in error) || error.name !== 'AggregateError'
    || !('errors' in error) || !Array.isArray(error.errors)) return;
  for (const child of error.errors.slice(0, 3)) {
    let current: unknown = child;
    const seen = new Set<unknown>();
    for (let depth = 0; depth < 4 && current && typeof current === 'object' && !seen.has(current); depth++) {
      seen.add(current);
      const item = current as { code?: unknown; cause?: unknown };
      if (typeof item.code === 'string' && networkCodes.has(item.code)) found.add(item.code);
      if (found.size >= 3) return;
      current = item.cause;
    }
  }
}

/** Excludes messages, full stacks, paths, bodies, prompts, URLs and authentication. */
export function photoReadDiagnostic(context: PhotoReadContext, error: unknown): PhotoReadDiagnostic {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  const errorClass = error instanceof ProviderError ? 'ProviderError' : error instanceof BlobError ? 'BlobError'
    : error instanceof PhotoFormatError ? 'PhotoFormatError' : error instanceof ValidationError ? 'ValidationError'
      : error instanceof ApiError ? 'ApiError' : name === 'AbortError' || name === 'TimeoutError' || name === 'TypeError' ? name : 'Error';
  let code: string | undefined;
  let httpStatus: number | undefined;
  const bundleFrames: NonNullable<PhotoReadDiagnostic['bundleFrames']> = [];
  let messageFingerprint: PhotoReadDiagnostic['messageFingerprint'];
  let notAFunction = false;
  const aggregateNetworkCodes = new Set<string>();
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    const item = current as { code?: unknown; status?: unknown; cause?: unknown; stack?: unknown; message?: unknown };
    if (typeof item.code === 'string' && codes.has(item.code)) code ??= item.code;
    if (typeof item.status === 'number' && Number.isInteger(item.status) && item.status >= 100 && item.status <= 599) httpStatus ??= item.status;
    appendBundleFrames(item.stack, bundleFrames);
    if (typeof item.message === 'string') {
      messageFingerprint ??= messageFingerprints.get(item.message);
      notAFunction ||= /^[^\r\n]{1,512} is not a function$/.test(item.message);
    }
    appendAggregateNetworkCodes(current, aggregateNetworkCodes);
    current = item.cause;
  }
  if (error instanceof BlobError) {
    const status = /^(?:Vercel Blob: )?Failed to fetch blob: ([1-5]\d{2})(?:\s|$)/.exec(error.message);
    if (status) httpStatus ??= Number(status[1]);
  }
  const httpDisposition = httpStatus === undefined ? undefined
    : httpStatus === 401 || httpStatus === 403 ? 'access-denied'
      : httpStatus === 408 || httpStatus === 429 || httpStatus >= 500 ? 'retryable-response'
        : httpStatus >= 400 && httpStatus < 500 ? 'request-rejected' : 'other-response';
  return { event: 'photo_result_read_failed', stage: context.stage, errorClass,
    ...(uuid.test(context.jobId) ? { jobId: context.jobId } : {}),
    ...(uuid.test(context.requestId) ? { providerRequestId: context.requestId } : {}),
    ...(code ? { code } : {}), ...(httpStatus === undefined ? {} : { httpStatus, httpDisposition }),
    ...(bundleFrames.length ? { bundleFrames } : {}), ...(messageFingerprint ? { messageFingerprint } : {}),
    ...(notAFunction ? { notAFunction: true } : {}), ...(aggregateNetworkCodes.size ? { networkCodes: [...aggregateNetworkCodes] } : {}) };
}

/** Node's redirect:error failure has a fixed cause; inspect that exact marker without exposing text. */
export function photoReadRedirectBlocked(error: unknown): boolean {
  if (!(error instanceof TypeError) && !(error && typeof error === 'object' && 'name' in error && error.name === 'TypeError')) return false;
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    const item = current as { message?: unknown; cause?: unknown };
    if (depth > 0 && item.message === 'unexpected redirect') return true;
    current = item.cause;
  }
  return false;
}

/** Observe one accepted-result operation without changing its errors, retry policy, costs or transport. */
export async function withPhotoReadStage<T>(context: PhotoReadContext, operation: () => T | Promise<T>, report: (diagnostic: PhotoReadDiagnostic) => void = diagnostic => console.warn('Studio existing photo result read failed', diagnostic)): Promise<T> {
  try { return await operation(); }
  catch (error) {
    // A logging failure must never replace the provider error or alter its recovery semantics.
    try { report(photoReadDiagnostic(context, error)); } catch { /* The original read remains authoritative. */ }
    throw error;
  }
}
