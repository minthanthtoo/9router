import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyRotation,normalizeRotationUsage,rotationValue,evaluateRotation,compareResetPriority} from '../../src/shared/utils/rotationSequence.mjs';
import {rotationDisplayMetrics,rotationMeasurements} from '../../src/shared/utils/rotationPreview.mjs';
import {accountModelAccess,textModelPermissionReason} from '../../src/shared/utils/textModelPermission.mjs';
import {rotationPool} from '../../src/sse/services/providerRotation.js';
import {accountMatchesQuotaModel} from '../../src/shared/utils/quotaModelCatalog.mjs';
const now=Date.now(),model='premium-model';
const account=id=>({id,provider:'codex',isActive:true});
const usage=(left,seconds=2592000)=>({plan:seconds===2592000?'free':'plus',quotas:{session:{total:100,used:100-left,windowSeconds:seconds,resetAt:new Date(now+seconds*1000).toISOString()}}});
const evidence=models=>({source:'account_models',observedAt:now,models});
const context={provider:'codex',model,now};
test('free monthly allowance is preserved and enforced with sorting off without inventing weekly headroom',()=>{
 const snapshot=normalizeRotationUsage('codex',usage(0),now);
 assert.equal(snapshot.plan,'free');assert.equal(snapshot.quotas[0].windowSeconds,2592000);
 assert.equal(rotationDisplayMetrics({snapshot},'codex',model,now).find(metric=>metric.key==='monthly-remaining').label,'30d left %');
 assert.equal(rotationMeasurements(snapshot,'codex',model,now)['monthly-remaining'],0);
 assert.equal(snapshot.quotas[0].remaining,0);assert.equal(snapshot.quotas[0].unit,'relative_percent');
 assert.equal(rotationValue(snapshot,{window:'weekly',kind:'remaining'},'codex',model,now),null);
 const blocked=rotationPool([account('free')],{free:snapshot},emptyRotation(),context);
 assert.equal(blocked.ranked.length,0);assert.equal(blocked.blocked[0].reason,'Quota exhausted');
 const full=normalizeRotationUsage('codex',usage(100),now);
 assert.equal(rotationPool([account('free')],{free:full},emptyRotation(),context).ranked.length,1);
 assert.equal(rotationPool([account('paid')],{paid:normalizeRotationUsage('codex',usage(0,18000),now)},emptyRotation(),context).ranked.length,0);
});
test('account model discovery gates requested text model while unknown evidence remains honest and images stay separate',()=>{
 const a=account('free'),access=evidence(['basic-model']);
 assert.equal(accountModelAccess(a,model,access,now).state,'unsupported');
 assert.equal(accountModelAccess(a,'cx/basic-model(high)',access,now).state,'supported');
 for(const old of [undefined,{...access,observedAt:now-600001},{...access,observedAt:now+1}]) assert.equal(accountModelAccess(a,model,old,now).state,'unknown');
 assert.equal(accountModelAccess(a,'gpt-image-2',access,now).reason,null);
 assert.equal(textModelPermissionReason(a,model,null,access,now),'Model unavailable on this account');
 assert.equal(accountMatchesQuotaModel({...a,modelAccess:access},{provider:'codex',id:model,kind:'llm'}),false);
 assert.equal(accountMatchesQuotaModel({...a,modelAccess:access},{provider:'codex',id:'custom-generation',kind:'image'}),true);
 const data={free:{...normalizeRotationUsage('codex',usage(100),now),modelAccess:access},paid:{...normalizeRotationUsage('codex',usage(100,18000),now),modelAccess:evidence([model])}};
 const pool=rotationPool([a,account('paid')],data,emptyRotation(),context);
 assert.deepEqual(pool.ranked.map(row=>row.connection.id),['paid']);
 assert.equal(pool.blocked[0].reason,'Model unavailable on this account');
});
test('reset priority orders the complete pool with no hidden groups; explicit ordinary grouping alone divides',()=>{
 const rows=['outside','none','match'].map(account);
 const snapshots=Object.fromEntries(rows.map((a,i)=>[a.id,normalizeRotationUsage('codex',usage(70+i,18000),now)]));
 snapshots.outside.credits={availableCount:1,observedAt:now,expiresAt:now+10*86400000};
 snapshots.match.credits={availableCount:1,observedAt:now,expiresAt:now+86400000};
 const policy={...emptyRotation(),enabled:true,resetPriority:{enabled:true,days:3,weeklyBelow:null}};
 for(const sorts of [[],[{key:'session-remaining',direction:'asc',division:'half'}]]){
  const pool=evaluateRotation(rows,snapshots,{...policy,sorts},context);
  assert.equal(pool.segments.length,1);assert.deepEqual(pool.ranked.map(r=>r.connection.id),['match','outside','none']);
  assert.equal(pool.candidates.length,3);
 }
 const group=evaluateRotation(rows,snapshots,{...policy,sorts:[{key:'session-remaining',direction:'asc',division:'half'},{key:'session-reset',direction:'asc',division:'half'}]},context);
 assert.equal(group.segments.length,2);
 assert.equal(compareResetPriority({urgent:false,expiry:null},{urgent:false,expiry:null}),0);
});
test('live evidence changes rerank only unsent eligible accounts and never make percentages absolute capacity',()=>{
 const rows=['a','b','free'].map(account),snapshots={a:normalizeRotationUsage('codex',usage(100,18000),now),b:normalizeRotationUsage('codex',usage(50,18000),now),free:normalizeRotationUsage('codex',usage(100),now)};
 const policy={...emptyRotation(),enabled:true,sorts:[{key:'session-remaining',direction:'desc',division:'half'}]};
 assert.deepEqual(rotationPool(rows,snapshots,policy,context).ranked.map(r=>r.connection.id),['a','b','free']);
 snapshots.a=normalizeRotationUsage('codex',usage(0,18000),now);
 assert.deepEqual(rotationPool(rows.filter(a=>a.id!=='a'),snapshots,policy,context).ranked.map(r=>r.connection.id),['b','free']);
 snapshots.b.modelAccess=evidence(['basic-model']);
 assert.deepEqual(rotationPool(rows,snapshots,policy,context).ranked.map(r=>r.connection.id),['free']);
});

test('reset sort preserves explicitly chosen quota groups and orders credits inside them',()=>{
 const accounts=['a','b','c','d'].map(account);
 const snapshots=Object.fromEntries(accounts.map((a,i)=>[a.id,normalizeRotationUsage('codex',usage(20+i*20,18000),now)]));
 snapshots.d.credits={availableCount:1,observedAt:now,expiresAt:now+86400000};
 const sorts=[{key:'session-remaining',direction:'asc',division:'half'},{key:'session-reset',direction:'asc',division:'half'}];
 const policy={...emptyRotation(),enabled:true,sorts,resetPriority:{enabled:true,days:3,weeklyBelow:null}};
 const pool=evaluateRotation(accounts,snapshots,policy,context);
 assert.deepEqual(pool.segments.map(group=>group.rows.map(row=>row.connection.id)),[['a','b'],['d','c']]);
});
