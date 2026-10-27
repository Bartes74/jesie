import { backupLabelPattern, CloudBackupError, normalizedBackupStoreId } from './types';

export type BackupStoreCredentials = { storeId: string; token?: string };
export type CloudBackupConfiguration = {
  source: BackupStoreCredentials;
  destination: BackupStoreCredentials;
  encryption: { keyId: string; key: Buffer };
  maximumObjectBytes: number;
  maximumSnapshotBytes: number;
  maximumSnapshotRows: number;
  maximumSnapshotDurationMs: number;
  inventoryPageSize: number;
};

function boundedInteger(value: string | undefined, fallback: number, lower: number, upper: number) {
  if (value === undefined) return fallback;
  const number = /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < lower || number > upper) throw new CloudBackupError('BACKUP_LIMIT_CONFIGURATION');
  return number;
}

function credentials(id: string | undefined, token: string | undefined): BackupStoreCredentials {
  const tokenId = token?.startsWith('vercel_blob_rw_') ? token.split('_')[3] : undefined;
  if (!id && !tokenId) throw new CloudBackupError('BACKUP_STORE_CONFIGURATION');
  const storeId = normalizedBackupStoreId(id ?? tokenId!);
  // Explicit token auth takes precedence in the installed SDK. Prevent a target
  // ID from appearing independent while its actual token still writes to source.
  if (token && (!tokenId || normalizedBackupStoreId(tokenId) !== storeId)) throw new CloudBackupError('BACKUP_STORE_TOKEN_MISMATCH');
  return { storeId, ...(token ? { token } : {}) };
}

/** Disabled means no validation/network work and no accidentally enabled backup. */
export function cloudBackupConfiguration(env: Readonly<Record<string, string | undefined>> = process.env): CloudBackupConfiguration | null {
  if (env.MEDIA_BACKUP_ENABLED !== '1') {
    if (env.MEDIA_BACKUP_ENABLED !== undefined && env.MEDIA_BACKUP_ENABLED !== '0') throw new CloudBackupError('BACKUP_ENABLED_CONFIGURATION');
    return null;
  }
  const source = credentials(env.BLOB_STORE_ID, env.BLOB_READ_WRITE_TOKEN);
  const destination = credentials(env.MEDIA_BACKUP_STORE_ID, env.MEDIA_BACKUP_READ_WRITE_TOKEN);
  if (source.storeId === destination.storeId) throw new CloudBackupError('BACKUP_INDEPENDENT_STORE_REQUIRED');
  const keyId = env.MEDIA_BACKUP_KEY_ID;
  const encodedKey = env.MEDIA_BACKUP_ENCRYPTION_KEY;
  if (!keyId || !backupLabelPattern.test(keyId) || !encodedKey || !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) throw new CloudBackupError('BACKUP_KEY_CONFIGURATION');
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encodedKey) throw new CloudBackupError('BACKUP_KEY_CONFIGURATION');
  return {
    source, destination, encryption: { keyId, key },
    maximumObjectBytes: boundedInteger(env.MEDIA_BACKUP_MAX_OBJECT_BYTES, 64 * 1024 * 1024, 1024, 256 * 1024 * 1024),
    maximumSnapshotBytes: boundedInteger(env.MEDIA_BACKUP_MAX_SNAPSHOT_BYTES, 128 * 1024 * 1024, 1024, 256 * 1024 * 1024),
    maximumSnapshotRows: boundedInteger(env.MEDIA_BACKUP_MAX_SNAPSHOT_ROWS, 1_000_000, 1, 10_000_000),
    maximumSnapshotDurationMs: boundedInteger(env.MEDIA_BACKUP_MAX_SNAPSHOT_DURATION_MS, 180_000, 1000, 240_000),
    inventoryPageSize: boundedInteger(env.MEDIA_BACKUP_PAGE_SIZE, 25, 1, 100),
  };
}
