import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { backupDigest } from './crypto';
import { newRestoreScope } from './restore';
import { createCloudBackupService } from './service';
import { captureDatabaseSnapshot } from './snapshot';
import { fixtureConfig, fixtureNow, MemoryBackupStore } from './test-fixtures';

const execute = promisify(execFile);

test('PG18 actual encrypted snapshot restores constraints, functions, RLS, sequences and exact bigint/numeric/bytea rows into its isolated database', { timeout: 90_000 }, async () => {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production') throw new Error('Isolated development test only.');
  const bin = process.env.MEDIA_BACKUP_TEST_PG_BIN ?? '/opt/homebrew/Cellar/postgresql@18/18.6_1/bin';
  const root = await mkdtemp('/private/tmp/jesie-cloud-backup-test-'); await chmod(root, 0o700);
  const data = join(root, 'data'), socket = join(root, 'socket');
  const { mkdir } = await import('node:fs/promises'); await mkdir(socket, { mode: 0o700 });
  const role = 'backup_test_owner', port = 55485, sourceDatabase = `source_fixture_${randomUUID().replaceAll('-', '')}`;
  // Do not inherit application DSNs, PG service/password files or provider keys.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', PGPASSFILE: '/dev/null', NODE_ENV: 'test' };
  let started = false, source: Client | undefined, admin: Client | undefined;
  const clients = new Set<Client>();
  const connect = async (database: string) => {
    const client = new Client({ host: socket, port, user: role, database, ssl: false, connectionTimeoutMillis: 5000 });
    client.on('error', () => {}); await client.connect(); clients.add(client); return client;
  };
  try {
    await execute(join(bin, 'initdb'), ['-D', data, '-U', role, '--encoding=UTF8', '--locale=C', '--auth-local=trust', '--auth-host=reject'], { env });
    await execute(join(bin, 'pg_ctl'), ['-D', data, '-l', join(root, 'postgres.log'), '-w', '-t', '20', '-o', `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -p ${port} -c ssl=off -c shared_buffers=16MB`, 'start'], { env });
    started = true; admin = await connect('postgres');
    const identity = (await admin.query("SELECT current_setting('data_directory') AS data,inet_server_addr() AS address")).rows[0];
    assert.equal(identity.data, data); assert.equal(identity.address, null);
    await admin.query(`CREATE DATABASE "${sourceDatabase}" TEMPLATE template0`);
    source = await connect(sourceDatabase);
    await source.query(`CREATE TYPE public.fixture_mood AS ENUM ('warm','cool');
      CREATE SEQUENCE public.manual_seq AS bigint START WITH 40;
      CREATE TABLE public.records(id bigint PRIMARY KEY,secret text NOT NULL,precise numeric(40,16),mood public.fixture_mood,doubled bigint GENERATED ALWAYS AS(id*2) STORED);
      CREATE TABLE public.children(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,parent_id bigint REFERENCES public.records(id),payload bytea);
      INSERT INTO public.records(id,secret,precise,mood) VALUES(9007199254740993,'private fixture row',123456789012345678901234.1234567890123456,'warm');
      INSERT INTO public.children(parent_id,payload) VALUES(9007199254740993,decode('00ff102030','hex'));
      SELECT setval('public.manual_seq',82,false);
      CREATE FUNCTION public.guard_records() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.secret='private fixture row' THEN RAISE EXCEPTION 'Restoration must insert data before triggers'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER records_guard BEFORE INSERT ON public.records FOR EACH ROW EXECUTE FUNCTION public.guard_records();
      ALTER TABLE public.records ENABLE ROW LEVEL SECURITY;
      CREATE POLICY records_read ON public.records FOR SELECT USING (true);`);
    const dumpEnv = { ...env, PGHOST: socket, PGPORT: String(port), PGUSER: role, PGDATABASE: sourceDatabase, PGSSLMODE: 'disable' };
    const common = ['--schema-only', '--no-owner', '--no-acl', '--no-password'];
    const preData = (await execute(join(bin, 'pg_dump'), [...common, '--section=pre-data'], { env: dumpEnv, maxBuffer: 4 * 1024 * 1024 })).stdout;
    const postData = (await execute(join(bin, 'pg_dump'), [...common, '--section=post-data'], { env: dumpEnv, maxBuffer: 4 * 1024 * 1024 })).stdout;
    const configuration = { ...fixtureConfig, maximumSnapshotBytes: 16 * 1024 * 1024 };
    const snapshot = await captureDatabaseSnapshot(source, 'local-restore-fixture', configuration);
    const bundle = { preData, postData, manifest: { format: 1 as const, serverMajor: snapshot.serverMajor,
      preDataSha256: backupDigest(Buffer.from(preData)), postDataSha256: backupDigest(Buffer.from(postData)), schemaFingerprint: snapshot.schemaFingerprint } };
    let bundleLoads = 0;
    let restoredCatalog: Record<string, unknown>[] = [];
    const service = createCloudBackupService({ configuration, source: new MemoryBackupStore('source123'), destination: new MemoryBackupStore('backup456'), now: fixtureNow,
      captureSnapshot: async () => snapshot,
      loadSchemaBundle: async () => { if (++bundleLoads > 1) throw new Error('A future deployment no longer has this schema'); return bundle; },
      connectAdmin: () => connect(sourceDatabase), connectTarget: async name => {
        const client = await connect(name);
        return { async query(sql, values) { const result = await client.query(sql, values);
          if (sql.includes("'column' AS kind")) restoredCatalog = result.rows.map(row => row.item);
          return result;
        }, end: () => client.end() };
      },
    });
    const backup = await service.snapshotBackup(snapshot.runId);
    assert.ok(backup.schema.cipherBytes > 0); assert.equal(backup.rowCount, 2);
    const scope = newRestoreScope(snapshot.runId), restored = await service.verifyRestore(snapshot.runId, scope);
    assert.deepEqual(restoredCatalog, snapshot.proof.structuralCatalog);
    assert.equal(restored.verified, true, JSON.stringify(restored)); assert.equal(restored.cleanupConfirmed, true);
    assert.equal(restored.tableHashesMatch, true); assert.equal(restored.sequenceStateMatches, true); assert.equal(restored.structuralCatalogMatches, true);
    assert.equal(bundleLoads, 1, 'Restore must use frozen backup schema, not the deployment bundle.');
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM pg_database WHERE datname=$1', [scope.databaseName])).rows[0].count, 0);
    const original = (await source.query('SELECT id::text,precise::text,doubled::text FROM public.records')).rows[0];
    assert.equal(original.id, '9007199254740993'); assert.equal(original.precise, '123456789012345678901234.1234567890123456');
    assert.equal(original.doubled, '18014398509481986');
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    if (started) await execute(join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '20', 'stop'], { env }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
