"use client";
import {useEffect,useState} from 'react';
import ImageHelp from './ImageHelp';
import { imageRunSummary, imageRunPauseDetails } from './imageRunStatus.mjs';
const STATES={queued:['Queued','schedule'],running:['Running','progress_activity'],stopping:['Stopping','stop'],waiting_reset:['Waiting for reset','schedule'],paused:['Paused','pause_circle'],needs_review:['Needs review','fact_check'],completed:['Finished','task_alt'],cancelled:['Stopped','cancel']};
const OUTCOMES=[['succeeded','Succeeded','check_circle','text-emerald-500'],['refused','Blocked','block','text-amber-500'],['unknown','Unconfirmed','help','text-violet-500'],['cancelled','Skipped / cancelled','cancel','text-text-muted'],['running','Running','progress_activity','text-blue-500'],['pending','Pending','schedule','text-text-muted']];
const COLORS={succeeded:'#16a34a',refused:'#d97706',unknown:'#8b5cf6',cancelled:'#6b7280'};
export default function ImageRunProgress({runner,provider=null,connectionId=null,controls=false}) {
 const [now,setNow]=useState(Date.now);
 useEffect(()=>{if(!controls)return;const timer=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(timer);},[controls]);
 const job=runner.job,items=(job?.items||[]).filter(item=>(!provider||item.provider===provider)&&(!connectionId||item.connectionId===connectionId));
 if(!items.length&&!runner.error)return controls&&runner.statusKnown===false?<p role="status" className="inline-flex items-center gap-2 text-xs text-text-muted"><span aria-hidden="true" className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>Checking saved run status…</p>:null;
 if(!items.length)return controls?<div role="status" className="flex flex-wrap items-center gap-2 text-xs text-amber-500"><span>{runner.error}</span><button type="button" onClick={runner.refresh} className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2 text-text-main"><span aria-hidden="true" className="material-symbols-outlined text-[16px]">refresh</span>Recheck</button>{runner.retryStart&&<button type="button" onClick={runner.retryStart} className="h-8 rounded-lg border border-border px-2" title="Resubmit the identical saved command key; the server will not duplicate it">Confirm same start</button>}</div>:null;
 const pause=imageRunPauseDetails(job);
 const count=imageRunSummary(items);
 const heldGroups=new Map();
 for(const target of runner.blockedTargets||[])if(target.runId!==job.id)heldGroups.set(target.runId,[...(heldGroups.get(target.runId)||[]),target]);
 const heldRuns=[...heldGroups.entries()],heldTargetCount=heldRuns.reduce((sum,[,targets])=>sum+targets.length,0);
 const nextReset=items.filter(item=>item.state==='pending'&&item.notBefore&&Number.isFinite(Date.parse(item.notBefore))).map(item=>item.notBefore).sort()[0];
 const scopedState=count.unknown?'needs_review':count.running?'running':count.pending?job.state:'completed';
 const [label,icon]=STATES[controls?job.state:scopedState]||['Status unknown','help'];
 if(!controls)return <div className="image-check-result" role="status" aria-label={`${count.processed} of ${count.total} checks processed`}>
  {count.running>0&&<span className="text-blue-500">Checking…</span>}
  {count.succeeded>0&&<span className="text-emerald-500"><span aria-hidden="true" className="material-symbols-outlined">check_circle</span>{count.succeeded} passed</span>}
  {count.refused>0&&<span className="text-amber-500"><span aria-hidden="true" className="material-symbols-outlined">error_outline</span>{count.refused} rejected</span>}
  {count.unknown>0&&<span className="text-violet-500">{count.unknown} unconfirmed</span>}
  {count.pending>0&&<span className="text-text-muted">{count.pending} waiting</span>}
  {count.cancelled>0&&<span className="text-text-muted">{count.cancelled} skipped / cancelled</span>}
  <ImageHelp label="Recorded check results"><p>{label} · {count.attempted} attempted · {count.processed}/{count.total} processed. A passed check confirms one request, not a known remaining allowance.</p>{items.filter(item=>item.state==='refused'||item.state==='cancelled'||item.state==='unknown').map(item=><p key={item.operationId||`${item.connectionId}:${item.model}`}><strong>{item.model}</strong> · {item.message||`HTTP ${item.status||'unknown'}`}{item.retryAt&&<> · next check <time dateTime={item.retryAt}>{new Date(item.retryAt).toLocaleString()}</time></>}</p>)}</ImageHelp>
 </div>;
 return <div className="w-full min-w-0 space-y-2 py-1" aria-label={`${provider||'Overall'} ${connectionId?'account ':''}test progress`}>
  <div className="flex flex-wrap items-center gap-2 text-xs">
   <span className={`inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium ${job.state==='needs_review'?'bg-violet-500/10 text-violet-500':job.state==='paused'?'bg-amber-500/10 text-amber-500':'bg-surface-2 text-text-main'}`}><span aria-hidden="true" className={`material-symbols-outlined text-[16px] ${runner.busy&&job.state==='running'?'animate-spin':''}`}>{icon}</span>{label}</span>
   <span className="tabular-nums text-text-muted">{count.processed}/{count.total} processed</span>
   {controls&&<div className="ml-auto flex flex-wrap gap-1">
    {runner.busy&&<button type="button" onClick={runner.stop} title="Stop after the current request" aria-label="Stop server test run" className="flex size-8 items-center justify-center rounded-lg border border-border"><span aria-hidden="true" className="material-symbols-outlined text-[16px]">stop</span></button>}
    {job.state==='paused'&&<button type="button" onClick={runner.resume} title="Continue pending tests on other accounts; skip accounts still blocked by quota or sign-in. Completed tests are not repeated." className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-primary/30 bg-primary/10 px-2 text-xs text-primary"><span aria-hidden="true" className="material-symbols-outlined text-[16px]">play_arrow</span>Continue eligible</button>}
    {items.some(item=>item.state==='unknown')&&<button type="button" onClick={runner.reconcile} title="Reads saved evidence only; never resends an image request" className="inline-flex h-8 items-center gap-1 rounded-lg border border-violet-500/30 px-2 text-xs text-violet-500"><span aria-hidden="true" className="material-symbols-outlined text-[16px]">fact_check</span>Check saved result</button>}
    {['paused','needs_review'].includes(job.state)&&<button type="button" onClick={runner.close} title="Release this batch. Unconfirmed account/model pairs stay blocked; no requests are sent." className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-border px-2 text-xs"><span aria-hidden="true" className="material-symbols-outlined text-[16px]">inventory_2</span>{job.state==='paused'?'End batch':'Release batch'}</button>}
    <button type="button" onClick={runner.refresh} title="Refresh saved run status" aria-label="Refresh test run" className="flex size-8 items-center justify-center rounded-lg border border-border"><span aria-hidden="true" className="material-symbols-outlined text-[16px]">refresh</span></button>
   </div>}
  </div>
  {controls&&job.state==='waiting_reset'&&nextReset&&<p role="status" className="inline-flex items-center gap-1.5 text-xs text-text-muted"><span aria-hidden="true" className="material-symbols-outlined text-[15px]">schedule</span>Next request after provider reset · <time dateTime={nextReset}>{new Date(nextReset).toLocaleString()}</time></p>}
  {controls&&pause&&<div role="status" className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"><p>{pause.reason}{pause.retryAt&&<> Retry after: <time dateTime={pause.retryAt}>{new Date(pause.retryAt).toLocaleString()}</time>.</>}</p><div className="mt-1 flex items-center gap-1"><span>{count.pending} pending</span><ImageHelp label="Continue eligible tests"><p>Rechecks current permissions and quota waits. Disabled or blocked targets are skipped; completed tests are never repeated. End batch cancels pending work and preserves all saved results.</p></ImageHelp></div></div>}
  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">{OUTCOMES.filter(([key])=>count[key]>0).map(([key,title,glyph,color])=><span key={key} className={`inline-flex items-center gap-1 tabular-nums ${color}`}><span aria-hidden="true" className="material-symbols-outlined text-[15px]">{glyph}</span>{count[key]} {title.toLowerCase()}</span>)}</div>
  {count.refused>0&&<div className="flex flex-wrap gap-2 text-xs text-text-muted">{[[429,'Image quota reached'],[403,'Access denied'],[401,'Sign-in required'],[400,'Request rejected']].map(([status,title])=>{const matches=items.filter(item=>item.state==='refused'&&item.status===status);return matches.length?<span key={status} className="rounded bg-surface-2 px-2 py-1">{matches.length} {title}{status===429&&matches.some(item=>item.retryAt)&&<span>{Date.parse(matches.filter(item=>item.retryAt).map(item=>item.retryAt).sort().at(-1))<=now?' · recorded wait ended ':' · provider retry after '}<time dateTime={matches.filter(item=>item.retryAt).map(item=>item.retryAt).sort().at(-1)}>{new Date(matches.filter(item=>item.retryAt).map(item=>item.retryAt).sort().at(-1)).toLocaleString()}</time></span>}</span>:null;})}</div>}
  <div role="progressbar" aria-label="Tests processed, including cancelled and unconfirmed outcomes" aria-valuemin={0} aria-valuemax={count.total} aria-valuenow={count.processed} aria-valuetext={OUTCOMES.filter(([key])=>count[key]>0).map(([key,title])=>`${count[key]} ${title.toLowerCase()}`).join(', ')} className="flex h-1 overflow-hidden rounded-full bg-surface-2">{Object.entries(COLORS).filter(([key])=>count[key]>0).map(([key,color])=><span key={key} style={{width:`${count[key]/count.total*100}%`,backgroundColor:color}}/>)}</div>
  {controls&&heldRuns.length>0&&<details className="rounded-lg border border-violet-500/20 px-2 py-1 text-xs"><summary className="min-h-8 cursor-pointer py-1 text-violet-500">{heldTargetCount} historical unresolved {heldTargetCount===1?'request':'requests'}</summary>
   <p className="mb-2 text-text-muted">These are separate from this run. Only the listed account/model pairs are held; other eligible models can be tested.</p>
   <ul className="divide-y divide-border-subtle">{heldRuns.map(([id,targets])=>{
    const names=targets.map(item=>`${item.accountLabel||'Account'} · ${item.model}`).join(', '),review=runner.heldReviews?.[id];
    return <li key={id} className="min-w-0 py-2">
     <div className="flex min-w-0 flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-words text-text-main">{names}</span><button type="button" aria-label={`Inspect saved request for ${names}`} disabled={!!runner.checkingHeld} onClick={()=>runner.inspectHeld?.(id)} className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded border border-border px-2 text-text-main disabled:opacity-50"><span aria-hidden="true" className="material-symbols-outlined text-base">manage_search</span>Inspect</button></div>
     {targets[0].createdAt&&<time className="text-text-muted" dateTime={targets[0].createdAt}>{new Date(targets[0].createdAt).toLocaleString()}</time>}
     {review&&<div className="mt-1 space-y-1 text-text-muted">
      {(review.evidence||[]).map(item=><p key={item.operationId}>{item.evidence==='outcome_unknown'?'Request was sent; output was not confirmed.':item.evidence==='recorded'?'Saved response is available to check.':'Saved evidence is incomplete.'}{item.httpStatus!=null&&` HTTP ${item.httpStatus}.`}</p>)}
      {review.checked&&review.unresolved>0&&<p>No confirming result found. Kept on hold; no request resent.</p>}
      <button type="button" aria-label={`Check saved results for ${names}`} disabled={!!runner.checkingHeld} aria-busy={runner.checkingHeld===id||undefined} onClick={()=>runner.reconcileHeld(id)} className="inline-flex min-h-8 items-center gap-1 rounded border border-violet-500/30 px-2 text-violet-500 disabled:opacity-50" title="Reads saved evidence only; never retries generation"><span aria-hidden="true" className={`material-symbols-outlined text-base ${runner.checkingHeld===id?'animate-spin':''}`}>{runner.checkingHeld===id?'progress_activity':'fact_check'}</span>{review.checked?'Recheck saved evidence':'Check saved evidence'}</button>
     </div>}
    </li>;
   })}</ul>
  </details>}
  {controls&&runner.recoveryNotice&&<p role="status" className="text-xs text-violet-500">{runner.recoveryNotice}</p>}
  {controls&&runner.error&&<p role="status" className="text-xs text-amber-500">{runner.error}</p>}
  {controls&&count.unknown>0&&<p className="text-xs text-violet-500">{count.unknown} unconfirmed {count.unknown===1?'result':'results'} stay blocked. {['paused','needs_review'].includes(job.state)?'Check saved results or release this batch; other models can then be tested.':`${count.unknown===1?'This account/model':'These account/model pairs'} stay blocked until saved evidence confirms them.`}</p>}
 </div>;
}
