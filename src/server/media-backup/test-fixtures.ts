import { createHash } from 'node:crypto';
import { backupDigest } from './crypto';
import type { CloudBackupConfiguration } from './config';
import type { DatabaseProof } from './database-proof';
import type { DatabaseRestoreReceipt, RestoreSchemaBundle } from './restore';
import { snapshotSchemaFingerprint, type DatabaseSnapshot } from './snapshot';
import { CloudBackupError, type BackupBlobMetadata, type BackupBlobRead, type PrivateBackupBlobStore } from './types';

export const fixtureNow = () => new Date('2026-10-17T01:00:00.000Z');
export const fixtureEncryption = { keyId: 'test-key-v1', key: Buffer.alloc(32, 17) };
export const fixtureConfig: CloudBackupConfiguration = {
  source: { storeId: 'source123' }, destination: { storeId: 'backup456' }, encryption: fixtureEncryption,
  maximumObjectBytes: 1024 * 1024, maximumSnapshotBytes: 1024 * 1024, maximumSnapshotRows: 1000, maximumSnapshotDurationMs: 60_000, inventoryPageSize: 2,
};

export class MemoryBackupStore implements PrivateBackupBlobStore {
  readonly entries = new Map<string, BackupBlobRead>();
  writes = 0; reads = 0;
  acceptedWriteLosesResponse = false;
  corruptReadback = false;
  constructor(readonly storeId: string) {}
  seed(pathname: string, bytes: Buffer, uploadedAt = fixtureNow().toISOString()) {
    const item = { pathname, bytes: Buffer.from(bytes), size: bytes.length, etag: backupDigest(bytes), uploadedAt, contentType: 'application/octet-stream' };
    this.entries.set(pathname, item);
    return { pathname, size: item.size, etag: item.etag, uploadedAt } satisfies BackupBlobMetadata;
  }
  async list(cursor?: string, limit = 25) {
    const start = cursor ? Number(cursor) : 0;
    const all = [...this.entries.values()].sort((a, b) => a.pathname.localeCompare(b.pathname));
    const blobs = all.slice(start, start + limit).map(({ bytes, ...metadata }) => { void bytes; return metadata; });
    const hasMore = start + limit < all.length;
    return { blobs, hasMore, ...(hasMore ? { cursor: String(start + limit) } : {}) };
  }
  async get(pathname: string, maximumBytes: number) {
    this.reads++;
    const item = this.entries.get(pathname);
    if (!item) return null;
    if (item.size > maximumBytes) throw new CloudBackupError('BACKUP_OBJECT_TOO_LARGE');
    const bytes = Buffer.from(item.bytes);
    if (this.corruptReadback && bytes.length) bytes[bytes.length - 1] ^= 1;
    return { ...item, bytes };
  }
  async putImmutable(pathname: string, bytes: Buffer) {
    this.writes++;
    if (this.entries.has(pathname)) throw new CloudBackupError('BACKUP_OBJECT_EXISTS');
    this.seed(pathname, bytes);
    if (this.acceptedWriteLosesResponse) throw new Error('synthetic token=never-echo-me');
  }
}

export function snapshotFixture(lines = ['{"id": "one", "secret": "private database rows"}']): DatabaseSnapshot {
  const proof: DatabaseProof = {
    format: 1, hashMethod: 'fixture canonical rows',
    tables: [{ schema: 'public', name: 'records', rows: lines.length, sha256: createHash('sha256').update(lines.length ? lines.join('\n') + '\n' : '').digest('hex') }],
    sequences: [], structuralCatalog: [{ kind: 'fixture-schema' }], securityCatalog: [{ kind: 'original-owner', detail: { owner: 'source_role' } }],
  };
  return {
    format: 'jesie-pg-json-v1', runId: '2026-10-17', capturedAt: fixtureNow().toISOString(), serverVersion: '18.6', serverMajor: 18,
    sourceDatabase: 'source_db', sourceSnapshot: '1:2:', proof,
    tables: [{ schema: 'public', name: 'records', columns: [{ name: 'id', generated: '' }, { name: 'secret', generated: '' }], rows: lines }],
    schemaFingerprint: snapshotSchemaFingerprint(proof), mediaReferences: { requiredPaths: [], literalPaths: [], referencedAssetIds: [], missingAssetIds: [] },
    restoreAdaptation: 'Database-local restore under current owner; original owner/ACL/role metadata retained separately; no production writes.',
  };
}

export function schemaBundleFixture(snapshot = snapshotFixture()): RestoreSchemaBundle {
  const preData = 'CREATE TABLE public.records(id text,secret text);';
  const postData = 'CREATE UNIQUE INDEX records_id ON public.records(id);';
  return { preData, postData, manifest: { format: 1, serverMajor: 18, preDataSha256: backupDigest(Buffer.from(preData)), postDataSha256: backupDigest(Buffer.from(postData)), schemaFingerprint: snapshot.schemaFingerprint } };
}

export function restoreReceiptFixture(snapshot = snapshotFixture()): DatabaseRestoreReceipt {
  return { runId: snapshot.runId, attemptId: 'a'.repeat(24), targetDatabase: 'isolated-fixture', verified: true,
    tableCount: snapshot.proof.tables.length, rowCount: snapshot.proof.tables.reduce((sum, table) => sum + table.rows, 0), tableHashesMatch: true,
    sequenceStateMatches: true, structuralCatalogMatches: true, sourceSecurityCatalogSha256: backupDigest(Buffer.from(JSON.stringify(snapshot.proof.securityCatalog))),
    ownershipAclAdapted: true, cleanupConfirmed: true, verifiedAt: fixtureNow().toISOString(), productionWrites: false };
}
