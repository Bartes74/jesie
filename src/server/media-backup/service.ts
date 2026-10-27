import 'server-only';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Client } from 'pg';
import { createPrivateBackupBlobStore } from './blob';
import { cloudBackupConfiguration, type CloudBackupConfiguration } from './config';
import { saveCheckpointManifest } from './manifest';
import { copyMediaBackupPage, readEncryptedBackup, saveEncryptedBackup } from './objects';
import { validateRestoreBundle, verifyIsolatedDatabaseRestore, type DatabaseRestoreReceipt, type RestoreQueryClient, type RestoreSchemaBundle, type RestoreScope } from './restore';
import { captureDatabaseSnapshot, decodeDatabaseSnapshot, encodeDatabaseSnapshot, type DatabaseSnapshot } from './snapshot';
import { assertIndependentBackupStores, backupLabelPattern, CloudBackupError, type BackupBlobMetadata, type EncryptedBackupProof, type MediaBackupProof, type PrivateBackupBlobStore } from './types';

export { newRestoreScope } from './restore';
export type { DatabaseRestoreReceipt, RestoreScope } from './restore';
export type { MediaBackupProof } from './types';

export type DatabaseBackupReceipt = {
  runId: string; database: EncryptedBackupProof; schema: EncryptedBackupProof; format: 'jesie-pg-json-v1'; capturedAt: string;
  serverMajor: number; tableCount: number; rowCount: number; schemaFingerprint: string;
  requiredMediaObjects: number; integrityVerified: true; restoreVerified: false;
};

type ServiceDependencies = {
  configuration: CloudBackupConfiguration;
  source: PrivateBackupBlobStore;
  destination: PrivateBackupBlobStore;
  captureSnapshot: (runId: string) => Promise<DatabaseSnapshot>;
  loadSchemaBundle: () => Promise<RestoreSchemaBundle>;
  connectAdmin: () => Promise<RestoreQueryClient>;
  connectTarget: (databaseName: string) => Promise<RestoreQueryClient>;
  now?: () => Date;
};

export function createCloudBackupService(dependencies: ServiceDependencies) {
  const { configuration: config, source, destination } = dependencies;
  assertIndependentBackupStores(source, destination);
  const snapshotPath = (runId: string) => {
    if (!backupLabelPattern.test(runId)) throw new CloudBackupError('BACKUP_RUN_ID_INVALID');
    return `vault/v1/${config.encryption.keyId}/checkpoints/${runId}/database.json.gz.aesgcm`;
  };
  const readSnapshot = async (runId: string) => {
    const stored = await readEncryptedBackup({ pathname: snapshotPath(runId), context: `checkpoint/${runId}/database`,
      maximumBytes: config.maximumSnapshotBytes, destination, encryption: config.encryption, now: dependencies.now });
    return stored ? { snapshot: decodeDatabaseSnapshot(stored.plaintext, runId, config.maximumSnapshotBytes), proof: stored.proof } : null;
  };
  const schemaPath = (runId: string) => snapshotPath(runId).replace('database.json.gz.aesgcm', 'schema-bundle.json.gz.aesgcm');
  const readFrozenSchema = async (runId: string, snapshot: DatabaseSnapshot) => {
    const stored = await readEncryptedBackup({ pathname: schemaPath(runId), context: `checkpoint/${runId}/schema`,
      maximumBytes: 32 * 1024 * 1024, destination, encryption: config.encryption, now: dependencies.now });
    if (!stored) return null;
    let bundle: RestoreSchemaBundle;
    try { bundle = JSON.parse(gunzipSync(stored.plaintext, { maxOutputLength: 32 * 1024 * 1024 }).toString('utf8')); }
    catch { throw new CloudBackupError('BACKUP_SCHEMA_BUNDLE_INVALID'); }
    validateRestoreBundle(snapshot, bundle);
    return { bundle, proof: stored.proof };
  };
  return {
    async snapshotBackup(runId: string): Promise<DatabaseBackupReceipt> {
      // A replay adopts the already committed consistent snapshot. It never
      // captures another timestamp and overwrites the first successful copy.
      let stored = await readSnapshot(runId);
      if (!stored) {
        const snapshot = await dependencies.captureSnapshot(runId);
        const plaintext = encodeDatabaseSnapshot(snapshot, config.maximumSnapshotBytes);
        const proof = await saveEncryptedBackup({ pathname: snapshotPath(runId), context: `checkpoint/${runId}/database`,
          plaintext, destination, encryption: config.encryption, now: dependencies.now });
        const checked = await readSnapshot(runId);
        if (!checked || checked.proof.plaintextSha256 !== proof.plaintextSha256) throw new CloudBackupError('BACKUP_SNAPSHOT_READBACK_MISMATCH');
        stored = checked;
      }
      const { snapshot, proof } = stored;
      let schema = await readFrozenSchema(runId, snapshot);
      if (!schema) {
        // Snapshot survives a missing/stale deployment bundle. A successful
        // checkpoint freezes its exact matching restore DDL independently.
        const bundle = await dependencies.loadSchemaBundle();
        validateRestoreBundle(snapshot, bundle);
        const bytes = Buffer.from(JSON.stringify(bundle));
        if (bytes.length > 32 * 1024 * 1024) throw new CloudBackupError('BACKUP_SCHEMA_BUNDLE_INVALID');
        await saveEncryptedBackup({ pathname: schemaPath(runId), context: `checkpoint/${runId}/schema`,
          plaintext: gzipSync(bytes), destination, encryption: config.encryption, now: dependencies.now });
        schema = await readFrozenSchema(runId, snapshot);
        if (!schema) throw new CloudBackupError('BACKUP_SCHEMA_BUNDLE_MISSING');
      }
      return { runId, database: proof, schema: schema.proof, format: snapshot.format, capturedAt: snapshot.capturedAt,
        serverMajor: snapshot.serverMajor, tableCount: snapshot.proof.tables.length,
        rowCount: snapshot.proof.tables.reduce((sum, table) => sum + table.rows, 0), schemaFingerprint: snapshot.schemaFingerprint,
        requiredMediaObjects: snapshot.mediaReferences.requiredPaths.length, integrityVerified: true, restoreVerified: false };
    },
    async copyPage(cursor?: string) {
      return copyMediaBackupPage(cursor, config.inventoryPageSize, { source, destination, encryption: config.encryption, maximumObjectBytes: config.maximumObjectBytes, now: dependencies.now });
    },
    async verifyRestore(runId: string, scope: RestoreScope): Promise<DatabaseRestoreReceipt> {
      const stored = await readSnapshot(runId);
      if (!stored) throw new CloudBackupError('BACKUP_SNAPSHOT_MISSING');
      const schema = await readFrozenSchema(runId, stored.snapshot);
      if (!schema) throw new CloudBackupError('BACKUP_SCHEMA_BUNDLE_MISSING');
      const admin = await dependencies.connectAdmin();
      try {
        return await verifyIsolatedDatabaseRestore({ snapshot: stored.snapshot, scope, bundle: schema.bundle, admin,
          connectTarget: dependencies.connectTarget, now: dependencies.now, maximumDurationMs: config.maximumSnapshotDurationMs });
      } finally { await admin.end().catch(() => {}); }
    },
    async finalize(runId: string, inventory: BackupBlobMetadata[], proofs: MediaBackupProof[], restore: DatabaseRestoreReceipt, archiveCatalog?: EncryptedBackupProof) {
      const stored = await readSnapshot(runId);
      if (!stored) throw new CloudBackupError('BACKUP_SNAPSHOT_MISSING');
      const schema = await readFrozenSchema(runId, stored.snapshot);
      if (!schema) throw new CloudBackupError('BACKUP_SCHEMA_BUNDLE_MISSING');
      return saveCheckpointManifest({ runId, snapshot: stored.snapshot, databaseProof: stored.proof, databaseSchemaProof: schema.proof, restore,
        inventory, inventoryComplete: true, proofs, source, destination, encryption: config.encryption, now: dependencies.now, archiveCatalog });
    },
  };
}

/** TLS verified and direct, with credentials retained only inside this process. */
function sourceConnection(databaseName?: string): Client {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname.endsWith('.neon.tech')) throw new Error();
    url.hostname = url.hostname.replace('-pooler.', '.');
    if (databaseName) {
      if (!/^jesie_restore_[a-f0-9]{12}_[a-f0-9]{24}$/.test(databaseName) || decodeURIComponent(url.pathname.slice(1)) === databaseName) throw new Error();
      url.pathname = `/${databaseName}`;
    }
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(key);
    const client = new Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 15_000,
      query_timeout: 90_000, application_name: 'jesie_cloud_backup' });
    client.on('error', () => {});
    return client;
  } catch { throw new CloudBackupError('BACKUP_DATABASE_CONFIGURATION'); }
}

async function connected(databaseName?: string): Promise<RestoreQueryClient> {
  const client = sourceConnection(databaseName);
  try { await client.connect(); return client; }
  catch { await client.end().catch(() => {}); throw new CloudBackupError('BACKUP_DATABASE_CONNECT_FAILED', true); }
}

/** Called only from Node steps; no secrets, rows or SQL are returned to Workflow. */
export function cloudBackupService() {
  const configuration = cloudBackupConfiguration();
  if (!configuration) throw new CloudBackupError('BACKUP_DISABLED');
  return createCloudBackupService({
    configuration,
    source: createPrivateBackupBlobStore(configuration.source), destination: createPrivateBackupBlobStore(configuration.destination),
    captureSnapshot: async runId => {
      const client = await connected();
      try { return await captureDatabaseSnapshot(client, runId, configuration); }
      finally { await client.end().catch(() => {}); }
    },
    loadSchemaBundle: async () => {
      try {
        const root = join(process.cwd(), 'src', 'server', 'media-backup', 'schema');
        const [preData, postData, manifest] = await Promise.all([
          readFile(join(root, 'pre-data.sql'), 'utf8'), readFile(join(root, 'post-data.sql'), 'utf8'), readFile(join(root, 'manifest.json'), 'utf8'),
        ]);
        return { preData, postData, manifest: JSON.parse(manifest) };
      } catch { throw new CloudBackupError('BACKUP_SCHEMA_BUNDLE_UNAVAILABLE'); }
    },
    connectAdmin: () => connected(), connectTarget: databaseName => connected(databaseName),
  });
}

export async function snapshotBackup(runId: string) { return cloudBackupService().snapshotBackup(runId); }
export async function verifyRestore(runId: string, scope: RestoreScope) { return cloudBackupService().verifyRestore(runId, scope); }
export async function backupMediaPage(cursor?: string) { return cloudBackupService().copyPage(cursor); }
export async function finalizeBackup(runId: string, inventory: BackupBlobMetadata[], proofs: MediaBackupProof[], restore: DatabaseRestoreReceipt, archiveCatalog?: EncryptedBackupProof) {
  return cloudBackupService().finalize(runId, inventory, proofs, restore, archiveCatalog);
}
