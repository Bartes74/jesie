import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRestoreScope, dropOwnedRestoreDatabase, newRestoreScope, restoreBundleSql, verifyIsolatedDatabaseRestore, type RestoreQueryClient, type RestoreScope } from './restore';
import { fixtureNow, schemaBundleFixture, snapshotFixture } from './test-fixtures';

function restoreFixture() {
  const snapshot = snapshotFixture(), scope = newRestoreScope(snapshotFixture().runId), bundle = schemaBundleFixture(snapshot);
  const databases = new Map<string, Record<string, unknown>>();
  const adminQueries: { sql: string; values?: unknown[] }[] = [], targetQueries: { sql: string; values?: unknown[] }[] = [];
  let targetDatabase = scope.databaseName, targetClosed = false;
  const admin: RestoreQueryClient = { async query(sql, values) {
    adminQueries.push({ sql, values });
    if (sql.startsWith('SELECT current_database()')) return { rows: [{ database: snapshot.sourceDatabase, owner: 'owner' }] };
    if (sql.includes('FROM pg_database')) return { rows: databases.has(String(values![0])) ? [databases.get(String(values![0]))!] : [] };
    if (sql.startsWith('CREATE DATABASE')) databases.set(scope.databaseName, { datname: scope.databaseName, owner: 'owner', marker: null });
    if (sql.startsWith('COMMENT ON DATABASE')) databases.get(scope.databaseName)!.marker = scope.marker;
    if (sql.startsWith('DROP DATABASE')) databases.delete(scope.databaseName);
    return { rows: [] };
  }, async end() {} };
  const target: RestoreQueryClient = { async query(sql, values) {
    targetQueries.push({ sql, values });
    if (sql.startsWith('SELECT current_database()')) return { rows: [{ database: targetDatabase, owner: 'owner' }] };
    return { rows: [] };
  }, async end() { targetClosed = true; } };
  const execute = (extra = {}) => verifyIsolatedDatabaseRestore({ snapshot, scope, bundle, admin, connectTarget: async () => target,
    collectProof: async () => snapshot.proof, now: fixtureNow, ...extra });
  return { snapshot, scope, bundle, databases, adminQueries, targetQueries, admin, target, execute,
    setTargetDatabase: (name: string) => { targetDatabase = name; }, targetClosed: () => targetClosed };
}

test('restore scope is unpredictable, bound to one run and never allows the source database', () => {
  const first = newRestoreScope('2026-10-17'), second = newRestoreScope('2026-10-17');
  assert.notEqual(first.databaseName, second.databaseName);
  assert.ok(first.databaseName.length <= 63);
  assertRestoreScope(first, first.runId, 'source_db');
  for (const scope of [{ ...first, databaseName: 'source_db' }, { ...first, marker: 'different' }, { ...first, runId: 'other-day' }]) assert.throws(() => assertRestoreScope(scope, first.runId, 'source_db'), /SCOPE_INVALID/);
});

test('schema bundle permits only recognized pg_dump delimiters and rejects cluster/destructive scope changes', () => {
  assert.match(restoreBundleSql('\\restrict abc123\nSET statement_timeout = 0;\nCREATE TABLE public.x(id int);\n\\unrestrict abc123'), /CREATE TABLE/);
  for (const unsafe of ['\\connect source_db', 'CREATE DATABASE production;', 'DROP ROLE owner;', 'SET ROLE owner;', '\\include /secret']) assert.throws(() => restoreBundleSql(unsafe), /SCHEMA_BUNDLE_UNSAFE/);
});

test('real verifier routes all schema/data writes to its confirmed isolated target, checks proofs and drops only owned target', async () => {
  const fixture = restoreFixture();
  const receipt = await fixture.execute();
  assert.equal(receipt.verified, true); assert.equal(receipt.cleanupConfirmed, true);
  assert.equal(receipt.productionWrites, false); assert.equal(fixture.targetClosed(), true); assert.equal(fixture.databases.size, 0);
  assert.ok(fixture.targetQueries.some(item => item.sql.startsWith('INSERT INTO')));
  assert.ok(fixture.adminQueries.every(item => !/^(INSERT|UPDATE|DELETE|DROP SCHEMA|CREATE TABLE)/.test(item.sql)));
  assert.equal(fixture.adminQueries.filter(item => item.sql.startsWith('DROP DATABASE')).length, 1);
  assert.doesNotMatch(JSON.stringify(receipt), /private database rows|source_role|postgresql:/);
});

test('restoring raw PostgreSQL JSON avoids JavaScript bigint conversion and skips generated columns', async () => {
  const fixture = restoreFixture();
  fixture.snapshot.tables[0].rows = ['{"id":9007199254740993,"secret":"exact","computed":"skip"}'];
  fixture.snapshot.tables[0].columns.push({ name: 'computed', generated: 's' });
  await fixture.execute();
  const insert = fixture.targetQueries.find(item => item.sql.startsWith('INSERT INTO'))!;
  assert.match(String(insert.values?.[0]), /9007199254740993/);
  assert.doesNotMatch(insert.sql, /computed/); assert.match(insert.sql, /OVERRIDING SYSTEM VALUE/);
});

test('schema mismatch retains snapshot and never creates a database', async () => {
  const fixture = restoreFixture(); fixture.bundle.manifest.schemaFingerprint = 'a'.repeat(64);
  const receipt = await fixture.execute();
  assert.equal(receipt.verified, false); assert.equal(receipt.code, 'BACKUP_SCHEMA_BUNDLE_MISMATCH');
  assert.equal(fixture.adminQueries.length, 0); assert.equal(fixture.targetQueries.length, 0);
});

test('pre-existing wrong-marker or wrong-owner database is never adopted or dropped', async () => {
  for (const wrong of [{ marker: 'foreign' }, { owner: 'foreign_owner' }]) {
    const fixture = restoreFixture(); fixture.databases.set(fixture.scope.databaseName, { datname: fixture.scope.databaseName, owner: 'owner', marker: fixture.scope.marker, ...wrong });
    const receipt = await fixture.execute();
    assert.equal(receipt.verified, false); assert.equal(receipt.cleanupConfirmed, false);
    assert.ok(fixture.databases.has(fixture.scope.databaseName));
    assert.ok(fixture.adminQueries.every(item => !item.sql.startsWith('DROP DATABASE') && !item.sql.startsWith('CREATE DATABASE')));
  }
});

test('misrouted connection to source fails before even DROP SCHEMA or INSERT and closes only its own client', async () => {
  const fixture = restoreFixture(); fixture.setTargetDatabase(fixture.snapshot.sourceDatabase);
  const receipt = await fixture.execute();
  assert.equal(receipt.code, 'BACKUP_RESTORE_TARGET_MISMATCH'); assert.equal(receipt.verified, false); assert.equal(receipt.cleanupConfirmed, true);
  assert.ok(fixture.targetQueries.every(item => item.sql.startsWith('SELECT current_database()')));
});

test('failed data restore and mismatched proof both remove only the exact confirmed temporary database', async () => {
  for (const failure of ['insert', 'proof']) {
    const fixture = restoreFixture();
    const base = fixture.target.query;
    if (failure === 'insert') fixture.target.query = async (sql, values) => { if (sql.startsWith('INSERT')) throw new Error('private SQL/secret'); return base(sql, values); };
    const receipt = await fixture.execute(failure === 'proof' ? { collectProof: async () => ({ ...fixture.snapshot.proof, tables: [] }) } : {});
    assert.equal(receipt.verified, false); assert.equal(receipt.cleanupConfirmed, true); assert.equal(fixture.databases.size, 0);
    assert.doesNotMatch(JSON.stringify(receipt), /private SQL|secret/);
  }
});

test('cleanup rechecks marker and current source identity immediately before DROP', async () => {
  const fixture = restoreFixture();
  fixture.databases.set(fixture.scope.databaseName, { datname: fixture.scope.databaseName, owner: 'owner', marker: 'changed-during-run' });
  await assert.rejects(dropOwnedRestoreDatabase(fixture.admin, fixture.scope, fixture.snapshot.sourceDatabase, 'owner'), /OWNERSHIP_UNCONFIRMED/);
  await assert.rejects(dropOwnedRestoreDatabase(fixture.admin, { ...fixture.scope, databaseName: fixture.snapshot.sourceDatabase } as RestoreScope, fixture.snapshot.sourceDatabase, 'owner'), /SCOPE_INVALID/);
  assert.ok(fixture.adminQueries.every(item => !item.sql.startsWith('DROP DATABASE')));
});
