"use client";
import {createPortal} from "react-dom";
import {useLayoutEffect,useRef,useState} from 'react';
import ImageRunProgress from './ImageRunProgress';

export default function ImageTestRunRecovery({runner,held=false,onInteractionChange,open:openProp,onOpenChange,showTrigger=true,triggerLabel='Review run',returnFocusRef,compactTrigger=false}) {
 const [localOpen,setLocalOpen]=useState(false),dialog=useRef(null),trigger=useRef(null);
 const controlled=typeof openProp==='boolean',open=controlled?openProp:localOpen;
 const changeOpen=value=>{if(controlled)onOpenChange?.(value);else setLocalOpen(value);onInteractionChange?.(value);};
 useLayoutEffect(()=>{if(!open)return;const element=dialog.current;if(!element||element.open)return;element.showModal();return()=>{if(element.open)element.close();};},[open]);
 const close=()=>{changeOpen(false);requestAnimationFrame(()=>{(returnFocusRef?.current||trigger.current)?.focus();});};
 if(!open&&!showTrigger)return null;
 if(!open&&!runner.unknown&&!held)return null;
 return <>
  {showTrigger&&<button ref={trigger} type="button" onClick={()=>changeOpen(true)} title="Review or release the saved test run" aria-label={compactTrigger?triggerLabel:undefined} className={compactTrigger?"inline-flex size-7 shrink-0 items-center justify-center rounded-md text-violet-500 hover:bg-violet-500/10":"inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg border border-violet-500/30 px-2 text-xs text-violet-500 hover:bg-violet-500/10"}><span aria-hidden="true" className="material-symbols-outlined text-[16px]">fact_check</span>{!compactTrigger&&triggerLabel}</button>}
  {open&&createPortal(<dialog ref={dialog} aria-label="Review image test run" onCancel={event=>{event.preventDefault();close();}} className="image-run-dialog fixed inset-0 m-auto flex max-h-[min(84dvh,56rem)] w-[min(40rem,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-border bg-surface p-0 text-text-main shadow-xl backdrop:bg-black/60">
   <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-4 py-3"><div className="min-w-0"><h3 className="font-semibold">Image test run</h3></div><button type="button" onClick={close} aria-label="Close run review" className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-text-muted hover:bg-surface-2"><span aria-hidden="true" className="material-symbols-outlined text-[18px]">close</span></button></header>
   <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3"><ImageRunProgress runner={runner} controls/>
   {!runner.unknown&&!held&&['completed','cancelled'].includes(runner.job?.state)&&<p role="status" className="mt-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500">Run released. Eligible models can be tested.</p>}</div>
  </dialog>,document.body)}
 </>;
}
