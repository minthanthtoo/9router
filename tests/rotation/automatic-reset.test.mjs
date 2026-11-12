import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(new URL('../package.json',import.meta.url)),esbuild=require('esbuild');
async function fixture({consent=true,uncertain=false,positive=false,providerRecovered=false,holds=[],other=null,otherRecovered=false,readFailure=false,onRead=()=>{}}={}) {
 const now=Date.now(),connection={id:'empty',provider:'codex',isActive:true,errorCode:429,'modelLock_gpt-6-sol':new Date(now+3600000).toISOString()};
 const policy={version:1,enabled:true,sorts:[],resetPriority:{enabled:true,days:3,weeklyBelow:30,autoReset:consent}};
 const quota=remaining=>({provider:'codex',observedAt:Date.now(),credits:{availableCount:1,observedAt:now,expiresAt:now+86400000},quotas:[{id:'session',window:'session',scope:'codex:main',remaining,resetAt:now+3600000},{id:'weekly',window:'weekly',scope:'codex:main',remaining:remaining?70:0,resetAt:now+86400000}]});
 const connections=[connection,...(other?[{id:'other',provider:'codex',isActive:other!=='disabled',...(other==='locked'?{errorCode:503,'modelLock_gpt-6-sol':new Date(now+3600000).toISOString()}: {})}]:[])];
 const f={policy,connection,connections,otherData:other==='unknown'?null:quota(other==='empty'?0:80),data:quota(positive?70:0),calls:[],holds};globalThis.__autoResetTest=f;
 const mocks={
  '@/lib/localDb':`export const getSettings=async()=>({providerStrategies:{codex:{rotationSequence:globalThis.__autoResetTest.policy}}});export const getProviderConnectionById=async(id)=>globalThis.__autoResetTest.connections.find(c=>c.id===id);export const updateProviderConnection=async(id,data)=>{globalThis.__autoResetTest.calls.push('clear-lock');Object.assign(globalThis.__autoResetTest.connection,data)};`,
  '@/lib/db/repos/providerRotationRepo.js':`export const readRotationSnapshots=async()=>({empty:globalThis.__autoResetTest.data,other:globalThis.__autoResetTest.otherData});export const readCreditResetHolds=async()=>globalThis.__autoResetTest.holds;export const completeCreditResetRecovery=async()=>globalThis.__autoResetTest.calls.push('recovered');`,
 };
 const result=await esbuild.build({entryPoints:[resolve(root,'src/shared/services/automaticCreditReset.js')],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'fixture',setup(b){
  b.onResolve({filter:/antigravityQuota\.js$/},()=>({path:'antigravityQuota',namespace:'quota-cache'}));
  b.onLoad({filter:/.*/,namespace:'quota-cache'},()=>({contents:'export const getAntigravityQuotaBlockForConnection=()=>null;export const getAntigravityQuotaCache=()=>new Map();',loader:'js'}));
  b.onResolve({filter:/^@\//},a=>mocks[a.path]?{path:a.path,namespace:'fixture'}:a.path.includes('/app/api/')?{path:a.path,namespace:'route'}:{path:resolve(root,'src',a.path.slice(2))+(existsSync(resolve(root,'src',a.path.slice(2)))?'':'.js')});
  b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:mocks[a.path],loader:'js'}));
  b.onLoad({filter:/.*/,namespace:'route'},()=>({contents:'export const GET=()=>{throw Error("Unexpected provider read")};export const POST=()=>{throw Error("Unexpected provider write")}',loader:'js'}));
 }}]});
 const m=new Module(resolve(root,'tests/rotation/auto-fixture.cjs'));m.filename=resolve(root,'tests/rotation/auto-fixture.cjs');m._compile(result.outputFiles[0].text,m.filename);
 const run=(model='gpt-6-sol')=>m.exports.prepareAutomaticCreditReset(connections,policy,model,{
  reset:async(_,ctx)=>{f.calls.push('reset');f.sent=true;assert.ok(ctx.automaticCycle);if(uncertain)throw Error('timeout');return Response.json({reset:true,redeemRequestId:'attempt'})},
  readUsage:async(_,ctx)=>{onRead();f.calls.push('read-usage');if(readFailure)return Response.json({},{status:503});if((await ctx.params).connectionId==='other'){if(otherRecovered)f.otherData=quota(80);}else f.data=quota(f.sent||providerRecovered||holds.some(h=>h.state==='confirmed')?80:0);return Response.json({})},
  readCredits:async()=>{f.calls.push('read-credits');return Response.json({})},
 });
 return {f,run};
}
test('zero quota reset waits for confirmed reset and fresh allowance before becoming ready',async()=>{
 const {f,run}=await fixture();assert.deepEqual(await run(),{blocked:[],readyId:'empty'});
 assert.deepEqual(f.calls,['read-usage','read-usage','read-credits','reset','read-usage','read-credits','clear-lock','recovered']);assert.equal(f.connection['modelLock_gpt-6-sol'],null);
});
test('no consent, positive quota and unknown outcomes never bypass confirmed recovery',async()=>{
 for(const options of [{consent:false},{positive:true},{uncertain:true},{holds:[{connectionId:'empty',state:'unknown',id:'old'}]}]){
  const {f,run}=await fixture(options);const result=await run();assert.equal(result.readyId,undefined);
  if(options.uncertain)assert.deepEqual(result.blocked,['empty']);else assert.equal(f.calls.includes('reset'),false);
 }
});
test('confirmed reset resumes quota verification after restart without redeeming again',async()=>{
 const {f,run}=await fixture({holds:[{connectionId:'empty',state:'confirmed',id:'old'}]});
 assert.deepEqual(await run(),{blocked:[]});assert.equal(f.calls.includes('reset'),false);assert.ok(f.calls.includes('recovered'));
});
test('durable ledger serializes manual and automated attempts and never replays an uncertain cycle',async()=>{
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec('CREATE TABLE providerCreditResetAttempts(id TEXT PRIMARY KEY,connectionId TEXT,cycle TEXT,state TEXT,createdAt INTEGER,result TEXT); CREATE TABLE settings(id INTEGER,data TEXT)');
 sqlite.prepare('INSERT INTO settings VALUES(1,?)').run(JSON.stringify({providerStrategies:{codex:{rotationSequence:{enabled:true,resetPriority:{enabled:true,autoReset:true}}}}}));
 globalThis._dbAdapter={instance:{driver:'node:sqlite',get:(s,p=[])=>sqlite.prepare(s).get(...p),all:(s,p=[])=>sqlite.prepare(s).all(...p),run:(s,p=[])=>sqlite.prepare(s).run(...p),exec:s=>sqlite.exec(s)},logged:true};
 try {
  const repo=await import('../../src/lib/db/repos/providerRotationRepo.js');
  assert.equal(await repo.claimCreditReset('account','cycle',{enabled:false}),null);
  const first=await repo.claimCreditReset('account','cycle');assert.ok(first);
  assert.equal(await repo.claimCreditReset('account','cycle'),null);assert.equal(await repo.claimCreditReset('account'),null);
  await repo.finishCreditReset(first,'unknown','timeout');assert.equal(await repo.claimCreditReset('account','new-cycle'),null);
  assert.equal((await repo.readCreditResetHolds([{id:'account'}]))[0].state,'unknown');
  const second=await repo.claimCreditReset('other','cycle');await repo.finishCreditReset(second,'confirmed','reset');assert.equal(await repo.claimCreditReset('other'),null);
  await repo.completeCreditResetRecovery(second);assert.equal(await repo.claimCreditReset('other','cycle'),null);assert.ok(await repo.claimCreditReset('other','new-cycle'));
 } finally {sqlite.close();delete globalThis._dbAdapter;}
});
test('preview distinguishes exhausted resettable accounts from uncertain resets without dispatch',async()=>{
 const {rotationPool}=await import('../../src/sse/services/providerRotation.js');
 const {f}=await fixture();
 const preview=rotationPool([f.connection],{empty:f.data},f.policy,{provider:'codex',model:'gpt-6-sol'});
 // A quota cooldown may enter the reset queue; it is not dispatched until recovery.
 assert.equal(preview.candidates[0].id,'empty');
 f.connection['modelLock_gpt-6-sol']=null;
 const pending=rotationPool([f.connection],{empty:f.data},f.policy,{provider:'codex',model:'gpt-6-sol',resetHolds:[{connectionId:'empty',state:'unknown'}]});
 assert.equal(pending.blocked[0].reason,'Reset pending verification');
 const resettable=rotationPool([f.connection],{empty:f.data},f.policy,{provider:'codex',model:'gpt-6-sol'});
 assert.equal(resettable.candidates[0].id,'empty');
});

test('image and separate Codex allowance models never redeem or reconcile main reset credits',async()=>{
 const {f,run}=await fixture({holds:[{connectionId:'empty',state:'confirmed',id:'old'}]});
 assert.deepEqual(await run('gpt-image-2'),{blocked:[]});
 assert.equal(f.calls.length,0);
});

test('a fresh provider read showing recovery prevents an unnecessary credit spend',async()=>{
 const {f,run}=await fixture({providerRecovered:true});
 assert.deepEqual(await run(),{blocked:[]});
 assert.deepEqual(f.calls,['read-usage','clear-lock']);
 assert.equal(f.connection['modelLock_gpt-6-sol'],null);
});

test('automatic reset is last resort across the full eligible pool, not just matching credits',async()=>{
 for(const other of ['ready','unknown']){
  const {f,run}=await fixture({other});
  assert.deepEqual(await run(),{blocked:['empty']});
  assert.deepEqual(f.calls,[]);
 }
 for(const other of ['disabled','locked','empty']){
  const {f,run}=await fixture({other});
  assert.equal((await run()).readyId,'empty');
  assert.equal(f.calls.filter(call=>call==='reset').length,1);
 }
});

test('preview and selection use ordinary ready accounts before reset-required priority candidates',async()=>{
 const {rotationPool}=await import('../../src/sse/services/providerRotation.js');
 const {f}=await fixture({other:'ready'});
 const snapshots={empty:f.data,other:{...f.otherData,credits:null}};
 const pool=rotationPool(f.connections,snapshots,f.policy,{provider:'codex',model:'gpt-6-sol'});
 assert.deepEqual(pool.candidates.map(c=>c.id),['other']);
 assert.equal(pool.ranked.some(row=>row.connection.id==='empty'),false);
 const fallback=rotationPool([f.connection],snapshots,f.policy,{provider:'codex',model:'gpt-6-sol'});
 assert.equal(fallback.candidates[0].id,'empty');
});

test('recovery on another exhausted account is re-read before spending a reset credit',async()=>{
 const {f,run}=await fixture({other:'empty',otherRecovered:true});
 assert.deepEqual(await run(),{blocked:['empty']});
 assert.equal(f.calls.includes('reset'),false);
 assert.equal(f.calls.filter(call=>call==='read-usage').length,2);
});
test('an incomplete pool recheck prevents automatic credit redemption',async()=>{
 const {f,run}=await fixture({readFailure:true});
 assert.deepEqual(await run(),{blocked:['empty']});
 assert.equal(f.calls.includes('reset'),false);
});

test('pool rechecks advance the eligibility clock before matching fresh reset evidence',async()=>{
 const original=Date.now;let now=original();Date.now=()=>now;
 try{
  const {run}=await fixture({onRead:()=>{now+=100;}});
  assert.equal((await run()).readyId,'empty');
 }finally{Date.now=original;}
});
