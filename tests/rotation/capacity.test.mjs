import test from 'node:test';
import assert from 'node:assert/strict';
import { accountContext, usageWorkload, collectCapacitySamples, estimateCapacity } from '../../src/shared/utils/quotaCapacity.mjs';
const now=1794400000000, reset=now+86400000;
const snapshot=(remaining,at=now)=>({provider:'codex',plan:'free',observedAt:at,completedAt:at+100,quotas:[{id:'session',window:'monthly',scope:'codex:main',unit:'relative_percent',windowSeconds:2592000,remaining,resetAt:reset}]});
const request=(i,extra={})=>({model:'gpt-6-luna',status:'ok',timestamp:new Date(now+1000+i*1000).toISOString(),tokens:JSON.stringify({prompt_tokens:1000,cached_tokens:500,completion_tokens:100}),meta:JSON.stringify({startedAt:now+200+i*1000,speed:'standard',effort:'medium'}),...extra});
test('account context keeps live plan source separate from auth mode and unverified claim',()=>{
 assert.deepEqual(accountContext({authType:'oauth',providerSpecificData:{chatgptPlanType:'plus'}},snapshot(90)),{authMode:'subscription',plan:'free',planSource:'provider_usage',observedAt:now});
 assert.equal(accountContext({authType:'apikey',providerSpecificData:{chatgptPlanType:'pro'}},null).authMode,'api_key');
 assert.equal(accountContext({authType:'oauth',providerSpecificData:{chatgptPlanType:'future-plan'}},null).planSource,'authentication');
 assert.deepEqual(usageWorkload(Infinity,{service_tier:'evil',reasoning_effort:'high'}),{});
});
test('samples pair complete homogeneous traffic with same quota cycle, preserve components and percentage rounding',()=>{
 const samples=collectCapacitySamples(snapshot(100),snapshot(90,now+10000),[request(0),request(1)]);
 assert.equal(samples.length,1); assert.equal(samples[0].requests,2);assert.equal(samples[0].points,10);
 assert.deepEqual(samples[0].tokens,{uncached:1000,cached:1000,output:200});
 for(const change of [{plan:'plus'},{quotas:[{...snapshot(90).quotas[0],resetAt:reset+100000}]},{observedAt:now+3600001}])assert.equal(collectCapacitySamples(snapshot(100),{...snapshot(90,now+10000),...change},[request(0)]).length,0);
 for(const rows of [[request(0),request(1,{model:'other'})],[request(0,{meta:'{}'})],[request(0,{status:'error'})],[request(0,{meta:JSON.stringify({startedAt:now-1,speed:'standard',effort:'medium'})})]])assert.equal(collectCapacitySamples(snapshot(100),snapshot(90,now+10000),rows).length,0);
 assert.equal(collectCapacitySamples(snapshot(100),snapshot(99,now+10000),[request(0)]).length,0);
});
test('estimates require model and sufficient recent comparable evidence; never convert relative allowance into fixed tokens',()=>{
 const sample=collectCapacitySamples(snapshot(100),snapshot(90,now+10000),[request(0),request(1)])[0];
 const s={...snapshot(50,now+60000),capacitySamples:Array.from({length:5},(_,i)=>({...sample,at:now+10000+i*1000}))};
 const e=estimateCapacity(s,'gpt-6-luna',now+60000);
 assert.equal(e.state,'observed');assert.equal(e.samples,5);assert.equal(e.unit,'similar_requests');assert.ok(e.low<=10&&e.high>=10);
 assert.equal(estimateCapacity({...s,capacitySamples:s.capacitySamples.slice(0,2)},'gpt-6-luna',now+60000).state,'learning');
 assert.equal(estimateCapacity(s,'other',now+60000).state,'learning');
 assert.equal(estimateCapacity(s,'',now+60000).state,'choose_model');
 assert.equal(estimateCapacity(s,'gpt-6-luna',now+86400000*8).state,'learning');
 assert.equal(estimateCapacity({...s,quotas:[{...s.quotas[0],remaining:0}]},'gpt-6-luna',now+60000).high,0);
});
test('missing applicable allowance cannot produce a complete capacity estimate',()=>{
 const sample=collectCapacitySamples(snapshot(100),snapshot(90,now+10000),[request(0),request(1)])[0];
 const s={...snapshot(50,now+60000),capacitySamples:Array.from({length:5},()=>sample)};
 assert.equal(estimateCapacity(s,'gpt-6-luna',now+60000,[...s.quotas,{remaining:null}]).state,'learning');
});
test('cross-account comparisons reject different speed/effort and substantially different request sizes',async()=>{
 const {capacityComparable}=await import('../../src/shared/utils/quotaCapacity.mjs');
 const e={state:'observed',speed:'standard',effort:'medium',workload:{uncached:100,cached:100,output:100}};
 assert.equal(capacityComparable([e,{...e,workload:{uncached:110,cached:100,output:90}}]),true);
 assert.equal(capacityComparable([e,{...e,speed:'fast'}]),false);
 assert.equal(capacityComparable([e,{...e,workload:{uncached:10000,cached:100,output:100}}]),false);
});
test('relative percentage display never invents a request counter',async()=>{
 const {getQuotaUsageDisplay}=await import('../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaUsageDisplay.mjs');
 assert.equal(getQuotaUsageDisplay({displayUnit:'relative_percentage',used:16,total:100,remaining:84}).text,'84% left');
 assert.match(getQuotaUsageDisplay({displayUnit:'relative_percentage',quotaStatus:'unknown'}).text,/unknown/);
 assert.equal(getQuotaUsageDisplay({displayUnit:'relative_percentage',remaining:null,used:null}).text,'Unreported');
 const {rotationMetrics,rotationValue}=await import('../../src/shared/utils/rotationSequence.mjs');
 const metric=rotationMetrics('codex').find(m=>m.key==='workload-capacity');assert.equal(metric.kind,'capacity');
 assert.equal(rotationValue(snapshot(100),metric,'codex','gpt-6-luna',now),null);
});

test('capacity sort orders comparable measured work and ignores incompatible profiles',async()=>{
 const {evaluateRotation,emptyRotation}=await import('../../src/shared/utils/rotationSequence.mjs');
 const sample=collectCapacitySamples(snapshot(100),snapshot(90,now+10000),[request(0),request(1)])[0];
 const s={...snapshot(50,now+60000),capacitySamples:Array.from({length:5},(_,i)=>({...sample,at:now+10000+i*1000}))};
 const connections=[{id:'a',isActive:true},{id:'b',isActive:true}];
 const policy={...emptyRotation(),enabled:true,sorts:[{key:'workload-capacity',direction:'desc',division:'half'}]};
 const run=(b)=>evaluateRotation(connections,{a:s,b},policy,{provider:'codex',model:'gpt-6-luna',now:now+60000});
 const higher={...s,quotas:[{...s.quotas[0],remaining:80}]};
 assert.equal(run(higher).ranked[0].connection.id,'b');
 const incompatible={...higher,capacitySamples:higher.capacitySamples.map(sample=>({...sample,speed:'fast'}))};
 assert.ok(run(incompatible).ranked.every(row=>row.values[0]===null));
});
