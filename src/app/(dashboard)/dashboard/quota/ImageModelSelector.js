"use client";
import { useEffect, useLayoutEffect, useRef, useState, useId } from "react";
import { createPortal } from "react-dom";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { QUOTA_MODEL_ID } from "@/shared/utils/quotaModelCatalog.mjs";

export default function ImageModelSelector({ value = "", catalog = [], loading = false, onCommit }) {
  const container = useRef(null), input = useRef(null), popup = useRef(null);
  const id = useId();
  const [draft, setDraft] = useState(value), [open, setOpen] = useState(false), [activeKey, setActiveKey] = useState("");
  const [position, setPosition] = useState(null);
  useEffect(() => setDraft(value), [value]);
  const term = draft.trim().toLocaleLowerCase();
  const matches = catalog.filter(item => !term || `${item.id} ${item.name} ${item.providers?.map(p=>p.provider).join(' ')}`.toLocaleLowerCase().includes(term)).slice(0,40);
  const activeIndex = Math.max(0,matches.findIndex(item => item.id === activeKey));
  useEffect(() => {
    if (!open) return;
    const dismiss = event => { if (!container.current?.contains(event.target) && !popup.current?.contains(event.target)) { setOpen(false);setDraft(value); } };
    document.addEventListener("pointerdown",dismiss);
    return () => document.removeEventListener("pointerdown",dismiss);
  },[open,value]);
  useLayoutEffect(() => {
    if (!open) {setPosition(null);return;}
    const place = () => {
      const anchor=container.current?.getBoundingClientRect();if(!anchor)return;
      const scroll=(container.current.closest('.quota-controls-strip')||container.current.closest('.quota-filter-scroll'))?.getBoundingClientRect();
      const viewport=window.visualViewport, left=viewport?.offsetLeft||0, top=viewport?.offsetTop||0;
      const width=viewport?.width||innerWidth,height=viewport?.height||innerHeight;
      if(anchor.bottom<=top||anchor.top>=top+height||(scroll&&(anchor.left<scroll.left-1||anchor.right>scroll.right+1))){setOpen(false);setDraft(value);return;}
      const panelWidth=Math.min(Math.max(anchor.width,360),width-16);
      const below=top+height-anchor.bottom-8,above=anchor.top-top-8;
      const upward=below<220&&above>below;
      const space=upward?above:below;
      if(space<48){setOpen(false);return;}
      const maxHeight=Math.min(360,space);
      setPosition({left:Math.max(left+8,Math.min(anchor.left,left+width-panelWidth-8)),...(upward?{bottom:innerHeight-anchor.top+4}:{top:anchor.bottom+4}),width:panelWidth,maxHeight});
    };
    place();
    window.addEventListener('scroll',place,true);window.addEventListener('resize',place);
    window.visualViewport?.addEventListener('resize',place);window.visualViewport?.addEventListener('scroll',place);
    const observer=new ResizeObserver(place);observer.observe(container.current);
    return()=>{window.removeEventListener('scroll',place,true);window.removeEventListener('resize',place);window.visualViewport?.removeEventListener('resize',place);window.visualViewport?.removeEventListener('scroll',place);observer.disconnect();};
  },[open,value]);
  useEffect(()=>{if(open&&activeKey)document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({block:"nearest"});},[open,activeKey,activeIndex,id]);
  const commit=(next,provider="")=>{if(next&&!QUOTA_MODEL_ID.test(next))return;onCommit(next,provider);setDraft(next);setOpen(false);input.current?.focus();};
  const choose=item=>commit(item.id,"");
  const showAll=()=>{container.current?.scrollIntoView({block:'nearest',inline:'nearest'});setDraft("");setOpen(true);setActiveKey("");requestAnimationFrame(()=>input.current?.focus());};
  return <div ref={container} className="relative w-52 shrink-0" onBlur={event=>{if(!container.current?.contains(event.relatedTarget)&&!popup.current?.contains(event.relatedTarget)){setOpen(false);setDraft(value);}}}>
    <label htmlFor={id} className="sr-only">Model filter</label>
    <span aria-hidden="true" className="material-symbols-outlined pointer-events-none absolute left-2 top-2 text-blue-500" style={{fontSize:18}}>search</span>
    <input ref={input} id={id} role="combobox" autoComplete="off" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-options`} aria-activedescendant={open&&matches[activeIndex]?`${id}-option-${activeIndex}`:undefined}
      value={draft} onFocus={event=>{event.target.select();container.current?.scrollIntoView({block:'nearest',inline:'nearest'});setOpen(true);}}
      onChange={event=>{setDraft(event.target.value);setActiveKey("");setOpen(true);}}
      onKeyDown={event=>{
        if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();setOpen(true);if(matches.length){const step=event.key==='ArrowDown'?1:-1;setActiveKey(matches[(activeIndex+step+matches.length)%matches.length].id);}}
        else if(event.key==='Enter'){event.preventDefault();matches[activeIndex]?choose(matches[activeIndex]):QUOTA_MODEL_ID.test(draft.trim())&&commit(draft.trim());}
        else if(event.key==='Escape'){event.preventDefault();setDraft(value);setOpen(false);}
      }} placeholder="All models" className="h-9 w-full rounded-lg border border-black/10 bg-surface pl-8 pr-[4.25rem] text-sm text-text-primary outline-none focus:border-primary/60 dark:border-white/10" />
    <div className="absolute right-0 top-0 flex h-9 items-center">
      {(draft||value)&&<button type="button" aria-label="Clear model filter" title="Clear model filter" className="flex size-8 items-center justify-center rounded text-text-muted hover:text-primary" onMouseDown={event=>event.preventDefault()} onClick={()=>{onCommit("","");setDraft("");setActiveKey("");setOpen(true);input.current?.focus();}}><span aria-hidden="true" className="material-symbols-outlined" style={{fontSize:16}}>close</span></button>}
      <button type="button" aria-label="Choose model" aria-expanded={open} aria-haspopup="listbox" title="Choose model" className="flex size-8 items-center justify-center rounded text-text-muted hover:text-primary" onMouseDown={event=>event.preventDefault()} onClick={()=>open?(setOpen(false),setDraft(value)):showAll()}><span aria-hidden="true" className="material-symbols-outlined" style={{fontSize:18}}>expand_more</span></button>
    </div>
    {open&&position&&createPortal(<div ref={popup} className="fixed z-[90] overflow-auto rounded-xl border border-border bg-surface p-1 shadow-xl" style={position}>
      <div className="px-2 py-1 text-[10px] text-text-muted">{loading?'Updating counts…':'Configured account matches · current filters'}</div>
      <ul id={`${id}-options`} role="listbox" aria-label="Models">
        {matches.map((item,index)=><li key={item.id} id={`${id}-option-${index}`} role="option" aria-selected={index===activeIndex}>
          <button type="button" tabIndex={-1} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(item)} className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs ${index===activeIndex?'bg-primary/10':'hover:bg-black/5 dark:hover:bg-white/5'}`}>
            <span aria-hidden="true" className={`material-symbols-outlined shrink-0 ${item.kind==='image'?'text-violet-500':'text-blue-500'}`} style={{fontSize:18}}>{item.kind==='image'?'image':'chat_bubble'}</span>
            <span className="min-w-0 flex-1"><span className="block truncate">{item.name}</span><span className="block truncate text-[10px] text-text-muted">{item.id}</span></span>
            <span className="flex shrink-0 items-center gap-1" aria-label="Matching providers">{item.providers.filter(provider=>provider.accountCount>0).slice(0,3).map(provider=><span key={provider.provider} title={`${provider.provider}: ${provider.accountCount} matching accounts`}><ProviderIcon providerId={provider.provider} alt={provider.provider} size={16} className="rounded object-contain" fallbackText={provider.provider.slice(0,2).toUpperCase()} /></span>)}{item.providerCount>3&&<span className="text-[9px] text-text-muted">+{item.providerCount-3}</span>}</span>
            <span className="flex shrink-0 items-center gap-2 tabular-nums text-text-muted"><span className="inline-flex items-center gap-0.5" aria-label={`${item.accountCount} accounts`} title={`${item.accountCount} matching account cards`}><span aria-hidden="true" className="material-symbols-outlined" style={{fontSize:14}}>account_circle</span>{item.accountCount}</span><span className="inline-flex items-center gap-0.5" aria-label={`${item.providerCount} providers`} title={`${item.providerCount} providers with matching accounts`}><span aria-hidden="true" className="material-symbols-outlined" style={{fontSize:14}}>hub</span>{item.providerCount}</span></span>
          </button>
        </li>)}
      </ul>
      {!matches.length&&<p role="status" className="px-2 py-3 text-xs text-text-muted">{loading?'Loading models…':'No matching catalog models.'}</p>}
      <p className="border-t border-border px-2 py-1.5 text-[10px] text-text-muted">Counts match configured cards, not confirmed access or available quota.</p>
    </div>,document.body)}
  </div>;
}
