import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { DiscoveryDeliveryState } from './discovery';

const source=ts.transpileModule(readFileSync(new URL('../../workflows/seo-discovery.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const pending:DiscoveryDeliveryState={status:'pending',serverNow:'2026-10-12T06:00:00.000Z',nextAttemptAt:'2026-10-12T06:15:00.000Z'};
function harness(options:{claim?:boolean;states?:DiscoveryDeliveryState[]}={}){
  let deliveries=0,continuations=0;const sleeps:Date[]=[];
  const imports:Record<string,unknown>={
    workflow:{getWorkflowMetadata:()=>({workflowRunId:'offline-worker'}),sleep:async(date:Date)=>{sleeps.push(date);}},
    '@/server/seo/discovery-steps':{
      claimDiscoveryDelivery:async(event:string,generation:number,token:string,id:string)=>{assert.equal(event,'event-id');assert.equal(generation,1);assert.equal(token,'lease-token');assert.equal(id,'offline-worker');return options.claim??true;},
      deliverDiscoveryEvent:async()=>{const states=options.states??[{...pending,status:'completed'}];return states[Math.min(deliveries++,states.length-1)];},
      continueDiscoveryDelivery:async()=>{continuations++;return {continued:true};},
    },
  };
  const exports:{notifyDiscoveryEvent?:(event:string,generation:number,token:string)=>Promise<unknown>}={};
  runInNewContext(source,{exports,Date,Math,require:(name:string)=>{assert(Object.hasOwn(imports,name));return imports[name];}});
  return {run:()=>exports.notifyDiscoveryEvent!('event-id',1,'lease-token'),sleeps,deliveries:()=>deliveries,continuations:()=>continuations};
}

test('a duplicate worker losing startup claim performs no delivery or sleep',async()=>{
  const worker=harness({claim:false});await worker.run();assert.equal(worker.deliveries(),0);assert.equal(worker.sleeps.length,0);
});
test('a completed event exits immediately without periodic polling',async()=>{
  const worker=harness();await worker.run();assert.equal(worker.deliveries(),1);assert.equal(worker.sleeps.length,0);assert.equal(worker.continuations(),0);
});
test('persisted retry deadlines produce durable sleep until delivery succeeds',async()=>{
  const worker=harness({states:[pending,{...pending,status:'completed'}]});await worker.run();assert.equal(worker.deliveries(),2);assert.equal(worker.sleeps[0].toISOString(),pending.nextAttemptAt);
});
test('a superseded generation stops without notifying or continuing an obsolete worker',async()=>{
  const worker=harness({states:[{...pending,status:'superseded'}]});await worker.run();assert.equal(worker.deliveries(),1);assert.equal(worker.continuations(),0);
});
test('long-lived retries rotate after a bounded event count while retaining the event identity',async()=>{
  const worker=harness({states:[pending]});await worker.run();assert.equal(worker.deliveries(),32);assert.equal(worker.sleeps.length,32);assert.equal(worker.continuations(),1);
});
