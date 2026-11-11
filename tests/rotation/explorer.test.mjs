import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRotation,emptyRotation,rotationMetrics } from '../../src/shared/utils/rotationSequence.mjs';
import { rotationStages,rotationMeasurements,quotaScopeSummary,resetAxis } from '../../src/shared/utils/rotationPreview.mjs';
const now=Date.parse('2026-11-06T10:00:00Z');
const connections=Array.from({length:6},(_,i)=>({id:String(i),accessToken:'must-not-leak'}));
const snapshots=Object.fromEntries(connections.map((row,i)=>[row.id,{provider:'codex',observedAt:now,quotas:[{id:'session',window:'session',scope:'codex:main',remaining:90-i*10,resetAt:now+[1,4,2,.5,3,1.5][i]*3600000},{id:'weekly',window:'weekly',scope:'codex:main',remaining:70-i*5,resetAt:now+86400000}]}]));
const policy={...emptyRotation(),enabled:true,sorts:[{key:'session-remaining',direction:'desc',division:'half'},{key:'session-reset',direction:'asc',division:'half'}]};
function run(p=policy,s=snapshots){const events=[];const result=evaluateRotation(connections,s,p,{provider:'codex',model:'gpt-6-sol',now,onStep:event=>events.push(event)});return {result,stages:rotationStages(events,p)};}
test('walkthrough captures real sorted, split and final orders without rerunning a different algorithm',()=>{
 const {result,stages}=run();assert.deepEqual(stages.map(s=>s.id),['eligible','sort-0','waiting','split-1','sort-1']);
 assert.deepEqual(stages[1].groups.flatMap(g=>g.ids),['0','1','2','3','4','5']);assert.deepEqual(stages[3].groups.map(g=>g.ids),[['0','1','2'],['3','4','5']]);assert.deepEqual(stages[4].groups.map(g=>g.ids),[['0','2','1'],['3','5','4']]);
 assert.deepEqual(stages.at(-1).groups.flatMap(g=>g.ids),result.ranked.map(r=>r.connection.id));assert.ok(!JSON.stringify(stages).includes('must-not-leak'));
});
test('trace is observational across three/four rules, missing values, credit priority and all division modes',()=>{
 for(const division of ['half','median','gap'])for(let variant=0;variant<30;variant++){
 const p={...policy,resetPriority:{enabled:variant%2===0,days:3,weeklyBelow:null},sorts:rotationMetrics('codex').map((m,i)=>({key:m.key,direction:(variant+i)%2?'asc':'desc',division}))};
 const s=Object.fromEntries(Object.entries(snapshots).map(([id,v],i)=>[id,{...v,quotas:variant%5===i?[]:v.quotas.map(q=>({...q,remaining:variant%3? q.remaining:50})),credits:{observedAt:now,availableCount:i%3===0?1:0,expiresAt:now+86400000}}]));
 const {result,stages}=run(p,s),without=evaluateRotation(connections,s,p,{provider:'codex',model:'gpt-6-sol',now});assert.deepEqual(result,without);
 for(const stage of stages)assert.deepEqual([...stage.groups.flatMap(g=>g.ids)].sort(),connections.map(c=>c.id).sort());
 assert.deepEqual(stages.at(-1).groups.map(g=>g.ids),result.segments.map(g=>g.rows.map(r=>r.connection.id)));
 }
});
test('equal-value and missing split notes remain distinct from actual count splitting',()=>{
 const s=Object.fromEntries(Object.entries(snapshots).map(([id,v])=>[id,{...v,quotas:v.quotas.map(q=>({...q,remaining:50}))}]));
 const median=run({...policy,sorts:policy.sorts.map(rule=>({...rule,division:'median'}))},s);assert.equal(median.stages[3].groups.length,1);assert.equal(median.stages[3].groups[0].note,'No value split: values equal');
 assert.equal(run(policy,s).stages[3].groups.length,2);
 const missing=run(policy,{});assert.match(missing.stages[1].groups[0].note,/not reported/);assert.equal(missing.stages[3].groups.length,1);
});
test('all applicable windows stay visible regardless active sort; model families stay separate',()=>{
 const values=rotationMeasurements(snapshots['0'],'codex','gpt-6-sol',now);assert.equal(Object.keys(values).length,5);assert.equal(values['workload-capacity'],null);assert.equal(values['weekly-remaining'],70);
 assert.match(quotaScopeSummary(snapshots['0'],'codex','gpt-6-sol',now),/shared/);
 const spark=rotationMeasurements(snapshots['0'],'codex','gpt-6-spark',now);assert.ok(Object.values(spark).every(v=>v===null));assert.match(quotaScopeSummary(snapshots['0'],'codex','gpt-6-spark',now),/not reported/);
});
test('time axes are proportional, share a fixed range, and mark off-scale/due/missing explicitly',()=>{
 const values=[now+3600000,now+2*3600000,now+4*3600000,now+8*3600000,null,now-1];const axis=resetAxis(values,now,4*3600000);
 assert.deepEqual(axis.ticks.map(t=>t.fraction),[0,.25,.5,.75,1]);assert.deepEqual(axis.points.slice(0,3).map(p=>p.position),[.25,.5,1]);assert.equal(axis.points[3].offScale,true);assert.equal(axis.points[4],null);assert.equal(axis.points[5].due,true);assert.equal(resetAxis([null],now).horizon,3600000);
});
test('disabled sequence exposes eligibility only without pretending rules executed',()=>{
 const {stages}=run({...policy,enabled:false});assert.deepEqual(stages.map(s=>s.id),['eligible']);
});
