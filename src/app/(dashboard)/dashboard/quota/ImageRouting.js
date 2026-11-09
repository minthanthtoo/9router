"use client";
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import ImageHelp from './ImageHelp';
import ProviderIcon from '@/shared/components/ProviderIcon';
import QuotaSortBar from '@/shared/components/QuotaSortBar';
import RotationPreviewExplorer from '@/shared/components/RotationPreviewExplorer';
import ResetPriorityControl from '@/shared/components/ResetPriorityControl';
import {emptyRotation,rotationMetrics} from '@/shared/utils/rotationSequence.mjs';
import {resolveImageRouting,validateImageRouting} from '@/shared/utils/imageRouting.mjs';
const field='min-h-9 min-w-0 max-w-full rounded-lg border border-border bg-surface px-2 text-xs';
const stamp=value=>value?new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Not observed';
export default function ImageRouting(props){
 return <ImageRoutingEditor key={props.initialProvider||"*"} {...props}/>;
}
function ImageRoutingEditor({state,initialProvider="*"}){
 const [saved,setSaved]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[scope,setScope]=useState({operation:'generate',provider:initialProvider,model:'*'}),[draft,setDraft]=useState(null),[notice,setNotice]=useState(''),[uncertain,setUncertain]=useState(false);
 const generation=useRef(0),previewGeneration=useRef(0),capture=useRef(null),{operation,provider,model}=scope;
 const [preview,setPreview]=useState(null),[previewContext,setPreviewContext]=useState(''),[previewError,setPreviewError]=useState(''),[previewBusy,setPreviewBusy]=useState(false),[now,setNow]=useState(Date.now);
 const load=useCallback(async()=>{const request=++generation.current;try{const response=await fetch('/api/private/image-routing/v1',{cache:'no-store'});const data=await response.json();if(!response.ok||data.schema!=='image_routing.v1')throw Error();data.config=validateImageRouting(data.config);if(request===generation.current){setSaved(data);setDraft(null);setError('');setUncertain(false);}}catch{if(request===generation.current)setError('Could not read image rotation. Refresh to retry.');}},[]);
 useEffect(()=>{const epoch=generation;let disposed=false;void Promise.resolve().then(()=>{if(!disposed)return load();});return()=>{disposed=true;epoch.current++;};},[load]);
 const effective=useMemo(()=>saved?resolveImageRouting({aurixImageRouting:saved.config},provider,model,operation):null,[saved,provider,model,operation]);
 const exact=saved?.config.rules.find(rule=>rule.operation===operation&&rule.provider===provider&&rule.model===model);
 const original=useMemo(()=>({strategy:effective?.strategy||'provider',stickyRequests:effective?.stickyRequests||1,accountPreference:effective?.accountPreference||{mode:'text'},tryNextOnQuota:effective?.tryNextOnQuota!==false}),[effective]);
 const value=draft||original,preference=value.accountPreference;
 const update=patch=>{capture.current?.();setDraft({...value,...patch});setNotice('');};
 const sequence=preference.sequence||saved?.textSequences?.[provider]||emptyRotation();
 const catalog=(state.catalog||[]).filter(row=>operation!=='edit'?row.capabilities?.generation:row.capabilities?.editing);
 const providers=[...new Set(catalog.map(row=>row.provider))];
 const models=catalog.filter(row=>row.provider===provider);
 const metrics=rotationMetrics(provider);
 let validation='';try{validateImageRouting({version:1,rules:[{...scope,...value}]});}catch{validation='Choose a supported provider and at least one sort for a custom sequence.';}
 const validModel=model==='*'||models.some(row=>row.id===model);
 const previewModel=model!=='*'?model:models[0]?.id||'';
 const context=JSON.stringify([scope,value,previewModel]);
 const previewCurrent=preview&&previewContext===context&&now<preview.validUntil;
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 useEffect(()=>{
  const epoch=previewGeneration,request=++epoch.current;
  const timer=setTimeout(async()=>{
   const [previewScope,previewValue,selectedModel]=JSON.parse(context);
   if(previewScope.provider==='*'||!saved||validation||!validModel||!selectedModel){setPreview(null);setPreviewError('');setPreviewBusy(false);return;}
   setPreviewBusy(true);setPreviewError('');
   try{
    const response=await fetch(`/api/providers/${encodeURIComponent(previewScope.provider)}/rotation`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'preview',model:selectedModel,policy:saved.textSequences?.[previewScope.provider]||emptyRotation(),imageRule:{...previewScope,...previewValue}})});
    const data=await response.json();if(!response.ok)throw Error(data.error||'Preview unavailable');
    if(request===previewGeneration.current){setPreview(data.preview);setPreviewContext(context);setNow(Date.now());}
   }catch(error){if(request===previewGeneration.current)setPreviewError(error.message);}
   finally{if(request===previewGeneration.current)setPreviewBusy(false);}
  },300);
  return()=>{clearTimeout(timer);epoch.current++;};
 },[context,saved,validation,validModel]);
 const dirty=JSON.stringify(value)!==JSON.stringify(original);
 const setSource=source=>update(source==='provider'?{strategy:'provider',stickyRequests:1,accountPreference:{mode:'text'}}:{strategy:value.strategy==='provider'?'round-robin':value.strategy,accountPreference:value.accountPreference||{mode:'text'}});
 const changeScope=patch=>{setScope(current=>({...current,...patch}));setDraft(null);setNotice('');setError('');};
 const save=async remove=>{if(!saved||busy||uncertain)return;setBusy(true);setError('');setNotice('');const rules=saved.config.rules.filter(rule=>!(rule.operation===operation&&rule.provider===provider&&rule.model===model));if(!remove)rules.push({...scope,...value});try{const response=await fetch('/api/private/image-routing/v1',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:saved.revision,config:{version:1,rules}})});const data=await response.json();if(!response.ok){if(response.status===409)setUncertain(true);throw Error(response.status===409?'Changed elsewhere. Refresh and review before saving.':'Rule refused. Check its scope and values.');}setSaved(current=>({...current,...data}));setDraft(null);setNotice(remove?'Using inherited image rotation.':'Image rotation saved.');}catch(failure){setUncertain(true);setError(failure.message||'Save outcome unknown. Refresh before trying again.');}finally{setBusy(false);}};
 const quotaReads=saved?.automation?.quotaReads;
 return <section aria-label="Image rotation" className="image-study space-y-3" style={{containerType:'inline-size'}}>
  <div className="mb-2 flex flex-wrap items-center gap-1 text-[10px] text-text-muted" aria-label="Image routing order"><span className="rounded bg-surface-2 px-2 py-1">Eligible quota</span><span aria-hidden="true">→</span><span className="rounded bg-surface-2 px-2 py-1">{value.strategy==='provider'?'Provider account order':preference.mode==='text'?'Provider sequence':preference.mode==='custom'?'Custom sequence':'All eligible accounts'}</span><span aria-hidden="true">→</span><span className="rounded bg-surface-2 px-2 py-1">{value.strategy==='provider'?'Provider rotation':value.strategy==='round-robin'?'Round robin':'Fill first'}</span></div>
  <div className="image-study-heading"><h3 className="text-sm font-semibold">Image account rotation</h3><ImageHelp label="Image rotation"><p>Admission: account permission → applicable subscription allowance → image-model quota / held result → preferred account group → round robin or fill first. A zero remaining short window waits after the first sort and before later splits. Generate and Edit have separate account positions. Permission, subscription allowances, model limits and unresolved jobs are checked before preference. Text and image quotas stay separate unless the provider reports a shared scope.</p></ImageHelp><button type="button" disabled={busy} onClick={load} className="image-study-icon" aria-label="Refresh image rotation"><span className="material-symbols-outlined" aria-hidden="true">refresh</span></button></div>
  <div className="flex flex-wrap gap-2">
   <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">Request<select className={field} value={operation} disabled={busy} onChange={e=>changeScope({operation:e.target.value,model:'*'})}><option value="generate">Generate</option><option value="edit">Edit</option></select></label>
   <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">Provider<select className={field} value={provider} disabled={busy} onChange={e=>changeScope({provider:e.target.value,model:'*'})}><option value="*">All providers</option>{providers.map(id=><option key={id}>{id}</option>)}</select></label>
  </div>
  <details><summary className="cursor-pointer text-xs text-text-muted">Model override · {model==='*'?'All supported models':model}</summary><label className="mt-2 flex flex-col gap-1 text-xs">Image model<select className={field} value={model} disabled={busy||provider==='*'} onChange={e=>changeScope({model:e.target.value})}><option value="*">All supported models</option>{!validModel&&<option value={model}>{model} · unavailable</option>}{models.map(row=><option key={row.id} value={row.id}>{row.name||row.id}</option>)}</select></label></details>
  <label className="flex flex-col gap-1 text-xs">Image rotation settings<select className={field} aria-label="Image rotation settings" value={value.strategy==='provider'?'provider':'custom'} disabled={busy} onChange={e=>setSource(e.target.value)}><option value="provider">Use provider settings</option><option value="custom">Custom image settings</option></select></label>
  {value.strategy!=='provider'&&<>
   <div className="flex flex-wrap items-end gap-2">
    <label className="flex flex-1 flex-col gap-1 text-xs">Rotation method<select className={field} aria-label="Image rotation strategy" value={value.strategy} disabled={busy} onChange={e=>update({strategy:e.target.value})}><option value="round-robin">Round robin</option><option value="fill-first">Fill first</option></select></label>
    {value.strategy==='round-robin'&&<label className="flex flex-col gap-1 text-xs">Requests per account<input className={`${field} w-24`} aria-label="Sticky image requests" type="number" min="1" max="100" value={value.stickyRequests} disabled={busy} onChange={e=>update({stickyRequests:Number(e.target.value)})}/></label>}
   </div>
   <label className="flex flex-col gap-1 text-xs">Account order<select className={field} aria-label="Image account order" value={preference.mode} disabled={busy} onChange={e=>update({accountPreference:e.target.value==='custom'?{mode:'custom',sequence:{...sequence,enabled:true}}:{mode:e.target.value}})}><option value="text">Provider sequence</option><option value="none">All eligible accounts</option><option value="custom" disabled={provider==='*'||!metrics.length}>Custom sequence</option></select></label>
   {preference.mode==='custom'&&<div className="flex min-w-0 flex-wrap items-start gap-2">{provider==='codex'&&<ResetPriorityControl value={sequence.resetPriority} disabled={busy} onChange={resetPriority=>update({accountPreference:{mode:'custom',sequence:{...sequence,enabled:true,resetPriority}}})}/>}<div className="min-w-0 flex-1"><QuotaSortBar wrap provider={provider} sorts={sequence.sorts} options={metrics} disabled={busy} onChange={sorts=>update({accountPreference:{mode:'custom',sequence:{...sequence,enabled:true,sorts}}})}/></div></div>}
  </>}
  <div className="flex flex-wrap items-center gap-2 text-xs"><label className="flex min-h-9 items-center gap-2"><input type="checkbox" role="switch" checked={value.tryNextOnQuota} disabled={busy} onChange={e=>update({tryNextOnQuota:e.target.checked})}/>Try next account on quota limit</label><ImageHelp label="Quota failover"><p>Tries the next eligible account for a definite quota rejection, within the existing request/time budget. Keeps the requested model and operation. Invalid requests, unknown accepted work and a response already delivered cannot be blindly retried. Attempts are recorded in history.</p></ImageHelp></div>
  <div className="flex flex-wrap items-center gap-2"><button type="button" disabled={!saved||busy||uncertain||!dirty||!!validation||!validModel} onClick={()=>save(false)} className="min-h-9 rounded-lg bg-primary px-3 text-sm text-white disabled:opacity-40">{busy?'Saving…':'Save image rotation'}</button>{exact&&<button type="button" disabled={busy||uncertain} onClick={()=>save(true)} className="min-h-9 rounded-lg border border-border px-3 text-xs disabled:opacity-40">Remove override</button>}<span className="text-xs text-text-muted">{draft?'Unsaved changes':exact?'Saved override':effective?'Inherited image rule':'Provider settings'}</span></div>
  {validation&&<p role="status" className="text-xs text-amber-500">{validation}</p>}{!validModel&&<p role="alert" className="text-xs text-amber-500">Model unavailable. Select a supported model or remove its override.</p>}{error&&<p role="alert" className="text-xs text-amber-500">{error} <button className="underline" disabled={busy} onClick={load}>Refresh</button></p>}{notice&&<p role="status" className="text-xs text-emerald-500">{notice}</p>}
  {provider!=='*'&&<section aria-label="Image rotation preview" className="border-t border-border-subtle pt-2"><div className="flex flex-wrap items-center gap-2 text-xs"><strong>Preview</strong><span className="min-w-0 break-all text-text-muted">{previewModel} · saved observations</span>{previewBusy&&<span role="status">Updating…</span>}</div>{previewError&&<p role="alert" className="text-xs text-amber-500">{previewError}</p>}{preview&&<RotationPreviewExplorer provider={provider} captureRef={capture} preview={preview} current={!!previewCurrent} dirty={!!draft} now={now} updating={previewBusy}/>}</section>}
  <details className="border-t border-border-subtle pt-2 text-xs"><summary className="min-h-8 cursor-pointer">Automation · {quotaReads?.running?'Quota reads running':quotaReads?.configured?'Quota reads configured':'No automatic quota reads'}</summary><dl className="mt-2 grid grid-cols-2 gap-2"><dt>Quota reads</dt><dd>{quotaReads?.running?'Server timer · every minute':'Not running in this process'}</dd><dt>Last attempt</dt><dd>{stamp(quotaReads?.lastAttemptAt)}</dd><dt>Last success</dt><dd>{stamp(quotaReads?.lastSuccessAt)}</dd><dt>Next timer tick</dt><dd>{stamp(quotaReads?.nextDueAt)}</dd><dt>Heartbeat</dt><dd>{stamp(quotaReads?.heartbeatAt)}</dd><dt>Passive learning</dt><dd>Recorded traffic</dd><dt>Image recovery tests</dt><dd>Manual · not scheduled</dd></dl>{quotaReads?.lastError&&<p role="alert" className="mt-2 text-amber-500">{quotaReads.lastError}</p>}<p className="mt-2 text-text-muted">This server process only. Refresh for current status. Enabling a sequence starts read-only monitoring; image tests consume allowance and require an explicit action.</p></details>
  <details className="border-t border-border-subtle pt-2 text-xs"><summary className="min-h-8 cursor-pointer">Saved overrides · {saved?.config.rules.length||0}</summary><ul>{saved?.config.rules.map(rule=><li key={`${rule.operation}:${rule.provider}:${rule.model}`}><button type="button" disabled={busy} onClick={()=>changeScope({operation:rule.operation,provider:rule.provider,model:rule.model})} className="flex min-h-10 w-full flex-wrap items-center gap-2 border-t border-border-subtle py-2 text-left">{rule.provider!=='*'&&<ProviderIcon providerId={rule.provider} alt="" size={18}/>}<strong>{rule.operation==='edit'?'Edit':'Generate'}</strong><span>{rule.provider==='*'?'All providers':rule.provider}</span><span className="min-w-0 break-all text-text-muted">{rule.model==='*'?'All models':rule.model}</span><span className="ml-auto text-primary">Edit</span></button></li>)}</ul></details>
 </section>;
}
