import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { Pool } from 'pg';
async function main(){
  config({path:process.argv[2]||'.env.local',quiet:true});if(!process.env.DATABASE_URL)throw new Error('DATABASE_NOT_CONFIGURED');
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:10_000});const client=await pool.connect();
  try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('jesie-editorial-migrations'))");
    const name='0006-ingredient-reuse';const source=await readFile(`migrations/${name}.sql`,'utf8');const hash=createHash('sha256').update(source).digest('hex');
    const prior=await client.query('SELECT hash FROM editorial_migration WHERE name=$1',[name]);
    if(prior.rowCount){if(prior.rows[0].hash!==hash)throw new Error('APPLIED_MIGRATION_CHANGED');}
    else{await client.query(source);await client.query('INSERT INTO editorial_migration(name,hash) VALUES($1,$2)',[name,hash]);}
    await client.query('COMMIT');console.log('Ingredient reuse schema is current.');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}
}
main().catch(()=>{console.error('Ingredient reuse migration failed. No credentials were logged.');process.exitCode=1;});
