"use client";
import {formatResetTime} from "../usage/components/ProviderLimits/utils";
import {useState} from 'react';
import {imageCardModelRows,imageModelMatchesCategory} from './imageQuotaTable.mjs';
import {imageCount,imageModelEvidence,estimateLabel,imageNextCheck} from './imageLearningDisplay.mjs';
import {imageManualPolicy,imagePolicyKey} from './imagePolicyCommand.mjs';
import ImagePolicyToggle from './ImagePolicyToggle';
import ImageTestButton from './ImageTestButton';
import ImageModelActivity from './ImageModelActivity';
import QuotaRemainingMeter from '@/shared/components/QuotaRemainingMeter';
import QuotaModelRow from '@/shared/components/QuotaModelRow';
const time=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Not reported';
const duration=seconds=>seconds>=3600?`${+(seconds/3600).toFixed(1)}h`:seconds>0?`${+(seconds/60).toFixed(1)}m`:'Window unknown';
export default function ImageCardModelGroup({connection,row,state,onSelectModel,modelRows,modelInteraction,onRevealSummary,onOpenAccountSettings,onHideModel}){
 const [page,setPage]=useState(1),[tray,setTray]=useState(null),[chart,setChart]=useState(null),[confirming,setConfirming]=useState(null);
 const interaction=modelInteraction||{tray,setTray,chart,setChart};
 const models=(modelRows||imageCardModelRows(row||{provider:connection.provider},state.catalog)).filter(entry=>imageModelMatchesCategory(entry,state.modelCategory)).filter(entry=>!state.model||((!state.modelProvider||state.modelProvider===connection.provider)&&entry.model===state.model));
 const pages=Math.max(1,Math.ceil(models.length/8)),active=Math.min(page,pages);
 return <section className="min-w-0" aria-label="Image model controls">{models.slice((active-1)*8,active*8).map(entry=>{
  const evidence=imageModelEvidence(row,entry),wait=entry.wait||imageNextCheck(row,entry)||evidence.next;
  const windows=evidence.windows||[],next=wait?.at;
  const resetAt=next||windows.find(w=>w.resetAt)?.resetAt||entry.estimate?.resetAt;
  const when=next?wait?.source==='learned_window'?'Estimated recovery':'Provider retry':windows.some(w=>w.resetAt)?'Reported reset':'Reset unknown';
  const result=state.tests?.resultFor?.(row?.connectionId,entry.model,connection.provider);
  const held=state.tests?.blockedTargets?.filter(target=>target.connectionId===row?.connectionId&&target.model===entry.model)||[];
  const otherHeldRuns=[...new Set(held.map(target=>target.runId).filter(runId=>runId&&runId!==state.tests?.job?.id))];
  const pending=state.drafts?.[imagePolicyKey(row?.connectionId,entry.model)]?.outcomeUnknown;
  const waiting=held.length||wait||evidence.kind==='restriction'||result?.state==='unknown'||row?.routeState==='quota_blocked';
  const statusLabel=imageManualPolicy(row,entry.model).state==='paused'?'Off':row?.accountEnabled===false?'Account off':waiting?'Waiting':evidence.kind==='reported'&&!evidence.stale?'Reported allowance':'Unknown';
  const receipt=[pending?'Permission save unconfirmed':null,held.length?'Held · check saved outcome':null,result?`${result.state}${result.sample?` · ${result.sample}/${result.maxAttempts}`:''}${result.status?` · ${result.status}`:''}`:null].filter(Boolean).join(' · ');
  return <QuotaModelRow key={entry.model} id={`image:${entry.model}`} name={entry.model} interaction={interaction} onHide={onHideModel?()=>onHideModel(entry.model):undefined}
   disabled={imageManualPolicy(row,entry.model).state==='paused'||imageManualPolicy(row).state==='paused'||row?.accountEnabled===false} testing={result?.state==='running'} status={null}
   reset={Number.isFinite(Date.parse(resetAt))?(Date.parse(resetAt)>Date.now()?`in ${formatResetTime(resetAt)}`:"Time passed"):"—"}
   measurement={windows.length?<div className="quota-model-windows">{windows.map((window,index)=><div key={index} className="quota-model-window" title={`${evidence.shared?'Shared image allowance · ':''}${evidence.label}`}><span className="quota-model-window-label">{duration(window.windowSeconds)}</span>{Number.isFinite(window.remainingPercentage)?<><QuotaRemainingMeter value={window.remainingPercentage} label={`${entry.model} ${duration(window.windowSeconds)} remaining`} compact/><strong title={`${window.remainingPercentage}%`}>{Math.round(window.remainingPercentage)}%</strong></>:<span className="text-text-muted">—</span>}</div>)}</div>:entry.estimate?.state==='estimated'&&Number.isFinite(entry.estimate.remainingPercentage)?<div className="quota-model-windows"><div className="quota-model-window" title={estimateLabel(entry.estimate)}><span className="quota-model-window-label">Est.</span><QuotaRemainingMeter value={entry.estimate.remainingPercentage} label={`${entry.model} estimated remaining`} compact/><strong title={`${entry.estimate.remainingPercentage}% estimated`}>~{Math.round(entry.estimate.remainingPercentage)}%</strong></div></div>:<span className="text-text-muted">Unreported</span>}
   allow={row&&<ImagePolicyToggle compact row={row} state={state} model={entry.model}/>}
   quickActions={row&&entry.capabilities?.generation&&state.tests&&<ImageTestButton compact runner={state.tests} row={row} model={entry.model} onComplete={state.fetchStatus} onInteractionChange={active=>setConfirming(active?entry.model:null)}/>}
   keepOpen={confirming===entry.model||pending||Boolean(state.busyId)||Boolean(state.tests?.busy)||result?.state==='unknown'} receipt={receipt}
   actions={null}
   analysis={<ImageModelActivity context={<div className="space-y-1.5"><p><>{statusLabel} · {evidence.label}{evidence.observedAt&&<> · <time dateTime={evidence.observedAt}>{time(evidence.observedAt)}</time></>}</></p><div className="flex items-center justify-between gap-2"><span className="text-text-muted">{when}</span><time className="text-right">{time(resetAt)}</time></div><p className="text-text-muted">{estimateLabel(entry.estimate)}. Last observation: {time(evidence.observedAt)}. A retry or reset is not proof of restored allowance. Recorded requests exclude unobserved external use.</p>{evidence.shared&&<button type="button" className="min-h-8 text-blue-500" onClick={()=>{onRevealSummary?.();interaction.setChart(`image:${entry.model}`);}}>View shared allowance</button>}<div className="flex flex-wrap gap-x-3 text-text-muted"><span><strong>{imageCount(entry.counts?.calls24h)}</strong> requests · 24h</span><span><strong>{imageCount(entry.counts?.callsTotal)}</strong> total</span></div><div className="flex flex-wrap items-center gap-x-3 gap-y-1">{onSelectModel&&<button type="button" className="min-h-8 text-primary" onClick={()=>onSelectModel(entry.model,connection.provider)}>Filter model</button>}{onOpenAccountSettings&&<button type="button" className="min-h-8 text-primary" onClick={()=>onOpenAccountSettings(row)}>Settings</button>}{result?.state==='unknown'&&<button type="button" className="min-h-8 text-violet-500" onClick={state.tests.reconcile}>Check saved result</button>}{otherHeldRuns.map(runId=><button key={runId} type="button" className="min-h-8 text-violet-500" onClick={()=>state.tests.reconcileHeld(runId)}>Check run {runId.slice(0,6)}</button>)}</div></div>} connection={connection} model={entry.model} row={row} live={result?.state==='running'} revision={state.tests?.job?.revision}/>}
  />;
 })}{!models.length&&<p className="py-2 text-xs text-text-muted">{state.catalogError||'No matching image models.'}</p>}{pages>1&&<nav aria-label="Image model pages" className="flex items-center justify-end gap-2 text-xs"><span className="mr-auto">{models.length} models</span><button className="min-h-9 px-2" disabled={active===1} onClick={()=>setPage(active-1)}>Previous</button>{[...new Set([1,active-1,active,active+1,pages])].filter(n=>n>0&&n<=pages).sort((a,b)=>a-b).map(n=><button key={n} aria-current={n===active?'page':undefined} onClick={()=>setPage(n)} className={`min-h-9 rounded px-2 ${n===active?'bg-primary/10 text-primary':''}`}>{n}</button>)}<button className="min-h-9 px-2" disabled={active===pages} onClick={()=>setPage(active+1)}>Next</button></nav>}</section>;
}
