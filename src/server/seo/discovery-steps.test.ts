import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { DiscoveryDeliveryState } from './discovery';

const source=ts.transpileModule(readFileSync(new URL('./discovery-steps.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const delivered:DiscoveryDeliveryState={status:'completed',serverNow:'2026-10-12T06:00:00.000Z',nextAttemptAt:'2026-10-12T06:00:00.000Z'};
class OfflineRetry extends Error {constructor(message:string,readonly options:{retryAfter:string}){super(message);}}
function harness(options:{status?:number;body?:unknown;secret?:string;dispatchFailed?:boolean}={}){
  const requests:Array<{url:URL;init:RequestInit}>=[];
  const imports:Record<string,unknown>={
    workflow:{RetryableError:OfflineRetry},
    '@/lib/seo':{PUBLIC_SITE_URL:'https://www.jesie.pl'},
    './discovery':{attachDiscoveryWorkflow:async()=>true},
    './dispatch':{dispatchDiscoveryWorkflows:async()=>({failed:options.dispatchFailed?1:0,locked:0})},
  };
  const exports:{deliverDiscoveryEvent?:(event:string,generation:number,workflow:string)=>Promise<DiscoveryDeliveryState>;continueDiscoveryDelivery?:(event:string,generation:number,workflow:string)=>Promise<unknown>}={};
  runInNewContext(source,{exports,URL,AbortSignal,Date,Number,process:{env:{CRON_SECRET:options.secret??'offline-secret'}},
    fetch:async(url:URL,init:RequestInit)=>{requests.push({url,init});return new Response(JSON.stringify(options.body??{delivery:delivered}),{status:options.status??200,headers:{'Content-Type':'application/json'}});},
    require:(name:string)=>{assert(Object.hasOwn(imports,name));return imports[name];}});
  return {deliver:()=>exports.deliverDiscoveryEvent!('event-id',3,'offline-worker'),continue:()=>exports.continueDiscoveryDelivery!('event-id',3,'offline-worker'),requests};
}

test('delivery RPC uses only the canonical owned route and exact event/generation identity',async()=>{
  const rpc=harness();const result=await rpc.deliver();assert.equal(result.status,'completed');
  const {url,init}=rpc.requests[0];assert.equal(url.origin,'https://www.jesie.pl');assert.equal(url.pathname,'/api/cron/seo');
  assert.equal(url.searchParams.get('event'),'event-id');assert.equal(url.searchParams.get('generation'),'3');assert.equal(url.searchParams.get('workflow'),'offline-worker');
  assert.equal((init.headers as Record<string,string>).authorization,'Bearer offline-secret');assert.equal(init.redirect,'error');
  assert.equal(JSON.stringify(result).includes('offline-secret'),false);
});
test('an unavailable or incompatible handler becomes a bounded retry without exposing authorization',async()=>{
  for(const options of [{status:503},{body:{legacy:'old deployment'}}]){
    await assert.rejects(harness(options).deliver(),error=>error instanceof OfflineRetry&&error.message==='DISCOVERY_DELIVERY_UNAVAILABLE'&&error.options.retryAfter==='1m');
  }
});
test('a missing cron secret never sends the handler request',async()=>{
  const rpc=harness({secret:''});await assert.rejects(rpc.deliver(),/DISCOVERY_CRON_NOT_CONFIGURED/);assert.equal(rpc.requests.length,0);
});
test('failed continuation startup stays in the durable step retry instead of losing its pending event',async()=>{
  await assert.rejects(harness({dispatchFailed:true}).continue(),/DISCOVERY_CONTINUATION_UNAVAILABLE/);
});
