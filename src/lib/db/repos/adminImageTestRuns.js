import { randomUUID, createHash } from 'node:crypto';
import { getAdapter } from '../driver.js';

const ACTIVE = "('queued','running','stopping','waiting_reset','paused','needs_review')";
export const TEST_LEASE_MS = 600_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const nowIso = () => new Date().toISOString();
export class AdminImageRunError extends Error { constructor(code, status = 409) { super(code); this.code=code; this.status=status; } }
async function store() {
  const db=await getAdapter();
  if(!['node:sqlite','better-sqlite3','bun:sqlite'].includes(db.driver)) throw new AdminImageRunError('durable_store_required',503);
  return db;
}
function project(row) {
  if(!row)return null;
  return {id:row.id,state:row.state,revision:Number(row.revision),items:JSON.parse(row.itemsJson),createdAt:row.createdAt,updatedAt:row.updatedAt};
}
function settlement(result) {
  const status=Number.isInteger(result?.status)&&result.status>=100&&result.status<=599?result.status:null;
  const outputs=Number.isSafeInteger(result?.outputCount)&&result.outputCount>=0?result.outputCount:null;
  const ok=result?.ok===true&&result.outcomeUnknown===false&&status>=200&&status<300&&outputs>0;
  const refused=result?.ok===false&&result.outcomeUnknown===false&&status>=400&&(result.outputCount===undefined||outputs===0);
  const uncertain=!ok&&!refused;
  const failureCode=typeof result?.failureCode==='string'&&/^[a-z_]{1,80}$/.test(result.failureCode)?result.failureCode:null;
  return {ok,outcomeUnknown:uncertain,failureCode,notSent:result?.notSent===true,status,outputCount:ok?outputs:0,sharedImageQuota:result?.sharedImageQuota===true,
    quotaLimitHit:result?.quotaLimitHit===true&&failureCode==='image_quota'&&result?.ok===false&&result?.outcomeUnknown===false&&!result?.notSent&&status===429&&outputs===0,
    requestId:typeof result?.requestId==='string'&&/^[A-Za-z0-9._:-]{1,160}$/.test(result.requestId)?result.requestId:null,
    retryAt:typeof result?.retryAt==='string'&&result.retryAt.length<=80&&Number.isFinite(Date.parse(result.retryAt))?new Date(result.retryAt).toISOString():null,
    retrySource:typeof result?.retrySource==='string'&&/^[a-z0-9_:-]{1,80}$/.test(result.retrySource)?result.retrySource:null,
    retryConfidence:['provider_confirmed','estimated','unknown'].includes(result?.retryConfidence)?result.retryConfidence:'unknown',
    message:(!uncertain||result?.ok===false&&result.outcomeUnknown===true)&&typeof result?.message==='string'?result.message.slice(0,300):'Outcome unconfirmed; reconcile saved evidence before continuing.'};
}
function enqueueSample(items,item,{stopped=false,notBefore=null,quotaHits=item.quotaHits||0}={}) {
  if(stopped||items.length>=500)return;
  items.splice(items.indexOf(item)+1,0,{connectionId:item.connectionId,provider:item.provider,model:item.model,quotaKey:item.quotaKey,
    ...(item.requestMode?{requestMode:item.requestMode,requestCount:item.requestCount,quotaLimitHits:item.quotaLimitHits,quotaHits}:{}),
    ...(item.maxAttempts?{maxAttempts:item.maxAttempts}:{}),sample:item.sample+1,operationId:randomUUID(),state:'pending',...(notBefore?{notBefore,quotaCycleContinuation:true}:{})});
}
function continueSample(items,item,stopped) {
  if(item.requestMode==='count'){
    if(item.ok&&item.sample<item.requestCount)enqueueSample(items,item,{stopped});
    if(item.ok&&item.sample===item.requestCount)item.message='Request count reached.';
    return;
  }
  if(item.quotaLimitHit&&item.requestMode==='until_quota'){
    const quotaHits=(item.quotaHits||0)+1;item.quotaHits=quotaHits;
    if(quotaHits>=item.quotaLimitHits){item.message=`${quotaHits} confirmed image quota ${quotaHits===1?'limit':'limits'} reached.`;return;}
    if(item.sample>=item.maxAttempts){item.message='Request cap reached before the next quota limit.';return;}
    const retryAt=Date.parse(item.retryAt);
    if(item.retryConfidence!=='provider_confirmed'||!Number.isFinite(retryAt)||retryAt<=Date.now()){
      item.message='Stopped after the first quota limit; no future provider-confirmed reset time is available.';return;
    }
    enqueueSample(items,item,{stopped,notBefore:new Date(retryAt).toISOString(),quotaHits});
    return;
  }
  if(item.ok&&item.maxAttempts&&item.sample<item.maxAttempts)enqueueSample(items,item,{stopped});
  if(item.ok&&item.maxAttempts&&item.sample===item.maxAttempts)item.message='Sample budget reached; quota limit not observed.';
}
function unresolvedTargets(db) {
  return db.all("SELECT id,itemsJson,createdAt FROM adminImageTestRuns WHERE itemsJson LIKE '%\"unknown\"%'").flatMap(row =>
    JSON.parse(row.itemsJson).filter(item => item.state === 'unknown').map(({connectionId,provider,model,operationId,quotaKey}) => ({connectionId,provider,model,operationId,quotaKey,runId:row.id,createdAt:row.createdAt})));
}
export async function readUnresolvedImageTargets() {
  return unresolvedTargets(await store());
}
export async function assertImageTargetResolved(connectionId,model) {
  if ((await readUnresolvedImageTargets()).some(item => item.connectionId === connectionId && item.model === model))
    throw new AdminImageRunError('target_outcome_unconfirmed');
}
export async function createAdminImageRun(principal,key,targets,{until429=false,maxAttempts=20,requestMode=null,requestCount=1,quotaLimitHits=1}={}) {
  if(typeof key!=='string'||!/^[A-Za-z0-9._:-]{16,120}$/.test(key)||!Array.isArray(targets)||!targets.length||targets.length>500)throw new AdminImageRunError('invalid_plan',422);
  if(typeof until429!=='boolean'||requestMode!==null&&!['count','until_quota'].includes(requestMode)||requestMode&&until429||!Number.isSafeInteger(requestCount)||requestCount<1||requestCount>100||!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>100||!Number.isSafeInteger(quotaLimitHits)||![1,2].includes(quotaLimitHits))throw new AdminImageRunError('invalid_test_budget',422);
  const mode=requestMode||(until429?'until_quota':null),budget=mode==='count'?requestCount:mode==='until_quota'?requestMode?requestCount:maxAttempts:1;
  if(mode&&targets.length*budget>500)throw new AdminImageRunError('invalid_test_budget',422);
  const ordered=targets.map(({connectionId,provider,model})=>({connectionId,provider,model}));
  const canonical=requestMode==='count'?{targets:ordered,requestMode,requestCount}:requestMode==='until_quota'?{targets:ordered,requestMode,requestCount,quotaLimitHits}:until429?{targets:ordered,until429,maxAttempts}:ordered.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const digest=hash(JSON.stringify(canonical)),commandKey=hash(principal+'\n'+key),db=await store();
  return db.transaction(()=>{
    const prior=db.get('SELECT * FROM adminImageTestRuns WHERE commandKey=?',[commandKey]);
    if(prior){if(prior.digest!==digest)throw new AdminImageRunError('idempotency_conflict');return project(prior);}
    if(unresolvedTargets(db).some(item=>targets.some(target=>(target.connectionId===item.connectionId||target.quotaKey&&target.quotaKey===item.quotaKey)&&target.model===item.model)))throw new AdminImageRunError('target_outcome_unconfirmed');
    if(db.get(`SELECT id FROM adminImageTestRuns WHERE state IN ${ACTIVE} LIMIT 1`))throw new AdminImageRunError('run_already_active');
    const id=randomUUID(),at=nowIso();
    const items=targets.map((target,index)=>({...target,operationId:randomUUID(),...(mode==='count'?{requestMode:mode,requestCount,sample:1}:mode==='until_quota'?{requestMode:mode,requestCount:budget,maxAttempts:budget,quotaLimitHits:requestMode?quotaLimitHits:1,quotaHits:0,sample:1}:{}),state:targets.slice(0,index).some(prior=>target.quotaKey&&prior.quotaKey===target.quotaKey&&prior.model===target.model)?'cancelled':'pending',...(targets.slice(0,index).some(prior=>target.quotaKey&&prior.quotaKey===target.quotaKey&&prior.model===target.model)?{message:'Skipped: linked credential shares this subscription model quota.'}:{})}));
    db.run("INSERT INTO adminImageTestRuns(id,commandKey,digest,state,itemsJson,createdAt,updatedAt) VALUES(?,?,?,'queued',?,?,?)",[id,commandKey,digest,JSON.stringify(items),at,at]);
    return project(db.get('SELECT * FROM adminImageTestRuns WHERE id=?',[id]));
  });
}
export async function readAdminImageRun({id=null,principal=null,key=null}={}) {
 const db=await store();
 if(id)return project(db.get('SELECT * FROM adminImageTestRuns WHERE id=?',[id]));
 if(key)return project(db.get('SELECT * FROM adminImageTestRuns WHERE commandKey=?',[hash(principal+'\n'+key)]));
 return project(db.get(`SELECT * FROM adminImageTestRuns ORDER BY CASE WHEN state IN ${ACTIVE} THEN 0 ELSE 1 END,createdAt DESC LIMIT 1`));
}
export async function claimAdminImageItem(owner,now=Date.now()) {
 const db=await store();
 return db.transaction(()=>{
  const row=db.get("SELECT * FROM adminImageTestRuns WHERE state IN ('queued','running','stopping','waiting_reset') ORDER BY createdAt LIMIT 1");
  if(!row||row.owner&&row.leaseUntil>now)return null;
  const items=JSON.parse(row.itemsJson);
  const inFlight=items.find(item=>item.state==='running');
  if(inFlight){
    inFlight.state='unknown';inFlight.outcomeUnknown=true;inFlight.message='Worker interrupted; reconcile the saved request before continuing.';
    db.run("UPDATE adminImageTestRuns SET state='needs_review',itemsJson=?,owner=NULL,leaseUntil=0,revision=revision+1,updatedAt=? WHERE id=?",[JSON.stringify(items),nowIso(),row.id]);return null;
  }
  if(row.stopRequested){for(const item of items)if(item.state==='pending')item.state='cancelled';db.run("UPDATE adminImageTestRuns SET state='cancelled',itemsJson=?,owner=NULL,leaseUntil=0,revision=revision+1,updatedAt=? WHERE id=?",[JSON.stringify(items),nowIso(),row.id]);return null;}
  const item=items.find(item=>item.state==='pending'&&(!item.notBefore||Date.parse(item.notBefore)<=now));
  const deferred=items.filter(item=>item.state==='pending'&&item.notBefore&&Date.parse(item.notBefore)>now);
  if(!item&&deferred.length){if(row.state!=='waiting_reset')db.run("UPDATE adminImageTestRuns SET state='waiting_reset',owner=NULL,leaseUntil=0,revision=revision+1,updatedAt=? WHERE id=?",[nowIso(),row.id]);return null;}
  if(!item){db.run("UPDATE adminImageTestRuns SET state='completed',owner=NULL,leaseUntil=0,revision=revision+1,updatedAt=? WHERE id=?",[nowIso(),row.id]);return null;}
  item.state='running';item.startedAt=nowIso();
  db.run("UPDATE adminImageTestRuns SET state='running',itemsJson=?,owner=?,leaseUntil=?,revision=revision+1,updatedAt=? WHERE id=?",[JSON.stringify(items),owner,now+TEST_LEASE_MS,nowIso(),row.id]);
  return {runId:row.id,item:{...item}};
 });
}
export async function adminImageTestWakeDelay(now=Date.now()) {
 const db=await store();
 const row=db.get("SELECT state,owner,leaseUntil,stopRequested,itemsJson FROM adminImageTestRuns WHERE state IN ('queued','running','stopping','waiting_reset') ORDER BY createdAt LIMIT 1");
 if(!row)return null;
 if(row.owner&&row.leaseUntil>now)return Math.min(row.leaseUntil-now,30_000);
 if(row.stopRequested||row.state==='running'||row.state==='stopping')return 0;
 const items=JSON.parse(row.itemsJson),pending=items.filter(item=>item.state==='pending');
 if(pending.some(item=>!item.notBefore||Date.parse(item.notBefore)<=now))return 0;
 if(!pending.length)return 0;
 const next=Math.min(...pending.map(item=>Date.parse(item.notBefore)).filter(Number.isFinite));
 return Number.isFinite(next)?Math.max(0,next-now):0;
}
export async function heartbeatAdminImageRun(id,owner) {
 const db=await store();db.run("UPDATE adminImageTestRuns SET leaseUntil=? WHERE id=? AND owner=? AND state IN ('running','stopping')",[Date.now()+TEST_LEASE_MS,id,owner]);
}
export async function finishAdminImageItem(id,operationId,owner,result) {
 const db=await store();return db.transaction(()=>{
  const row=db.get('SELECT * FROM adminImageTestRuns WHERE id=?',[id]);
  if(!row||row.owner!==owner)return null;
  const items=JSON.parse(row.itemsJson),item=items.find(value=>value.operationId===operationId);
  if(!item||item.state!=='running')return null;
  const settled=settlement(result);
  Object.assign(item,settled,{state:settled.outcomeUnknown?'unknown':settled.ok?'succeeded':'refused',completedAt:nowIso()});
  continueSample(items,item,Boolean(row.stopRequested));
  // A definite refusal constrains its subscription identity, not unrelated accounts.
  if(!settled.outcomeUnknown && [401,403,429].includes(settled.status)) {
   for(const next of items) if(next.state==='pending'&&!next.quotaCycleContinuation && (item.quotaKey&&next.quotaKey===item.quotaKey||next.connectionId===item.connectionId)
     && ([401,403].includes(settled.status)||settled.sharedImageQuota||next.model===item.model)) {
    Object.assign(next,{state:'cancelled',retryAt:settled.retryAt,retryConfidence:settled.retryConfidence,
     message:settled.status===429?'Skipped: linked image quota reached; wait for the recorded reset.':'Skipped: subscription account needs sign-in or access.'});
   }
  }
  // A disabled target was never sent; independent eligible work can continue.
  let state=settled.outcomeUnknown?'needs_review':settled.status>=500&&!(settled.notSent&&settled.failureCode==='image_pool_paused')?'paused':'queued';
  if(row.stopRequested){for(const next of items)if(next.state==='pending')next.state='cancelled';if(state!=='needs_review')state='cancelled';}
  if(state==='queued'){
   const pending=items.filter(next=>next.state==='pending');
   if(!pending.length)state='completed';
   else if(!pending.some(next=>!next.notBefore||Date.parse(next.notBefore)<=Date.now()))state='waiting_reset';
  }
  db.run('UPDATE adminImageTestRuns SET state=?,itemsJson=?,owner=NULL,leaseUntil=0,revision=revision+1,updatedAt=? WHERE id=?',[state,JSON.stringify(items),nowIso(),id]);return project(db.get('SELECT * FROM adminImageTestRuns WHERE id=?',[id]));
 });
}
export async function controlAdminImageRun(id,action,revision) {
 const db=await store();return db.transaction(()=>{
  const row=db.get('SELECT * FROM adminImageTestRuns WHERE id=?',[id]);if(!row)throw new AdminImageRunError('run_not_found',404);
  if(action!=='stop'&&row.revision!==revision)throw new AdminImageRunError('revision_conflict');
  if(action==='stop'&&['completed','cancelled'].includes(row.state))return project(row);
  const items=JSON.parse(row.itemsJson);
  if(action==='close'){
   if(!['needs_review','paused'].includes(row.state)||items.some(item=>item.state==='running'))throw new AdminImageRunError('run_not_closable');
   for(const item of items)if(item.state==='pending')item.state='cancelled';
   db.run("UPDATE adminImageTestRuns SET state='cancelled',itemsJson=?,stopRequested=1,revision=revision+1,updatedAt=? WHERE id=?",[JSON.stringify(items),nowIso(),id]);
  }else if(action==='stop'){
   for(const item of items)if(item.state==='pending')item.state='cancelled';
   const state=items.some(item=>item.state==='unknown')?'needs_review':items.some(item=>item.state==='running')?'stopping':'cancelled';
   db.run('UPDATE adminImageTestRuns SET state=?,itemsJson=?,stopRequested=1,revision=revision+1,updatedAt=? WHERE id=?',[state,JSON.stringify(items),nowIso(),id]);
  }else if(action==='resume'){
   if(row.state!=='paused'||items.some(item=>['running','unknown'].includes(item.state)))throw new AdminImageRunError('reconciliation_required');
   const blockedAccounts=new Set(items.filter(item=>item.state==='refused'&&([401,403].includes(item.status)||item.status===429&&(!item.retryAt||Date.parse(item.retryAt)>Date.now()))).map(item=>item.connectionId));
   for(const item of items)if(item.state==='pending'&&blockedAccounts.has(item.connectionId)){
    item.state='cancelled';item.message='Skipped: this account is quota-limited or requires sign-in. No test sent.';
   }
   const state=items.some(item=>item.state==='pending')?'queued':'cancelled';
   db.run("UPDATE adminImageTestRuns SET state=?,itemsJson=?,stopRequested=?,revision=revision+1,updatedAt=? WHERE id=?",[state,JSON.stringify(items),state==='cancelled'?1:0,nowIso(),id]);
  }else throw new AdminImageRunError('invalid_action',422);
  return project(db.get('SELECT * FROM adminImageTestRuns WHERE id=?',[id]));
 });
}
export async function reconcileAdminImageRun(id,observe,revision) {
 const original=await readAdminImageRun({id});if(!original)throw new AdminImageRunError('run_not_found',404);
 if(revision!==undefined&&revision!==original.revision)throw new AdminImageRunError('revision_conflict');
 if(!['needs_review','cancelled'].includes(original.state)||!original.items.some(item=>item.state==='unknown'))throw new AdminImageRunError('reconciliation_not_required');
 const updates=[];
 for(const item of original.items.filter(value=>value.state==='unknown')){
  const result=await observe(item.operationId);if(result)updates.push([item.operationId,result]);
 }
 const db=await store();return db.transaction(()=>{
  const row=db.get('SELECT * FROM adminImageTestRuns WHERE id=?',[id]);if(!row||row.revision!==original.revision)throw new AdminImageRunError('revision_conflict');
  const items=JSON.parse(row.itemsJson);
  let changed=false;
  for(const [operationId,result]of updates){
   const settled=settlement(result);if(settled.outcomeUnknown)continue;
   const item=items.find(item=>item.operationId===operationId);
   Object.assign(item,settled,{state:settled.ok?'succeeded':'refused',reconciledAt:nowIso()});
   continueSample(items,item,row.state==='cancelled'||Boolean(row.stopRequested));changed=true;
  }
  if(!changed)return project(row);
  const state=row.state==='cancelled'?'cancelled':items.some(item=>item.state==='unknown')?'needs_review':row.stopRequested?'cancelled':items.some(item=>item.state==='pending')?(items.some(item=>item.state==='pending'&&(!item.notBefore||Date.parse(item.notBefore)<=Date.now()))?'paused':'waiting_reset'):'completed';
  db.run('UPDATE adminImageTestRuns SET state=?,itemsJson=?,revision=revision+1,updatedAt=? WHERE id=?',[state,JSON.stringify(items),nowIso(),id]);return project(db.get('SELECT * FROM adminImageTestRuns WHERE id=?',[id]));
 });
}
