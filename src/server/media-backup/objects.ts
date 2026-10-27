import { backupDigest, decryptBackupBytes, encryptedBackupOverheadLimit, encryptBackupBytes } from './crypto';
import { assertIndependentBackupStores, backupLabelPattern, backupSha256Pattern, CloudBackupError, safeBackupPath, type BackupBlobMetadata, type BackupBlobRead, type BackupEncryption, type EncryptedBackupProof, type MediaBackupProof, type PrivateBackupBlobStore } from './types';

export type BackupDependencies = {
  source: PrivateBackupBlobStore;
  destination: PrivateBackupBlobStore;
  encryption: BackupEncryption;
  maximumObjectBytes: number;
  now?: () => Date;
};

function encryptedProof(stored: BackupBlobRead, plaintext: Buffer, encryption: BackupEncryption, destination: PrivateBackupBlobStore, now: () => Date): EncryptedBackupProof {
  return { backupStoreId: destination.storeId, backupPath: stored.pathname, backupEtag: stored.etag, keyId: encryption.keyId,
    plaintextSha256: backupDigest(plaintext), plaintextBytes: plaintext.length, cipherSha256: backupDigest(stored.bytes), cipherBytes: stored.bytes.length,
    readbackVerifiedAt: now().toISOString() };
}

/** Retry after response loss reads the same immutable object before another create. */
export async function saveEncryptedBackup(options: {
  pathname: string; context: string; plaintext: Buffer; destination: PrivateBackupBlobStore; encryption: BackupEncryption; now?: () => Date;
}): Promise<EncryptedBackupProof> {
  safeBackupPath(options.pathname);
  const maximum = options.plaintext.length + encryptedBackupOverheadLimit;
  let stored = await options.destination.get(options.pathname, maximum);
  if (!stored) {
    const encrypted = encryptBackupBytes(options.plaintext, options.encryption, options.context);
    let writeError: unknown;
    try { await options.destination.putImmutable(options.pathname, encrypted, 'application/octet-stream'); }
    catch (error) { writeError = error; }
    // Also reconcile a conditional-create race or an accepted PUT whose response
    // was lost. No second name and no overwrite can be created by this retry.
    stored = await options.destination.get(options.pathname, maximum);
    if (!stored) {
      if (writeError instanceof CloudBackupError) throw writeError;
      throw new CloudBackupError('BACKUP_WRITE_UNCONFIRMED', true);
    }
  }
  const plaintext = decryptBackupBytes(stored.bytes, options.encryption, options.context, options.plaintext.length);
  if (plaintext.length !== options.plaintext.length || backupDigest(plaintext) !== backupDigest(options.plaintext)) throw new CloudBackupError('BACKUP_IMMUTABLE_CONTENT_CONFLICT');
  return encryptedProof(stored, plaintext, options.encryption, options.destination, options.now ?? (() => new Date()));
}

export async function readEncryptedBackup(options: {
  pathname: string; context: string; maximumBytes: number; destination: PrivateBackupBlobStore; encryption: BackupEncryption; now?: () => Date;
}): Promise<{ plaintext: Buffer; proof: EncryptedBackupProof } | null> {
  const stored = await options.destination.get(safeBackupPath(options.pathname), options.maximumBytes + encryptedBackupOverheadLimit);
  if (!stored) return null;
  const plaintext = decryptBackupBytes(stored.bytes, options.encryption, options.context, options.maximumBytes);
  return { plaintext, proof: encryptedProof(stored, plaintext, options.encryption, options.destination, options.now ?? (() => new Date())) };
}

export function mediaBackupObjectPath(keyId: string, sha256: string) {
  if (!backupLabelPattern.test(keyId) || !backupSha256Pattern.test(sha256)) throw new CloudBackupError('BACKUP_OBJECT_ID_INVALID');
  return `vault/v1/${keyId}/objects/sha256/${sha256.slice(0, 2)}/${sha256}.aesgcm`;
}

/** Original/master/variant bytes all use the same exact-byte, lossless path. */
export async function copyMediaBackupObject(reference: BackupBlobMetadata, dependencies: BackupDependencies): Promise<MediaBackupProof> {
  assertIndependentBackupStores(dependencies.source, dependencies.destination);
  safeBackupPath(reference.pathname);
  if (reference.sourceStoreId && reference.sourceStoreId !== dependencies.source.storeId) throw new CloudBackupError('BACKUP_SOURCE_STORE_MISMATCH');
  if ((reference.aliases?.length || reference.sourceFile) && dependencies.source.storeId !== 'applicationbundle') throw new CloudBackupError('BACKUP_SOURCE_ALIASES_UNTRUSTED');
  reference.aliases?.forEach(safeBackupPath);
  if (reference.sourceFile) safeBackupPath(reference.sourceFile);
  if (!Number.isSafeInteger(reference.size) || reference.size < 0 || reference.size > dependencies.maximumObjectBytes) throw new CloudBackupError('BACKUP_OBJECT_TOO_LARGE');
  const source = await dependencies.source.get(reference.pathname, dependencies.maximumObjectBytes);
  if (!source) throw new CloudBackupError('BACKUP_SOURCE_MISSING');
  if (source.pathname !== reference.pathname || source.size !== reference.size || source.bytes.length !== reference.size
    || source.etag !== reference.etag || source.uploadedAt !== reference.uploadedAt) throw new CloudBackupError('BACKUP_SOURCE_CHANGED');
  if (dependencies.source.storeId === 'applicationbundle' && ((source.sourceStoreId ?? dependencies.source.storeId) !== (reference.sourceStoreId ?? dependencies.source.storeId)
    || source.sourceFile !== reference.sourceFile || JSON.stringify(source.aliases ?? []) !== JSON.stringify(reference.aliases ?? []))) throw new CloudBackupError('BACKUP_SOURCE_CHANGED');
  const sha256 = backupDigest(source.bytes);
  const encrypted = await saveEncryptedBackup({
    pathname: mediaBackupObjectPath(dependencies.encryption.keyId, sha256), context: `media/sha256/${sha256}`,
    plaintext: source.bytes, destination: dependencies.destination, encryption: dependencies.encryption, now: dependencies.now,
  });
  return {
    sourceStoreId: dependencies.source.storeId, sourcePath: source.pathname, sourceEtag: source.etag, sourceUploadedAt: source.uploadedAt,
    size: source.size, sha256, backupStoreId: encrypted.backupStoreId, backupPath: encrypted.backupPath, backupEtag: encrypted.backupEtag,
    keyId: encrypted.keyId, cipherSha256: encrypted.cipherSha256, cipherBytes: encrypted.cipherBytes,
    readbackVerifiedAt: encrypted.readbackVerifiedAt, restoreVerifiedAt: encrypted.readbackVerifiedAt, status: 'complete',
    ...(reference.aliases ? { aliases: reference.aliases } : {}), ...(reference.sourceFile ? { sourceFile: reference.sourceFile } : {}),
  };
}

/** A bounded page is one durable step. Persist its proofs before advancing cursor. */
export async function copyMediaBackupPage(cursor: string | undefined, pageSize: number, dependencies: BackupDependencies) {
  assertIndependentBackupStores(dependencies.source, dependencies.destination);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new CloudBackupError('BACKUP_PAGE_LIMIT_INVALID');
  const page = await dependencies.source.list(cursor, pageSize);
  if (page.blobs.length > pageSize || page.hasMore && (!page.cursor || page.cursor === cursor)) throw new CloudBackupError('BACKUP_INVENTORY_CURSOR_INVALID');
  const proofs: MediaBackupProof[] = [];
  // Sequential work bounds memory and upstream load. A replay reuses the same
  // content-addressed objects after verifying their decrypted bytes again.
  for (const blob of page.blobs) proofs.push(await copyMediaBackupObject(blob, dependencies));
  return { proofs, inventory: page.blobs, hasMore: page.hasMore, ...(page.hasMore ? { cursor: page.cursor } : {}) };
}
