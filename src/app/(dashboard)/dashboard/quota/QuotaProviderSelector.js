"use client";
import { useEffect, useLayoutEffect, useRef, useState, useId } from "react";
import { createPortal } from "react-dom";
import ProviderIcon from "@/shared/components/ProviderIcon";

export default function QuotaProviderSelector({ value, options, onChange }) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState(null);
  const anchor = useRef(null), popup = useRef(null), id = useId();
  const selected = options.find(item => item.id === value);
  const close = () => { setOpen(false); anchor.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    const place = () => {
      const r = anchor.current?.getBoundingClientRect(); if (!r) return;
      const clip = (anchor.current.closest('.quota-controls-strip')||anchor.current.closest('.quota-filter-scroll'))?.getBoundingClientRect();
      const view = window.visualViewport, left = view?.offsetLeft || 0, top = view?.offsetTop || 0;
      const width = view?.width || innerWidth, height = view?.height || innerHeight;
      if (r.bottom <= top || r.top >= top + height || clip && (r.left < clip.left-1 || r.right > clip.right+1)) { setOpen(false); return; }
      const w = Math.min(288, width-16), below = top+height-r.bottom-8, above = r.top-top-8;
      const up = below < 220 && above > below;
      setPosition({ left: Math.max(left+8,Math.min(r.left,left+width-w-8)), width:w, maxHeight:Math.max(48,Math.min(400,up?above:below)), ...(up?{bottom:innerHeight-r.top+4}:{top:r.bottom+4}) });
    };
    place(); window.addEventListener('scroll',place,true); window.addEventListener('resize',place);
    window.visualViewport?.addEventListener('resize',place); window.visualViewport?.addEventListener('scroll',place);
    const observer = new ResizeObserver(place); observer.observe(anchor.current);
    return () => { window.removeEventListener('scroll',place,true); window.removeEventListener('resize',place); window.visualViewport?.removeEventListener('resize',place); window.visualViewport?.removeEventListener('scroll',place); observer.disconnect(); };
  },[open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = event => { if (!anchor.current?.contains(event.target) && !popup.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown',dismiss);
    return () => document.removeEventListener('pointerdown',dismiss);
  },[open]);
  useEffect(() => { if (open && position) popup.current?.querySelector('[aria-checked="true"]')?.focus(); },[open,Boolean(position)]);
  const all = [{id:'all',label:'All providers'},...options];
  return <>
    <button ref={anchor} type="button" aria-label={`Quota provider: ${selected?.label || 'All providers'}`} title="Filter quota providers" aria-haspopup="menu" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(!open)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault();setOpen(true); } else if (event.key === 'Escape') close(); }}
      className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-sm text-text-primary transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10">
      {value === 'all' ? <span aria-hidden="true" className="material-symbols-outlined text-text-muted" style={{fontSize:18}}>apps</span> : <ProviderIcon providerId={value} alt="" size={18} className="rounded object-contain" fallbackText={value.slice(0,2).toUpperCase()} />}
      <span className="quota-provider-label">{selected?.label || 'All providers'}</span><span aria-hidden="true" className="material-symbols-outlined text-text-muted" style={{fontSize:16}}>expand_more</span>
    </button>
    {open && position && createPortal(<div ref={popup} id={id} role="menu" aria-label="Quota providers" style={position} className="quota-provider-menu fixed z-[90] overflow-y-auto rounded-2xl border border-black/10 bg-surface p-1.5 shadow-xl dark:border-white/10"
      onBlur={event=>{if(!popup.current?.contains(event.relatedTarget)&&!anchor.current?.contains(event.relatedTarget))setOpen(false);}}
      onKeyDown={event=>{
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
        if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
        event.preventDefault();const items=[...popup.current.querySelectorAll('[role="menuitemradio"]')], current=items.indexOf(document.activeElement);
        const next=event.key==='Home'?0:event.key==='End'?items.length-1:(current+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();
      }}>
      {all.map(item=><button key={item.id} type="button" role="menuitemradio" aria-checked={item.id===value} onClick={()=>{onChange(item.id);close();}}
        className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${item.id===value?'bg-primary/10 text-primary':'text-text-primary hover:bg-black/5 dark:hover:bg-white/10'} ${item.id==='all'?'mb-1 border-b border-black/10 dark:border-white/10':''}`}>
        {item.id==='all'?<span aria-hidden="true" className="material-symbols-outlined" style={{fontSize:22}}>apps</span>:<ProviderIcon providerId={item.id} alt="" size={24} className="rounded-md object-contain" fallbackText={item.id.slice(0,2).toUpperCase()} />}
        <span className="font-medium">{item.label}</span>{item.id===value&&<span aria-hidden="true" className="material-symbols-outlined ml-auto" style={{fontSize:20}}>check</span>}
      </button>)}
    </div>,document.body)}
  </>;
}
