import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { Pool } from 'pg';

async function main() {
  const args = process.argv.slice(2); const verifyOnly = args.includes('--verify-only');
  const files = args.filter(argument => argument !== '--verify-only');
  if (files.length > 1 || files.some(argument => argument.startsWith('--'))) throw new Error('INVALID_ARGUMENTS');
  const env = parse(await readFile(files[0] || '.env.local', 'utf8'));
  const connection = env.DATABASE_URL_UNPOOLED || env.POSTGRES_URL_NON_POOLING;
  if (!connection || new URL(connection).hostname.includes('-pooler.')) throw new Error('DIRECT_DATABASE_REQUIRED');
  if (env.DATABASE_URL) {
    const pooled = new URL(env.DATABASE_URL), direct = new URL(connection);
    if (pooled.hostname.replace('-pooler.', '.') !== direct.hostname || pooled.pathname !== direct.pathname || pooled.username !== direct.username) throw new Error('TARGET_MISMATCH');
  }
  const name = '0026-remove-spending-limits';
  const migration = await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8');
  const hash = createHash('sha256').update(migration).digest('hex');
  const pool = new Pool({ connectionString: connection, max: 1, connectionTimeoutMillis: 10000, query_timeout: 65000 });
  try {
    const client = await pool.connect();
    try {
      await client.query(verifyOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'"); await client.query("SET LOCAL statement_timeout='60s'");
      if (!verifyOnly) await client.query("SELECT pg_advisory_xact_lock(hashtext('jesie-editorial-migrations'))");
      const prior = '0025-plan-metrics';
      const previous = await client.query('SELECT hash FROM editorial_migration WHERE name=$1', [prior]);
      const expected = createHash('sha256').update(await readFile(new URL(`../migrations/${prior}.sql`, import.meta.url))).digest('hex');
      if (previous.rows[0]?.hash !== expected) throw new Error('MIGRATION_0025_REQUIRED');
      const existing = await client.query('SELECT hash FROM editorial_migration WHERE name=$1', [name]);
      if (existing.rowCount) { if (existing.rows[0].hash !== hash) throw new Error('APPLIED_MIGRATION_CHANGED'); }
      else {
        if (verifyOnly) throw new Error('MIGRATION_NOT_APPLIED');
        const duplicates = await client.query("SELECT 1 FROM ai_job WHERE ingredient_key IS NOT NULL AND reuse_source_job_id IS NULL AND ingredient_resolved_at IS NULL AND result IS NULL AND status <> 'failed' GROUP BY ingredient_key HAVING count(*)>1 LIMIT 1");
        if (duplicates.rowCount) throw new Error('ACTIVE_INGREDIENT_PRODUCER_DUPLICATES');
        await client.query(migration);
        await client.query('INSERT INTO editorial_migration(name,hash) VALUES($1,$2)', [name, hash]);
      }
      const check = await client.query("SELECT convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='ai_job'::regclass AND conname='ai_job_reserved_usd_check'");
      if (check.rowCount !== 1 || !check.rows[0].convalidated || !/reserved_usd >= \(?0/.test(check.rows[0].definition) || /kind|model|reserved_usd > 0/.test(check.rows[0].definition)) throw new Error('ZERO_RESERVATION_CHECK_REQUIRED');
      const index = await client.query("SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname='ai_ingredient_producer_unique'");
      const definition = index.rows[0]?.indexdef || '';
      if (!definition.includes('UNIQUE') || definition.includes('reserved_usd') || !definition.includes('ingredient_resolved_at IS NULL') || !definition.includes('reuse_source_job_id IS NULL')) throw new Error('PRODUCER_GUARD_REQUIRED');
      await client.query('COMMIT');
      console.log(JSON.stringify({ migration: name, hash, status: verifyOnly ? 'verified' : existing.rowCount ? 'already_current' : 'applied', historicalRowsChanged: false, producerIdentityGuardPreserved: true }));
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } finally { await pool.end(); }
}
main().catch(() => { console.error('Removing spending limits failed. No credentials or private queries were logged.'); process.exitCode = 1; });
