import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

type QueryClient = { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> };
type TableProof = { schema: string; name: string; rows: number; sha256: string };
export type DatabaseProof = {
  format: 1;
  hashMethod: string;
  tables: TableProof[];
  sequences: Record<string, unknown>[];
  structuralCatalog: Record<string, unknown>[];
  securityCatalog: Record<string, unknown>[];
};

const role = 'jesie_restore';
const restoredDatabase = 'jesie_restore_check';
const restorePort = '55484';
const defaultBin = '/opt/homebrew/Cellar/postgresql@18/18.6_1/bin';
const snapshotPattern = /^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{8}-[0-9]+$/;
const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

function baseEnvironment(): NodeJS.ProcessEnv {
  // No inherited PG service, credentials, provider keys or application DSN.
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: '/private/tmp', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', NODE_ENV: 'production', PGPASSFILE: '/dev/null' };
}

export function directDatabaseUrl(connectionString: string): URL {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname.endsWith('.neon.tech')) throw new Error('BACKUP_DB_UNSUPPORTED_SOURCE');
  url.hostname = url.hostname.replace('-pooler.', '.');
  url.searchParams.set('sslmode', 'verify-full');
  return url;
}

export function productionPgEnvironment(connectionString: string): NodeJS.ProcessEnv {
  const url = directDatabaseUrl(connectionString);
  return { ...baseEnvironment(), PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: '/etc/ssl/cert.pem', PGCONNECT_TIMEOUT: '20', PGAPPNAME: 'jesie_private_backup',
    PGOPTIONS: '-c default_transaction_read_only=on', PGTZ: 'UTC' };
}

export function localPgEnvironment(socketDirectory: string, database = 'postgres'): NodeJS.ProcessEnv {
  if (!/^\/private\/tmp\/jesie-pg-restore-[A-Za-z0-9_-]+$/.test(socketDirectory)
    || !['postgres', restoredDatabase].includes(database)) throw new Error('BACKUP_DB_LOCAL_TARGET_REQUIRED');
  return { ...baseEnvironment(), PGHOST: socketDirectory, PGPORT: restorePort, PGUSER: role, PGDATABASE: database,
    PGSSLMODE: 'disable', PGCONNECT_TIMEOUT: '20', PGAPPNAME: 'jesie_restore_verification', PGTZ: 'UTC' };
}

export function dumpArguments(output: string, snapshot: string): string[] {
  if (!path.isAbsolute(output) || !snapshotPattern.test(snapshot)) throw new Error('BACKUP_DB_INVALID_DUMP_SCOPE');
  // Keep all schemas, owner metadata and ACLs in the portable disaster-recovery archive.
  return ['--format=custom', '--compress=gzip:6', '--no-password', '--lock-wait-timeout=30s', `--snapshot=${snapshot}`, `--file=${output}`, '--verbose'];
}

export function restoreArguments(output: string, socketDirectory: string): string[] {
  localPgEnvironment(socketDirectory, restoredDatabase);
  if (!path.isAbsolute(output)) throw new Error('BACKUP_DB_LOCAL_SOURCE_REQUIRED');
  return [`--host=${socketDirectory}`, `--port=${restorePort}`, `--username=${role}`, `--dbname=${restoredDatabase}`,
    '--no-password', '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--verbose', output];
}

/** Use inside the owner's exported READ ONLY snapshot, or the isolated restore transaction. No row contents are retained. */
export async function collectDatabaseProof(client: QueryClient): Promise<DatabaseProof> {
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  await client.query('SET LOCAL row_security = off');
  const relationRows = (await client.query(`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p') ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`)).rows;
  const tables: TableProof[] = [];
  for (let index = 0; index < relationRows.length; index++) {
    const relation = relationRows[index];
    const schema = String(relation.schema), name = String(relation.name);
    const cursor = quoteIdentifier(`jesie_backup_rows_${index}`);
    const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
    await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS line FROM ${qualified} t ORDER BY to_jsonb(t)::text COLLATE "C"`);
    const hash = createHash('sha256'); let rows = 0;
    try {
      while (true) {
        const chunk = (await client.query(`FETCH 250 FROM ${cursor}`)).rows;
        for (const row of chunk) { if (typeof row.line !== 'string') throw new Error('BACKUP_DB_INVALID_PROOF_ROW'); hash.update(row.line).update('\n'); rows++; }
        if (chunk.length < 250) break;
      }
    } finally { await client.query(`CLOSE ${cursor}`); }
    tables.push({ schema, name, rows, sha256: hash.digest('hex') });
  }
  const sequences: Record<string, unknown>[] = [];
  const sequenceRows = (await client.query(`SELECT n.nspname AS schema,c.relname AS name,s.seqstart::text,s.seqincrement::text,s.seqmin::text,s.seqmax::text,s.seqcache::text,s.seqcycle
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_sequence s ON s.seqrelid=c.oid
    WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`)).rows;
  for (const sequence of sequenceRows) {
    const state = (await client.query(`SELECT last_value::text,is_called FROM ${quoteIdentifier(String(sequence.schema))}.${quoteIdentifier(String(sequence.name))}`)).rows[0];
    sequences.push({ ...sequence, ...state });
  }
  const structuralCatalog = (await client.query(`SELECT to_jsonb(x) AS item FROM (
    SELECT 'column' AS kind,n.nspname AS schema,c.relname AS parent,a.attname AS name,jsonb_build_object('position',a.attnum,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid)) AS detail
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE a.attnum>0 AND NOT a.attisdropped AND c.relkind IN('r','p') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'constraint',n.nspname,c.relname,k.conname,jsonb_build_object('definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'index',n.nspname,c.relname,i.relname,jsonb_build_object('definition',pg_get_indexdef(i.oid)) FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class c ON c.oid=x.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'function',n.nspname,'',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',jsonb_build_object('definition',pg_get_functiondef(p.oid),'securityDefiner',p.prosecdef,'config',p.proconfig) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'relation-security',n.nspname,c.relname,c.relname,jsonb_build_object('rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN('r','p') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'policy',n.nspname,c.relname,p.polname,jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN v=0 THEN 'PUBLIC' ELSE pg_get_userbyid(v) END ORDER BY v) FROM unnest(p.polroles) v),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'trigger',n.nspname,c.relname,t.tgname,jsonb_build_object('definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
  ) x ORDER BY kind COLLATE "C",schema COLLATE "C",parent COLLATE "C",name COLLATE "C"`)).rows.map(row => row.item as Record<string, unknown>);
  const securityCatalog = (await client.query(`SELECT to_jsonb(x) AS item FROM (
    SELECT 'schema-acl' AS kind,n.nspname AS schema,''::text AS name,jsonb_build_object('owner',pg_get_userbyid(n.nspowner),'acl',n.nspacl) AS detail FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'relation-acl',n.nspname,c.relname,jsonb_build_object('owner',pg_get_userbyid(c.relowner),'acl',c.relacl) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'column-acl',n.nspname,c.relname||'.'||a.attname,jsonb_build_object('acl',a.attacl) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'function-acl',n.nspname,p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl,'securityDefiner',p.prosecdef) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'default-acl',COALESCE(n.nspname,''),pg_get_userbyid(d.defaclrole)||':'||d.defaclobjtype::text,jsonb_build_object('owner',pg_get_userbyid(d.defaclrole),'acl',d.defaclacl) FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
    UNION ALL SELECT 'role','',r.rolname,jsonb_build_object('superuser',r.rolsuper,'inherit',r.rolinherit,'createRole',r.rolcreaterole,'createDb',r.rolcreatedb,'login',r.rolcanlogin,'replication',r.rolreplication,'bypassRls',r.rolbypassrls,'config',r.rolconfig) FROM pg_roles r
  ) x ORDER BY kind COLLATE "C",schema COLLATE "C",name COLLATE "C"`)).rows.map(row => row.item as Record<string, unknown>);
  return { format: 1, hashMethod: 'SHA-256 of UTF-8 to_jsonb(row)::text sorted COLLATE C, each followed by LF; owners/ACL separate.', tables, sequences, structuralCatalog, securityCatalog };
}

async function hashFile(filename: string): Promise<string> {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex');
}

async function privateParent(filename: string): Promise<string> {
  if (!path.isAbsolute(filename)) throw new Error('BACKUP_DB_ABSOLUTE_PATH_REQUIRED');
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const parent = await realpath(path.dirname(filename));
  const workspace = await realpath(process.cwd());
  if (parent === workspace || parent.startsWith(`${workspace}${path.sep}`)) throw new Error('BACKUP_DB_PRIVATE_PATH_REQUIRED');
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('BACKUP_DB_PRIVATE_DIRECTORY_REQUIRED');
  return path.join(parent, path.basename(filename));
}

async function privateJson(filename: string, value: unknown) {
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

async function runTool(bin: string, tool: string, args: string[], env: NodeJS.ProcessEnv, logPath: string): Promise<string> {
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(path.join(bin, tool), args, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data.toString(); }); child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', () => reject(new Error('BACKUP_DB_TOOL_START_FAILED')));
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  await writeFile(logPath, result.stdout + result.stderr, { mode: 0o600, flag: 'wx' });
  if (result.code !== 0) throw new Error(`BACKUP_DB_${tool.toUpperCase()}_FAILED`);
  return result.stdout;
}

async function sourceVersion(connectionString: string) {
  const client = new pg.Client({ connectionString: directDatabaseUrl(connectionString).toString(), connectionTimeoutMillis: 20_000 });
  client.on('error', () => {});
  try { await client.connect(); await client.query('BEGIN READ ONLY'); return (await client.query("SELECT current_setting('server_version') AS version,current_setting('server_version_num')::integer AS version_num")).rows[0]; }
  finally { await client.query('ROLLBACK').catch(() => {}); await client.end().catch(() => {}); }
}

export async function dumpDatabase(options: { envFile: string; snapshot: string; output: string; pgBin?: string }) {
  const args = dumpArguments(options.output, options.snapshot);
  const env = dotenv.parse(await readFile(options.envFile));
  if (!env.DATABASE_URL) throw new Error('BACKUP_DB_SOURCE_MISSING');
  const output = await privateParent(options.output), bin = options.pgBin ?? defaultBin;
  const server = await sourceVersion(env.DATABASE_URL);
  const version = (await runTool(bin, 'pg_dump', ['--version'], baseEnvironment(), `${output}.tool-version.private.log`)).trim();
  if (!version.includes(`PostgreSQL) ${Math.floor(server.version_num / 10000)}.`)) throw new Error('BACKUP_DB_TOOL_MAJOR_MISMATCH');
  const destination = await open(output, 'wx', 0o600); await destination.close();
  await runTool(bin, 'pg_dump', args, productionPgEnvironment(env.DATABASE_URL), `${output}.dump.private.log`);
  await chmod(output, 0o600);
  const file = await lstat(output); const header = await open(output, 'r');
  try { const bytes = Buffer.alloc(5); await header.read(bytes, 0, 5, 0); if (bytes.toString() !== 'PGDMP') throw new Error('BACKUP_DB_INVALID_ARCHIVE'); } finally { await header.close(); }
  const sha256 = await hashFile(output);
  const metadata = { format: 1, createdAt: new Date().toISOString(), serverVersion: server.version, toolVersion: version, snapshot: options.snapshot,
    bytes: file.size, sha256, customArchive: true, allSchemas: true, includesOwnerMetadata: true, includesAcl: true, productionWrites: false };
  await privateJson(`${output}.metadata.private.json`, metadata);
  return { output, metadataFile: `${output}.metadata.private.json`, bytes: file.size, sha256, toolVersion: version };
}

export async function restoreDatabaseTest(options: { output: string; proofFile: string; metadataFile?: string; pgBin?: string; keepLocalCluster?: boolean }) {
  const output = await privateParent(options.output), bin = options.pgBin ?? defaultBin;
  const file = await lstat(output);
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) throw new Error('BACKUP_DB_PRIVATE_ARCHIVE_REQUIRED');
  const metadata = JSON.parse(await readFile(options.metadataFile ?? `${output}.metadata.private.json`, 'utf8'));
  if (typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256) || await hashFile(output) !== metadata.sha256) throw new Error('BACKUP_DB_ARCHIVE_HASH_MISMATCH');
  const expected = JSON.parse(await readFile(options.proofFile, 'utf8')) as DatabaseProof;
  if (expected.format !== 1 || !Array.isArray(expected.tables) || !Array.isArray(expected.structuralCatalog)) throw new Error('BACKUP_DB_INVALID_SOURCE_PROOF');
  const runId = randomUUID(); const root = await mkdtemp(path.join(path.dirname(output), 'restore-check-')); await chmod(root, 0o700);
  const socket = await mkdtemp('/private/tmp/jesie-pg-restore-'); await chmod(socket, 0o700);
  const data = path.join(root, 'data'); const postgresLog = path.join(root, 'postgres.private.log');
  await writeFile(postgresLog, '', { mode: 0o600, flag: 'wx' });
  await privateJson(path.join(root, 'scope.private.json'), { runId, socketOnly: true, dataDirectory: data, socketDirectory: socket });
  let startAttempted = false, preserveClone = false;
  try {
    await runTool(bin, 'initdb', ['-D', data, '-U', role, '--encoding=UTF8', '--locale=C', '--auth-local=trust', '--auth-host=reject', '--data-checksums'], baseEnvironment(), path.join(root, 'initdb.private.log'));
    const serverOptions = `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -p ${restorePort} -c ssl=off -c timezone=UTC -c max_connections=20 -c shared_buffers=32MB`;
    startAttempted = true;
    await runTool(bin, 'pg_ctl', ['-D', data, '-l', postgresLog, '-w', '-t', '60', '-o', serverOptions, 'start'], baseEnvironment(), path.join(root, 'start.private.log'));
    const admin = new pg.Client({ host: socket, port: Number(restorePort), user: role, database: 'postgres', ssl: false, connectionTimeoutMillis: 10_000 }); admin.on('error', () => {});
    try {
      await admin.connect();
      const state = (await admin.query("SELECT current_setting('data_directory') AS data,current_setting('listen_addresses') AS listen,inet_server_addr() AS address")).rows[0];
      if (state.data !== data || state.listen !== '' || state.address !== null) throw new Error('BACKUP_DB_LOCAL_TARGET_UNCONFIRMED');
      await admin.query(`CREATE DATABASE ${quoteIdentifier(restoredDatabase)} TEMPLATE template0 ENCODING 'UTF8'`);
    } finally { await admin.end().catch(() => {}); }
    // PostgreSQL 18 dumps omit the built-in public namespace when it has no
    // separate schema entry. Keep template0's empty public namespace so the
    // archive can recreate its functions and tables there.
    await runTool(bin, 'pg_restore', restoreArguments(output, socket), localPgEnvironment(socket, restoredDatabase), path.join(root, 'restore.private.log'));
    const restored = new pg.Client({ host: socket, port: Number(restorePort), user: role, database: restoredDatabase, ssl: false, connectionTimeoutMillis: 10_000 }); restored.on('error', () => {});
    let actual: DatabaseProof;
    try { await restored.connect(); await restored.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); actual = await collectDatabaseProof(restored); }
    finally { await restored.query('ROLLBACK').catch(() => {}); await restored.end().catch(() => {}); }
    await privateJson(path.join(root, 'restored-proof.private.json'), actual);
    const tableEqual = JSON.stringify(actual.tables) === JSON.stringify(expected.tables);
    const sequenceEqual = JSON.stringify(actual.sequences) === JSON.stringify(expected.sequences);
    const schemaEqual = JSON.stringify(actual.structuralCatalog) === JSON.stringify(expected.structuralCatalog);
    const reportFile = path.join(root, 'restore-report.private.json');
    const localUrl = new URL(`postgresql://${role}@localhost:${restorePort}/${restoredDatabase}`);
    localUrl.searchParams.set('host', socket); localUrl.searchParams.set('sslmode', 'disable');
    const report = { format: 1, runId, completedAt: new Date().toISOString(), archiveSha256: metadata.sha256, productionWrites: false, socketOnly: true,
      adaptation: { localOwner: role, ownerStatementsSkipped: true, aclStatementsSkipped: true, fullArchiveAclRetained: true },
      tables: actual.tables.length, rows: actual.tables.reduce((sum, table) => sum + table.rows, 0), tableHashesMatch: tableEqual, sequenceStateMatches: sequenceEqual, structuralCatalogMatches: schemaEqual,
      localSecurityCatalogSha256: createHash('sha256').update(JSON.stringify(actual.securityCatalog)).digest('hex'),
      sourceSecurityCatalogSha256: createHash('sha256').update(JSON.stringify(expected.securityCatalog)).digest('hex'),
      securityMetadataComparison: 'Owner/ACL adaptation is explicit. RLS, policy expressions, triggers, securityDefiner and constraint validated flags are compared in structuralCatalog.',
      verificationPassed: tableEqual && sequenceEqual && schemaEqual,
      keepLocalCluster: Boolean(options.keepLocalCluster),
      localCluster: { dataDirectory: data, socketDirectory: socket, database: restoredDatabase, user: role, port: restorePort, connectionString: localUrl.toString(), pgBin: bin },
      stop: { executable: path.join(bin, 'pg_ctl'), arguments: ['-D', data, '-m', 'fast', '-w', '-t', '60', 'stop'] },
      cleanup: { executable: process.execPath, arguments: ['--import', 'tsx', fileURLToPath(import.meta.url), '--mode=cleanup-restore', `--output=${output}`, `--restore-report=${reportFile}`] } };
    await privateJson(reportFile, report);
    if (!report.verificationPassed) throw new Error('BACKUP_DB_RESTORE_PROOF_MISMATCH');
    preserveClone = Boolean(options.keepLocalCluster);
    // The local URL is retained only in the private report, never in the CLI output.
    return { reportFile, restoredProofFile: path.join(root, 'restored-proof.private.json'), archiveSha256: metadata.sha256,
      tables: report.tables, rows: report.rows, verificationPassed: report.verificationPassed, socketOnly: true, keptRunning: preserveClone };
  } finally {
    if (!preserveClone) {
      if (startAttempted) {
        try { await runTool(bin, 'pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '60', 'stop'], baseEnvironment(), path.join(root, 'stop.private.log')); }
        catch { if (await lstat(path.join(data, 'postmaster.pid')).catch(() => null)) throw new Error('BACKUP_DB_LOCAL_STOP_UNCONFIRMED'); }
      }
      // Only this process's newly generated private data and socket directories are removed.
      await rm(data, { recursive: true, force: true }); await rm(socket, { recursive: true, force: true });
    }
  }
}

export async function cleanupRestoreClone(options: { output: string; reportFile: string }) {
  const output = await privateParent(options.output), reportFile = await privateParent(options.reportFile);
  const root = path.dirname(reportFile);
  if (path.dirname(root) !== path.dirname(output) || !path.basename(root).startsWith('restore-check-')) throw new Error('BACKUP_DB_INVALID_LOCAL_CLEANUP_SCOPE');
  const report = JSON.parse(await readFile(reportFile, 'utf8'));
  const scope = JSON.parse(await readFile(path.join(root, 'scope.private.json'), 'utf8'));
  if (!report.verificationPassed || !report.keepLocalCluster || !report.socketOnly || report.runId !== scope.runId
    || report.localCluster?.dataDirectory !== path.join(root, 'data') || report.localCluster.dataDirectory !== scope.dataDirectory
    || report.localCluster.socketDirectory !== scope.socketDirectory || !scope.socketOnly) throw new Error('BACKUP_DB_INVALID_LOCAL_CLEANUP_SCOPE');
  localPgEnvironment(scope.socketDirectory, restoredDatabase);
  const dataInfo = await lstat(scope.dataDirectory);
  if (!dataInfo.isDirectory() || dataInfo.isSymbolicLink() || dataInfo.uid !== process.getuid?.() || (dataInfo.mode & 0o077) !== 0) throw new Error('BACKUP_DB_INVALID_LOCAL_CLEANUP_SCOPE');
  if (await lstat(path.join(scope.dataDirectory, 'postmaster.pid')).catch(() => null)) {
    await runTool(defaultBin, 'pg_ctl', ['-D', scope.dataDirectory, '-m', 'fast', '-w', '-t', '60', 'stop'], baseEnvironment(), path.join(root, 'cleanup-stop.private.log'));
  }
  await rm(scope.dataDirectory, { recursive: true }); await rm(scope.socketDirectory, { recursive: true, force: true });
  await privateJson(path.join(root, 'cleanup.private.json'), { runId: scope.runId, cleanedAt: new Date().toISOString(), sourceDumpPreserved: true, productionWrites: false });
  return { cleaned: true, reportFile, sourceDumpPreserved: true, productionWrites: false };
}

async function main() {
  const options = Object.fromEntries(process.argv.slice(2).map(argument => { const at = argument.indexOf('='); if (!argument.startsWith('--') || at < 0) throw new Error('BACKUP_DB_NAMED_ARGUMENTS_REQUIRED'); return [argument.slice(2, at), argument.slice(at + 1)]; }));
  const allowed = new Set(['mode', 'env', 'snapshot', 'output', 'proof', 'metadata', 'pg-bin', 'keep-local-cluster', 'restore-report']);
  if (Object.keys(options).some(key => !allowed.has(key))) throw new Error('BACKUP_DB_UNKNOWN_OPTION');
  if (!options.output) throw new Error('BACKUP_DB_OUTPUT_REQUIRED');
  const mode = options.mode ?? 'plan';
  if (mode === 'plan') { console.log(JSON.stringify({ mode, pgBin: options['pg-bin'] ?? defaultBin, output: options.output, dumpRequiresLiveExportedSnapshot: true, restoreTarget: 'new private local Unix socket only', productionWrites: false })); return; }
  if (mode === 'dump') { if (!options.snapshot || !options.env) throw new Error('BACKUP_DB_DUMP_SCOPE_REQUIRED'); console.log(JSON.stringify(await dumpDatabase({ envFile: options.env, snapshot: options.snapshot, output: options.output, pgBin: options['pg-bin'] }))); return; }
  if (mode === 'restore-test') {
    if (!options.proof) throw new Error('BACKUP_DB_SOURCE_PROOF_REQUIRED');
    if (options['keep-local-cluster'] && !['true', 'false'].includes(options['keep-local-cluster'])) throw new Error('BACKUP_DB_INVALID_KEEP_OPTION');
    console.log(JSON.stringify(await restoreDatabaseTest({ output: options.output, proofFile: options.proof, metadataFile: options.metadata, pgBin: options['pg-bin'], keepLocalCluster: options['keep-local-cluster'] === 'true' }))); return;
  }
  if (mode === 'cleanup-restore') { if (!options['restore-report']) throw new Error('BACKUP_DB_RESTORE_REPORT_REQUIRED'); console.log(JSON.stringify(await cleanupRestoreClone({ output: options.output, reportFile: options['restore-report'] }))); return; }
  throw new Error('BACKUP_DB_UNKNOWN_MODE');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { console.error(JSON.stringify({ errorClass: error?.constructor?.name ?? 'Error', code: /^BACKUP_DB_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'BACKUP_DB_OPERATION_FAILED', sqlState: typeof error?.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : undefined })); process.exitCode = 1; });
}
