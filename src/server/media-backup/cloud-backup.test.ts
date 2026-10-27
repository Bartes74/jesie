import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudBackupConfiguration } from './config';
import { backupDigest, decryptBackupBytes, encryptBackupBytes } from './crypto';
import { saveCheckpointManifest } from './manifest';
import { copyMediaBackupObject, copyMediaBackupPage, readEncryptedBackup, saveEncryptedBackup } from './objects';
import { createCloudBackupService } from './service';
import { fixtureConfig, fixtureEncryption, fixtureNow, MemoryBackupStore, restoreReceiptFixture, schemaBundleFixture, snapshotFixture } from './test-fixtures';

test('configuration requires independent actual stores, a valid escrow key and bounded limits without echoing secrets', () => {
  assert.equal(cloudBackupConfiguration({}), null);
  const env = { MEDIA_BACKUP_ENABLED: '1', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_source123_synthetic-secret',
    MEDIA_BACKUP_STORE_ID: 'backup456', MEDIA_BACKUP_READ_WRITE_TOKEN: 'vercel_blob_rw_backup456_private',
    MEDIA_BACKUP_KEY_ID: fixtureEncryption.keyId, MEDIA_BACKUP_ENCRYPTION_KEY: fixtureEncryption.key.toString('base64') };
  assert.equal(cloudBackupConfiguration(env)?.destination.storeId, 'backup456');
  for (const change of [
    { MEDIA_BACKUP_STORE_ID: 'source123', MEDIA_BACKUP_READ_WRITE_TOKEN: env.BLOB_READ_WRITE_TOKEN },
    { MEDIA_BACKUP_STORE_ID: 'backup456', MEDIA_BACKUP_READ_WRITE_TOKEN: env.BLOB_READ_WRITE_TOKEN },
    { MEDIA_BACKUP_ENCRYPTION_KEY: 'private-invalid-key' }, { MEDIA_BACKUP_MAX_OBJECT_BYTES: '0' },
  ]) assert.throws(() => cloudBackupConfiguration({ ...env, ...change }), error => error instanceof Error && !/synthetic-secret|private-invalid-key|vercel_blob_rw/.test(error.message));
});

test('authenticated envelopes use fresh nonces and reject changed bytes, keys, identity or context', () => {
  const bytes = Buffer.from('private complete database');
  const encrypted = encryptBackupBytes(bytes, fixtureEncryption, 'checkpoint/day/database');
  assert.notDeepEqual(encrypted, encryptBackupBytes(bytes, fixtureEncryption, 'checkpoint/day/database'));
  assert.deepEqual(decryptBackupBytes(encrypted, fixtureEncryption, 'checkpoint/day/database', 1000), bytes);
  const changed = Buffer.from(encrypted); changed[changed.length - 1] ^= 1;
  for (const [body, key, context] of [[changed, fixtureEncryption, 'checkpoint/day/database'],
    [encrypted, { ...fixtureEncryption, key: Buffer.alloc(32, 3) }, 'checkpoint/day/database'],
    [encrypted, fixtureEncryption, 'checkpoint/other/database']] as const) assert.throws(() => decryptBackupBytes(body, key, context, 1000), /BACKUP_AUTHENTICATION_FAILED/);
  assert.throws(() => decryptBackupBytes(encrypted, fixtureEncryption, 'checkpoint/day/database', 1));
});

test('media backup copies exact bytes to an independent private object and deduplicates equal originals', async () => {
  const source = new MemoryBackupStore('source123'), destination = new MemoryBackupStore('backup456');
  const bytes = Buffer.from('pixel-perfect source and alpha');
  const original = source.seed('ai/original.png', bytes), alias = source.seed('ai/other.png', bytes);
  const deps = { source, destination, encryption: fixtureEncryption, maximumObjectBytes: 1024, now: fixtureNow };
  const first = await copyMediaBackupObject(original, deps), second = await copyMediaBackupObject(alias, deps);
  assert.equal(first.sha256, backupDigest(bytes)); assert.equal(first.backupPath, second.backupPath);
  assert.equal(first.status, 'complete'); assert.equal(first.restoreVerifiedAt, fixtureNow().toISOString());
  assert.equal(destination.writes, 1); assert.equal(destination.entries.size, 1);
  assert.doesNotMatch(JSON.stringify(first), /pixel-perfect|private complete/);
  assert.notDeepEqual([...destination.entries.values()][0].bytes, bytes);
});

test('accepted immutable upload with lost response is reconciled by GET, without another object', async () => {
  const source = new MemoryBackupStore('source123'), destination = new MemoryBackupStore('backup456'); destination.acceptedWriteLosesResponse = true;
  const reference = source.seed('ai/image.png', Buffer.from('same pixels'));
  const deps = { source, destination, encryption: fixtureEncryption, maximumObjectBytes: 1024, now: fixtureNow };
  const first = await copyMediaBackupObject(reference, deps);
  assert.deepEqual(await copyMediaBackupObject(reference, deps), first);
  assert.equal(destination.writes, 1);
});

test('changed source, oversized object, shared store and corrupted readback never produce a complete proof', async () => {
  const source = new MemoryBackupStore('source123'), destination = new MemoryBackupStore('backup456');
  const reference = source.seed('ai/image.png', Buffer.from('original'));
  const deps = { source, destination, encryption: fixtureEncryption, maximumObjectBytes: 1024, now: fixtureNow };
  await assert.rejects(copyMediaBackupObject(reference, { ...deps, destination: source }), /INDEPENDENT_STORE/);
  await assert.rejects(copyMediaBackupObject(reference, { ...deps, maximumObjectBytes: 1 }), /TOO_LARGE/);
  source.seed(reference.pathname, Buffer.from('changed'));
  await assert.rejects(copyMediaBackupObject(reference, deps), /SOURCE_CHANGED/);
  const current = source.seed(reference.pathname, Buffer.from('original'));
  destination.corruptReadback = true;
  await assert.rejects(copyMediaBackupObject(current, deps), /AUTHENTICATION_FAILED/);
  assert.equal(destination.entries.size, 1);
});

test('bounded pages preserve progress and reuse committed bytes after a partial-page retry', async () => {
  const source = new MemoryBackupStore('source123'), destination = new MemoryBackupStore('backup456');
  for (let index = 0; index < 3; index++) source.seed(`ai/${index}.png`, Buffer.from(`pixels${index}`));
  const deps = { source, destination, encryption: fixtureEncryption, maximumObjectBytes: 1024, now: fixtureNow };
  const first = await copyMediaBackupPage(undefined, 2, deps);
  assert.equal(first.proofs.length, 2); assert.equal(first.hasMore, true);
  assert.equal((await copyMediaBackupPage(undefined, 2, deps)).proofs.length, 2); assert.equal(destination.writes, 2);
  const last = await copyMediaBackupPage(first.cursor, 2, deps); assert.equal(last.proofs.length, 1); assert.equal(last.hasMore, false);
});

test('snapshot replay reads the existing encrypted capture and returns only safe metadata', async () => {
  const source = new MemoryBackupStore('source123'), destination = new MemoryBackupStore('backup456'); let captures = 0, bundleLoads = 0;
  const service = createCloudBackupService({ configuration: fixtureConfig, source, destination, now: fixtureNow,
    captureSnapshot: async () => { captures++; return snapshotFixture(); },
    loadSchemaBundle: async () => { bundleLoads++; if (bundleLoads > 1) throw new Error('deployment changed'); return schemaBundleFixture(); }, connectAdmin: async () => { throw new Error('must not connect'); }, connectTarget: async () => { throw new Error('must not connect'); },
  });
  const first = await service.snapshotBackup('2026-10-17'), second = await service.snapshotBackup('2026-10-17');
  assert.deepEqual(first, second); assert.equal(captures, 1); assert.equal(bundleLoads, 1); assert.equal(first.rowCount, 1);
  assert.ok(first.schema.backupPath.endsWith('schema-bundle.json.gz.aesgcm'));
  assert.equal(first.integrityVerified, true); assert.equal(first.restoreVerified, false);
  assert.doesNotMatch(JSON.stringify(first), /private database rows|source_role|source_db|rows":\[/);
});

test('complete manifest requires verified DB restore, every inventory version and snapshot reference closure; replay stays immutable', async () => {
  const source = new MemoryBackupStore('source123'), destination = new MemoryBackupStore('backup456');
  const reference = source.seed('ai/original.png', Buffer.from('final exact pixels'));
  const proof = await copyMediaBackupObject(reference, { source, destination, encryption: fixtureEncryption, maximumObjectBytes: 1024, now: fixtureNow });
  const snapshot = snapshotFixture(); snapshot.mediaReferences.requiredPaths = [reference.pathname];
  const databaseProof = await saveEncryptedBackup({ pathname: 'vault/db.aesgcm', context: 'database/fixture', plaintext: Buffer.from('fixture-db'), destination, encryption: fixtureEncryption, now: fixtureNow });
  const options = { runId: snapshot.runId, source, destination, snapshot, databaseProof, databaseSchemaProof: databaseProof, restore: restoreReceiptFixture(snapshot), inventory: [reference], inventoryComplete: true, proofs: [proof], encryption: fixtureEncryption, now: fixtureNow };
  await assert.rejects(saveCheckpointManifest({ ...options, proofs: [] }), /COPY_INCOMPLETE/);
  await assert.rejects(saveCheckpointManifest({ ...options, restore: { ...options.restore, verified: false } }), /RESTORE_NOT_VERIFIED/);
  await assert.rejects(saveCheckpointManifest({ ...options, snapshot: { ...snapshot, mediaReferences: { ...snapshot.mediaReferences, requiredPaths: ['ai/missing.png'] } } }), /CLOSURE_INCOMPLETE/);
  const first = await saveCheckpointManifest(options); const writes = destination.writes;
  const replay = await saveCheckpointManifest({ ...options, now: () => new Date('2026-10-18T01:00:00Z'), proofs: [{ ...proof, readbackVerifiedAt: '2026-10-18T01:00:00Z' }] });
  assert.equal(replay.manifest.cipherSha256, first.manifest.cipherSha256); assert.equal(destination.writes, writes);
  const restored = await readEncryptedBackup({ pathname: first.manifest.backupPath, context: `checkpoint/${snapshot.runId}/manifest`, maximumBytes: 1024 * 1024, destination, encryption: fixtureEncryption });
  assert.equal(JSON.parse(restored!.plaintext.toString()).databaseRestoreVerified, true);
});

test('verified physical application bundle files cover historical aliases without admitting foreign source stores', async () => {
  const source = new MemoryBackupStore('source123'), bundle = new MemoryBackupStore('applicationbundle'), destination = new MemoryBackupStore('backup456');
  const file = bundle.seed('bundle/private-media/recovered.png', Buffer.from('recovered pixels'));
  const item = { ...file, sourceStoreId: 'applicationbundle', sourceFile: 'private-media/recovered.png', aliases: ['ai/historical.png'] };
  Object.assign(bundle.entries.get(file.pathname)!, item);
  const proof = await copyMediaBackupObject(item, { source: bundle, destination, encryption: fixtureEncryption, maximumObjectBytes: 1024, now: fixtureNow });
  const snapshot = snapshotFixture(); snapshot.mediaReferences.requiredPaths = ['ai/historical.png'];
  const databaseProof = await saveEncryptedBackup({ pathname: 'vault/db.aesgcm', context: 'database/fixture', plaintext: Buffer.from('db'), destination, encryption: fixtureEncryption, now: fixtureNow });
  const options = { runId: snapshot.runId, snapshot, databaseProof, databaseSchemaProof: databaseProof, restore: restoreReceiptFixture(snapshot), source, destination,
    inventory: [item], inventoryComplete: true, proofs: [proof], encryption: fixtureEncryption, now: fixtureNow };
  assert.equal((await saveCheckpointManifest(options)).closureVerified, true);
  await assert.rejects(saveCheckpointManifest({ ...options, inventory: [{ ...item, sourceStoreId: 'otherstore' }] }), /SOURCE_STORE_MISMATCH/);
  Object.assign(bundle.entries.get(file.pathname)!, { aliases: ['ai/changed-alias.png'] });
  await assert.rejects(copyMediaBackupObject(item, { source: bundle, destination, encryption: fixtureEncryption, maximumObjectBytes: 1024, now: fixtureNow }), /SOURCE_CHANGED/);
});
