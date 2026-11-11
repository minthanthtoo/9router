"use client";
import {useEffect,useState} from 'react';
import { quotaSegmentDescription, formatQuotaSortValue, formatQuotaGap } from "../usage/components/ProviderLimits/utils";

import {quotaRemainingColors} from '@/shared/components/QuotaRemainingMeter';

function SegmentDetail({detail,text}) {
 const known=Number.isFinite(detail.min),percent=detail.kind==='remaining';
 const value=n=>formatQuotaSortValue(n,detail.kind);
 const range=!known?'Unreported':detail.min===detail.max?value(detail.min):`${value(detail.min)}–${value(detail.max)}`;
 const colors=known&&percent?quotaRemainingColors(detail.min):null;
 const tone=colors?`${colors.text} ${colors.bgLight}`:known?'text-sky-700 dark:text-sky-300 bg-sky-500/10':'text-text-muted bg-surface-2 border-dashed';
 const method=detail.mode==='half'?`½ · ${detail.startRank}–${detail.endRank}/${detail.parentCount}`:detail.mode==='median'?`P50 · ${value(detail.threshold)}`:detail.mode==='gap'?detail.gap?`Gap · ${formatQuotaGap(detail.gap.size,detail.kind)}`:'No gap':null;
 return <span role="img" aria-label={text} title={text} className="quota-segment-detail inline-flex min-w-0 items-center gap-1.5">
  <span aria-hidden="true" className="quota-segment-metric inline-flex min-w-0 items-center gap-1 rounded bg-primary/5 px-1.5 py-0.5 text-text-muted"><span className="material-symbols-outlined text-[13px] text-primary">{detail.kind==='reset'?'hourglass_empty':percent?'percent':'science'}</span><span className="truncate">{detail.label}{detail.direction==='asc'?' ↑':detail.direction==='desc'?' ↓':''}</span></span>
  <span aria-hidden="true" title={known&&percent?`${range} remaining · color follows the lowest value`:range} className={`shrink-0 rounded-md border border-current/15 px-2 py-0.5 font-semibold tabular-nums ${tone}`}>{range}</span>
  {detail.missing>0&&known&&<span aria-hidden="true" className="shrink-0 text-text-muted">+{detail.missing} unknown</span>}
  {method&&<span aria-hidden="true" className="quota-segment-method shrink-0 rounded bg-cyan-500/10 px-1.5 py-0.5 text-cyan-700 dark:text-cyan-300">{method}</span>}
 </span>;
}

export default function QuotaSegmentBar({ segment, index, total, previous, next, covered = false, headingId, onNavigate, compact=false }) {
 const boundaries=segment.boundaries?.length?segment.boundaries:segment.ordering?[segment.ordering]:[];
 const details=quotaSegmentDescription(segment),[current,setCurrent]=useState(0),[paused,setPaused]=useState(false),[hover,setHover]=useState(false);
 useEffect(()=>{
  if(!compact||details.length<2||paused||hover||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const timer=setInterval(()=>{if(!document.hidden)setCurrent(value=>(value+1)%details.length);},3500);
  return()=>clearInterval(timer);
 },[compact,details.length,paused,hover]);
 const name=(segment.resetGroup||segment.availability||['ready','unavailable'].includes(segment.key))?segment.rotationName:segment.key==='disabled'?'Disabled accounts':segment.key==='pinned'?'Pinned':segment.rotationName ? `${segment.rotationName} ${index+1}` : `Segment ${segment.key}`;
 return <div className={`quota-segment-bar col-span-full min-w-0 ${compact?'is-compact':''} ${covered?'invisible':''}`} inert={covered} aria-hidden={covered || undefined} onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)} onFocus={()=>setHover(true)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setHover(false);}}>
  <div className="quota-segment-heading flex min-w-0 items-center gap-2">
   <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-primary" style={{fontSize:18}}>{segment.resetGroup&&segment.resetGroup!=='regular'?'restart_alt':segment.key==='pinned'?'push_pin':'account_tree'}</span>
   <h2 id={headingId || `quota-segment-${segment.key}`} className="truncate text-xs font-semibold text-text-main">{name}</h2>
   <span className="shrink-0 text-xs tabular-nums text-text-muted">{segment.connections.length} {segment.connections.length===1?'card':'cards'}</span>
   {compact&&details.length>0&&<button type="button" className="quota-segment-ticker min-w-0 flex-1 text-left" aria-label={`Next segment detail. ${details.join("; ")}`} onClick={()=>{setPaused(true);setCurrent(value=>(value+1)%details.length);}} title={details.join('\n')}><span key={`${segment.key}-${current}`} className="quota-segment-tick text-xs text-text-muted" aria-hidden="true"><SegmentDetail detail={boundaries[current%details.length]} text={details[current%details.length]}/></span><span className="sr-only">{details.join('; ')}</span></button>}
   {compact&&details.length>1&&<button type="button" aria-pressed={paused} aria-label={paused?'Play segment details':'Pause segment details'} onClick={()=>setPaused(value=>!value)} className="quota-ticker-pause"><span aria-hidden="true" className="material-symbols-outlined text-[16px]">{paused?'play_arrow':'pause'}</span></button>}
   <span className="ml-auto shrink-0 text-[11px] tabular-nums text-text-muted" aria-label={`Segment ${index+1} of ${total}`}>{index+1}/{total}</span>
   <div className="flex shrink-0 gap-1" role="group" aria-label={`Navigate from segment ${segment.key}`}>
    {[[previous,'Previous segment','keyboard_double_arrow_up'],[next,'Next segment','keyboard_double_arrow_down']].map(([key,label,icon])=><button key={label} type="button" disabled={!key} aria-label={key?`${label}: ${key}`:label} title={key?`${label} ${key}`:label} onClick={()=>onNavigate(key)} className="flex size-8 items-center justify-center rounded-[8px] border border-border text-text-muted transition-colors hover:bg-surface-2 hover:text-primary disabled:cursor-default disabled:opacity-30"><span aria-hidden="true" className="material-symbols-outlined" style={{fontSize:18}}>{icon}</span></button>)}
   </div>
  </div>
  {!compact&&details.length>0&&<div className="quota-segment-values flex min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap text-xs text-text-muted" tabIndex={0} aria-label={`Value boundaries for segment ${segment.key}`}>
   {details.map((text,i)=><SegmentDetail key={i} detail={boundaries[i]} text={text}/>)}
  </div>}
 </div>;
}
