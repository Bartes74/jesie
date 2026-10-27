import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { captureDatabaseSnapshot, decodeDatabaseSnapshot, encodeDatabaseSnapshot } from './snapshot';
import { fixtureConfig, fixtureNow, snapshotFixture } from './test-fixtures';

function snapshotClient(lines: string[], unsupported = false) {
  const queries: string[] = [];
  return { queries, async query(sql: string) {
    queries.push(sql);
    if (sql.includes('current_database() AS database')) return { rows: [{ database: 'source_db', version: '18.6', version_num: 180006, snapshot: '1:2:', captured_at: fixtureNow() }] };
    if (sql.includes('pg_largeobject_metadata')) return { rows: [{ large_objects: unsupported ? 1 : 0, external_relations: 0, inheritance_relations: 0 }] };
    if (sql.startsWith('SELECT a.attname')) return { rows: [{ name: 'id', generated: '' }, { name: 'secret', generated: '' }] };
    if (sql.startsWith('FETCH')) return { rows: lines.map(line => ({ line })) };
    return { rows: [] };
  } };
}

test('capture uses one read-only repeatable snapshot and exact actual rows, never count estimates', async () => {
  const original = snapshotFixture(['{"id": 9007199254740993, "secret": "private"}']);
  const client = snapshotClient(original.tables[0].rows);
  const snapshot = await captureDatabaseSnapshot(client, original.runId, fixtureConfig, { collectProof: async () => original.proof, now: fixtureNow });
  assert.deepEqual(snapshot.tables[0].rows, original.tables[0].rows);
  assert.equal(snapshot.proof.tables[0].rows, 1);
  assert.equal(client.queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(client.queries.at(-1), 'COMMIT');
  assert.ok(client.queries.some(query => query.includes('COLLATE "C"')));
  assert.ok(client.queries.every(query => !/^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/.test(query)));
  assert.equal(decodeDatabaseSnapshot(encodeDatabaseSnapshot(snapshot, 100_000), original.runId, 100_000).tables[0].rows[0], original.tables[0].rows[0]);
});

test('row/hash drift, unsupported native features and bounds roll back without accepting a partial snapshot', async () => {
  const snapshot = snapshotFixture();
  const cases = [
    { client: snapshotClient(['{"id":"changed"}']), limits: fixtureConfig, code: 'PROOF_MISMATCH' },
    { client: snapshotClient(snapshot.tables[0].rows, true), limits: fixtureConfig, code: 'NATIVE_DUMP_REQUIRED' },
    { client: snapshotClient(snapshot.tables[0].rows), limits: { ...fixtureConfig, maximumSnapshotRows: 0 }, code: 'SIZE_LIMIT' },
  ];
  for (const item of cases) {
    await assert.rejects(captureDatabaseSnapshot(item.client, snapshot.runId, item.limits, { collectProof: async () => snapshot.proof, now: fixtureNow }), new RegExp(item.code));
    assert.equal(item.client.queries.at(-1), 'ROLLBACK');
  }
});

test('encrypted snapshot payload validation rejects changed rows, wrong checkpoint and decompression bombs', () => {
  const snapshot = snapshotFixture(), bytes = encodeDatabaseSnapshot(snapshot, 100_000);
  assert.throws(() => decodeDatabaseSnapshot(bytes, 'different-day', 100_000), /SNAPSHOT_INVALID/);
  assert.throws(() => decodeDatabaseSnapshot(bytes, snapshot.runId, 10), /SNAPSHOT_INVALID/);
  snapshot.tables[0].rows[0] = '{"id":"forged"}';
  assert.throws(() => decodeDatabaseSnapshot(gzipSync(Buffer.from(JSON.stringify(snapshot))), snapshot.runId, 100_000), /SNAPSHOT_INVALID/);
});

test('snapshot reference closure retains master/original aliases, compaction targets and missing asset diagnostics', async () => {
  const snapshot = snapshotFixture();
  const records = [
    { name: 'ai_asset', row: '{"id":"asset-one","blob_pathname":"ai/master.png","original_blob_pathname":"ai/raw.png"}' },
    { name: 'media_compaction', row: '{"source_pathname":"ai/raw.png","target_pathname":"ai/compact/raw.webp"}' },
    { name: 'editorial_recipe', row: '{"content":{"assetId":"asset-one","photos":[{"mediaAssetId":"missing-asset"}],"old":"ai/historical.png","image":"/media/missing-string-asset?width=96"}}' },
    { name: 'media_delivery_variant', row: '{"status":"ready","blob_pathname":"media-variants/webp-delivery-v1/master/hero/exact.webp"}' },
    { name: 'collection_asset', row: '{"id":"collection-art","blob_pathname":"media/collections/collection-art.webp","kind":"inspiration"}' },
    { name: 'event_collection_publication', row: '{"snapshot":{"theme":{"hero":{"assetId":"collection-art","src":"/media/collections/collection-art"}}}}' },
  ];
  const tables = records.map(item => snapshotFixture([item.row]).proof.tables[0]);
  tables.forEach((table, index) => { table.name = records[index].name; });
  const proof = { ...snapshot.proof, tables };
  let active = 0;
  const client = snapshotClient([]);
  const baseQuery = client.query;
  client.query = async sql => {
    if (sql.startsWith('DECLARE')) { active = Number(/jesie_cloud_backup_([0-9]+)/.exec(sql)![1]); return { rows: [] }; }
    if (sql.startsWith('FETCH')) return { rows: [{ line: records[active].row }] };
    return baseQuery(sql);
  };
  const captured = await captureDatabaseSnapshot(client, snapshot.runId, fixtureConfig, { collectProof: async () => proof, now: fixtureNow });
  assert.deepEqual(captured.mediaReferences.requiredPaths, ['ai/compact/raw.webp', 'ai/master.png', 'media-variants/webp-delivery-v1/master/hero/exact.webp', 'media/collections/collection-art.webp']);
  assert.deepEqual(captured.mediaReferences.missingAssetIds, ['missing-asset', 'missing-string-asset']);
  assert.ok(captured.mediaReferences.literalPaths.includes('ai/raw.png'));
  assert.ok(captured.mediaReferences.literalPaths.includes('ai/historical.png'));
  assert.ok(!captured.mediaReferences.requiredPaths.includes('ai/historical.png'));
});
