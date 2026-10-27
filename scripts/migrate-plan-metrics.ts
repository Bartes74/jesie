import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { Pool } from 'pg';

async function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes('--verify-only');
  const files = args.filter(argument => argument !== '--verify-only');
  if (files.length > 1 || files.some(argument => argument.startsWith('--'))) throw new Error('INVALID_ARGUMENTS');
  // Read only the explicitly selected environment file; inherited DSNs cannot redirect this runner.
  const env = parse(await readFile(files[0] || '.env.local', 'utf8'));
  const connection = env.DATABASE_URL_UNPOOLED || env.POSTGRES_URL_NON_POOLING || env.DATABASE_URL;
  if (!connection || new URL(connection).hostname.includes('-pooler.')) throw new Error('DIRECT_DATABASE_REQUIRED');
  const name = '0025-plan-metrics';
  const migration = await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8');
  const hash = createHash('sha256').update(migration).digest('hex');
  const pool = new Pool({ connectionString: connection, max: 1, connectionTimeoutMillis: 10000, query_timeout: 70000 });
  try {
    const client = await pool.connect();
    try {
      await client.query(verifyOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '60s'");
      if (!verifyOnly) await client.query("SELECT pg_advisory_xact_lock(hashtext('jesie-editorial-migrations'))");
      const previous = await client.query("SELECT hash FROM editorial_migration WHERE name='0024-kitchen-experience'");
      const previousHash = createHash('sha256').update(await readFile(new URL('../migrations/0024-kitchen-experience.sql', import.meta.url), 'utf8')).digest('hex');
      if (previous.rows[0]?.hash !== previousHash) throw new Error('MIGRATION_0024_REQUIRED');
      const existing = await client.query('SELECT hash FROM editorial_migration WHERE name=$1', [name]);
      if (existing.rowCount) {
        if (existing.rows[0].hash !== hash) throw new Error('APPLIED_MIGRATION_CHANGED');
      } else {
        if (verifyOnly) throw new Error('MIGRATION_NOT_APPLIED');
        await client.query(migration);
        await client.query('INSERT INTO editorial_migration(name,hash) VALUES($1,$2)', [name, hash]);
      }
      const constraints = await client.query("SELECT conname,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='seo_usage_daily'::regclass AND conname IN ('seo_usage_daily_path_check','seo_usage_daily_check')");
      if (constraints.rowCount !== 2 || constraints.rows.some(row => !row.convalidated || !row.definition.includes('plan'))) throw new Error('PLAN_METRICS_CONSTRAINTS_REQUIRED');
      await client.query('COMMIT');
      console.log(JSON.stringify({ migration: name, hash, status: verifyOnly ? 'verified' : existing.rowCount ? 'already_current' : 'applied' }));
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } finally { await pool.end(); }
}

main().catch(() => { console.error('Plan metrics migration failed. No credentials were logged.'); process.exitCode = 1; });
