import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { config } from 'dotenv';
import type { EditorialContent } from '@/lib/editorial-types';
import { recipes } from '@/lib/recipes';
import { closeDb } from '@/server/db';
import { contentHash, emptyChecks } from '@/server/editorial/store';
import { dispatchDiscoveryWorkflows } from './dispatch';
import { getDiscoveryStatus, processDiscoveryOutbox, queuePublishedDiscoveryBackfill, attachDiscoveryWorkflow, getDiscoveryDeliveryState, reserveDiscoveryWorkflow } from './discovery';

// All writes live in a disposable development schema, all HTTP/media are offline stubs.
const schema=`seo_test_${randomUUID().replaceAll('-','')}`;
let adminPool:Pool;
let isolatedPool:Pool;
let originalFetch:typeof fetch;
let originalKey:string|undefined;

before(async()=>{
  if(process.env.NODE_ENV==='production'||process.env.VERCEL_ENV==='production') throw new Error('Tests require development.');
  config({path:'.env.local',quiet:true});
  const connection=process.env.EDITORIAL_TEST_DATABASE_URL||process.env.DATABASE_URL_UNPOOLED||process.env.POSTGRES_URL_NON_POOLING;
  if(!connection) throw new Error('An isolated development Postgres connection is required.');
  adminPool=new Pool({connectionString:connection,max:1,connectionTimeoutMillis:20_000,query_timeout:30_000});
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const url=new URL(connection); url.searchParams.set('options',`-c search_path=${schema}`);
  process.env.DATABASE_URL=url.toString();
  isolatedPool=new Pool({connectionString:url.toString(),max:2,connectionTimeoutMillis:20_000,query_timeout:30_000});
  await isolatedPool.query(`CREATE TABLE auth_user(id text PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT false,image text,role text NOT NULL DEFAULT 'admin',disabled boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
  for(const name of ['0001-editorial','0002-ai','0003-trends','0004-trend-research','0005-trend-manual-runs','0006-ingredient-reuse','0007-local-photo-corrections','0008-ai-photo-batches','0009-ai-budget-settings','0010-daily-publication','0011-seo-discovery','0014-seo-workflows', '0015-recipe-trash']) await isolatedPool.query(await readFile(`migrations/${name}.sql`,'utf8'));
  originalKey=process.env.INDEXNOW_KEY; process.env.INDEXNOW_KEY='offline-test-key-123';
  originalFetch=globalThis.fetch; globalThis.fetch=async()=>{throw new Error('Tests must not call real HTTP providers.');};
});
after(async()=>{
  if(originalFetch) globalThis.fetch=originalFetch;
  if(originalKey===undefined) delete process.env.INDEXNOW_KEY; else process.env.INDEXNOW_KEY=originalKey;
  await closeDb(); if(isolatedPool) await isolatedPool.end();
  if(adminPool){await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await adminPool.end();}
});
beforeEach(async()=>{await isolatedPool.query('TRUNCATE editorial_recipe CASCADE');process.env.INDEXNOW_KEY='offline-test-key-123';});

async function fixture(published=true, slugs=true){
  const id=randomUUID(),publicationId=randomUUID(),eventId=randomUUID();
  const recipe=structuredClone(recipes[0]);recipe.id=id;recipe.slug={pl:`current-${id}`,en:`current-${id}`};
  const content:EditorialContent={recipe,originalText:'Private source',author:'Private editor',sources:[],photos:{ingredients:{},steps:{}}};
  const hash=contentHash(content);
  await isolatedPool.query(`INSERT INTO editorial_recipe(id,content,content_hash,checks,created_by,updated_by,updated_by_name) VALUES($1,$2,$3,$4,'offline','offline','Offline')`,[id,content,hash,emptyChecks()]);
  if(slugs){
    await isolatedPool.query(`INSERT INTO editorial_publication(id,recipe_id,revision,snapshot,content_hash,checks,approval_origin,published_by,published_by_name) VALUES($1,$2,1,$3,$4,$5,'manual','offline','Offline')`,[publicationId,id,content,hash,emptyChecks()]);
    await isolatedPool.query(`UPDATE editorial_recipe SET published_id=$2,published_revision=1,publication_status=$3 WHERE id=$1`,[id,publicationId,published?'published':'unpublished']);
    for(const [locale,slug] of [['pl',`old-${id}`],['pl',recipe.slug.pl],['en',recipe.slug.en]]) await isolatedPool.query('INSERT INTO editorial_slug(locale,slug,recipe_id) VALUES($1,$2,$3)',[locale,slug,id]);
  }
  await isolatedPool.query(`INSERT INTO editorial_outbox(id,recipe_id,revision,event) VALUES($1,$2,2,$3)`,[eventId,id,published?'publish':'unpublish']);
  return {id,eventId,recipe};
}
function harness(status=200){
  const requests:Array<{url:string;body:{urlList:string[]}}>=[];
  const invalidations:string[]=[];let prepared=0;
  return {requests,invalidations,prepared:()=>prepared,dependencies:{production:()=>true,
    revalidate:(path:string)=>{invalidations.push(path);},prepareMedia:async()=>{prepared++;},
    request:(async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{requests.push({url:String(url),body:JSON.parse(String(init?.body))});return new Response(null,{status,headers:status===429?{'retry-after':'600'}:{}});}) as typeof fetch}};
}
async function outbox(eventId:string){return(await isolatedPool.query('SELECT * FROM editorial_outbox WHERE id=$1',[eventId])).rows[0];}

test('preview does not consume publication events or call IndexNow',async()=>{
  const item=await fixture();const offline=harness();
  const result=await processDiscoveryOutbox({dependencies:{...offline.dependencies,production:()=>false}});
  assert.deepEqual(result,{enabled:false,claimed:0,completed:0,retries:0});
  assert.equal((await outbox(item.eventId)).attempts,0);assert.equal(offline.requests.length,0);
});

test('concurrent deliveries lease one event and a completed replay performs no HTTP',async()=>{
  const item=await fixture();const offline=harness();
  const results=await Promise.all([processDiscoveryOutbox({limit:1,dependencies:offline.dependencies}),processDiscoveryOutbox({limit:1,dependencies:offline.dependencies})]);
  assert.equal(results.reduce((sum,result)=>sum+result.claimed,0),1);assert.equal(offline.requests.length,1);assert.equal(offline.prepared(),1);
  assert.equal((await outbox(item.eventId)).status,'completed');assert((await outbox(item.eventId)).processed_at);
  assert(offline.requests[0].body.urlList.includes(`https://www.jesie.pl/pl/recipes/old-${item.id}`));
  assert(offline.invalidations.includes('/sitemap.xml'));assert(offline.invalidations.includes('/pl/feed.xml'));
  await processDiscoveryOutbox({dependencies:offline.dependencies});assert.equal(offline.requests.length,1);
});

test('throttling records retry then a later 202 completes without repeating cache invalidation',async()=>{
  const item=await fixture();const throttled=harness(429);
  const first=await processDiscoveryOutbox({dependencies:throttled.dependencies});assert.equal(first.retries,1);
  const failed=await outbox(item.eventId);assert.equal(failed.status,'retry');assert.equal(failed.last_error,'INDEXNOW_HTTP_429');assert.equal(failed.attempts,1);assert(failed.cache_processed_at);
  assert(failed.next_attempt_at.getTime()>Date.now()+9*60_000);
  assert.equal((await processDiscoveryOutbox({dependencies:throttled.dependencies})).claimed,0);
  await isolatedPool.query(`UPDATE editorial_outbox SET next_attempt_at=now()-interval '1 second' WHERE id=$1`,[item.eventId]);
  const accepted=harness(202);assert.equal((await processDiscoveryOutbox({dependencies:accepted.dependencies})).completed,1);
  assert.equal(accepted.invalidations.length,0);assert.equal((await outbox(item.eventId)).indexnow_status,202);assert.equal((await outbox(item.eventId)).attempts,2);
});

test('withdrawal submits historical public addresses and never prepares private media',async()=>{
  const item=await fixture(false);const offline=harness();
  await processDiscoveryOutbox({dependencies:offline.dependencies});assert.equal(offline.prepared(),0);
  const urls=offline.requests[0].body.urlList;
  assert(urls.includes(`https://www.jesie.pl/pl/recipes/old-${item.id}`));assert(urls.includes(`https://www.jesie.pl/pl/recipes/current-${item.id}`));
});

test('expired processing leases are recovered while fresh leases remain exclusive',async()=>{
  const item=await fixture();const offline=harness();
  await isolatedPool.query(`UPDATE editorial_outbox SET status='processing',lease_token='lost-worker',lease_expires_at=now()+interval '5 minutes',attempts=1 WHERE id=$1`,[item.eventId]);
  assert.equal((await processDiscoveryOutbox({dependencies:offline.dependencies})).claimed,0);
  await isolatedPool.query(`UPDATE editorial_outbox SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,[item.eventId]);
  assert.equal((await processDiscoveryOutbox({dependencies:offline.dependencies})).completed,1);
  assert.equal((await outbox(item.eventId)).attempts,2);assert.equal((await outbox(item.eventId)).lease_token,null);
});

test('missing configuration leaves a durable retry and diagnostics expose no key or private notes',async()=>{
  const item=await fixture();delete process.env.INDEXNOW_KEY;const offline=harness();
  assert.equal((await processDiscoveryOutbox({dependencies:offline.dependencies})).retries,1);assert.equal(offline.requests.length,0);
  assert.equal((await outbox(item.eventId)).last_error,'INDEXNOW_NOT_CONFIGURED');
  const status=await getDiscoveryStatus();assert.equal(status.indexNowConfigured,false);assert.equal(status.counts.retries,1);
  assert.equal(JSON.stringify(status).includes('Private source'),false);assert.equal(JSON.stringify(status).includes('Private editor'),false);
});

test('archiving a never-published draft needs no notification or IndexNow key',async()=>{
  const item=await fixture(false,false);delete process.env.INDEXNOW_KEY;const offline=harness();
  assert.equal((await processDiscoveryOutbox({dependencies:offline.dependencies})).completed,1);assert.equal(offline.requests.length,0);
  assert.equal((await outbox(item.eventId)).status,'completed');
});


test('per-event dispatch is fenced across concurrent starts and duplicate delivery generations',async()=>{
  const item=await fixture();let starts=0;let leaseToken='';
  const dependencies={production:()=>true,start:async(lease:{eventId:string;generation:number;token:string})=>{starts++;leaseToken=lease.token;return {runId:'offline-worker'};},state:async()=> 'running',cancel:async()=>{throw new Error('Winning worker must not be cancelled.');}};
  const results=await Promise.all([dispatchDiscoveryWorkflows({eventId:item.eventId,dependencies}),dispatchDiscoveryWorkflows({eventId:item.eventId,dependencies})]);
  assert.equal(starts,1);assert.equal(results.reduce((sum,result)=>sum+result.started,0),1);
  assert.equal(await attachDiscoveryWorkflow(item.eventId,1,leaseToken,'offline-worker'),true);
  assert.equal(await attachDiscoveryWorkflow(item.eventId,1,leaseToken,'duplicate-worker'),false);
  assert.equal((await getDiscoveryDeliveryState(item.eventId,1,'duplicate-worker')).status,'superseded');
  const offline=harness();
  assert.equal((await processDiscoveryOutbox({eventId:item.eventId,workflow:{id:'duplicate-worker',generation:1},dependencies:offline.dependencies})).claimed,0);
  assert.equal((await processDiscoveryOutbox({eventId:item.eventId,workflow:{id:'offline-worker',generation:1},dependencies:offline.dependencies})).completed,1);
  assert.equal(offline.requests.length,1);
});

test('failed workers are recovered and obsolete generations can no longer claim delivery',async()=>{
  const item=await fixture();const first=await reserveDiscoveryWorkflow(item.eventId);assert(first);
  assert.equal(await attachDiscoveryWorkflow(item.eventId,first.generation,first.token,'failed-worker'),true);
  const result=await dispatchDiscoveryWorkflows({eventId:item.eventId,dependencies:{production:()=>true,state:async()=> 'failed',start:async()=>({runId:'replacement-worker'})}});
  assert.equal(result.started,1);
  assert.equal((await getDiscoveryDeliveryState(item.eventId,first.generation,'failed-worker')).status,'superseded');
  const row=await outbox(item.eventId);assert.equal(row.discovery_generation,2);assert.equal(row.discovery_workflow_id,'replacement-worker');
});

test('an ambiguous startup response retains its lease and the accepted worker can attach itself',async()=>{
  const item=await fixture();let captured:{eventId:string;generation:number;token:string}|undefined;
  const options={eventId:item.eventId,dependencies:{production:()=>true,start:async(lease:{eventId:string;generation:number;token:string})=>{captured=lease;throw new Error('Lost SDK response.');}}};
  assert.equal((await dispatchDiscoveryWorkflows(options)).failed,1);
  assert.equal((await dispatchDiscoveryWorkflows(options)).locked,1);assert(captured);
  assert.equal(await attachDiscoveryWorkflow(captured.eventId,captured.generation,captured.token,'accepted-worker'),true);
  assert.equal((await getDiscoveryDeliveryState(item.eventId,captured.generation,'accepted-worker')).status,'pending');
});

test('no pending events and preview dispatch cause no workflow SDK calls',async()=>{
  let starts=0;const dependencies={production:()=>true,start:async()=>{starts++;return {runId:'unused'};}};
  assert.equal((await dispatchDiscoveryWorkflows({dependencies})).started,0);await fixture();
  assert.equal((await dispatchDiscoveryWorkflows({dependencies:{...dependencies,production:()=>false}})).enabled,false);assert.equal(starts,0);
});


test('a bounded recovery batch prioritizes new events over older active retry workers',async()=>{
  const old=await fixture();const first=await reserveDiscoveryWorkflow(old.eventId);assert(first);
  await attachDiscoveryWorkflow(old.eventId,first.generation,first.token,'old-active-worker');
  const fresh=await fixture();let selected='';let stateReads=0;
  const result=await dispatchDiscoveryWorkflows({limit:1,dependencies:{production:()=>true,state:async()=>{stateReads++;return 'running';},start:async lease=>{selected=lease.eventId;return {runId:'fresh-worker'};}}});
  assert.equal(result.started,1);assert.equal(selected,fresh.eventId);assert.equal(stateReads,0);
});


test('an initial backfill is idempotent, public-only and never changes snapshot history or dates',async()=>{
  const live=await fixture();await fixture(false);
  const before=(await isolatedPool.query('SELECT * FROM editorial_publication ORDER BY id')).rows;
  const first=await queuePublishedDiscoveryBackfill(true);assert.equal(first.queued,1);assert.equal(first.total,1);
  assert.equal((await queuePublishedDiscoveryBackfill(true)).queued,0);
  assert.equal((await queuePublishedDiscoveryBackfill(false)).enabled,false);
  assert.deepEqual((await isolatedPool.query('SELECT * FROM editorial_publication ORDER BY id')).rows,before);
  const queued=(await isolatedPool.query("SELECT * FROM editorial_outbox WHERE event='seo_backfill'")).rows;
  assert.equal(queued.length,1);assert.equal(queued[0].recipe_id,live.id);
});

test('a bounded batch also prioritizes a fresh event over unresolved older startup leases',async()=>{
  const uncertain=await fixture();await reserveDiscoveryWorkflow(uncertain.eventId);
  const fresh=await fixture();let selected='';
  assert.equal((await dispatchDiscoveryWorkflows({limit:1,dependencies:{production:()=>true,start:async lease=>{selected=lease.eventId;return {runId:'fresh-after-unknown'};}}})).started,1);
  assert.equal(selected,fresh.eventId);
});
