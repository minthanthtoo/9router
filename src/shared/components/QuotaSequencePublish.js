'use client';
import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import Modal from './Modal';
import Button from './Button';
import ProviderIcon from './ProviderIcon';
import ImageHelp from '../../app/(dashboard)/dashboard/quota/ImageHelp';
import {getModelsByProviderId} from '../constants/models';
import {quotaSequencePolicy,rotationPublishReady,sameQuotaSequence} from '../utils/quotaSequenceDraft.mjs';
import styles from './quotaSequencePublish.module.css';
const textModels=provider=>getModelsByProviderId(provider).filter(row=>!['image','image_generation','embedding','tts','stt'].includes(row.kind||row.type)&&!row.imageGen);
async function request(provider,method,body) {
 const response=await fetch(`/api/providers/${encodeURIComponent(provider)}/rotation${method==='GET'?'?summary=1':''}`,{method,cache:'no-store',...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
 const data=await response.json();if(!response.ok){const error=new Error(data.error||'Rotation request failed');error.status=response.status;throw error;}return data;
}
export default function QuotaSequencePublish({sorts,resetPriority,groupAvailability,providers,providerFilter,model,modelProvider,onPreview,onApplied}) {
 const [open,setOpen]=useState(false),[curated,setCurated]=useState(null),[selected,setSelected]=useState([]),[rows,setRows]=useState({}),[busy,setBusy]=useState(false),[receipt,setReceipt]=useState(''),[now,setNow]=useState(Date.now);
 const dialog=useRef(null),launcher=useRef(null),generation=useRef(0),jobs=useRef(new Map()),busyRef=useRef(false);
 busyRef.current=busy;
 const openReview=()=>{
  const ids=[...new Set(providers)],policies={},unsupported={};
  for(const provider of ids){try{policies[provider]=quotaSequencePolicy(provider,sorts,resetPriority,groupAvailability);}catch(error){unsupported[provider]=error.message;}}
  generation.current++;jobs.current.clear();setCurated({sorts:sorts.map(sort=>({...sort})),resetPriority:{...resetPriority},providers:ids,policies,unsupported});setRows({});setSelected(providerFilter!=='all'&&policies[providerFilter]?[providerFilter]:[]);setReceipt('');setOpen(true);
 };
 useEffect(()=>{
  if(!open)return;
  const frame=requestAnimationFrame(()=>dialog.current?.focus());const timer=setInterval(()=>setNow(Date.now()),1000);
  const trap=event=>{
   if(event.key==='Escape'){const detail=event.target.closest?.('details');if(detail?.open){event.preventDefault();event.stopImmediatePropagation();detail.open=false;detail.querySelector('summary')?.focus();return;}event.preventDefault();event.stopImmediatePropagation();if(!busyRef.current)setOpen(false);}
   if(event.key!=='Tab')return;
   const elements=[...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]')].filter(node=>node.getClientRects().length&&!node.closest('details:not([open]) > :not(summary)'));
   if(!elements.length)return;const first=elements[0],last=elements.at(-1);
   if(!dialog.current.contains(document.activeElement)||document.activeElement===dialog.current){event.preventDefault();(event.shiftKey?last:first).focus();}
   else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  };
  document.addEventListener('keydown',trap,true);return()=>{generation.current++;cancelAnimationFrame(frame);clearInterval(timer);document.removeEventListener('keydown',trap,true);launcher.current?.focus({preventScroll:true});};
 },[open]);
 const prepare=async(provider,chosenModel)=>{
  const generationId=generation.current,job=(jobs.current.get(provider)||0)+1;jobs.current.set(provider,job);
  const fresh=()=>generation.current===generationId&&jobs.current.get(provider)===job;
  const models=textModels(provider),candidate=chosenModel??rows[provider]?.model??(model&&(!modelProvider||modelProvider===provider)&&models.some(row=>row.id===model)?model:models[0]?.id||'');
  setRows(current=>({...current,[provider]:{...current[provider],model:candidate,loading:true,error:'',status:'',preview:null}}));
  try{
   if(!candidate)throw new Error('Choose a text model to preview');
   const saved=await request(provider,'GET');
   const result=await request(provider,'POST',{action:'preview',policy:curated.policies[provider],model:candidate});
   if(fresh())setRows(current=>({...current,[provider]:{model:candidate,revision:saved.revision,savedPolicy:saved.policy,preview:result.preview,loading:false,status:'',error:''}}));
  }catch(error){if(fresh())setRows(current=>({...current,[provider]:{...current[provider],loading:false,error:error.message}}));}
 };
 useEffect(()=>{
  if(!open||!curated)return;
  for(const provider of selected)if(!rows[provider])void prepare(provider);
 },[open,curated,selected,rows]);
 const toggle=provider=>{if(busy||rows[provider]?.status==='applied')return;setSelected(current=>current.includes(provider)?current.filter(id=>id!==provider):[...current,provider]);};
 const pending=selected.filter(provider=>rows[provider]?.status!=='applied'),ready=pending.length>0&&pending.every(provider=>rotationPublishReady(rows[provider],now));
 const publish=async()=>{
  if(!pending.every(provider=>rotationPublishReady(rows[provider],Date.now())))return;
  setBusy(true);let succeeded=0,failed=0;const applied=[];
  for(const provider of pending){
   const row=rows[provider];
   if(!rotationPublishReady(row,Date.now())){failed++;setRows(current=>({...current,[provider]:{...current[provider],error:'Review expired while applying. Refresh before trying again.'}}));continue;}
   setRows(current=>({...current,[provider]:{...current[provider],status:'saving'}}));
   try{
    await request(provider,'PATCH',{policy:curated.policies[provider],revision:row.revision});succeeded++;applied.push(provider);setRows(current=>({...current,[provider]:{...current[provider],status:'applied',error:''}}));
   }catch(error){
    if(error.status===409){failed++;setRows(current=>({...current,[provider]:{...current[provider],status:'conflict',error:'Changed elsewhere. Refresh review before replacing it.'}}));continue;}
    // A lost response is reconciled by reading; never automatically repeat a publication.
    try{const actual=await request(provider,'GET');if(sameQuotaSequence(actual.policy,curated.policies[provider])){succeeded++;applied.push(provider);setRows(current=>({...current,[provider]:{...current[provider],status:'applied',error:''}}));}else{failed++;setRows(current=>({...current,[provider]:{...current[provider],status:'error',error:'Not confirmed. Refresh review before trying again.'}}));}}
    catch{failed++;setRows(current=>({...current,[provider]:{...current[provider],status:'uncertain',error:'Save outcome unknown. Check live settings before retrying.'}}));}
   }
  }
  for(const provider of applied)onApplied?.(provider,curated.policies[provider]);
  setReceipt(`${succeeded} applied${failed?` · ${failed} need review`:''}. Each provider is saved separately.`);setBusy(false);
 };
 const compatible=curated?curated.providers.filter(provider=>curated.policies[provider]):[];
 return <>
  <button ref={launcher} type="button" disabled={!sorts.length&&!resetPriority.enabled} onClick={openReview} className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg border border-primary/40 bg-primary/10 px-2 text-sm text-primary disabled:opacity-40" aria-label="Apply sequence to providers" title="Apply sequence to providers"><span aria-hidden="true" className="material-symbols-outlined text-[18px]">playlist_add_check</span><span className="quota-sort-label">Apply</span></button>
  {open&&curated&&createPortal(<Modal isOpen={open} onClose={()=>{if(!busy)setOpen(false);}} title="Apply sequence" size="sm" className={styles.modal}>
   <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Apply sequence" className={styles.editor}>
    <div className={styles.body}>
     <div className={styles.selection}><button type="button" disabled={busy} onClick={()=>setSelected(current=>[...new Set([...current,...compatible])])}>All compatible ({compatible.length})</button><button type="button" disabled={busy} onClick={()=>setSelected(current=>current.filter(provider=>rows[provider]?.status==='applied'))}>Clear</button><ImageHelp label="Apply sequence"><p>Replaces and enables the selected providers’ account sequence. Card filters and pins do not limit routing. Image rules select inside its preferred group. Codex reset conditions are omitted for other providers. Compatibility, saved quota preview and revision are checked before saving. Each provider saves separately; successful providers are not repeated. Use provider settings for detailed model comparison.</p></ImageHelp></div>
     {curated.providers.map(provider=>{
      const row=rows[provider],chosen=selected.includes(provider),invalid=curated.unsupported[provider],isReady=rotationPublishReady(row,now);
      return <article key={provider} className={`${styles.provider} ${chosen?styles.selected:''}`}>
       <div className={styles.providerHeader}><label><input type="checkbox" aria-label={`Apply to ${provider}`} disabled={Boolean(invalid)||busy||row?.status==='applied'} checked={chosen} onChange={()=>toggle(provider)}/><ProviderIcon providerId={provider} size={20} alt=""/><strong>{provider}</strong></label><a href={`/dashboard/providers/${provider}?rotation=1`} className={styles.settings} aria-label={`Review ${provider} rotation`} title="Review rotation"><span aria-hidden="true" className="material-symbols-outlined">tune</span></a>{row?.status==='applied'?<span className={styles.success}>✓ Applied</span>:row?.loading?<span role="status" className={styles.note}>Checking…</span>:chosen&&isReady?<span className={styles.success}>✓ Ready</span>:null}</div>
       {invalid&&<span className={styles.note}>{invalid}</span>}
       {chosen&&!invalid&&row?.preview&&!isReady&&row.status!=='applied'&&!row.error&&<button type="button" disabled={busy||row.loading} onClick={()=>void prepare(provider)}>Refresh review</button>}
       {chosen&&row?.error&&<div role="alert" className={styles.error}>{row.error} <button type="button" disabled={busy||row.loading} onClick={()=>void prepare(provider)}>Refresh review</button></div>}
      </article>;
     })}
     {!curated.providers.length&&<p>No configured providers found.</p>}
     {receipt&&<p role="status" className={styles.note}>{receipt}</p>}
    </div>
    <footer className={styles.footer}><span>{busy?'Applying…':!pending.length?selected.length?'Selected providers applied':'Choose providers':!ready?'Selected providers need a current review':`${pending.length} selected`}</span><div><Button variant="ghost" disabled={busy} onClick={()=>setOpen(false)}>Close</Button><Button disabled={busy||!ready} onClick={publish}>{busy?'Applying…':`Apply to ${pending.length} provider${pending.length===1?'':'s'}`}</Button></div></footer>
   </section>
  </Modal>,document.body)}
 </>;
}
