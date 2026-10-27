/** Safe metadata only. Credentials and plaintext snapshots must never enter a workflow event. */
export type BackupBlobMetadata = {
  pathname: string;
  size: number;
  etag: string;
  uploadedAt: string;
  contentType?: string;
  sourceStoreId?: string;
  /** Only a separately verified application-bundle manifest may supply these. */
  aliases?: string[];
  sourceFile?: string;
};

export type BackupBlobRead = BackupBlobMetadata & { bytes: Buffer };
export type BackupInventoryPage = { blobs: BackupBlobMetadata[]; cursor?: string; hasMore: boolean };

export interface PrivateBackupBlobStore {
  readonly storeId: string;
  list(cursor?: string, limit?: number): Promise<BackupInventoryPage>;
  get(pathname: string, maximumBytes: number): Promise<BackupBlobRead | null>;
  /** Must be a conditional create: neither overwrite nor randomized suffixes. */
  putImmutable(pathname: string, bytes: Buffer, contentType: string): Promise<void>;
}

export type BackupEncryption = { keyId: string; key: Buffer };

/** Verifies exact original bytes after reading and decrypting the independent copy. */
export type MediaBackupProof = {
  sourceStoreId: string;
  sourcePath: string;
  sourceEtag: string;
  sourceUploadedAt: string;
  size: number;
  sha256: string;
  backupStoreId: string;
  backupPath: string;
  backupEtag: string;
  keyId: string;
  cipherSha256: string;
  cipherBytes: number;
  readbackVerifiedAt: string;
  restoreVerifiedAt: string;
  status: 'complete';
  aliases?: string[];
  sourceFile?: string;
};

export type EncryptedBackupProof = {
  backupStoreId: string;
  backupPath: string;
  backupEtag: string;
  keyId: string;
  plaintextSha256: string;
  plaintextBytes: number;
  cipherSha256: string;
  cipherBytes: number;
  readbackVerifiedAt: string;
};

export class CloudBackupError extends Error {
  constructor(public readonly code: string, public readonly retryable = false) {
    super(code);
    this.name = 'CloudBackupError';
  }
}

export const backupSha256Pattern = /^[a-f0-9]{64}$/;
export const backupLabelPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;

export function safeBackupPath(value: string): string {
  if (typeof value !== 'string' || value.length > 2000 || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value)
    || value.split('/').some(part => part === '' || part === '.' || part === '..')) throw new CloudBackupError('BACKUP_PATH_INVALID');
  return value;
}

export function normalizedBackupStoreId(value: string): string {
  const id = value.startsWith('store_') ? value.slice(6) : value;
  if (!/^[a-zA-Z0-9]{5,100}$/.test(id)) throw new CloudBackupError('BACKUP_STORE_CONFIGURATION');
  return id.toLowerCase();
}

export function assertIndependentBackupStores(source: PrivateBackupBlobStore, destination: PrivateBackupBlobStore) {
  if (normalizedBackupStoreId(source.storeId) === normalizedBackupStoreId(destination.storeId)) throw new CloudBackupError('BACKUP_INDEPENDENT_STORE_REQUIRED');
}
