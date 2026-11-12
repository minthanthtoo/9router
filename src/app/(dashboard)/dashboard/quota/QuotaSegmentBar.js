"use client";
import {useEffect,useId,useRef,useState} from 'react';
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
  <span aria-hidden="true" className="quota-segment-metric inline-flex min-w-0 items-center gap-1 text-text-muted"><span className="material-symbols-outlined" style={{fontSize:12}}>{detail.kind==='reset'?'hourglass_empty':percent?'percent':'science'}</span><span className="truncate">{detail.label}{detail.direction==='asc'?' ↑':detail.direction==='desc'?' ↓':''}</span></span>
  <span aria-hidden="true" title={known&&percent?`${range} remaining · color follows the lowest value`:range} className={`shrink-0 rounded border border-transparent px-1.5 py-0.5 font-medium tabular-nums ${tone}`}>{range}</span>
  {detail.missing>0&&known&&<span aria-hidden="true" className="shrink-0 text-text-muted">+{detail.missing} unknown</span>}
  {method&&<span aria-hidden="true" className="quota-segment-method shrink-0 border-l border-border pl-1.5 text-text-muted">{method}</span>}
 </span>;
}

export default function QuotaSegmentBar({ segment, previousSegment, index, total, previous, next, covered = false, headingId, onNavigate, compact=false }) {
 const boundaries = segment.boundaries?.length ? segment.boundaries : segment.ordering ? [segment.ordering] : [];
 const details = quotaSegmentDescription(segment);
 const [hover, setHover] = useState(false);
 const [pinned, setPinned] = useState(false);
 const root = useRef(null);
 const trigger = useRef(null);
 const panelId = useId();
 const changedBoundary = boundaries.findIndex((boundary, i) => JSON.stringify(boundary) !== JSON.stringify(previousSegment?.boundaries?.[i]));
 const depth = !previousSegment || previousSegment.availability !== segment.availability ? 0 : changedBoundary < 0 ? boundaries.length : changedBoundary + 1;
 const name = (segment.resetGroup || segment.availability || ['ready','waiting','unavailable'].includes(segment.key)) ? segment.rotationName : segment.key === 'disabled' ? 'Disabled accounts' : segment.key === 'pinned' ? 'Pinned' : segment.rotationName ? `${segment.rotationName} ${index+1}` : `Segment ${segment.key}`;
 const label = depth > 0 ? name.replace(/^(Ready|Waiting|Unavailable) · /, '') : name;
 const expanded = details.length > 0 && (hover || pinned);
 useEffect(() => {
  if (!pinned) return;
  const dismiss = event => {
   if (!root.current?.contains(event.target)) { setPinned(false); setHover(false); }
  };
  document.addEventListener('pointerdown', dismiss);
  return () => document.removeEventListener('pointerdown', dismiss);
 }, [pinned]);
 return <div ref={root} className={`quota-segment-bar col-span-full min-w-0 ${compact?'is-compact':''} ${covered?'invisible':''}`} data-availability={segment.availability||undefined} data-depth={Math.min(depth,3)} style={{'--segment-indent':`${Math.min(depth,3)*8}px`}} inert={covered} aria-hidden={covered || undefined}
  onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
  onFocus={()=>setHover(true)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setHover(false);}}
  onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();trigger.current?.focus();setPinned(false);setHover(false);}}}>
  <div className="quota-segment-heading flex min-w-0 items-center gap-2">
   <h2 id={headingId || `quota-segment-${segment.key}`} className="min-w-0">
    <button ref={trigger} type="button" className="quota-segment-trigger" aria-label={`${name}, ${segment.connections.length} ${segment.connections.length===1?'account':'accounts'}${details.length?', show division details':''}`} aria-expanded={details.length ? expanded : undefined} aria-controls={details.length ? panelId : undefined} onClick={()=>{setPinned(value=>!value);setHover(false);}}>
     <span aria-hidden="true" className="material-symbols-outlined">{segment.key==='pinned'?'push_pin':depth===0?'account_tree':'subdirectory_arrow_right'}</span>
     <span className="truncate">{label}</span>
     <span className="quota-segment-count">{segment.connections.length}</span>
    </button>
   </h2>
   <span className="quota-segment-rule" aria-hidden="true" />
   <span className="shrink-0 text-[11px] tabular-nums text-text-muted" aria-label={`Segment ${index+1} of ${total}`}>{index+1}/{total}</span>
   <div className="flex shrink-0" role="group" aria-label={`Navigate from segment ${segment.key}`}>
    {[[previous,'Previous segment','keyboard_double_arrow_up'],[next,'Next segment','keyboard_double_arrow_down']].map(([key,label,icon])=><button key={label} type="button" disabled={!key} aria-label={key?`${label}: ${key}`:label} title={key?`${label} ${key}`:label} onClick={()=>onNavigate(key)} className="flex size-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-primary disabled:cursor-default disabled:opacity-30"><span aria-hidden="true" className="material-symbols-outlined" style={{fontSize:18}}>{icon}</span></button>)}
   </div>
  </div>
  {expanded&&<div id={panelId} className="quota-segment-values" role="region" aria-label={`Division details for ${name}`}>
   {details.map((text,i)=><div key={i} className="quota-segment-level" style={{paddingInlineStart:`${i*8}px`}}><span className="quota-segment-level-number" aria-label={`Sort level ${i+1}`}>{i+1}</span><SegmentDetail detail={boundaries[i]} text={text}/></div>)}
  </div>}
 </div>;
}
