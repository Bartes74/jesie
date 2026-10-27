import { randomBytes } from 'node:crypto';
import { backupDigest } from './crypto';
import { collectDatabaseProof, type DatabaseProof } from './database-proof';
import { quoteBackupIdentifier, snapshotSchemaFingerprint, type DatabaseSnapshot } from './snapshot';
import { backupLabelPattern, backupSha256Pattern, CloudBackupError } from './types';

export type RestoreScope = { runId: string; attemptId: string; databaseName: string; marker: string };
export type SchemaBundleManifest = { format: 1; serverMajor: number; preDataSha256: string; postDataSha256: string; schemaFingerprint: string };
export type RestoreSchemaBundle = { preData: string; postData: string; manifest: SchemaBundleManifest };
export type RestoreQueryClient = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<unknown>;
};
export type DatabaseRestoreReceipt = {
  runId: string; attemptId: string; targetDatabase: string; verified: boolean; code?: string;
  tableCount: number; rowCount: number; tableHashesMatch: boolean; sequenceStateMatches: boolean; structuralCatalogMatches: boolean;
  sourceSecurityCatalogSha256: string; restoredSecurityCatalogSha256?: string;
  ownershipAclAdapted: true; cleanupConfirmed: boolean; verifiedAt?: string; productionWrites: false;
};

function scopeName(runId: string, attemptId: string) { return `jesie_restore_${backupDigest(Buffer.from(runId)).slice(0, 12)}_${attemptId}`; }
function scopeMarker(runId: string, attemptId: string) { return `jesie-cloud-restore-v1:${runId}:${attemptId}`; }

/** Persist this safe identity before the CREATE DATABASE step. No password/token. */
export function newRestoreScope(runId: string): RestoreScope {
  if (!backupLabelPattern.test(runId)) throw new CloudBackupError('BACKUP_RUN_ID_INVALID');
  const attemptId = randomBytes(12).toString('hex');
  return { runId, attemptId, databaseName: scopeName(runId, attemptId), marker: scopeMarker(runId, attemptId) };
}

export function assertRestoreScope(scope: RestoreScope, runId: string, sourceDatabase: string) {
  if (!backupLabelPattern.test(runId) || scope.runId !== runId || !/^[a-f0-9]{24}$/.test(scope.attemptId)
    || scope.databaseName !== scopeName(runId, scope.attemptId) || scope.marker !== scopeMarker(runId, scope.attemptId)
    || scope.databaseName === sourceDatabase || scope.databaseName.length > 63) throw new CloudBackupError('BACKUP_RESTORE_SCOPE_INVALID');
}

/** pg_dump emits psql-only restrict delimiters; no other meta-command is accepted. */
export function restoreBundleSql(sql: string): string {
  if (Buffer.byteLength(sql) > 16 * 1024 * 1024 || !sql.trim()) throw new CloudBackupError('BACKUP_SCHEMA_BUNDLE_INVALID');
  const lines = sql.split(/\r?\n/).filter(line => !/^\\(?:un)?restrict [A-Za-z0-9]+$/.test(line));
  if (lines.some(line => /^\s*\\/.test(line))
    || lines.some(line => /^\s*(?:CREATE|ALTER|DROP)\s+(?:DATABASE|ROLE|USER|TABLESPACE)\b/i.test(line))
    || lines.some(line => /^\s*SET\s+(?:ROLE|SESSION\s+AUTHORIZATION)\b/i.test(line))) throw new CloudBackupError('BACKUP_SCHEMA_BUNDLE_UNSAFE');
  return lines.filter(line => !/^SET (?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout|transaction_timeout) = 0;$/.test(line)).join('\n');
}

export function validateRestoreBundle(snapshot: DatabaseSnapshot, bundle: RestoreSchemaBundle) {
  const manifest = bundle.manifest;
  if (manifest.format !== 1 || manifest.serverMajor !== snapshot.serverMajor || !backupSha256Pattern.test(manifest.preDataSha256)
    || !backupSha256Pattern.test(manifest.postDataSha256) || !backupSha256Pattern.test(manifest.schemaFingerprint)
    || backupDigest(Buffer.from(bundle.preData)) !== manifest.preDataSha256 || backupDigest(Buffer.from(bundle.postData)) !== manifest.postDataSha256
    || snapshotSchemaFingerprint(snapshot.proof) !== manifest.schemaFingerprint || snapshot.schemaFingerprint !== manifest.schemaFingerprint) throw new CloudBackupError('BACKUP_SCHEMA_BUNDLE_MISMATCH');
  return { preData: restoreBundleSql(bundle.preData), postData: restoreBundleSql(bundle.postData) };
}

async function databaseIdentity(admin: RestoreQueryClient, databaseName: string) {
  return (await admin.query("SELECT datname,pg_get_userbyid(datdba) AS owner,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [databaseName])).rows[0];
}

/** This is the only DROP boundary. A matching name alone never grants deletion. */
export async function dropOwnedRestoreDatabase(admin: RestoreQueryClient, scope: RestoreScope, sourceDatabase: string, sourceOwner: string): Promise<boolean> {
  assertRestoreScope(scope, scope.runId, sourceDatabase);
  const actualSource = (await admin.query('SELECT current_database() AS database,current_user AS owner')).rows[0];
  if (actualSource.database !== sourceDatabase || actualSource.owner !== sourceOwner) throw new CloudBackupError('BACKUP_RESTORE_ADMIN_SCOPE_CHANGED');
  const identity = await databaseIdentity(admin, scope.databaseName);
  if (!identity) return true;
  if (identity.datname !== scope.databaseName || identity.owner !== sourceOwner || identity.marker !== scope.marker) throw new CloudBackupError('BACKUP_RESTORE_OWNERSHIP_UNCONFIRMED');
  await admin.query(`DROP DATABASE ${quoteBackupIdentifier(scope.databaseName)}`);
  return !await databaseIdentity(admin, scope.databaseName);
}

/** Real restore. Source admin never receives schema SQL or row INSERTs. */
export async function verifyIsolatedDatabaseRestore(options: {
  snapshot: DatabaseSnapshot; scope: RestoreScope; bundle: RestoreSchemaBundle; admin: RestoreQueryClient;
  connectTarget: (databaseName: string) => Promise<RestoreQueryClient>;
  collectProof?: (client: RestoreQueryClient) => Promise<DatabaseProof>;
  now?: () => Date; maximumDurationMs?: number;
}): Promise<DatabaseRestoreReceipt> {
  const { snapshot, scope, admin } = options;
  const now = options.now ?? (() => new Date());
  const receipt: DatabaseRestoreReceipt = {
    runId: snapshot.runId, attemptId: scope.attemptId, targetDatabase: scope.databaseName, verified: false,
    tableCount: snapshot.proof.tables.length, rowCount: snapshot.proof.tables.reduce((sum, table) => sum + table.rows, 0),
    tableHashesMatch: false, sequenceStateMatches: false, structuralCatalogMatches: false,
    sourceSecurityCatalogSha256: backupDigest(Buffer.from(JSON.stringify(snapshot.proof.securityCatalog))),
    ownershipAclAdapted: true, cleanupConfirmed: false, productionWrites: false,
  };
  let createdOrConfirmedOwned = false, target: RestoreQueryClient | undefined;
  let sourceDatabase = '', sourceOwner = '';
  try {
    const sql = validateRestoreBundle(snapshot, options.bundle);
    const source = (await admin.query('SELECT current_database() AS database,current_user AS owner')).rows[0];
    sourceDatabase = String(source.database); sourceOwner = String(source.owner);
    assertRestoreScope(scope, snapshot.runId, sourceDatabase);
    if (snapshot.sourceDatabase !== sourceDatabase) throw new CloudBackupError('BACKUP_RESTORE_SOURCE_MISMATCH');
    const existing = await databaseIdentity(admin, scope.databaseName);
    if (existing) {
      if (existing.marker !== scope.marker || existing.owner !== sourceOwner || existing.datname !== scope.databaseName) throw new CloudBackupError('BACKUP_RESTORE_OWNERSHIP_UNCONFIRMED');
      createdOrConfirmedOwned = true;
      if (!await dropOwnedRestoreDatabase(admin, scope, sourceDatabase, sourceOwner)) throw new CloudBackupError('BACKUP_RESTORE_CLEANUP_UNCONFIRMED');
      createdOrConfirmedOwned = false;
    }
    await admin.query(`CREATE DATABASE ${quoteBackupIdentifier(scope.databaseName)} TEMPLATE template0`);
    await admin.query(`COMMENT ON DATABASE ${quoteBackupIdentifier(scope.databaseName)} IS '${scope.marker}'`);
    const created = await databaseIdentity(admin, scope.databaseName);
    if (created?.marker !== scope.marker || created?.owner !== sourceOwner || created?.datname !== scope.databaseName) throw new CloudBackupError('BACKUP_RESTORE_OWNERSHIP_UNCONFIRMED');
    createdOrConfirmedOwned = true;
    target = await options.connectTarget(scope.databaseName);
    const targetIdentity = (await target.query('SELECT current_database() AS database,current_user AS owner')).rows[0];
    if (targetIdentity.database !== scope.databaseName || targetIdentity.database === sourceDatabase || targetIdentity.owner !== sourceOwner) throw new CloudBackupError('BACKUP_RESTORE_TARGET_MISMATCH');
    const started = now().getTime();
    const guarded: RestoreQueryClient = {
      async query(query, values) {
        if (now().getTime() - started > (options.maximumDurationMs ?? 240_000)) throw new CloudBackupError('BACKUP_RESTORE_TIME_LIMIT', true);
        return target!.query(query, values);
      },
      end: () => target!.end(),
    };
    await guarded.query('BEGIN');
    try {
      await guarded.query("SET LOCAL statement_timeout = '60s'");
      await guarded.query('DROP SCHEMA IF EXISTS public CASCADE');
      if (!/^CREATE SCHEMA public;/m.test(sql.preData)) await guarded.query('CREATE SCHEMA public');
      await guarded.query(sql.preData);
      for (const table of snapshot.tables) {
        const qualified = `${quoteBackupIdentifier(table.schema)}.${quoteBackupIdentifier(table.name)}`;
        const names = table.columns.filter(column => !column.generated).map(column => quoteBackupIdentifier(column.name));
        if (!names.length && table.rows.length) throw new CloudBackupError('BACKUP_RESTORE_COLUMNS_UNSUPPORTED');
        for (let offset = 0; offset < table.rows.length; offset += 100) {
          const rows = table.rows.slice(offset, offset + 100);
          // Preserve bigint/numeric/bytea JSON representations from PostgreSQL.
          await guarded.query(`INSERT INTO ${qualified} (${names.join(',')}) OVERRIDING SYSTEM VALUE SELECT ${names.join(',')} FROM jsonb_populate_recordset(NULL::${qualified},$1::jsonb)`, [`[${rows.join(',')}]`]);
        }
      }
      for (const sequence of snapshot.proof.sequences) {
        const qualified = `${quoteBackupIdentifier(String(sequence.schema))}.${quoteBackupIdentifier(String(sequence.name))}`;
        if (typeof sequence.last_value !== 'string' || !/^-?[0-9]+$/.test(sequence.last_value) || typeof sequence.is_called !== 'boolean') throw new CloudBackupError('BACKUP_RESTORE_SEQUENCE_INVALID');
        await guarded.query('SELECT pg_catalog.setval($1::regclass,$2::bigint,$3::boolean)', [qualified, sequence.last_value, sequence.is_called]);
      }
      await guarded.query(sql.postData);
      await guarded.query('COMMIT');
    } catch (error) { await target.query('ROLLBACK').catch(() => {}); throw error; }
    await guarded.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let actual: DatabaseProof;
    try { actual = await (options.collectProof ?? collectDatabaseProof)(guarded); }
    finally { await target.query('ROLLBACK').catch(() => {}); }
    receipt.tableHashesMatch = JSON.stringify(actual.tables) === JSON.stringify(snapshot.proof.tables);
    receipt.sequenceStateMatches = JSON.stringify(actual.sequences) === JSON.stringify(snapshot.proof.sequences);
    receipt.structuralCatalogMatches = JSON.stringify(actual.structuralCatalog) === JSON.stringify(snapshot.proof.structuralCatalog);
    receipt.restoredSecurityCatalogSha256 = backupDigest(Buffer.from(JSON.stringify(actual.securityCatalog)));
    receipt.verified = receipt.tableHashesMatch && receipt.sequenceStateMatches && receipt.structuralCatalogMatches;
    if (receipt.verified) receipt.verifiedAt = now().toISOString();
    else receipt.code = 'BACKUP_RESTORE_PROOF_MISMATCH';
  } catch (error) {
    receipt.code = error instanceof CloudBackupError ? error.code : 'BACKUP_RESTORE_FAILED';
  } finally {
    await target?.end().catch(() => {});
    if (createdOrConfirmedOwned) {
      try { receipt.cleanupConfirmed = await dropOwnedRestoreDatabase(admin, scope, sourceDatabase, sourceOwner); }
      catch { receipt.cleanupConfirmed = false; }
    } else if (sourceDatabase) {
      // A response lost between CREATE and COMMENT may leave an unconfirmed
      // database. Do not adopt or delete it merely because its name matches.
      try { receipt.cleanupConfirmed = !await databaseIdentity(admin, scope.databaseName); }
      catch { receipt.cleanupConfirmed = false; }
    } else receipt.cleanupConfirmed = true;
    if (!receipt.cleanupConfirmed) receipt.code = 'BACKUP_RESTORE_CLEANUP_UNCONFIRMED';
  }
  return receipt;
}
