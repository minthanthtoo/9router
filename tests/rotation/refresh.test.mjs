import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve,extname} from 'node:path';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const req=createRequire(new URL('../package.json',import.meta.url)),esbuild=req('esbuild');
async function fixture(options={}){
 delete globalThis.__rotationSnapshotRefresh;
 const data={connections:async()=>[],settings:async()=>({}),snapshots:async()=>({}),usage:async()=>Response.json({quotas:{}}),credits:async()=>Response.json({}),...options};globalThis.__refreshFixture=data;
 const sources={
  '@/lib/localDb':'export const getProviderConnections=(...a)=>globalThis.__refreshFixture.connections(...a);export const getSettings=(...a)=>globalThis.__refreshFixture.settings(...a);',
  '@/lib/db/repos/providerRotationRepo.js':'export const readRotationSnapshots=(...a)=>globalThis.__refreshFixture.snapshots(...a);',
  '@/app/api/usage/[connectionId]/route.js':'export const GET=(...a)=>globalThis.__refreshFixture.usage(...a);',
  '@/app/api/usage/[connectionId]/codex-reset-credits/route.js':'export const GET=(...a)=>globalThis.__refreshFixture.credits(...a);',
 };
 const result=await esbuild.build({entryPoints:[resolve(repo,'src/shared/services/rotationSnapshotRefresh.js')],bundle:true,format:'cjs',platform:'node',write:false,plugins:[{name:'saved-read-fixture',setup(build){
  build.onResolve({filter:/^@\//},a=>sources[a.path]?{path:a.path,namespace:'fixture'}:{path:resolve(repo,'src',a.path.slice(2)+(extname(a.path)?'':'.js'))});
  build.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:sources[a.path],loader:'js'}));
 }}]});
 const m=new Module(resolve(repo,'tests/rotation/refresh-fixture.cjs'));m.filename=resolve(repo,'tests/rotation/refresh-fixture.cjs');m._compile(result.outputFiles[0].text,m.filename);return m.exports;
}
test('one failed account read does not prevent other accounts or credits from refreshing',async()=>{
 const calls=[];const api=await fixture({connections:async()=>[{id:'bad'},{id:'good'}],usage:async(_,ctx)=>{const id=(await ctx.params).connectionId;calls.push(id);if(id==='bad')throw Error('transport failed');return Response.json({quotas:{session:{}}});},credits:async(_,ctx)=>{calls.push('credits:'+(await ctx.params).connectionId);return Response.json({});}});
 const result=await api.refreshRotationSnapshots('codex',true);assert.ok(result.errors.some(e=>e.id==='bad'));assert.ok(calls.includes('good'));assert.ok(calls.includes('credits:good'));
});
test('background refresh isolates failed providers and reports the incomplete cycle',async()=>{
 const calls=[];const sequence={version:1,enabled:true,sorts:[{key:'session-remaining',direction:'asc',division:'half'}],resetPriority:{enabled:false,days:3,weeklyBelow:null}};
 const api=await fixture({settings:async()=>({providerStrategies:{codex:{rotationSequence:sequence},claude:{rotationSequence:sequence}}}),connections:async({provider})=>{calls.push(provider);if(provider==='codex')throw Error('provider unavailable');return[];}});
 const interval=globalThis.setInterval,clear=globalThis.clearInterval;let tick;
 globalThis.setInterval=fn=>{tick=fn;return{unref(){}};};globalThis.clearInterval=()=>{};
 try{api.startRotationSnapshotRefresh();for(let i=0;i<30&&globalThis.__rotationSnapshotRefresh.tick;i++)await new Promise(setImmediate);
  assert.deepEqual(calls,['codex','claude']);assert.match(api.rotationAutomationStatus({}).quotaReads.lastError,/unavailable|failed/i);assert.equal(typeof tick,'function');
 }finally{globalThis.setInterval=interval;globalThis.clearInterval=clear;delete globalThis.__rotationSnapshotRefresh;delete globalThis.__refreshFixture;}
});
test('future-dated cached evidence cannot suppress a fresh account read',async()=>{
 let calls=0;const future=Date.now()+3600000;
 const api=await fixture({connections:async()=>[{id:'clock'}],snapshots:async()=>({clock:{observedAt:future,credits:{observedAt:future}}}),usage:async()=>{calls++;return Response.json({quotas:{session:{}}});},credits:async()=>{calls++;return Response.json({});}});
 assert.deepEqual((await api.refreshRotationSnapshots('codex',true)).errors,[]);assert.equal(calls,2);
});

test('monitor status exposes server disablement and sanitized settings-read failures',async()=>{
 const api=await fixture({settings:async()=>{throw Error('private database details');}}), interval=globalThis.setInterval,clear=globalThis.clearInterval;
 globalThis.setInterval=()=>({unref(){}});globalThis.clearInterval=()=>{};
 const prior=process.env.DISABLE_ROTATION_SNAPSHOT_REFRESH;
 try{
  process.env.DISABLE_ROTATION_SNAPSHOT_REFRESH='1';
  assert.equal(api.rotationAutomationStatus({}).quotaReads.disabled,true);
  delete process.env.DISABLE_ROTATION_SNAPSHOT_REFRESH;
  api.startRotationSnapshotRefresh();
  for(let i=0;i<30&&globalThis.__rotationSnapshotRefresh.tick;i++)await new Promise(setImmediate);
  const status=api.rotationAutomationStatus({}).quotaReads;
  assert.match(status.lastError,/monitor.*unavailable/i);
  assert.equal(typeof status.checkedAt,'number');
  assert.ok(!status.lastError.includes('private database'));
 }finally{globalThis.setInterval=interval;globalThis.clearInterval=clear;if(prior===undefined)delete process.env.DISABLE_ROTATION_SNAPSHOT_REFRESH;else process.env.DISABLE_ROTATION_SNAPSHOT_REFRESH=prior;delete globalThis.__rotationSnapshotRefresh;delete globalThis.__refreshFixture;}
});

test('a reset crossed since observation forces a read inside the normal cache interval',async()=>{
 const now=Date.now(),calls=[];
 const api=await fixture({connections:async()=>[{id:'due'},{id:'fresh'},{id:'already-read'}],snapshots:async()=>({due:{observedAt:now-30000,quotas:[{resetAt:now-1000}]},fresh:{observedAt:now-30000,quotas:[{resetAt:now+60000}]},'already-read':{observedAt:now-500,quotas:[{resetAt:now-1000}]}}),usage:async(_,ctx)=>{calls.push((await ctx.params).connectionId);return Response.json({quotas:{session:{}}});}});
 await api.refreshRotationSnapshots('codex');assert.deepEqual(calls,['due']);
});
test('quota read failures still allow an independent reset-credit expiry read',async()=>{
 const calls=[];const api=await fixture({connections:async()=>[{id:'failed'}],usage:async()=>Response.json({error:'unavailable'},{status:503}),credits:async(_,ctx)=>{calls.push((await ctx.params).connectionId);return Response.json({});}});
 const result=await api.refreshRotationSnapshots('codex',true);assert.deepEqual(calls,['failed']);assert.equal(result.errors.length,1);
});
test('idle server monitor notices newly enabled policies without a browser restarting it',async()=>{
 let settings={},tick;const calls=[];const disabled=process.env.DISABLE_ROTATION_SNAPSHOT_REFRESH;delete process.env.DISABLE_ROTATION_SNAPSHOT_REFRESH;
 const api=await fixture({settings:async()=>settings,connections:async({provider})=>{calls.push(provider);return[];}});
 const interval=globalThis.setInterval,clear=globalThis.clearInterval;
 globalThis.setInterval=fn=>{tick=fn;return{unref(){}};};globalThis.clearInterval=()=>{throw Error('idle monitor must stay available')};
 try{api.startRotationSnapshotRefresh();for(let i=0;i<30&&globalThis.__rotationSnapshotRefresh.tick;i++)await new Promise(setImmediate);
 settings={providerStrategies:{codex:{rotationSequence:{version:1,enabled:true,sorts:[{key:'weekly-remaining',direction:'desc',division:'half'}],resetPriority:{enabled:false,days:3,weeklyBelow:null}}}}};await tick();assert.deepEqual(calls,['codex']);
 }finally{globalThis.setInterval=interval;globalThis.clearInterval=clear;delete globalThis.__rotationSnapshotRefresh;if(disabled===undefined)delete process.env.DISABLE_ROTATION_SNAPSHOT_REFRESH;else process.env.DISABLE_ROTATION_SNAPSHOT_REFRESH=disabled;}
});
