import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { Pool } from 'pg';

async function main() {
  config({path:process.argv[2]||'.env.local',quiet:true,override:true});
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_NOT_CONFIGURED');
  const connection=new URL(process.env.DATABASE_URL);
  const local=['localhost','127.0.0.1','[::1]'].includes(connection.hostname);
  if (!local) for (const key of ['sslmode','sslcert','sslkey','sslrootcert','uselibpqcompat']) connection.searchParams.delete(key);
  const pool=new Pool({connectionString:connection.toString(),...(local?{}:{ssl:{rejectUnauthorized:true}}),max:1,connectionTimeoutMillis:10_000});
  const client=await pool.connect();
  try {
    const name=process.argv[3]||'0022-media-maintenance';
    if(!['0022-media-maintenance','0023-media-backup-proof-guards'].includes(name))throw new Error('MIGRATION_NAME_INVALID');
    const migration=await readFile(resolve(`migrations/${name}.sql`),'utf8');
    const hash=createHash('sha256').update(migration).digest('hex');
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('jesie-editorial-migrations'))");
    const existing=await client.query('SELECT hash FROM editorial_migration WHERE name=$1',[name]);
    if (existing.rowCount) { if(existing.rows[0].hash!==hash) throw new Error('APPLIED_MIGRATION_CHANGED'); }
    else {
      await client.query(migration);
      await client.query('INSERT INTO editorial_migration(name,hash) VALUES($1,$2)',[name,hash]);
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ok:true,migration:name,hash,alreadyApplied:Boolean(existing.rowCount)}));
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally {client.release();await pool.end();}
}
main().catch(()=>{console.error('Media maintenance migration failed. No credentials were logged.');process.exitCode=1;});
