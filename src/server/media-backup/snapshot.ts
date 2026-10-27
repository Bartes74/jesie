import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { backupDigest } from './crypto';
import { collectDatabaseProof, type DatabaseProof, type QueryClient } from './database-proof';
import { backupLabelPattern, CloudBackupError, safeBackupPath } from './types';

export type DatabaseSnapshotTable = { schema: string; name: string; columns: { name: string; generated: string }[]; rows: string[] };
export type DatabaseSnapshot = {
  format: 'jesie-pg-json-v1'; runId: string; capturedAt: string; serverVersion: string; serverMajor: number;
  sourceDatabase: string; sourceSnapshot: string; proof: DatabaseProof; tables: DatabaseSnapshotTable[];
  schemaFingerprint: string;
  mediaReferences: { requiredPaths: string[]; literalPaths: string[]; referencedAssetIds: string[]; missingAssetIds: string[] };
  restoreAdaptation: 'Database-local restore under current owner; original owner/ACL/role metadata retained separately; no production writes.';
};
export type SnapshotLimits = { maximumSnapshotBytes: number; maximumSnapshotRows: number; maximumSnapshotDurationMs: number };
export const quoteBackupIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const snapshotSchemaFingerprint = (proof: Pick<DatabaseProof, 'structuralCatalog'>) => backupDigest(Buffer.from(JSON.stringify(proof.structuralCatalog)));

function mediaReferences(tables: DatabaseSnapshotTable[]): DatabaseSnapshot['mediaReferences'] {
  const assets = new Map<string, { blob_pathname?: string; original_blob_pathname?: string }>();
  const mappings = new Map<string, string>();
  const readyVariants = new Set<string>();
  const literals = new Set<string>(), referenced = new Set<string>();
  const physicalPath = (value: unknown): value is string => typeof value === 'string' && /^(?:ai|seo|media|media-variants)\/[A-Za-z0-9_./-]+$/.test(value);
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(scan); return; }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if ((key === 'mediaAssetId' || key === 'assetId') && typeof item === 'string') referenced.add(item);
        scan(item);
      }
    } else if (physicalPath(value)) literals.add(safeBackupPath(value));
    else if (typeof value === 'string') {
      const mediaId = /^\/media\/(?:collections\/)?([A-Za-z0-9_-]+)(?:[?#]|$)/.exec(value)?.[1];
      if (mediaId) referenced.add(mediaId);
    }
  };
  for (const table of tables) for (const raw of table.rows) {
    const row = JSON.parse(raw) as Record<string, unknown>;
    if (['ai_asset', 'collection_asset'].includes(table.name) && typeof row.id === 'string') assets.set(row.id, {
      ...(physicalPath(row.blob_pathname) ? { blob_pathname: row.blob_pathname } : {}),
      ...(physicalPath(row.original_blob_pathname) ? { original_blob_pathname: row.original_blob_pathname } : {}),
    });
    if (table.name === 'media_compaction' && physicalPath(row.source_pathname) && physicalPath(row.target_pathname)) mappings.set(row.source_pathname, row.target_pathname);
    if (table.name === 'media_delivery_variant' && row.status === 'ready') {
      if (!physicalPath(row.blob_pathname)) throw new CloudBackupError('BACKUP_VARIANT_REFERENCE_INVALID');
      readyVariants.add(safeBackupPath(row.blob_pathname));
    }
    scan(row);
  }
  const resolve = (path: string) => {
    const seen = new Set<string>();
    while (mappings.has(path)) {
      if (seen.has(path)) throw new CloudBackupError('BACKUP_MEDIA_MAPPING_CYCLE');
      seen.add(path); path = mappings.get(path)!;
    }
    return safeBackupPath(path);
  };
  const required = new Set<string>();
  for (const asset of assets.values()) for (const key of ['blob_pathname', 'original_blob_pathname'] as const) {
    if (physicalPath(asset[key])) required.add(resolve(asset[key]));
  }
  for (const target of mappings.values()) required.add(resolve(target));
  for (const path of readyVariants) required.add(path);
  return { requiredPaths: [...required].sort(), literalPaths: [...literals].sort(), referencedAssetIds: [...referenced].sort(), missingAssetIds: [...referenced].filter(id => !assets.has(id)).sort() };
}

/** All actual rows and proofs are from this one transaction; no estimates. */
export async function captureDatabaseSnapshot(client: QueryClient, runId: string, limits: SnapshotLimits, dependencies: {
  collectProof?: (client: QueryClient) => Promise<DatabaseProof>; now?: () => Date;
} = {}): Promise<DatabaseSnapshot> {
  if (!backupLabelPattern.test(runId)) throw new CloudBackupError('BACKUP_RUN_ID_INVALID');
  const now = dependencies.now ?? (() => new Date());
  const started = now().getTime();
  const guarded: QueryClient = { async query(sql) {
    if (now().getTime() - started > limits.maximumSnapshotDurationMs) throw new CloudBackupError('BACKUP_SNAPSHOT_TIME_LIMIT', true);
    return client.query(sql);
  } };
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await guarded.query("SET LOCAL statement_timeout = '20s'");
    const metadata = (await guarded.query("SELECT current_database() AS database,current_setting('server_version') AS version,current_setting('server_version_num')::integer AS version_num,txid_current_snapshot()::text AS snapshot,clock_timestamp() AS captured_at")).rows[0];
    const unsupported = (await guarded.query("SELECT (SELECT count(*) FROM pg_largeobject_metadata)::int AS large_objects,(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN('f','m'))::int AS external_relations,(SELECT count(*) FROM pg_inherits)::int AS inheritance_relations")).rows[0];
    // These need a native pg_dump strategy rather than an incomplete JSON copy.
    if (Number(unsupported.large_objects) || Number(unsupported.external_relations) || Number(unsupported.inheritance_relations)) throw new CloudBackupError('BACKUP_NATIVE_DUMP_REQUIRED');
    const proof = await (dependencies.collectProof ?? collectDatabaseProof)(guarded);
    const tables: DatabaseSnapshotTable[] = [];
    let totalBytes = Buffer.byteLength(JSON.stringify(proof)), totalRows = 0;
    for (let index = 0; index < proof.tables.length; index++) {
      const table = proof.tables[index];
      const qualified = `${quoteBackupIdentifier(table.schema)}.${quoteBackupIdentifier(table.name)}`;
      const columns = (await guarded.query(`SELECT a.attname AS name,a.attgenerated AS generated FROM pg_attribute a WHERE a.attrelid=${"'" + qualified.replaceAll("'", "''") + "'"}::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`)).rows.map(row => ({ name: String(row.name), generated: String(row.generated) }));
      const cursor = quoteBackupIdentifier(`jesie_cloud_backup_${index}`);
      const rows: string[] = [], hash = createHash('sha256');
      await guarded.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS line FROM ${qualified} t ORDER BY to_jsonb(t)::text COLLATE "C"`);
      try {
        while (true) {
          const chunk = (await guarded.query(`FETCH 100 FROM ${cursor}`)).rows;
          for (const row of chunk) {
            if (typeof row.line !== 'string') throw new CloudBackupError('BACKUP_DATABASE_ROW_INVALID');
            totalBytes += Buffer.byteLength(row.line) + 1; totalRows++;
            if (totalBytes > limits.maximumSnapshotBytes || totalRows > limits.maximumSnapshotRows) throw new CloudBackupError('BACKUP_SNAPSHOT_SIZE_LIMIT');
            rows.push(row.line); hash.update(row.line).update('\n');
          }
          if (chunk.length < 100) break;
        }
      } finally { await guarded.query(`CLOSE ${cursor}`); }
      if (rows.length !== table.rows || hash.digest('hex') !== table.sha256) throw new CloudBackupError('BACKUP_SNAPSHOT_PROOF_MISMATCH');
      tables.push({ schema: table.schema, name: table.name, columns, rows });
    }
    const snapshot: DatabaseSnapshot = {
      format: 'jesie-pg-json-v1', runId, capturedAt: new Date(metadata.captured_at as string).toISOString(),
      serverVersion: String(metadata.version), serverMajor: Math.floor(Number(metadata.version_num) / 10000),
      sourceDatabase: String(metadata.database), sourceSnapshot: String(metadata.snapshot), proof, tables,
      schemaFingerprint: snapshotSchemaFingerprint(proof), mediaReferences: mediaReferences(tables),
      restoreAdaptation: 'Database-local restore under current owner; original owner/ACL/role metadata retained separately; no production writes.',
    };
    await client.query('COMMIT');
    return snapshot;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof CloudBackupError) throw error;
    throw new CloudBackupError('BACKUP_DATABASE_READ_FAILED', true);
  }
}

export function encodeDatabaseSnapshot(snapshot: DatabaseSnapshot, maximumBytes: number): Buffer {
  const bytes = Buffer.from(JSON.stringify(snapshot));
  if (bytes.length > maximumBytes) throw new CloudBackupError('BACKUP_SNAPSHOT_SIZE_LIMIT');
  return gzipSync(bytes, { level: 6 });
}

export function decodeDatabaseSnapshot(bytes: Buffer, runId: string, maximumBytes: number): DatabaseSnapshot {
  try {
    const snapshot = JSON.parse(gunzipSync(bytes, { maxOutputLength: maximumBytes }).toString('utf8')) as DatabaseSnapshot;
    if (snapshot.format !== 'jesie-pg-json-v1' || snapshot.runId !== runId || !Array.isArray(snapshot.tables) || !Array.isArray(snapshot.proof?.tables)
      || snapshot.tables.length !== snapshot.proof.tables.length || snapshotSchemaFingerprint(snapshot.proof) !== snapshot.schemaFingerprint) throw new Error();
    let rows = 0;
    const seen = new Set<string>();
    for (const table of snapshot.tables) {
      if (typeof table.schema !== 'string' || typeof table.name !== 'string' || !Array.isArray(table.columns) || !Array.isArray(table.rows)) throw new Error();
      const key = JSON.stringify([table.schema, table.name]);
      if (seen.has(key)) throw new Error();
      seen.add(key);
      const proof = snapshot.proof.tables.find(item => item.schema === table.schema && item.name === table.name);
      const hash = createHash('sha256');
      for (const row of table.rows) { if (typeof row !== 'string' || !row.startsWith('{')) throw new Error(); hash.update(row).update('\n'); rows++; }
      if (!proof || table.rows.length !== proof.rows || hash.digest('hex') !== proof.sha256) throw new Error();
    }
    if (!Number.isSafeInteger(rows) || !Array.isArray(snapshot.mediaReferences?.requiredPaths)) throw new Error();
    snapshot.mediaReferences.requiredPaths.forEach(safeBackupPath);
    return snapshot;
  } catch { throw new CloudBackupError('BACKUP_SNAPSHOT_INVALID'); }
}
