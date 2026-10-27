import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import { collectDatabaseProof, directDatabaseUrl, dumpDatabase } from './backup-db';

const option = (name: string) => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
async function main() {
const destination = option('--checkpoint-directory');
if (!destination || !path.isAbsolute(destination) || destination.startsWith(process.cwd() + path.sep)) throw new Error('PRIVATE_ABSOLUTE_CHECKPOINT_REQUIRED');
await mkdir(destination, { recursive: true, mode: 0o700 });
await chmod(destination, 0o700);
const envFile = option('--env') ?? '.env.production.local';
const env = dotenv.parse(await readFile(envFile));
if (!env.DATABASE_URL) throw new Error('DATABASE_CONFIGURATION_REQUIRED');
const client = new pg.Client({ connectionString: directDatabaseUrl(env.DATABASE_URL).href, connectionTimeoutMillis: 20_000, application_name: 'jesie_consistent_backup_readonly' });
client.on('error', () => {});
const save = async (name: string, value: unknown) => writeFile(path.join(destination, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot = (await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
  const startedAt = new Date().toISOString();
  const proof = await collectDatabaseProof(client);
  await save('database-proof.private.json', proof);
  const assets = (await client.query('SELECT id,recipe_id,job_id,kind,target_id,blob_pathname,original_blob_pathname,width,height,content_type FROM ai_asset ORDER BY id')).rows;
  const compaction = (await client.query('SELECT * FROM media_compaction ORDER BY source_pathname')).rows;
  const mapping = new Map<string, string>(compaction.map(row => [row.source_pathname, row.target_pathname]));
  const resolve = (source: string) => {
    let target = source; const seen = new Set<string>();
    while (mapping.has(target)) { if (seen.has(target)) throw new Error('COMPACTION_CYCLE'); seen.add(target); target = mapping.get(target)!; }
    return target;
  };
  const required = new Set<string>();
  for (const asset of assets) for (const key of ['blob_pathname', 'original_blob_pathname']) if (asset[key]) required.add(resolve(String(asset[key])));
  for (const item of compaction) required.add(resolve(item.target_pathname));
  const literalPaths = new Set<string>();
  const referencedAssetIds = new Set<string>();
  const scan = (input: unknown) => {
    if (Array.isArray(input)) { for (const value of input) scan(value); return; }
    if (input && typeof input === 'object') {
      for (const [key, value] of Object.entries(input)) {
        if ((key === 'mediaAssetId' || key === 'assetId') && typeof value === 'string') referencedAssetIds.add(value);
        scan(value);
      }
      return;
    }
    if (typeof input === 'string' && /^(?:ai|seo)\/[A-Za-z0-9_./-]+$/.test(input)) literalPaths.add(input);
  };
  for (const relation of proof.tables.filter(t => /^(ai_|editorial_|ingredient_|trend_)/.test(t.name))) {
    const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    const rows = (await client.query(`SELECT to_jsonb(t) AS item FROM ${identifier(relation.schema)}.${identifier(relation.name)} t`)).rows;
    for (const row of rows) scan(row.item);
  }
  const assetIds = new Set(assets.map(row => row.id));
  const missingAssets = [...referencedAssetIds].filter(id => !assetIds.has(id));
  // Retain historical literal/cache paths separately. Canonical assets and all
  // compaction targets must exist in the full physical Blob export.
  const references = { version: 1, snapshot, startedAt, databaseProofFile: 'database-proof.private.json',
    assets, compaction, requiredBlobPathnames: [...required].sort(), literalPaths: [...literalPaths].sort(),
    referencedAssetIds: [...referencedAssetIds].sort(), missingReferencedAssetIds: missingAssets };
  await save('db-media-references.private.json', references);
  console.log(JSON.stringify({ stage: 'snapshot-captured', tables: proof.tables.length, assets: assets.length, requiredBlobPaths: required.size, historicalLiteralPaths: literalPaths.size, missingReferencedAssets: missingAssets.length }));
  const dump = await dumpDatabase({ envFile, snapshot, output: path.join(destination, 'database.dump.private') });
  await save('snapshot-complete.private.json', { version: 1, startedAt, completedAt: new Date().toISOString(), snapshot, productionWrites: false, dump });
  console.log(JSON.stringify({ stage: 'dump-complete', bytes: dump.bytes, sha256: dump.sha256, tables: proof.tables.length }));
} catch (error) {
  const value = error as { code?: unknown; message?: unknown };
  const code = typeof value.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.code) ? value.code : 'FULL_BACKUP_FAILED';
  console.error(JSON.stringify({ ok: false, code }));
  process.exitCode = 1;
} finally { await client.query('ROLLBACK').catch(() => {}); await client.end().catch(() => {}); }
}
void main().catch(() => { console.error(JSON.stringify({ ok: false, code: 'FULL_BACKUP_PREFLIGHT_FAILED' })); process.exitCode = 1; });
