import { getDashboardAuthSession } from '@/lib/auth/dashboardSession';
import { isAuthenticated } from '@/dashboardGuard';
import { imageQuotaIdentity, imageQuotaIdentityGeneration } from '@/lib/db/repos/imageQuotaIdentity.js';
import { createHash } from 'node:crypto';
import { getProviderConnections } from '@/lib/localDb';
import { getImageQuotaModelCatalog } from '@/lib/db/repos/imageQuotaInsights';
import { getImageRequestTrace } from '@/lib/db/repos/imageQuotaRepo';
import { createAdminImageRun,readAdminImageRun,controlAdminImageRun,reconcileAdminImageRun,readUnresolvedImageTargets,AdminImageRunError } from '@/lib/db/repos/adminImageTestRuns';
import { startAdminImageTestWorker } from '@/sse/services/adminImageTestWorker';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const result=async(run,status=200)=>json({schema:'admin_image_tests.v1',run,blockedTargets:await readUnresolvedImageTargets()},status);
async function principal(request){
 if(!await isAuthenticated(request))return null;
 const session=await getDashboardAuthSession(request.cookies?.get?.('auth_token')?.value);
 return session?String(session.sub||session.oidcEmail||session.samlEmail||session.email||'operator'):null;
}
async function readBody(request){
 const text=await request.text();
 if(text.length>150000)throw new AdminImageRunError('body_too_large',413);
 try{return JSON.parse(text);}catch{throw new AdminImageRunError('invalid_json',422);}
}
function fail(error){return json({error:error instanceof AdminImageRunError?error.code:'test_service_unavailable'},error instanceof AdminImageRunError?error.status:503);}
export async function GET(request){
 const actor=await principal(request);if(!actor)return json({error:'dashboard_sign_in_required'},401);
 const q=new URL(request.url).searchParams;
 if([...q.keys()].some(key=>!['id','key'].includes(key))||q.get('id')&&!UUID.test(q.get('id'))||q.get('key')&&!/^[A-Za-z0-9._:-]{16,120}$/.test(q.get('key')))return json({error:'invalid_lookup'},422);
 try{
  const run=await readAdminImageRun({id:q.get('id'),key:q.get('key'),principal:actor});
  if(!q.get('id')||!run)return await result(run);
  const recovery=[];
  for(const item of run.items.filter(item=>item.state==='unknown')){
   const trace=await getImageRequestTrace({clientOperationId:item.operationId});
   const submissions=(trace.requests||[]).flatMap(request=>request.submissions||[]);
   recovery.push({operationId:item.operationId,model:item.model,createdAt:run.createdAt,
    evidence:trace.truncated?'incomplete':submissions.length!==1?'not_confirmed':submissions[0].outcome==='outcome_unknown'||submissions[0].outcome==='in_flight'?'outcome_unknown':'recorded',
    dispatchedAt:submissions.length===1?submissions[0].dispatched_at:null,httpStatus:submissions.length===1?submissions[0].http_status:null});
  }
  return json({schema:'admin_image_tests.v1',run,blockedTargets:await readUnresolvedImageTargets(),recovery});
 }catch(error){return fail(error);}
}
export async function POST(request){
 const actor=await principal(request);if(!actor)return json({error:'dashboard_sign_in_required'},401);
 try{
  const body=await readBody(request);
  if(!body||Array.isArray(body)||Object.keys(body).some(key=>!['targets','until429','maxAttempts','requestMode','requestCount','quotaLimitHits'].includes(key))||!Array.isArray(body.targets)||!body.targets.length||body.targets.length>500)throw new AdminImageRunError('invalid_plan',422);
  if(body.until429!==undefined&&typeof body.until429!=='boolean'||body.maxAttempts!==undefined&&(!Number.isSafeInteger(body.maxAttempts)||body.maxAttempts<1||body.maxAttempts>100)||body.requestMode!==undefined&&!['count','until_quota'].includes(body.requestMode)||body.requestCount!==undefined&&(!Number.isSafeInteger(body.requestCount)||body.requestCount<1||body.requestCount>100)||body.quotaLimitHits!==undefined&&![1,2].includes(body.quotaLimitHits)||body.requestMode&&body.until429||body.requestMode==='count'&&body.quotaLimitHits!==undefined||body.requestMode&&body.maxAttempts!==undefined)throw new AdminImageRunError('invalid_test_budget',422);
  const connections=await getProviderConnections({isActive:true}),catalog=await getImageQuotaModelCatalog(),targets=[];
  for(const item of body.targets){
   if(!item||Array.isArray(item)||Object.keys(item).some(key=>!['connectionId','model'].includes(key))||typeof item.connectionId!=='string'||typeof item.model!=='string')throw new AdminImageRunError('invalid_target',422);
   const connection=connections.find(value=>value.id===item.connectionId&&value.isActive!==false);
   if(!connection||!catalog.some(value=>value.provider===connection.provider&&value.id===item.model&&value.capabilities?.generation))throw new AdminImageRunError('unavailable_target',422);
   if((body.until429||body.requestMode==='until_quota')&&(!['codex','antigravity','gemini'].includes(connection.provider)||['apikey','api-key','api_key'].includes(connection.authType)))throw new AdminImageRunError('subscription_test_only',422);
   if(!targets.some(value=>value.connectionId===item.connectionId&&value.model===item.model))targets.push({connectionId:connection.id,provider:connection.provider,model:item.model,
    quotaKey:createHash('sha256').update(JSON.stringify([connection.provider,imageQuotaIdentity(connection),imageQuotaIdentityGeneration(connection)])).digest('hex')});
  }
  const options=body.requestMode==='count'?{requestMode:'count',requestCount:body.requestCount??1}:body.requestMode==='until_quota'?{requestMode:'until_quota',requestCount:body.requestCount??20,quotaLimitHits:body.quotaLimitHits??1}:{until429:body.until429===true,maxAttempts:body.maxAttempts??20};
  const run=await createAdminImageRun(actor,request.headers.get('Idempotency-Key'),targets,options);
  startAdminImageTestWorker();return await result(run,202);
 }catch(error){return fail(error);}
}
async function observe(operationId){
 const trace=await getImageRequestTrace({clientOperationId:operationId});
 if(trace.truncated||trace.requests?.length!==1)return null;
 const submissions=trace.requests.flatMap(run=>run.submissions||[]);
 // Admin samples permit one physical dispatch; conflicting/replayed evidence stays held.
 if(submissions.length!==1)return null;
 const proof=submissions[0];
 if(!Number.isInteger(proof.http_status)||!Number.isSafeInteger(proof.output_count))return null;
 if(proof.outcome==='succeeded'){
  if(proof.http_status<200||proof.http_status>=300||proof.output_count<=0)return null;
 }else if(!['quota_rejected','provider_rejected'].includes(proof.outcome)||proof.http_status<400||proof.http_status>599||proof.output_count!==0)return null;
 const success=proof.outcome==='succeeded';
 const quotaLimitHit=proof.outcome==='quota_rejected'&&proof.failure_class==='image_quota'&&proof.http_status===429&&proof.output_count===0;
 return {state:success?'succeeded':'refused',ok:success,outcomeUnknown:false,status:proof.http_status,requestId:trace.requests[0].router_request_id,
  outputCount:proof.output_count,retryAt:proof.retry_at||null,retryConfidence:proof.confidence||'unknown',quotaLimitHit,failureCode:quotaLimitHit?'image_quota':null,message:success?'Saved image output confirmed.':quotaLimitHit?'Saved image quota limit confirmed.':'Saved provider refusal confirmed.'};
}
export async function PATCH(request){
 if(!await principal(request))return json({error:'dashboard_sign_in_required'},401);
 try{
  const body=await readBody(request);
  if(!body||Object.keys(body).some(key=>!['id','action','revision'].includes(key))||!UUID.test(body.id||'')||!['stop','resume','reconcile','close'].includes(body.action)||!Number.isSafeInteger(body.revision))throw new AdminImageRunError('invalid_control',422);
  const run=body.action==='reconcile'?await reconcileAdminImageRun(body.id,observe,body.revision):await controlAdminImageRun(body.id,body.action,body.revision);
  startAdminImageTestWorker();return await result(run);
 }catch(error){return fail(error);}
}
