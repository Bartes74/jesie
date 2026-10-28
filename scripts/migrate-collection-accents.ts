import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { Pool } from 'pg';

async function main() {
  config({ path: process.argv[2] || '.env.local', quiet: true, override: true });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_NOT_CONFIGURED');
  const connection = new URL(process.env.DATABASE_URL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname);
  if (!local) for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) connection.searchParams.delete(key);
  const pool = new Pool({ connectionString: connection.toString(), ...(local ? {} : { ssl: { rejectUnauthorized: true } }), max: 1, connectionTimeoutMillis: 10_000 });
  const client = await pool.connect();
  try {
    const name = '0032-collection-accents', source = await readFile(`migrations/${name}.sql`, 'utf8');
    const hash = createHash('sha256').update(source).digest('hex');
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('jesie-editorial-migrations'))");
    const existing = await client.query('SELECT hash FROM editorial_migration WHERE name=$1', [name]);
    if (existing.rowCount) {
      if (existing.rows[0].hash !== hash) throw new Error('APPLIED_MIGRATION_CHANGED');
    } else {
      await client.query(source);
      await client.query('INSERT INTO editorial_migration(name,hash) VALUES($1,$2)', [name, hash]);
    }
    await client.query('COMMIT'); console.log('Collection accent schema is current.');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await pool.end(); }
}
main().catch(() => { console.error('Collection accent migration failed. No credentials were logged.'); process.exitCode = 1; });
