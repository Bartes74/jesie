import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { Client } from 'pg';
import { productionPgEnvironment } from './backup-db';
import { collectDatabaseProof } from '../src/server/media-backup/database-proof';
import { snapshotSchemaFingerprint } from '../src/server/media-backup/snapshot';

async function main() {
  config({path:process.argv[2]||'.env.production.local',override:true,quiet:true});
  const url=new URL(process.env.DATABASE_URL!);url.hostname=url.hostname.replace('-pooler.','.');
  for(const key of ['sslmode','sslcert','sslkey','sslrootcert','uselibpqcompat'])url.searchParams.delete(key);
  const client=new Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true},connectionTimeoutMillis:15_000});
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot=(await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const serverMajor=Number((await client.query('SHOW server_version_num')).rows[0].server_version_num.slice(0,-4));
    const proof=await collectDatabaseProof(client);
    const root=resolve('src/server/media-backup/schema');await mkdir(root,{recursive:true});
    for(const section of ['pre-data','post-data']) {
      await new Promise<void>((done,reject)=>{
        const child=spawn('/opt/homebrew/Cellar/postgresql@18/18.6_1/bin/pg_dump',[
          '--schema-only',`--section=${section}`,'--no-owner','--no-acl','--no-password','--lock-wait-timeout=30s',`--snapshot=${snapshot}`,`--file=${root}/${section}.sql`,
        ],{env:productionPgEnvironment(process.env.DATABASE_URL!),stdio:['ignore','ignore','pipe']});
        child.stderr.resume();child.on('error',()=>reject(new Error('BACKUP_SCHEMA_DUMP_UNAVAILABLE')));
        child.on('close',code=>code===0?done():reject(new Error('BACKUP_SCHEMA_DUMP_FAILED')));
      });
    }
    const hash=async(name:string)=>createHash('sha256').update(await readFile(`${root}/${name}`)).digest('hex');
    const manifest={format:1,serverMajor,preDataSha256:await hash('pre-data.sql'),postDataSha256:await hash('post-data.sql'),schemaFingerprint:snapshotSchemaFingerprint(proof)};
    await writeFile(`${root}/manifest.json`,JSON.stringify(manifest,null,2)+'\n');
    console.log(JSON.stringify({ok:true,tableCount:proof.tables.length,...manifest}));
  }finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
}
main().catch(()=>{console.error('BACKUP_SCHEMA_GENERATION_FAILED');process.exitCode=1;});
