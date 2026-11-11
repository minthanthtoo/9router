"use client";
import {useEffect,useState} from 'react';
import { quotaSegmentDescription } from "../usage/components/ProviderLimits/utils";

export default function QuotaSegmentBar({ segment, index, total, previous, next, covered = false, headingId, onNavigate, compact=false }) {
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
   {compact&&details.length>0&&<button type="button" className="quota-segment-ticker min-w-0 flex-1 text-left" aria-label={`Next segment detail. ${details.join("; ")}`} onClick={()=>{setPaused(true);setCurrent(value=>(value+1)%details.length);}} title={details.join('\n')}><span key={`${segment.key}-${current}`} className="quota-segment-tick text-xs text-text-muted" aria-hidden="true">{details[current%details.length]}</span><span className="sr-only">{details.join('; ')}</span></button>}
   {compact&&details.length>1&&<button type="button" aria-pressed={paused} aria-label={paused?'Play segment details':'Pause segment details'} onClick={()=>setPaused(value=>!value)} className="quota-ticker-pause"><span aria-hidden="true" className="material-symbols-outlined text-[16px]">{paused?'play_arrow':'pause'}</span></button>}
   <span className="ml-auto shrink-0 text-[11px] tabular-nums text-text-muted" aria-label={`Segment ${index+1} of ${total}`}>{index+1}/{total}</span>
   <div className="flex shrink-0 gap-1" role="group" aria-label={`Navigate from segment ${segment.key}`}>
    {[[previous,'Previous segment','keyboard_double_arrow_up'],[next,'Next segment','keyboard_double_arrow_down']].map(([key,label,icon])=><button key={label} type="button" disabled={!key} aria-label={key?`${label}: ${key}`:label} title={key?`${label} ${key}`:label} onClick={()=>onNavigate(key)} className="flex size-8 items-center justify-center rounded-[8px] border border-border text-text-muted transition-colors hover:bg-surface-2 hover:text-primary disabled:cursor-default disabled:opacity-30"><span aria-hidden="true" className="material-symbols-outlined" style={{fontSize:18}}>{icon}</span></button>)}
   </div>
  </div>
  {!compact&&details.length>0&&<div className="quota-segment-values flex min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap text-xs text-text-muted" tabIndex={0} aria-label={`Value boundaries for segment ${segment.key}`}>
   {details.map((detail,i)=><span key={i} title={detail} className="shrink-0 rounded-md bg-surface-2 px-2 py-1">{detail}</span>)}
  </div>}
 </div>;
}
