import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
const sqlite=new DatabaseSync(':memory:');let sequence=0;
const db={driver:'node:sqlite',get:(sql,params=[])=>sqlite.prepare(sql).get(...params),all:(sql,params=[])=>sqlite.prepare(sql).all(...params),run:(sql,params=[])=>sqlite.prepare(sql).run(...params),exec:sql=>sqlite.exec(sql),transaction:fn=>{const key='s'+ ++sequence;sqlite.exec('SAVEPOINT '+key);try{const value=fn();sqlite.exec('RELEASE '+key);return value;}catch(e){sqlite.exec('ROLLBACK TO '+key);sqlite.exec('RELEASE '+key);throw e;}}};
globalThis._dbAdapter={instance:db,initPromise:null,logged:true};
const {MIGRATIONS}=await import('../../src/lib/db/migrations/index.js');for(const migration of MIGRATIONS)migration.up(db);
const {createAdminImageRun,claimAdminImageItem,finishAdminImageItem,controlAdminImageRun,readAdminImageRun,reconcileAdminImageRun,adminImageTestWakeDelay}=await import('../../src/lib/db/repos/adminImageTestRuns.js');
const targets=['a','b'].map(model=>({connectionId:'one',provider:'codex',model,quotaKey:'shared'}));
const ok={ok:true,outcomeUnknown:false,status:200,outputCount:1};
async function finish(result){const claim=await claimAdminImageItem('worker');assert.ok(claim);return {claim,run:await finishAdminImageItem(claim.runId,claim.item.operationId,'worker',result)};}
test('repeat runs one model at a time, changes durable operation IDs and stops at 429 before the next model',async()=>{
 const initial=await createAdminImageRun('fixture','repeat-plan-00000001',targets,{until429:true,maxAttempts:3});
 assert.equal((await createAdminImageRun('fixture','repeat-plan-00000001',targets,{until429:true,maxAttempts:3})).id,initial.id);
 await assert.rejects(createAdminImageRun('fixture','repeat-plan-00000001',[...targets].reverse(),{until429:true,maxAttempts:3}),e=>e.code==='idempotency_conflict');
 const first=await finish(ok),second=await finish({ok:false,outcomeUnknown:false,status:429,outputCount:0,sharedImageQuota:false,retryAt:new Date(Date.now()+3600000).toISOString()});
 assert.equal(first.claim.item.model,'a');assert.equal(second.claim.item.model,'a');assert.notEqual(first.claim.item.operationId,second.claim.item.operationId);
 const next=await finish(ok);assert.equal(next.claim.item.model,'b');await finish(ok);const last=await finish(ok);assert.equal(last.run.state,'completed');assert.equal(last.run.items.filter(i=>i.model==='b').length,3);assert.match(last.run.items.at(-1).message,/budget reached/);
});
test('shared quota refusal skips linked models and preserves reset guidance',async()=>{
 await createAdminImageRun('fixture','repeat-plan-00000002',targets,{until429:true,maxAttempts:2});const at=new Date(Date.now()+3600000).toISOString();
 const {run}=await finish({ok:false,outcomeUnknown:false,status:429,outputCount:0,sharedImageQuota:true,retryAt:at});
 assert.equal(run.state,'completed');assert.equal(run.items[1].state,'cancelled');assert.equal(run.items[1].retryAt,at);
});
test('fixed request counts run sequentially and stop on the first refusal',async()=>{
 const target={...targets[0],connectionId:'fixed-count',quotaKey:'fixed-count'};
 const initial=await createAdminImageRun('fixture','fixed-count-plan-000001',[target],{requestMode:'count',requestCount:3});
 const first=await finish(ok),second=await finish(ok),third=await finish(ok);
 assert.deepEqual([first.claim.item.sample,second.claim.item.sample,third.claim.item.sample],[1,2,3]);
 assert.notEqual(first.claim.item.operationId,second.claim.item.operationId);assert.equal(third.run.state,'completed');
 assert.equal(third.run.items.filter(item=>item.state==='succeeded').length,3);
 const stopped=await createAdminImageRun('fixture','fixed-count-stop-0001',[{...target,connectionId:'fixed-count-stop',quotaKey:'fixed-count-stop'}],{requestMode:'count',requestCount:3});
 const refusal=await finish({ok:false,outcomeUnknown:false,status:400,outputCount:0,failureCode:'provider_rejected'});
 assert.equal(refusal.run.state,'completed');assert.equal(refusal.run.items.length,1);assert.equal(refusal.run.items[0].state,'refused');
});
test('two-hit quota runs wait for the provider reset and count only confirmed image-quota 429s',async()=>{
 const target={...targets[0],connectionId:'quota-cycle',quotaKey:'quota-cycle'},retryAt=new Date(Date.now()+60_000).toISOString();
 const initial=await createAdminImageRun('fixture','quota-cycle-plan-000001',[target],{requestMode:'until_quota',requestCount:5,quotaLimitHits:2});
 const hit={ok:false,outcomeUnknown:false,status:429,outputCount:0,failureCode:'image_quota',quotaLimitHit:true,retryAt,retryConfidence:'provider_confirmed'};
 const first=await finish(hit);assert.equal(first.run.state,'waiting_reset');assert.equal(first.run.items[0].quotaHits,1);
 assert.equal(first.run.items[1].state,'pending');assert.equal(first.run.items[1].notBefore,retryAt);
 assert.ok(await adminImageTestWakeDelay()>0);assert.equal(await claimAdminImageItem('worker'),null);
 const resumed=await claimAdminImageItem('worker',Date.parse(retryAt)+1);assert.ok(resumed);assert.equal(resumed.item.sample,2);assert.equal(resumed.item.quotaHits,1);
 const completed=await finishAdminImageItem(resumed.runId,resumed.item.operationId,'worker',hit);
 assert.equal(completed.state,'completed');assert.equal(completed.items[1].quotaHits,2);assert.match(completed.items[1].message,/2 confirmed image quota limits/);
});
test('one-hit mode stops at the first confirmed limit; stale reset estimates do not trigger a retry',async()=>{
 const target={...targets[0],connectionId:'one-quota-hit',quotaKey:'one-quota-hit'};
 const initial=await createAdminImageRun('fixture','one-quota-hit-plan-0001',[target],{requestMode:'until_quota',requestCount:20,quotaLimitHits:1});
 const {run}=await finish({ok:false,outcomeUnknown:false,status:429,outputCount:0,failureCode:'image_quota',quotaLimitHit:true,retryAt:new Date(Date.now()+60_000).toISOString(),retryConfidence:'provider_confirmed'});
 assert.equal(run.state,'completed');assert.equal(run.items.length,1);assert.equal(run.items[0].quotaHits,1);
 const estimated=await createAdminImageRun('fixture','quota-estimate-plan-001',[{...target,connectionId:'estimate-only',quotaKey:'estimate-only'}],{requestMode:'until_quota',requestCount:5,quotaLimitHits:2});
 const unconfirmed=await finish({ok:false,outcomeUnknown:false,status:429,outputCount:0,failureCode:'image_quota',quotaLimitHit:true,retryAt:new Date(Date.now()+60_000).toISOString(),retryConfidence:'estimated'});
 assert.equal(unconfirmed.run.state,'completed');assert.equal(unconfirmed.run.items.length,1);assert.equal(unconfirmed.run.items[0].quotaHits,1);
 const ordinary429=await createAdminImageRun('fixture','quota-not-proven-plan-01',[{...target,connectionId:'not-quota',quotaKey:'not-quota'}],{requestMode:'until_quota',requestCount:5,quotaLimitHits:1});
 const providerRefusal=await finish({ok:false,outcomeUnknown:false,status:429,outputCount:0,failureCode:'provider_rejected',quotaLimitHit:false});
 assert.equal(providerRefusal.run.state,'completed');assert.equal(providerRefusal.run.items[0].quotaHits,0);
});
test('cancel and uncertain outcomes do not enqueue further physical calls',async()=>{
 const job=await createAdminImageRun('fixture','repeat-plan-00000003',targets,{until429:true,maxAttempts:20});const claim=await claimAdminImageItem('worker');
 await controlAdminImageRun(job.id,'stop',job.revision);
 const cancelled=await finishAdminImageItem(job.id,claim.item.operationId,'worker',ok);assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.items.length,2);
 const next=await createAdminImageRun('fixture','repeat-plan-00000004',targets,{until429:true,maxAttempts:20});const {run}=await finish({ok:false,outcomeUnknown:true});assert.equal(run.state,'needs_review');assert.equal(await claimAdminImageItem('worker'),null);
 const resolved=await reconcileAdminImageRun(next.id,async()=>ok,run.revision);assert.equal(resolved.state,'paused');assert.equal(resolved.items.length,3);assert.equal(await claimAdminImageItem('worker'),null);await controlAdminImageRun(next.id,'close',resolved.revision);
 await assert.rejects(createAdminImageRun('fixture','repeat-plan-00000005',Array.from({length:30},(_,i)=>({...targets[0],model:String(i)})),{until429:true,maxAttempts:20}),e=>e.code==='invalid_test_budget');
});
test('closing a held batch releases unrelated work without clearing uncertain targets',async()=>{
 const held=await createAdminImageRun('fixture','held-recovery-00000001',[targets[0]]);
 const {run}=await finish({ok:false,outcomeUnknown:true});
 await assert.rejects(createAdminImageRun('fixture','held-recovery-00000002',[targets[1]]),e=>e.code==='run_already_active');
 const closed=await controlAdminImageRun(held.id,'close',run.revision);assert.equal(closed.state,'cancelled');assert.equal(closed.items[0].state,'unknown');
 await assert.rejects(createAdminImageRun('fixture','held-recovery-00000003',[targets[0]]),e=>e.code==='target_outcome_unconfirmed');
 const other=await createAdminImageRun('fixture','held-recovery-00000004',[targets[1]]);assert.equal(other.state,'queued');
 await controlAdminImageRun(other.id,'stop',other.revision);
});
test.after(()=>sqlite.close());

test('a model disabled before dispatch does not pause independent pending work',async()=>{
 const initial=await createAdminImageRun('fixture','disabled-target-000001',targets.map(t=>({...t,connectionId:'disabled-fixture',quotaKey:'disabled-fixture'})));
 const blocked=await finish({ok:false,outcomeUnknown:false,status:503,outputCount:0,failureCode:'image_pool_paused',notSent:true,message:'Model turned off: no test sent.'});
 assert.equal(blocked.run.state,'queued');assert.equal(blocked.run.items[0].notSent,true);
 const next=await finish(ok);assert.equal(next.claim.item.model,'b');assert.equal(next.run.state,'completed');
});
test('other definite server guards still pause and unconfirmed work still needs review',async()=>{
 const initial=await createAdminImageRun('fixture','server-guard-00000001',targets.map(t=>({...t,connectionId:'guard-fixture',quotaKey:'guard-fixture'})));
 const blocked=await finish({ok:false,outcomeUnknown:false,status:503,outputCount:0,failureCode:'image_accounting_unavailable',notSent:true});
 assert.equal(blocked.run.state,'paused');await controlAdminImageRun(initial.id,'close',blocked.run.revision);
});

test('worker carries a local disabled-target guard into the durable continuation decision',async()=>{
 const {tickAdminImageTests}=await import('../../src/sse/services/adminImageTestWorker.js');
 const initial=await createAdminImageRun('fixture','worker-disabled-000001',targets.map(t=>({...t,connectionId:'worker-disabled',quotaKey:'worker-disabled'})));
 let calls=0;
 await tickAdminImageTests({owner:'fixture-worker',execute:async()=>{calls++;return Response.json({ok:false,outcomeUnknown:false,status:503,outputCount:0,failureCode:'image_pool_paused',notSent:true});}});
 const saved=await readAdminImageRun({id:initial.id});assert.equal(calls,1);assert.equal(saved.state,'queued');assert.equal(saved.items[0].failureCode,'image_pool_paused');assert.equal(saved.items[0].notSent,true);
 await controlAdminImageRun(saved.id,'stop',saved.revision);
});
