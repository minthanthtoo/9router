import test from 'node:test';
import assert from 'node:assert/strict';
const root=new URL('../../',import.meta.url);
const {selectImageLearningScope}=await import(new URL('src/lib/db/repos/imageLearningScope.js',root));
const {estimateImageQuotaLearning}=await import(new URL('src/sse/services/imageQuotaLearning.js',root));
const {recoveryIntervals}=await import(new URL('src/sse/services/imageQuotaStatistics.js',root));
const {imageStudyGuidance}=await import(new URL('src/app/(dashboard)/dashboard/quota/imageStudyGuidance.mjs',root));
const at=seconds=>new Date(Date.UTC(2026,10,1)+seconds*1000).toISOString();
const event=(seconds,outcome,model='a',extra={})=>({model,outcome,dispatchedAt:at(seconds),completedAt:at(seconds+1),...extra});
const quota=JSON.stringify([{quotaGroupId:'subscription.images',constraintId:'image_gen',appliesToModels:['*']}]);
test('explicit wildcard scopes combine model traffic; absent evidence never pools models',()=>{
 const history=[event(0,'succeeded','a'),event(1,'succeeded','b'),event(2,'quota_rejected','b',{quotaObservations:quota})];
 const a=selectImageLearningScope(history,'a'),b=selectImageLearningScope(history,'b');
 assert.equal(a.events.length,3);assert.equal(a.predictionModel,b.predictionModel);assert.equal(a.model,'*');
 const separate=selectImageLearningScope(history.map(x=>({...x,quotaObservations:'[]'})),'a');assert.equal(separate.events.length,1);assert.equal(separate.model,'a');
});
test('multiple constraints prevent a pooled inference; model-specific refusals cannot constrain shared fit',()=>{
 const other=JSON.stringify([{quotaGroupId:'subscription.images',constraintId:'other',appliesToModels:['*']}]);
 const conflicting=selectImageLearningScope([event(0,'quota_rejected','a',{quotaObservations:quota}),event(1,'quota_rejected','a',{quotaObservations:other})],'a');assert.equal(conflicting.scope.ambiguous,true);
 const rows=selectImageLearningScope([event(0,'quota_rejected','a',{quotaObservations:quota}),event(1,'quota_rejected','b',{quotaObservations:'[]'}),event(2,'succeeded','b')],'a');assert.deepEqual(rows.events.map(x=>x.outcome),['quota_rejected','succeeded']);
});
test('completed uncertainty permits only a later truncated warmup; no history or hold mutation',()=>{
 const unknown=event(0,'outcome_unknown');const rows=[unknown,...Array.from({length:10},(_,i)=>event(10+i,'succeeded'))];
 const result=estimateImageQuotaLearning(rows);assert.equal(result.diagnostics.safePeriod.excluded,1);assert.equal(result.diagnostics.safePeriod.afterUncertainty,at(1));assert.equal(result.estimate.state,'learning');assert.equal(result.diagnostics.scoredCandidates,0);assert.equal(unknown.outcome,'outcome_unknown');
 const live=estimateImageQuotaLearning([event(0,'in_flight',{},{completedAt:null}),...rows.slice(1)]);assert.equal(live.diagnostics.safePeriod.liveUncertainty,true);assert.equal(live.diagnostics.fits.length,0);
});
test('recovery interval names preserve first/last refusal and first success',()=>{
 const recovery=recoveryIntervals([event(0,'quota_rejected'),event(100,'quota_rejected'),event(160,'succeeded')]).intervals[0];
 assert.equal(recovery.from,at(1));assert.equal(recovery.lastRefusalAt,at(101));assert.equal(recovery.firstSuccessAt,at(160));assert.equal(recovery.minSeconds,100);assert.equal(recovery.maxSeconds,159);
});
test('next observation respects provider wait and distinguishes minimum evidence from completeness',()=>{
 const row={nextCheck:{at:at(1000)},coverage:{firstAt:at(0)},sampleCounts:{succeeded:1,quota_rejected:0},diagnostics:{safePeriod:{liveUncertainty:false},recovery:{completed:0},fits:[]}};
 const guidance=imageStudyGuidance(row,Date.parse(at(500)));assert.equal(guidance.stage,'waiting');assert.equal(guidance.missing[0].missing,5);assert.match(guidance.next,/Wait/);
 const held=imageStudyGuidance({...row,diagnostics:{safePeriod:{liveUncertainty:true}}},Date.parse(at(500)));assert.equal(held.stage,'review');
});
test('a sufficiently observed later period can fit without clearing older uncertain evidence',()=>{
 const history=[event(0,'outcome_unknown')];
 for(let cycle=0;cycle<12;cycle++){const start=100+cycle*100;history.push(event(start,'succeeded'),event(start+10,'succeeded'),event(start+20,'quota_rejected'));}
 const result=estimateImageQuotaLearning(history);assert.ok(result.diagnostics.scoredCandidates>0);assert.ok(result.diagnostics.fits.length>0);assert.equal(result.diagnostics.safePeriod.excluded,1);assert.equal(history[0].outcome,'outcome_unknown');
});
