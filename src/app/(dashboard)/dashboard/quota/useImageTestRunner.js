"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { validImageTestRun, validBlockedImageTargets, imageRunReadError } from './imageRunStatus.mjs';

const ACTIVE=new Set(['queued','running','stopping','waiting_reset']);
const HELD=new Set(['paused','needs_review']);
export default function useImageTestRunner(refresh,accounts=[]) {
 const [blockedTargets,setBlockedTargets]=useState([]);
 const [recoveryNotice,setRecoveryNotice]=useState(''),[checkingHeld,setCheckingHeld]=useState(null);
 const heldCheck=useRef(false);
 const blockedSnapshot=useRef('[]');
 const acceptBlocked=useCallback(targets=>{const snapshot=JSON.stringify(targets);if(blockedSnapshot.current!==snapshot){blockedSnapshot.current=snapshot;setBlockedTargets(targets);}},[]);
 const [job,setJob]=useState(null),[error,setError]=useState(''),[creating,setCreating]=useState(false),[statusKnown,setStatusKnown]=useState(false);
 const readStatus=useRef(null);readStatus.current={known:statusKnown,error};
 const active=useRef(false),pendingKey=useRef(null),mounted=useRef(true),refreshRef=useRef(refresh),observed=useRef(''),latest=useRef(null),epoch=useRef(0),pendingTargets=useRef(null),pendingOptions=useRef({}),readSequence=useRef(0);
 refreshRef.current=refresh;
 const accept=useCallback(run=>{
  if(!mounted.current)return;
  if(!validImageTestRun(run))throw Object.assign(new Error(),{invalid:true});
  const old=latest.current;
  if(old&&(!run||(old.id===run.id&&old.revision>run.revision)||(old.id!==run.id&&old.createdAt>run.createdAt)))return;
  if(JSON.stringify(old)!==JSON.stringify(run)){latest.current=run;setJob(run);}
  if(run&&`${run.id}:${run.revision}`!==observed.current){observed.current=`${run.id}:${run.revision}`;void refreshRef.current({quiet:true});}
 },[]);
 const poll=useCallback(async()=>{
  const lookup=pendingKey.current,generation=epoch.current,sequence=++readSequence.current;
  const current=()=>mounted.current&&generation===epoch.current&&lookup===pendingKey.current&&sequence===readSequence.current;
  try {
   const query=lookup?`?key=${encodeURIComponent(lookup)}`:'';
   const response=await fetch(`/api/models/image-tests${query}`,{cache:'no-store',signal:AbortSignal.timeout(15000)});
   const data=await response.json().catch(()=>null);
   if(!current())return;
   if(!response.ok)throw Object.assign(new Error(),{status:response.status});
   if(data?.schema!=='admin_image_tests.v1'||!Object.hasOwn(data,'run')||!validImageTestRun(data.run)||!validBlockedImageTargets(data.blockedTargets))throw Object.assign(new Error(),{invalid:true});
   if(lookup&&!data.run){setStatusKnown(false);setError('Start not confirmed. Recheck status before another run.');return;}
   accept(data.run);acceptBlocked(data.blockedTargets);
   if(data.run){pendingKey.current=null;epoch.current++;}
   if(!readStatus.current.known)setStatusKnown(true);
   if(readStatus.current.error)setError('');
  }catch(failure){if(current()){setStatusKnown(false);setError(imageRunReadError(failure,Boolean(latest.current)));}}
 },[accept,acceptBlocked]);
 useEffect(()=>{
  mounted.current=true;let timer,ended=false;
  const check=async()=>{await poll();if(!ended)timer=setTimeout(check,latest.current?.state==='waiting_reset'?15_000:2000);};
  void check();return()=>{ended=true;mounted.current=false;clearTimeout(timer);};
 },[poll]);
 const run=async (targets,retryKey=null,options={})=>{
  if(active.current||(!retryKey&&(!statusKnown||pendingKey.current))||creating||ACTIVE.has(job?.state)||HELD.has(job?.state)||!targets.length)return null;
  active.current=true;setCreating(true);setError('');const key=retryKey||crypto.randomUUID();pendingTargets.current=targets;pendingOptions.current=options;pendingKey.current=key;epoch.current++;
  try{
   const response=await fetch('/api/models/image-tests',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({...options,targets:targets.map(({connectionId,model})=>({connectionId,model}))})});
   const data=await response.json();
   if(!response.ok){
    if(response.status<500){pendingKey.current=null;epoch.current++;await poll();setError(data.error==='run_already_active'?'Another server run is active.':data.error==='target_outcome_unconfirmed'?'This account/model still has an unconfirmed result. Choose another target.':'Plan refused. Refresh the current account/model selection.');return null;}
    throw Error();
   }
   if(data.schema!=='admin_image_tests.v1'||!data.run?.id||!validBlockedImageTargets(data.blockedTargets))throw Error();
   accept(data.run);acceptBlocked(data.blockedTargets);pendingKey.current=null;epoch.current++;setStatusKnown(true);return data.run;
  }catch{setError('Start outcome unconfirmed. Recheck server status; do not submit another run.');try{await poll();}catch{}}
  finally{active.current=false;if(mounted.current)setCreating(false);}
  return null;
 };
 const control=async action=>{
  if(!job)return;
  try{
   const response=await fetch('/api/models/image-tests',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:job.id,action,revision:job.revision})});
   const data=await response.json();
   if(!response.ok){await poll();setError(data.error==='retry_time_not_reached'?'Provider retry time has not been reached.':'State changed or reconciliation is still required. Recheck the run.');return;}
   if(!validImageTestRun(data.run)||!data.run||!validBlockedImageTargets(data.blockedTargets))throw Error();
   accept(data.run);acceptBlocked(data.blockedTargets);epoch.current++;setStatusKnown(true);setError('');
  }catch{setError('Control outcome unconfirmed. Recheck server status.');}
 };
 const reconcileHeld=async id=>{
  if(heldCheck.current)return;
  heldCheck.current=true;setCheckingHeld(id);setRecoveryNotice('');setError('');
  try {
   const response=await fetch(`/api/models/image-tests?id=${encodeURIComponent(id)}`,{cache:'no-store',signal:AbortSignal.timeout(15000)});
   const data=await response.json();
   if(!response.ok||!validImageTestRun(data.run)||!data.run)throw Error();
   const checked=await fetch('/api/models/image-tests',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,revision:data.run.revision,action:'reconcile'})});
   if(!checked.ok)throw Error();
   const result=await checked.json();
   if(result.schema!=='admin_image_tests.v1'||!validImageTestRun(result.run)||result.run?.id!==id||!validBlockedImageTargets(result.blockedTargets))throw Error();
   acceptBlocked(result.blockedTargets);
   const unresolved=result.blockedTargets.filter(target=>target.runId===id).length;
   setRecoveryNotice(unresolved?`${unresolved} ${unresolved===1?'result is':'results are'} still unconfirmed. No new request sent.`:'Saved result confirmed. Recovery hold cleared.');
   await poll();
  }catch{setError('Saved outcome could not be resolved. This account/model remains blocked.');}
  finally{heldCheck.current=false;setCheckingHeld(null);}
 };
 const items=(job?.items||[]).map(item=>({...item,accountLabel:accounts.find(account=>account.connectionId===item.connectionId&&account.provider===item.provider)?.accountLabel||`${item.provider||'Account'} ${item.connectionId.slice(0,8)}`}));
 const heldTargets=blockedTargets.map(item=>({...item,accountLabel:accounts.find(account=>account.connectionId===item.connectionId&&(!item.provider||account.provider===item.provider))?.accountLabel||`${item.provider||'Account'} ${item.connectionId.slice(0,8)}`}));
 return {statusKnown,reconcileHeld,recoveryNotice,checkingHeld,blockedTargets:heldTargets,isBlocked:(connectionId,model)=>blockedTargets.some(item=>item.connectionId===connectionId&&item.model===model),job:job?{...job,items}:null,results:items.filter(item=>!['pending','running'].includes(item.state)),busy:creating||ACTIVE.has(job?.state),unknown:!statusKnown||Boolean(pendingKey.current)||HELD.has(job?.state),error,run,retryStart:pendingKey.current&&pendingTargets.current?()=>run(pendingTargets.current,pendingKey.current,pendingOptions.current):null,
  resultFor:(connectionId,model,provider)=>items.filter(item=>item.connectionId===connectionId&&item.model===model&&(!provider||item.provider===provider)).findLast(item=>item.state==='running')||items.filter(item=>item.connectionId===connectionId&&item.model===model&&(!provider||item.provider===provider)&&item.state!=='pending').at(-1),
  close:()=>control('close'),stop:()=>control('stop'),resume:()=>control('resume'),reconcile:()=>control('reconcile'),refresh:poll};
}
