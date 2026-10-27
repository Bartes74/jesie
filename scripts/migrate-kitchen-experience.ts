import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { Pool } from 'pg';

async function main() {
  config({ path: process.argv[2] || '.env.local', quiet: true });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_NOT_CONFIGURED');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });
  const client = await pool.connect();
  try {
    const name = '0024-kitchen-experience';
    const migration = await readFile(new URL('../migrations/0024-kitchen-experience.sql', import.meta.url), 'utf8');
    const hash = createHash('sha256').update(migration).digest('hex');
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('jesie-editorial-migrations'))");
    await client.query('CREATE TABLE IF NOT EXISTS editorial_migration (name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const existing = await client.query('SELECT hash FROM editorial_migration WHERE name=$1', [name]);
    if (existing.rowCount) {
      if (existing.rows[0].hash !== hash) throw new Error('APPLIED_MIGRATION_CHANGED');
      console.log('Kitchen experience schema is already current.');
    } else {
      await client.query(migration);
      await client.query('INSERT INTO editorial_migration(name,hash) VALUES($1,$2)', [name, hash]);
      console.log('Kitchen experience migration applied.');
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await pool.end(); }
}
main().catch(() => { console.error('Kitchen experience migration failed. No credentials were logged.'); process.exitCode = 1; });
