"use client";
import {useEffect,useLayoutEffect,useRef,useState,useId} from 'react';
import {QUOTA_SORT_OPTIONS} from '../usage/components/ProviderLimits/utils';

export default function QuotaControlDock({children,sorts,onDockedChange,shortLabel="Short", options=QUOTA_SORT_OPTIONS, resetPriority=false}) {
 const sentinel=useRef(null),panel=useRef(null),trigger=useRef(null),id=useId();
 const [docked,setDocked]=useState(false),[open,setOpen]=useState(false),[bounds,setBounds]=useState({top:8,left:8,right:8}),[homeHeight,setHomeHeight]=useState(0);
 const directionLabel=(option,sort)=>option[sort.direction]||(option.kind==='remaining'?(sort.direction==='asc'?'Lowest first':'Highest first'):(sort.direction==='asc'?'Earliest first':'Latest first'));
 const sortSummary=(resetPriority?'Matching Codex reset credits first; ':'')+sorts.map((sort,index)=>{const option=options.find(item=>item.key===sort.key);return option?`${index+1+Number(resetPriority)}. ${option.label}: ${directionLabel(option,sort)}`:'';}).filter(Boolean).join('; ');
 const close=()=>{setOpen(false);trigger.current?.focus({preventScroll:true});};
 useLayoutEffect(()=>{
  let owner=sentinel.current.parentElement;
  while(owner&&!/(auto|scroll)/.test(getComputedStyle(owner).overflowY))owner=owner.parentElement;
  const target=owner||document,measure=()=>{
   const viewport=window.visualViewport,viewTop=viewport?.offsetTop||0;
   const top=Math.max(viewTop,owner?owner.getBoundingClientRect().top:0);
   const rect=sentinel.current.parentElement.getBoundingClientRect(),viewLeft=viewport?.offsetLeft||0,viewRight=viewLeft+(viewport?.width||window.innerWidth);
   const next=sentinel.current.getBoundingClientRect().bottom<top;
   if(!next)setHomeHeight(panel.current.getBoundingClientRect().height+1);
   setDocked(next);onDockedChange(next);setBounds(current=>{const next={top:Math.max(8,top+8),left:Math.max(viewLeft+8,rect.left||0),right:Math.max(8,window.innerWidth-Math.min(viewRight-8,rect.right||viewRight))};return current.top===next.top&&current.left===next.left&&current.right===next.right?current:next;});
  };
  measure();target.addEventListener('scroll',measure,{passive:true});window.addEventListener('resize',measure);window.visualViewport?.addEventListener('resize',measure);window.visualViewport?.addEventListener('scroll',measure);
  return()=>{target.removeEventListener('scroll',measure);window.removeEventListener('resize',measure);window.visualViewport?.removeEventListener('resize',measure);window.visualViewport?.removeEventListener('scroll',measure);};
 },[onDockedChange]);
 useLayoutEffect(()=>{
  if(!docked){setOpen(false);return;}
  if(open)panel.current.querySelector('button,select,input,[tabindex="0"]')?.focus({preventScroll:true});
  else {
   const selectors=panel.current.querySelectorAll('button[aria-haspopup][aria-expanded="true"]');
   selectors.forEach(button=>button.click());
   if(selectors.length||panel.current.contains(document.activeElement))trigger.current?.focus({preventScroll:true});
  }
 },[docked,open]);
 useEffect(()=>{
  if(!docked||!open)return;
  const escape=event=>{if(event.key==='Escape'&&!event.defaultPrevented&&!event.target.closest?.('[role=menu],[role=listbox],select')&&!panel.current.querySelector('[aria-haspopup][aria-expanded="true"]')){event.preventDefault();close();}};
  document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);
 },[docked,open]);
 return <div className="quota-control-home" style={docked?{minHeight:homeHeight}:undefined}>
  <div ref={sentinel} className="quota-dock-sentinel" aria-hidden="true"/>
  <div ref={panel} id={id} role={docked?'region':undefined} aria-label={docked?'Quota filters and sorting':undefined} inert={docked&&!open} aria-hidden={docked&&!open||undefined}
   className={`quota-control-panel ${docked?'is-docked':''} ${open?'is-open':''}`} style={docked?{'--dock-top':`${bounds.top}px`,'--dock-left':`${bounds.left}px`,'--dock-right':`${bounds.right}px`}:undefined}>
   {docked&&<button type="button" onClick={close} aria-label="Close quota controls" className="quota-dock-close"><span aria-hidden="true" className="material-symbols-outlined">close</span></button>}
   <div className="quota-controls-strip">{children}</div>
  </div>
  {docked&&<button ref={trigger} type="button" aria-label={`${open?'Close':'Open'} quota filters and sorting. ${sortSummary||'No active sorts'}`} aria-controls={id} aria-expanded={open} onClick={()=>open?close():setOpen(true)}
   className={`quota-dock-launcher ${open?'is-open':''}`} style={{top:`${bounds.top+44}px`,right:`${bounds.right}px`,height:sorts.length||resetPriority?`${16+40*(sorts.length+Number(resetPriority))}px`:'48px'}} title={`Filters & sort sequence: ${sortSummary||'off'}`}>
   {!sorts.length&&!resetPriority&&<span aria-hidden="true" className="quota-dock-wheel material-symbols-outlined">sort</span>}
   <span className="sr-only">{sorts.length||resetPriority?`${sorts.length+Number(resetPriority)} active sort steps`:'No active sorts'}</span>
   {resetPriority&&<span className="quota-dock-step" title="Matching Codex reset credits first"><span className="quota-dock-order">1</span><span aria-hidden="true" className="material-symbols-outlined">restart_alt</span><span aria-hidden="true" className="quota-dock-direction">↑</span></span>}
   {sorts.map((sort,index)=>{const option=options.find(item=>item.key===sort.key);return option&&<span key={`${sort.key}-${sort.direction}-${index}-${sort.division||'half'}`} className="quota-dock-step" title={`${index+1+Number(resetPriority)}. ${option.label}: ${directionLabel(option,sort)}`}>
    <span className="quota-dock-order">{index+1+Number(resetPriority)}</span><span aria-hidden="true" className="material-symbols-outlined">{option.icon}</span><span className="quota-dock-window">{{weekly:'7d',monthly:'Month',daily:'Day',cycle:'Period',rolling:'Roll',model:'Model'}[option.window]||shortLabel}</span><span aria-hidden="true" className="quota-dock-direction">{sort.direction==='asc'?'↑':'↓'}</span>
   </span>;})}
  </button>}
 </div>;
}
