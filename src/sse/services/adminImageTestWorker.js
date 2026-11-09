import { randomUUID } from 'node:crypto';
import { adminImageTestWakeDelay, claimAdminImageItem, heartbeatAdminImageRun, finishAdminImageItem } from '@/lib/db/repos/adminImageTestRuns';
import { executeAdminImageTest } from './adminImageTest';

const singleton = global.__adminImageTestWorker ??= {owner:randomUUID(),busy:false,timer:null};
export async function tickAdminImageTests({owner=singleton.owner,execute=executeAdminImageTest}={}) {
 const claim=await claimAdminImageItem(owner);if(!claim)return false;
 const heartbeat=setInterval(()=>heartbeatAdminImageRun(claim.runId,owner).catch(()=>{}),30_000);heartbeat.unref?.();
 let result;
 try {
  const response=await execute(new Request('http://127.0.0.1/api/models/image-test',{method:'POST'}),claim.item);
  const data=await response.json();
  if(data?.ok===true&&!response.ok){
   result={ok:false,outcomeUnknown:true,message:'Contradictory test response; reconcile saved evidence before continuing.'};
  }else if(typeof data?.outcomeUnknown!=='boolean'||typeof data.ok!=='boolean'){
   result=response.status>=400&&response.status<500?{ok:false,status:response.status,outcomeUnknown:false,message:'Test refused before dispatch.'}:{ok:false,outcomeUnknown:true,message:'Unconfirmed test response; inspect activity.'};
  }else{
   result={ok:data.ok,failureCode:typeof data.failureCode==='string'?data.failureCode:null,quotaLimitHit:data.quotaLimitHit===true,notSent:data.notSent===true,status:Number.isInteger(data.status)?data.status:response.status,outcomeUnknown:data.outcomeUnknown,outputCount:Number.isSafeInteger(data.outputCount)?data.outputCount:0,
    sharedImageQuota:data.sharedImageQuota===true,
    requestId:typeof data.requestId==='string'?data.requestId:null,
    retryAt:typeof data.retryAt==='string'&&Number.isFinite(Date.parse(data.retryAt))?data.retryAt:null,
    retrySource:typeof data.retrySource==='string'?data.retrySource.slice(0,80):null,
    retryConfidence:['provider_confirmed','estimated','unknown'].includes(data.retryConfidence)?data.retryConfidence:'unknown',
    message:typeof data.message==='string'?data.message.slice(0,300):'Test finished.'};
  }
 }catch{result={ok:false,outcomeUnknown:true,message:'Outcome unconfirmed; reconcile the saved request before continuing.'};}
 finally{clearInterval(heartbeat);}
 await finishAdminImageItem(claim.runId,claim.item.operationId,owner,result);return true;
}
export function startAdminImageTestWorker() {
 if(process.env.IMAGE_ADMIN_TEST_WORKER_ENABLED==='false'||singleton.busy)return;
 if(singleton.timer)clearTimeout(singleton.timer);
 const schedule=delay=>{
  singleton.timer=setTimeout(async()=>{
   singleton.timer=null;
   if(singleton.busy)return;
   singleton.busy=true;
   try{await tickAdminImageTests();}catch{console.warn('[AdminImageTests] Worker state unavailable');}
   finally{
    singleton.busy=false;
    try{schedule(await adminImageTestWakeDelay()??15_000);}catch{schedule(5_000);}
   }
  },Math.max(0,delay));
  singleton.timer.unref?.();
 };
 schedule(0);
}
