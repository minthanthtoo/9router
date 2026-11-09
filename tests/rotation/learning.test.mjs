import test from 'node:test';
import assert from 'node:assert/strict';
import {quotaHitSpans} from '../../src/sse/services/imageQuotaStatistics.js';
import {estimateImageQuotaLearning} from '../../src/sse/services/imageQuotaLearning.js';
import {selectImageLearningScope} from '../../src/lib/db/repos/imageLearningScope.js';
import {normalizeRotationUsage,rotationValue} from '../../src/shared/utils/rotationSequence.mjs';
const at=n=>new Date(Date.UTC(2026,10,6,0,n)).toISOString();
const event=(n,outcome,more={})=>({provider:'codex',model:'gpt-image-1',dispatchedAt:at(n),completedAt:at(n),outcome,...more});
test('repeated429s are one hit episode; successful dispatches and uncertainty remain distinct',()=>{
 const h=[event(0,'quota_rejected'),event(1,'quota_rejected'),event(2,'provider_rejected',{httpStatus:500}),event(3,'succeeded'),event(4,'succeeded'),event(5,'outcome_unknown'),event(6,'quota_rejected'),event(7,'quota_rejected')];
 const x=quotaHitSpans(h);assert.equal(x.intervals.length,1);assert.deepEqual(x.intervals[0],{from:at(1),to:at(6),seconds:300,successfulCalls:2,uncertain:true});assert.match(x.meaning,/not_a_reset/);assert.equal(x.latestHitAt,at(7));
 assert.equal(estimateImageQuotaLearning(h).estimate.windowSeconds,null);
});
test('subscription-wide Codex refusals retain operational history but cannot fit an image-model cap',()=>{
 const observation=id=>({quotaObservations:JSON.stringify([{quotaGroupId:'codex.image_generation',constraintId:id,appliesToModels:['*']}])});
 const h=[event(0,'quota_rejected',observation('usage_limit')),event(1,'succeeded'),event(3,'quota_rejected',observation('image_gen')),event(4,'succeeded'),event(6,'quota_rejected',observation('image_gen'))];
 const selected=selectImageLearningScope(h,'gpt-image-1');assert.equal(selected.events[0].outcome,'provider_rejected');assert.equal(h[0].outcome,'quota_rejected');assert.equal(quotaHitSpans(selected.events).intervals[0].successfulCalls,1);
});
test('subscription image windows rank images without borrowing main text capacity',()=>{
 const now=Date.now(),snapshot=normalizeRotationUsage('codex',{quotas:{session:{used:99,total:100,windowSeconds:18000},image_gen_primary:{used:20,total:100,quotaKind:'image_generation',limitId:'image_gen',windowSeconds:86400,resetAt:new Date(now+86400000).toISOString()},imagegen_premium_secondary:{used:50,total:100,quotaKind:'image_generation',limitId:'imagegen_premium',windowSeconds:604800,resetAt:new Date(now+604800000).toISOString()}}},now);
 assert.equal(rotationValue(snapshot,{window:'session',kind:'remaining'},'codex','gpt-image-1',now),80);assert.equal(rotationValue(snapshot,{window:'weekly',kind:'remaining'},'codex','gpt-image-1',now),50);assert.equal(rotationValue(snapshot,{window:'session',kind:'remaining'},'codex','gpt-6.1',now),1);
});

const {imageNextCheck}=await import('../../src/app/(dashboard)/dashboard/quota/imageLearningDisplay.mjs');
test('model-specific recovery dates never leak to unrelated image models',()=>{
 const account={routeState:'model_scoped_limits',nextKnownAt:at(10),constraints:[{appliesToModels:['a'],retryAt:at(10),source:'provider_retry_after',confidence:'provider_confirmed'}]};
 assert.equal(imageNextCheck(account,{model:'b'}),null);assert.equal(imageNextCheck(account,{model:'a'}).at,at(10));
 const ambiguous={...account,constraints:[...account.constraints,{appliesToModels:['a'],retryAt:null,source:'runtime_restriction'}]};assert.equal(imageNextCheck(ambiguous,{model:'a'}).at,null);
});

test('display-only image estimate reports retained rolling usage and next expiry without changing admission',()=>{
 const start=Date.parse('2026-11-01T00:00:00Z');
 const point=(seconds,outcome)=>({dispatchedAt:new Date(start+seconds*1000).toISOString(),outcome});
 const events=[0,61,122,183].flatMap(offset=>[point(offset,'succeeded'),point(offset+1,'succeeded'),point(offset+2,'succeeded'),point(offset+3,'quota_rejected')]);
 const result=estimateImageQuotaLearning(events,{now:start+190000});
 assert.equal(result.estimate.state,'estimated');assert.equal(result.estimate.remainingPercentage,0);assert.equal(result.estimate.usedInWindow,3);assert.equal(result.estimate.resetAt,new Date(start+243000).toISOString());
 const later=estimateImageQuotaLearning(events,{now:start+250000});assert.equal(later.estimate.remainingPercentage,100);assert.equal(later.estimate.resetAt,null);
 const uncertain=estimateImageQuotaLearning([...events,point(189,'in_flight')],{now:start+190000});assert.equal(uncertain.estimate.remainingPercentage,undefined);
});
