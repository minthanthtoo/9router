"use client";
import {createPortal} from "react-dom";

import { useLayoutEffect, useRef, useState, useImperativeHandle } from "react";
import styles from "./imageManagementMotion.module.css";
import ImageRouting from "./ImageRouting";
import dynamic from "next/dynamic";
const ImageAnalytics = dynamic(() => import("./ImageAnalytics"), { loading: () => <p role="status">Loading history…</p> });
import ImageQuotaPanel from "./ImageQuotaPanel";

export default function ImageManagementDialog({ state, onOpenAccountSettings, onSelectModel, settingsError, controlsRef }) {
  const dialog = useRef(null);
  const trigger = useRef(null);
  const [open, setOpen] = useState(false);
  const [view,setView]=useState("accounts");
  const [rotationProvider,setRotationProvider]=useState("*");
  const [visited,setVisited]=useState(new Set(["accounts"]));
  const selectView=key=>{setVisited(current=>new Set([...current,key]));setView(key);};
  useImperativeHandle(controlsRef,()=>({openRotation(provider){setRotationProvider(provider);selectView("routing");setOpen(true);}}));
  useLayoutEffect(() => {
    if (!open) return;
    const element = dialog.current;
    if (!element || element.open) return;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, [open]);
  const close = () => {
    dialog.current?.close();
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  return <>
    <button ref={trigger} type="button" onClick={() => setOpen(true)} aria-label="Image management" title="Manage image generation & editing" className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-black/10 px-2 text-xs text-primary transition-colors hover:bg-primary/10 dark:border-white/10"><span aria-hidden="true" className="material-symbols-outlined" style={{fontSize:18}}>photo_library</span><span className="hidden sm:inline">Image management</span></button>
    {open && createPortal(<dialog ref={dialog} aria-labelledby="image-management-title" onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === event.currentTarget) close(); }} className="image-management-dialog fade-in fixed inset-0 m-auto max-h-[85dvh] w-[calc(100vw-2rem)] max-w-4xl overflow-hidden rounded-[14px] border border-border-subtle bg-surface p-0 text-text-main shadow-[var(--shadow-elev)] backdrop:bg-black/50 backdrop:backdrop-blur-[2px] motion-reduce:transition-none" style={{gridTemplateRows:"auto minmax(0,1fr)",display:"grid"}}>
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle p-2">
        <div className="flex min-w-0 items-center">
          <div className="ml-2 mr-4 hidden items-center gap-2 md:flex">
            <button autoFocus type="button" onClick={close} aria-label="Close" title="Close" className="group/dot flex size-4 items-center justify-center rounded-full bg-[#FF5F56] transition-all hover:brightness-90"><span aria-hidden="true" className="text-[9px] font-bold leading-none text-white opacity-0 transition-opacity group-hover/dot:opacity-100">✕</span></button>
            <span aria-hidden="true" className="size-4 rounded-full bg-[#3a3a3a]/20 dark:bg-white/15" /><span aria-hidden="true" className="size-4 rounded-full bg-[#3a3a3a]/20 dark:bg-white/15" />
          </div>
          <h2 id="image-management-title" className="truncate text-lg font-semibold text-text-main">Image management</h2>
        </div>
        <button type="button" onClick={close} aria-label="Close" title="Close image management" className="rounded-[10px] p-1.5 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main md:hidden"><span aria-hidden="true" className="material-symbols-outlined text-[20px]">close</span></button>
      </div>
      <div className="image-workspace min-h-0 overflow-y-auto overscroll-contain p-3 text-sm custom-scrollbar sm:p-4">
      <div role="tablist" aria-label="Image management workspace" className="mb-4 flex gap-1 overflow-x-auto border-b border-border-subtle">{[["accounts","account_tree","Availability"],["routing","alt_route","Rotation"],["analytics","monitoring","History"]].map(([key,icon,label])=><button key={key} type="button" role="tab" id={`image-workspace-${key}`} aria-selected={view===key} aria-controls={`image-workspace-panel-${key}`} onClick={()=>selectView(key)} onKeyDown={event=>{if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;event.preventDefault();const tabs=["accounts","routing","analytics"],next=event.key==="Home"?tabs[0]:event.key==="End"?tabs[2]:tabs[(tabs.indexOf(key)+(event.key==="ArrowRight"?1:2))%3];selectView(next);event.currentTarget.parentElement.querySelector(`#image-workspace-${next}`)?.focus();}} tabIndex={view===key?0:-1} className={`inline-flex min-h-10 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors ${view===key?"border-brand-500 text-brand-500":"border-transparent text-text-muted hover:bg-surface-2 hover:text-text-main"}`}><span aria-hidden="true" className="material-symbols-outlined" style={{fontSize:18}}>{icon}</span>{label}</button>)}</div>
      <div className="min-w-0">
      {["accounts","analytics","routing"].filter(key=>visited.has(key)).map(key=><div key={key} role="tabpanel" hidden={view!==key} id={`image-workspace-panel-${key}`} aria-labelledby={`image-workspace-${key}`} className={`min-w-0 ${view===key?styles.enter:""}`}>
      {key==="routing"?<ImageRouting state={state} initialProvider={rotationProvider}/>:key==="analytics"?<ImageAnalytics state={state}/>:<ImageQuotaPanel state={state} onOpenAccountSettings={onOpenAccountSettings} onSelectModel={onSelectModel} settingsError={settingsError} />}
      </div>)}
      </div>
      </div>
    </dialog>,document.body)}
  </>;
}
