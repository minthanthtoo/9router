"use client";
import {useEffect,useImperativeHandle,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
const LABELS={summary:'Summary',text:'Text',images:'Images'},ICONS={summary:'data_usage',text:'chat',images:'photo_library'};
export default function QuotaCardDetailsOverlay({name,groups,controlsRef,onToggleGroup,onEnsureGroupVisible,disabled=false}){
 const [group,setGroup]=useState(null),[position,setPosition]=useState(null),[query,setQuery]=useState('');
 const root=useRef(null),panel=useRef(null),triggers=useRef({}),timer=useRef(null),pointerMode=useRef(false),focusNext=useRef(false),hoverTimer=useRef(null),previewTimer=useRef(null);
 const cancel=()=>{clearTimeout(timer.current);timer.current=null;};
 const inside=node=>Boolean(node?.nodeType&&(root.current?.contains(node)||panel.current?.contains(node)));
 const hold=()=>clearTimeout(previewTimer.current);
 const close=()=>{cancel();clearTimeout(hoverTimer.current);clearTimeout(previewTimer.current);setGroup(null);};
 const choose=(key,hover=false)=>{cancel();clearTimeout(hoverTimer.current);clearTimeout(previewTimer.current);focusNext.current=!hover&&!pointerMode.current;setQuery('');setGroup(key);if(hover)previewTimer.current=setTimeout(close,2200);};
 const hover=(key,event)=>{if(event.pointerType==='touch'||group===key)return;pointerMode.current=true;clearTimeout(hoverTimer.current);hoverTimer.current=setTimeout(()=>choose(key,true),140);};
 const leave=()=>{cancel();timer.current=setTimeout(()=>{if(pointerMode.current||!panel.current?.contains(document.activeElement))close();},260);};
 useImperativeHandle(controlsRef,()=>({choose}));
 useEffect(()=>()=>{cancel();clearTimeout(hoverTimer.current);clearTimeout(previewTimer.current);},[]);
 useEffect(()=>{
  if(!group)return;
  const outside=event=>{if(!inside(event.target))close();};
  const move=event=>{pointerMode.current=true;if(inside(event.target))cancel();else if(timer.current===null)leave();};
  const key=event=>{pointerMode.current=false;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();triggers.current[group]?.focus({preventScroll:true});}};
  document.addEventListener('pointerdown',outside);document.addEventListener('pointermove',move);document.addEventListener('keydown',key);
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('pointermove',move);document.removeEventListener('keydown',key);};
 },[group]);
 useLayoutEffect(()=>{
  if(!group){setPosition(null);return;}
  const place=()=>{
   const trigger=triggers.current[group]?.getBoundingClientRect();if(!trigger)return;
   const card=(root.current.closest('.quota-account-card-stack')||root.current).getBoundingClientRect(),view=window.visualViewport;
   const left=view?.offsetLeft||0,top=view?.offsetTop||0,width=view?.width||window.innerWidth,height=view?.height||window.innerHeight;
   const w=Math.min(360,Math.max(180,card.width-16),width-16),maxHeight=Math.max(80,Math.min(420,height-24)),h=Math.min(panel.current?.getBoundingClientRect().height||80,maxHeight);
   const y=trigger.bottom+h+8<=top+height?trigger.bottom+4:Math.max(top+8,trigger.top-h-4);
   setPosition({left:Math.max(left+8,Math.min(trigger.left,left+width-w-8)),top:y,width:w,maxHeight});
  };
  place();const observer=new ResizeObserver(place);if(panel.current)observer.observe(panel.current);observer.observe(root.current);const card=root.current.closest('.quota-account-card-stack');if(card)observer.observe(card);
  window.addEventListener('resize',place);window.addEventListener('scroll',place,true);window.visualViewport?.addEventListener('resize',place);
  return()=>{observer.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);window.visualViewport?.removeEventListener('resize',place);};
 },[group]);
 useLayoutEffect(()=>{if(group&&position&&focusNext.current){focusNext.current=false;panel.current?.querySelector('button:not(:disabled),input')?.focus({preventScroll:true});}},[group,position]);
 const choices=groups[group]?.choices||[],shown=choices.filter(choice=>`${choice.name} ${choice.key}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
 return <>
  <div ref={root} className="quota-card-details-overlay flex items-center gap-0.5" onPointerEnter={cancel} onPointerDown={()=>{pointerMode.current=true;cancel();}} onKeyDown={()=>{pointerMode.current=false;cancel();}}>
   {Object.keys(LABELS).map(key=><button key={key} ref={node=>{triggers.current[key]=node;}} type="button" data-section={key} aria-label={`${LABELS[key]} display options for ${name}`} aria-expanded={group===key} aria-keyshortcuts="ArrowDown" onContextMenu={event=>{event.preventDefault();choose(key);}} onKeyDown={event=>{if(event.key==="ArrowDown"){event.preventDefault();pointerMode.current=false;choose(key);}}} onPointerEnter={event=>hover(key,event)} onPointerLeave={()=>clearTimeout(hoverTimer.current)} disabled={disabled} onClick={()=>{if(!groups[key].visible)onEnsureGroupVisible?.(key);choose(key);}} title={`${LABELS[key]} · ${groups[key].visible?'shown':'hidden'}`} className={`quota-card-details-trigger flex items-center justify-start gap-1 px-[5px] ${groups[key].visible?'text-primary':'text-text-muted'} focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary`}><span aria-hidden="true" className="material-symbols-outlined text-[13px]">{ICONS[key]}</span><span className="quota-card-details-label">{LABELS[key]}</span></button>)}
  </div>
  {group&&createPortal(<div ref={panel} role="group" aria-label={`${LABELS[group]} display options for ${name}`} style={position||{visibility:'hidden'}} className="quota-card-options-tray fixed z-[70] flex min-w-0 flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface p-1 text-xs shadow-[var(--shadow-elev)]" onClickCapture={hold} onPointerEnter={()=>{cancel();hold();}} onPointerDown={()=>{pointerMode.current=true;cancel();hold();}} onKeyDown={()=>{pointerMode.current=false;cancel();hold();}} onFocus={()=>{cancel();if(!pointerMode.current)hold();}}>
   <div className="flex shrink-0 items-center gap-2 rounded-lg bg-surface-2 px-2"><span aria-hidden="true" className="material-symbols-outlined text-base text-primary">{ICONS[group]}</span><strong className="flex-1">{LABELS[group]}</strong><button type="button" disabled={disabled} aria-label={`${groups[group].visible?'Hide':'Show'} ${group} for ${name}`} aria-pressed={groups[group].visible} onClick={()=>onToggleGroup(group)} className="inline-flex min-h-9 items-center gap-1 text-primary disabled:opacity-50"><span aria-hidden="true" className="material-symbols-outlined text-base">{groups[group].visible?'visibility':'visibility_off'}</span>{groups[group].visible?'Shown':'Hidden'}</button></div>
   {groups[group].actions&&<div className="border-t border-border-subtle px-2 py-1">{groups[group].actions}</div>}
   <div className="flex shrink-0 items-center justify-between px-2 py-1 text-text-muted"><span>{choices.filter(choice=>!choice.visible).length} hidden</span><span title="Choices apply to matching provider/model rows across cards">Matching cards</span></div>
   {choices.length>12&&<input aria-label={`Search ${group} rows`} type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder={group==='summary'?'Find quota':'Find model'} className="mx-1 mb-1 min-h-9 shrink-0 rounded-lg border border-border-subtle bg-bg px-2"/>}
   <div className="min-h-0 overflow-y-auto" role="group" aria-label={`${group} row choices`}>
    {shown.filter(choice=>!choice.visible).map(choice=><button key={choice.key} type="button" disabled={disabled} aria-label={`Show ${choice.name}`} aria-pressed={choice.visible} onClick={()=>choice.onToggle()} className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-text-muted hover:bg-surface-2 disabled:opacity-50"><span aria-hidden="true" className="material-symbols-outlined shrink-0 text-base">visibility</span><span className="min-w-0 truncate" title={choice.key}>{choice.name}</span></button>)}
    {!shown.filter(choice=>!choice.visible).length&&<p className="px-2 py-2 text-text-muted">{query?'No matching hidden rows.':choices.length?'All rows are shown.':'No rows available.'}</p>}
   </div>
  </div>,document.body)}
 </>;
}
