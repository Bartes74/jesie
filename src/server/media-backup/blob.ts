import 'server-only';
import { BlobAccessError, BlobNotFoundError, BlobPreconditionFailedError, BlobServiceNotAvailable, BlobServiceRateLimited, get, head, list, put } from '@vercel/blob';
import type { BackupStoreCredentials } from './config';
import { CloudBackupError, normalizedBackupStoreId, safeBackupPath, type BackupBlobMetadata, type PrivateBackupBlobStore } from './types';

/** Only stable codes cross a step boundary. SDK messages can contain URLs. */
export function backupOperationError(error: unknown, fallback = 'BACKUP_STORAGE_UNAVAILABLE'): CloudBackupError {
  if (error instanceof CloudBackupError) return error;
  if (error instanceof BlobAccessError) return new CloudBackupError('BACKUP_STORAGE_ACCESS_DENIED');
  if (error instanceof BlobPreconditionFailedError) return new CloudBackupError('BACKUP_OBJECT_EXISTS');
  if (error instanceof BlobServiceNotAvailable || error instanceof BlobServiceRateLimited) return new CloudBackupError(fallback, true);
  return new CloudBackupError(fallback, true);
}

function safeMetadata(value: { pathname: string; size: number; etag: string; uploadedAt: Date; contentType?: string }): BackupBlobMetadata {
  safeBackupPath(value.pathname);
  if (!Number.isSafeInteger(value.size) || value.size < 0 || typeof value.etag !== 'string' || !value.etag || value.etag.length > 512
    || !Number.isFinite(value.uploadedAt.getTime())) throw new CloudBackupError('BACKUP_SOURCE_METADATA_INVALID');
  return { pathname: value.pathname, size: value.size, etag: value.etag, uploadedAt: value.uploadedAt.toISOString(), ...(value.contentType ? { contentType: value.contentType } : {}) };
}

type BlobReadMetadata = { pathname: string; size: number; etag: string; uploadedAt: Date; contentType?: string };
type BlobReadResponse = { stream: ReadableStream<Uint8Array>; blob: BlobReadMetadata };

function entityTag(value: string) { return value.trim().replace(/^W\//, ''); }

/** SDK get.size is HTTP Content-Length (zero for chunked), not object size.
 * Undici also transparently decodes br/gzip. HEAD is the authoritative stored
 * byte count; matching entity tags bind the decoded stream to that object. */
export async function readVerifiedBackupResponse(pathname: string, response: BlobReadResponse, stored: BlobReadMetadata, maximumBytes: number) {
  const metadata = safeMetadata(stored);
  if (metadata.pathname !== pathname || response.blob.pathname !== pathname || !response.blob.etag
    || entityTag(response.blob.etag) !== entityTag(metadata.etag)) {
    await response.stream.cancel().catch(() => {});
    throw new CloudBackupError('BACKUP_READ_METADATA_MISMATCH');
  }
  if (metadata.size > maximumBytes) { await response.stream.cancel(); throw new CloudBackupError('BACKUP_OBJECT_TOO_LARGE'); }
  const chunks: Buffer[] = [];
  let bytes = 0;
  const reader = response.stream.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes || bytes > metadata.size) throw new CloudBackupError('BACKUP_READ_SIZE_MISMATCH');
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  if (bytes !== metadata.size) throw new CloudBackupError('BACKUP_READ_SIZE_MISMATCH');
  return { ...metadata, bytes: Buffer.concat(chunks, bytes) };
}

export function createPrivateBackupBlobStore(credentials: BackupStoreCredentials): PrivateBackupBlobStore {
  const storeId = normalizedBackupStoreId(credentials.storeId);
  const auth = { storeId, ...(credentials.token ? { token: credentials.token } : {}) };
  return {
    storeId,
    async list(cursor, limit = 25) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CloudBackupError('BACKUP_PAGE_LIMIT_INVALID');
      try {
        const page = await list({ ...auth, limit, ...(cursor ? { cursor } : {}), abortSignal: AbortSignal.timeout(30_000) });
        if (page.hasMore && (!page.cursor || page.cursor === cursor)) throw new CloudBackupError('BACKUP_INVENTORY_CURSOR_INVALID');
        return { blobs: page.blobs.map(safeMetadata), hasMore: page.hasMore, ...(page.hasMore ? { cursor: page.cursor } : {}) };
      } catch (error) { throw backupOperationError(error); }
    },
    async get(pathname, maximumBytes) {
      safeBackupPath(pathname);
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new CloudBackupError('BACKUP_BYTE_LIMIT_INVALID');
      try {
        const stored = await head(pathname, { ...auth, abortSignal: AbortSignal.timeout(30_000) });
        if (stored.size > maximumBytes) throw new CloudBackupError('BACKUP_OBJECT_TOO_LARGE');
        const response = await get(pathname, { ...auth, access: 'private', useCache: false,
          headers: { 'Accept-Encoding': 'identity' }, abortSignal: AbortSignal.timeout(90_000) });
        if (!response) return null;
        if (response.statusCode !== 200 || response.blob.pathname !== pathname) throw new CloudBackupError('BACKUP_READ_METADATA_MISMATCH');
        return await readVerifiedBackupResponse(pathname, response, stored, maximumBytes);
      } catch (error) {
        if (error instanceof BlobNotFoundError) return null;
        throw backupOperationError(error);
      }
    },
    async putImmutable(pathname, bytes, contentType) {
      safeBackupPath(pathname);
      try {
        const result = await put(pathname, bytes, {
          ...auth, access: 'private', addRandomSuffix: false, allowOverwrite: false,
          contentType, cacheControlMaxAge: 60, abortSignal: AbortSignal.timeout(90_000),
        });
        if (result.pathname !== pathname) throw new CloudBackupError('BACKUP_WRITE_PATH_MISMATCH');
      } catch (error) { throw backupOperationError(error, 'BACKUP_WRITE_UNCONFIRMED'); }
    },
  };
}
