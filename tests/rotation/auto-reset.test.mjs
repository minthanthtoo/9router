import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyRotation,normalizeRotationUsage,rotationMetrics,rotationValue,evaluateRotation} from '../../src/shared/utils/rotationSequence.mjs';
import {segmentVisibleConnections} from '../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js';
import {availabilityQuotaSegments} from '../../src/app/(dashboard)/dashboard/quota/quotaPins.mjs';
const now=Date.parse('2026-11-13T00:00:00Z'),at=hours=>new Date(now+hours*3600000).toISOString();
const read=quotas=>normalizeRotationUsage('codex',{quotas},now);
const q=(remaining,hours,windowSeconds)=>({remainingPercentage:remaining,resetAt:hours===null?null:at(hours),windowSeconds});
const metric={key:'auto-reset',window:'auto',kind:'reset'};
const value=snapshot=>rotationValue(snapshot,metric,'codex','gpt-6-sol',now);
test('automatic reset uses the limiting exhausted allowance, not a healthy shorter window',()=>{
 assert.equal(value(read({session:q(100,5,18000),weekly:q(0,120,604800)})),now+120*3600000);
 assert.equal(value(read({session:q(0,2,18000),weekly:q(0,120,604800)})),now+120*3600000);
 assert.equal(value(read({session:q(0,2,18000),weekly:q(70,120,604800)})),now+2*3600000);
 assert.equal(value(read({session:q(90,3,18000),weekly:q(70,120,604800)})),now+3*3600000);
 assert.equal(value(read({session:q(0,600,2592000)})),now+600*3600000);
});
test('automatic reset preserves unknowns, freshness and requested-model scope',()=>{
 assert.equal(value(read({session:q(0,null,18000),weekly:q(0,120,604800)})),null);
 assert.equal(value({...read({session:q(0,2,18000)}),observedAt:now-11*60000}),null);
 const s=read({session:q(0,2,18000),image_gen_primary:{...q(0,120,604800),quotaKind:'image_generation',limitId:'image_gen'}});
 assert.equal(value(s),now+2*3600000);
 assert.equal(rotationValue(s,metric,'codex','gpt-image-2',now),now+120*3600000);
});
test('auto-reset policy and fallback card sorting agree, including missing last in either direction',()=>{
 assert.ok(rotationMetrics('codex').some(m=>m.key==='auto-reset'));
 const connections=[{id:'weekly',provider:'codex'},{id:'short',provider:'codex'},{id:'unknown',provider:'codex'}];
 const snapshots={weekly:read({session:q(100,1,18000),weekly:q(0,120,604800)}),short:read({session:q(0,2,18000)}),unknown:read({session:q(0,null,18000)})};
 const quotaData=Object.fromEntries(Object.entries(snapshots).map(([id,s])=>[id,{cachedAt:new Date(now).toISOString(),quotas:s.quotas.map(row=>({quotaType:row.id,remainingPercentage:row.remaining,resetAt:row.resetAt?new Date(row.resetAt).toISOString():null,windowSeconds:row.windowSeconds}))}]));
 for(const direction of ['asc','desc']){
  const sorts=[{key:'auto-reset',direction,division:'half'}],policy={...emptyRotation(),enabled:true,sorts};
  const server=evaluateRotation(connections,snapshots,policy,{provider:'codex',model:'gpt-6-sol',now,includeExhausted:true});
  const expected=direction==='asc'?['short','weekly','unknown']:['weekly','short','unknown'];
  assert.deepEqual(server.ranked.map(row=>row.connection.id),expected);
  assert.deepEqual(segmentVisibleConnections(connections,quotaData,sorts,now).flatMap(s=>s.connections.map(c=>c.id)),expected);
 }
});
test('compact account sections preserve ranked order without multiplying sort divisions',()=>{
 const a={id:'a'},b={id:'b'},c={id:'c'},d={id:'d',isActive:false};
 const segments=[{key:'regular.1',connections:[a,b],unavailableIds:['b']},{key:'regular.2',connections:[c,d]}];
 const groups=availabilityQuotaSegments(segments,[],{},true,true);
 assert.deepEqual(groups.map(g=>[g.key,g.connections.map(c=>c.id)]),[['ready',['a','c']],['unavailable',['b','d']]]);
 assert.equal(segments.length,2);
});

test('Auto reset keeps prior half, P50 and gap groups visible in the card list',()=>{
 const connections=Array.from({length:8},(_,i)=>({id:String(i),provider:'codex'}));
 const quotaData=Object.fromEntries(connections.map((c,i)=>[c.id,{quotas:[{quotaType:'session',...q(90-i*10,8-i,18000)},{quotaType:'weekly',...q(80-i*10,100+i,604800)}]}]));
 for(const division of ['half','median','gap']){
  const sorts=[{key:'weekly-remaining',direction:'desc',division:'half'},{key:'auto-reset',direction:'asc',division}];
  const segments=segmentVisibleConnections(connections,quotaData,sorts,now);
  assert.ok(segments.length>1,division);
  for(const enabled of [true,false]){
   const visible=availabilityQuotaSegments(segments,[],quotaData,enabled,false,true);
   assert.deepEqual(visible.map(g=>g.connections.map(c=>c.id)),segments.map(g=>g.connections.map(c=>c.id)),division);
   assert.deepEqual(visible.map(g=>g.boundaries),segments.map(g=>g.boundaries),division);
  }
 }
});
