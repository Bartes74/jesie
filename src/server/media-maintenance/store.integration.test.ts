import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { reserveMaintenanceRun,claimMaintenanceRun,advanceMaintenance } from './store';

const schema=`media_maintenance_test_${randomUUID().replaceAll('-','')}`;
let admin:Pool,pool:Pool;
before(async()=>{
  if(process.env.NODE_ENV==='production')throw new Error('An isolated development schema is required');
  config({path:'.env.local',quiet:true});
  const connection=process.env.EDITORIAL_TEST_DATABASE_URL||process.env.DATABASE_URL_UNPOOLED||process.env.POSTGRES_URL_NON_POOLING;
  if(!connection)throw new Error('A development test connection is required');
  admin=new Pool({connectionString:connection,max:1});await admin.query(`CREATE SCHEMA "${schema}"`);
  const url=new URL(connection);url.searchParams.set('options',`-c search_path=${schema}`);
  pool=new Pool({connectionString:url.toString(),max:4});
  await pool.query('CREATE TABLE ai_asset(id text PRIMARY KEY)');
  await pool.query(await readFile('migrations/0022-media-maintenance.sql','utf8'));
  await pool.query(await readFile('migrations/0023-media-backup-proof-guards.sql','utf8'));
});
after(async()=>{if(pool)await pool.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}});
test('concurrent cron dispatch reserves one generation; workflow duplicates have one owner',async()=>{
  const day=new Date('2026-10-17T00:00:00Z');
  const reservations=await Promise.all(Array.from({length:6},()=>reserveMaintenanceRun(day,pool)));
  const claimed=reservations.filter(Boolean);assert.equal(claimed.length,1);
  const run=claimed[0]!;
  const owners=await Promise.all(['worker-a','worker-b'].map(worker=>claimMaintenanceRun(run.id,run.generation,worker,pool)));
  assert.equal(owners.filter(Boolean).length,1);
  assert.equal(await reserveMaintenanceRun(day,pool),null);
});
test('expired dispatch recovers cursor and generation fences a late worker',async()=>{
  const row=(await pool.query('SELECT * FROM media_maintenance_run')).rows[0];
  await advanceMaintenance(row.id,row.generation,{phase:'media',media_cursor:'captured-cursor'},pool);
  await pool.query("UPDATE media_maintenance_run SET heartbeat_at=clock_timestamp()-interval '21 minutes'");
  const next=await reserveMaintenanceRun(new Date('2026-10-17T12:00:00Z'),pool);assert(next);
  assert.equal(next.generation,row.generation+1);assert.equal(next.media_cursor,'captured-cursor');
  await assert.rejects(advanceMaintenance(row.id,row.generation,{phase:'complete'},pool),{code:'MEDIA_MAINTENANCE_FENCED'});
  await advanceMaintenance(next.id,next.generation,{phase:'bundle'},pool);
});
test('a failing old checkpoint cannot suppress the next daily backup',async()=>{
  await pool.query("UPDATE media_maintenance_run SET status='retry',next_retry_at=clock_timestamp()+interval '1 day'");
  const next=await reserveMaintenanceRun(new Date('2026-10-18T00:00:00Z'),pool);assert(next);
  assert.equal(next.day,'2026-10-18');assert.equal(next.phase,'warm');
});
test('database refuses a complete receipt without an actual verified restore',async()=>{
  await assert.rejects(pool.query("UPDATE media_maintenance_run SET status='complete',completed_at=clock_timestamp(),manifest_receipt='{}'::jsonb,restore_receipt='{\"verified\":false}'::jsonb"));
  await assert.rejects(pool.query("UPDATE media_maintenance_run SET status='complete',completed_at=clock_timestamp(),manifest_receipt='{}'::jsonb,restore_receipt=NULL"));
});
