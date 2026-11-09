'use client';
import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import Modal from './Modal';
import ImageHelp from '../../app/(dashboard)/dashboard/quota/ImageHelp';
export default function ResetPriorityControl({value,onChange,disabled=false}) {
 const [open,setOpen]=useState(false),trigger=useRef(null),panel=useRef(null);
 useEffect(()=>{if(!open)return;panel.current?.querySelector('input')?.focus();const trap=event=>{
 if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();setOpen(false);}
 if(event.key==='Tab'){const nodes=[...panel.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')];const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
 };document.addEventListener('keydown',trap,true);return()=>{document.removeEventListener('keydown',trap,true);trigger.current?.focus({preventScroll:true});};},[open]);
 const field='h-9 min-w-0 rounded-lg border border-border bg-surface px-2 text-sm text-text-main';
 return <>
  <button ref={trigger} type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-label={`Codex reset priority: ${value.enabled?'on':'off'}`} title="Codex reset credits · conditions" onClick={()=>setOpen(true)} className={`inline-flex h-9 shrink-0 items-center gap-1 rounded-lg border px-2 text-sm ${value.enabled?'border-amber-500/40 bg-amber-500/10 text-amber-500':'border-border text-text-muted'}`}><span aria-hidden="true" className="material-symbols-outlined text-[18px]">hourglass_top</span><span className="quota-sort-label">Reset first</span>{value.enabled&&<span className="rounded bg-amber-500/10 px-1 text-[10px]">≤{value.days}d</span>}<span className="sr-only">Codex</span></button>
  {open&&createPortal(<Modal isOpen onClose={()=>setOpen(false)} title="Codex reset priority" size="sm"><div ref={panel} role="dialog" aria-modal="true" aria-label="Codex reset priority" className="space-y-4">
   <div className="flex items-center justify-between gap-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" role="switch" checked={value.enabled} disabled={disabled} onChange={event=>onChange({...value,enabled:event.target.checked})}/>Reset credits first</label><ImageHelp label="Reset priority"><p>Prefer eligible Codex accounts with unused reset credits expiring soon. The optional weekly cutoff applies to remaining allowance. This ranks accounts; it never spends a credit or clears a quota hold. Other providers do not use this condition.</p></ImageHelp></div>
   <div className="grid grid-cols-2 gap-3"><label className="flex min-w-0 flex-col gap-1 text-xs text-text-muted">Expires within<select className={field} aria-label="Credit expires within days" disabled={disabled||!value.enabled} value={value.days} onChange={event=>onChange({...value,days:Number(event.target.value)})}>{[1,2,3,5,7,14,30].map(days=><option key={days} value={days}>{days} days</option>)}</select></label><label className="flex min-w-0 flex-col gap-1 text-xs text-text-muted">Weekly left<select className={field} aria-label="Optional weekly remaining cutoff" disabled={disabled||!value.enabled} value={value.weeklyBelow??''} onChange={event=>onChange({...value,weeklyBelow:event.target.value===''?null:Number(event.target.value)})}><option value="">Any</option>{[0,10,20,30,50,75,100].map(value=><option key={value} value={value}>≤{value}%</option>)}</select></label></div>
   <button type="button" onClick={()=>setOpen(false)} className="h-9 w-full rounded-lg bg-primary/10 text-sm text-primary">Done</button>
  </div></Modal>,document.body)}
 </>;
}
