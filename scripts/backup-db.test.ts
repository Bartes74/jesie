import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanupRestoreClone, collectDatabaseProof, directDatabaseUrl, dumpArguments, localPgEnvironment, productionPgEnvironment, restoreArguments } from './backup-db';

test('dump credentials select the same direct Neon database with verify-full and never enter command arguments', () => {
  const source = 'postgresql://owner:synthetic%2Fsecret@ep-example-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require';
  const environment = productionPgEnvironment(source);
  assert.equal(environment.PGHOST, 'ep-example.eu-central-1.aws.neon.tech');
  assert.equal(environment.PGDATABASE, 'neondb'); assert.equal(environment.PGPASSWORD, 'synthetic/secret');
  assert.equal(environment.PGSSLMODE, 'verify-full'); assert.equal(environment.PGPASSFILE, '/dev/null');
  assert.equal(directDatabaseUrl(source).searchParams.get('sslmode'), 'verify-full');
  const args = dumpArguments('/private/backup/database.dump.private', '00000003-00000D9E-1');
  assert.ok(args.includes('--format=custom')); assert.ok(args.includes('--snapshot=00000003-00000D9E-1'));
  assert.doesNotMatch(JSON.stringify(args), /owner|secret|postgresql|--schema|--no-acl|--no-owner|--clean/);
});

test('a dump requires an absolute private destination and a valid exported snapshot identifier', () => {
  for (const snapshot of ['', "00000003-00000D9E-1';DROP TABLE x", 'https://private.invalid', '../snapshot']) assert.throws(() => dumpArguments('/private/backup/db.dump', snapshot));
  assert.throws(() => dumpArguments('relative.dump', '00000003-00000D9E-1'));
  assert.throws(() => directDatabaseUrl('postgresql://owner:secret@unrelated.invalid/db'));
});

test('local restore target cannot become a hostname, arbitrary socket or production connection', () => {
  const socket = '/private/tmp/jesie-pg-restore-random123';
  const env = localPgEnvironment(socket, 'jesie_restore_check');
  assert.equal(env.PGHOST, socket); assert.equal(env.PGSSLMODE, 'disable'); assert.equal(env.PGPASSWORD, undefined);
  const args = restoreArguments('/private/backup/db.dump', socket);
  for (const flag of ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction']) assert.ok(args.includes(flag));
  assert.ok(args.includes(`--host=${socket}`)); assert.ok(args.includes('--dbname=jesie_restore_check'));
  for (const target of ['ep-example.neon.tech', '/tmp', '/private/tmp/jesie-pg-restore-x/../other', 'postgresql://owner:secret@localhost/db']) assert.throws(() => localPgEnvironment(target));
  assert.throws(() => localPgEnvironment(socket, 'neondb'));
});

test('proof consumes ordered canonical rows through a bounded cursor, preserves security facts and retains only hashes', async () => {
  const queries: string[] = []; const lines = ['{"id": "1", "private": "synthetic secret"}', '{"id": "2", "private": "different secret"}'];
  const structural = { kind: 'constraint', detail: { validated: false } };
  const security = { kind: 'default-acl', detail: { owner: 'original_role', acl: ['owner=r/owner'] } };
  const proof = await collectDatabaseProof({ query: async sql => {
    queries.push(sql);
    if (sql.includes('c.relkind IN (\'r\',\'p\')')) return { rows: [{ schema: 'public', name: 'private"records' }] };
    if (sql.startsWith('FETCH')) return { rows: lines.map(line => ({ line })) };
    if (sql.includes('JOIN pg_sequence')) return { rows: [] };
    if (sql.includes("'column' AS kind")) return { rows: [{ item: structural }] };
    if (sql.includes("'schema-acl' AS kind")) return { rows: [{ item: security }] };
    return { rows: [] };
  } });
  assert.equal(proof.tables.length, 1); assert.equal(proof.tables[0].rows, 2);
  assert.equal(proof.tables[0].sha256, createHash('sha256').update(lines.join('\n') + '\n').digest('hex'));
  assert.deepEqual(proof.structuralCatalog, [structural]); assert.deepEqual(proof.securityCatalog, [security]);
  assert.ok(queries.some(query => query.includes('"public"."private""records"')));
  assert.ok(queries.some(query => query.includes('COLLATE "C"')));
  assert.ok(queries.some(query => query.startsWith('FETCH 250')));
  assert.ok(queries.some(query => query.startsWith('CLOSE')));
  assert.doesNotMatch(JSON.stringify(proof), /synthetic secret|different secret/);
  assert.ok(queries.every(query => !/^(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b/.test(query)));
});

test('cleanup rejects a mismatched local scope before removing data or touching a server', async () => {
  const root = await mkdtemp('/private/tmp/jesie-backup-test-'); await chmod(root, 0o700);
  const clone = path.join(root, 'restore-check-fixture'), data = path.join(clone, 'data');
  await mkdir(data, { recursive: true, mode: 0o700 });
  const output = path.join(root, 'db.dump'), reportFile = path.join(clone, 'restore-report.private.json');
  const retained = path.join(data, 'retained.private'); await writeFile(retained, 'untouched', { mode: 0o600 });
  await writeFile(path.join(clone, 'scope.private.json'), JSON.stringify({ runId: 'one', dataDirectory: data, socketDirectory: '/private/tmp/jesie-pg-restore-fixture', socketOnly: true }), { mode: 0o600 });
  await writeFile(reportFile, JSON.stringify({ runId: 'different', verificationPassed: true, keepLocalCluster: true, socketOnly: true, localCluster: { dataDirectory: data, socketDirectory: '/private/tmp/jesie-pg-restore-fixture' } }), { mode: 0o600 });
  try { await assert.rejects(cleanupRestoreClone({ output, reportFile }), /INVALID_LOCAL_CLEANUP_SCOPE/); assert.equal(await readFile(retained, 'utf8'), 'untouched'); }
  finally { await rm(root, { recursive: true, force: true }); }
});
