import { backupDigest } from './crypto';
import { readEncryptedBackup, saveEncryptedBackup } from './objects';
import type { DatabaseRestoreReceipt } from './restore';
import type { DatabaseSnapshot } from './snapshot';
import { assertIndependentBackupStores, backupLabelPattern, backupSha256Pattern, CloudBackupError, safeBackupPath, type BackupBlobMetadata, type BackupEncryption, type EncryptedBackupProof, type MediaBackupProof, type PrivateBackupBlobStore } from './types';

export type BackupCheckpointManifest = {
  format: 'jesie-cloud-backup-v1'; runId: string; completedAt: string;
  sourceStoreId: string; backupStoreId: string; keyId: string;
  database: EncryptedBackupProof & { schema: EncryptedBackupProof; format: 'jesie-pg-json-v1'; tableCount: number; rowCount: number; schemaFingerprint: string; restore: DatabaseRestoreReceipt };
  inventory: { complete: true; objects: number; bytes: number; sha256: string };
  media: MediaBackupProof[];
  references: DatabaseSnapshot['mediaReferences'];
  closureVerified: true; mediaRoundtripVerified: true; databaseRestoreVerified: boolean;
  archiveCatalog?: EncryptedBackupProof;
};

export function backupInventoryDigest(inventory: BackupBlobMetadata[]): string {
  return backupDigest(Buffer.from(JSON.stringify([...inventory].sort((a, b) => a.pathname.localeCompare(b.pathname))
    .map(item => [item.sourceStoreId ?? null, item.pathname, item.size, item.etag, item.uploadedAt, item.aliases ?? [], item.sourceFile ?? null]))));
}

/** Frozen inventories and exact versions are checked; no popularity/cache aliases. */
export async function saveCheckpointManifest(options: {
  runId: string; snapshot: DatabaseSnapshot; databaseProof: EncryptedBackupProof; databaseSchemaProof: EncryptedBackupProof;
  restore: DatabaseRestoreReceipt; inventory: BackupBlobMetadata[]; inventoryComplete: boolean; proofs: MediaBackupProof[];
  source: PrivateBackupBlobStore; destination: PrivateBackupBlobStore; encryption: BackupEncryption; now?: () => Date;
  archiveCatalog?: EncryptedBackupProof;
}) {
  const { source, destination, snapshot, runId } = options;
  assertIndependentBackupStores(source, destination);
  if (!backupLabelPattern.test(runId) || snapshot.runId !== runId || !options.inventoryComplete
    || options.restore.runId !== runId || options.databaseProof.backupStoreId !== destination.storeId
    || options.databaseProof.keyId !== options.encryption.keyId || options.databaseSchemaProof.backupStoreId !== destination.storeId
    || options.databaseSchemaProof.keyId !== options.encryption.keyId) throw new CloudBackupError('BACKUP_MANIFEST_SCOPE_INVALID');
  const inventory = new Map<string, BackupBlobMetadata>();
  const inventoryKey = (origin: string, pathname: string) => JSON.stringify([origin, pathname]);
  for (const item of options.inventory) {
    const origin = item.sourceStoreId ?? source.storeId;
    if (![source.storeId, 'applicationbundle'].includes(origin)) throw new CloudBackupError('BACKUP_SOURCE_STORE_MISMATCH');
    safeBackupPath(item.pathname); item.aliases?.forEach(safeBackupPath);
    if ((item.aliases?.length || item.sourceFile) && origin !== 'applicationbundle') throw new CloudBackupError('BACKUP_SOURCE_ALIASES_UNTRUSTED');
    const key = inventoryKey(origin, item.pathname);
    if (inventory.has(key)) throw new CloudBackupError('BACKUP_INVENTORY_DUPLICATE');
    inventory.set(key, item);
  }
  const proofs = new Map<string, MediaBackupProof>();
  for (const proof of options.proofs) {
    const key = inventoryKey(proof.sourceStoreId, proof.sourcePath);
    const item = inventory.get(key);
    if (!item || proofs.has(key) || proof.status !== 'complete'
      || proof.backupStoreId !== destination.storeId || proof.keyId !== options.encryption.keyId || !backupSha256Pattern.test(proof.sha256)
      || !backupSha256Pattern.test(proof.cipherSha256) || !proof.backupEtag || !proof.readbackVerifiedAt || !proof.restoreVerifiedAt
      || item.size !== proof.size || item.etag !== proof.sourceEtag || item.uploadedAt !== proof.sourceUploadedAt
      || JSON.stringify(item.aliases ?? []) !== JSON.stringify(proof.aliases ?? []) || item.sourceFile !== proof.sourceFile) throw new CloudBackupError('BACKUP_MEDIA_PROOF_MISMATCH');
    proofs.set(key, proof);
  }
  if (proofs.size !== inventory.size) throw new CloudBackupError('BACKUP_INVENTORY_COPY_INCOMPLETE');
  const covered = new Set([...proofs.values()].flatMap(proof => [proof.sourcePath, ...(proof.aliases ?? [])]));
  if (snapshot.mediaReferences.requiredPaths.some(path => !covered.has(path)) || snapshot.mediaReferences.missingAssetIds.length) throw new CloudBackupError('BACKUP_REFERENCE_CLOSURE_INCOMPLETE');
  if (!options.restore.verified || !options.restore.cleanupConfirmed) throw new CloudBackupError('BACKUP_RESTORE_NOT_VERIFIED');
  if (options.archiveCatalog && (options.archiveCatalog.backupStoreId !== destination.storeId || options.archiveCatalog.keyId !== options.encryption.keyId
    || !backupSha256Pattern.test(options.archiveCatalog.cipherSha256) || !backupSha256Pattern.test(options.archiveCatalog.plaintextSha256))) throw new CloudBackupError('BACKUP_CATALOG_PROOF_MISMATCH');
  const pathname = `vault/v1/${options.encryption.keyId}/checkpoints/${runId}/manifest.json.aesgcm`;
  const context = `checkpoint/${runId}/manifest`;
  const inventoryHash = backupInventoryDigest(options.inventory);
  const existing = await readEncryptedBackup({ pathname, context, maximumBytes: 64 * 1024 * 1024,
    destination, encryption: options.encryption, now: options.now });
  if (existing) {
    let previous: BackupCheckpointManifest;
    try { previous = JSON.parse(existing.plaintext.toString('utf8')); }
    catch { throw new CloudBackupError('BACKUP_MANIFEST_INVALID'); }
    const identity = (items: MediaBackupProof[]) => JSON.stringify([...items].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))
      .map(item => [item.sourceStoreId, item.sourcePath, item.sourceEtag, item.size, item.sha256, item.backupPath, item.aliases ?? []]));
    if (previous.format !== 'jesie-cloud-backup-v1' || previous.runId !== runId || previous.sourceStoreId !== source.storeId
      || previous.backupStoreId !== destination.storeId || previous.keyId !== options.encryption.keyId
      || previous.inventory.sha256 !== inventoryHash || previous.database.cipherSha256 !== options.databaseProof.cipherSha256
      || previous.database.schema.cipherSha256 !== options.databaseSchemaProof.cipherSha256
      || previous.archiveCatalog?.cipherSha256 !== options.archiveCatalog?.cipherSha256
      || !previous.databaseRestoreVerified || identity(previous.media) !== identity([...proofs.values()])) throw new CloudBackupError('BACKUP_IMMUTABLE_CONTENT_CONFLICT');
    return { runId, manifest: existing.proof, objects: inventory.size, databaseRestoreVerified: true, closureVerified: true as const, mediaRoundtripVerified: true as const };
  }
  const manifest: BackupCheckpointManifest = {
    format: 'jesie-cloud-backup-v1', runId, completedAt: (options.now ?? (() => new Date()))().toISOString(),
    sourceStoreId: source.storeId, backupStoreId: destination.storeId, keyId: options.encryption.keyId,
    database: { ...options.databaseProof, schema: options.databaseSchemaProof, format: 'jesie-pg-json-v1', tableCount: snapshot.proof.tables.length,
      rowCount: snapshot.proof.tables.reduce((sum, table) => sum + table.rows, 0), schemaFingerprint: snapshot.schemaFingerprint, restore: options.restore },
    inventory: { complete: true, objects: inventory.size, bytes: options.inventory.reduce((sum, item) => sum + item.size, 0), sha256: inventoryHash },
    media: [...proofs.values()].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)), references: snapshot.mediaReferences,
    closureVerified: true, mediaRoundtripVerified: true, databaseRestoreVerified: options.restore.verified && options.restore.cleanupConfirmed,
    ...(options.archiveCatalog ? { archiveCatalog: options.archiveCatalog } : {}),
  };
  const proof = await saveEncryptedBackup({ pathname, context, plaintext: Buffer.from(JSON.stringify(manifest)),
    destination, encryption: options.encryption, now: options.now });
  return { runId, manifest: proof, objects: inventory.size, databaseRestoreVerified: manifest.databaseRestoreVerified,
    closureVerified: true as const, mediaRoundtripVerified: true as const };
}
