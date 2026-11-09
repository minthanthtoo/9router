"use client";
import { useEffect, useState } from 'react';
import { ActivityChart, timeRange } from './ImageAccountCard';
import { imageCount } from './imageLearningDisplay.mjs';

export default function ImageManagementActivity({ account, rows, model = '' }) {
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState(24);
  const [selectedModel, setSelectedModel] = useState('');
  const [retry, setRetry] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const exactModel = model || selectedModel;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    const range = timeRange(hours);
    const query = new URLSearchParams({view:'insights',connection:account.connectionId,scope:'credential',...range,bucketSeconds:String(range.bucketSeconds),eventsLimit:'50'});
    if (exactModel) query.set('model',exactModel);
    setData(null); setError(false);
    fetch(`/api/private/image-quota/v1?${query}`,{cache:'no-store',signal:controller.signal})
      .then(async response => {
        const next=await response.json();
        if (!response.ok || next.schema!=='image_quota_insights.v1' || next.scope?.kind!=='credential' || next.scope.connectionId!==account.connectionId || next.scope.provider!==account.provider || (next.scope.model||'')!==exactModel || !Array.isArray(next.buckets)) throw Error();
        return next;
      })
      .then(next=>{if(active)setData(next);})
      .catch(failure=>{if(active&&failure.name!=='AbortError')setError(true);});
    return ()=>{active=false;controller.abort();};
  },[open,hours,exactModel,retry,account.connectionId,account.provider]);
  return <details className="mt-3 border-t border-border pt-2" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary className="flex min-h-10 cursor-pointer items-center gap-2 text-xs"><span aria-hidden="true" className="material-symbols-outlined text-blue-500" style={{fontSize:18}}>bar_chart</span>Activity over time</summary>
    {open && <div className="pb-2">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {[1,24,168].map(value=><button key={value} type="button" aria-pressed={hours===value} onClick={()=>setHours(value)} className={`min-h-9 rounded border px-2 text-xs ${hours===value?'border-primary text-primary':'border-border'}`}>{value===168?'7d':`${value}h`}</button>)}
        <select aria-label={`Activity model for ${account.accountLabel}`} value={exactModel} disabled={Boolean(model)} onChange={event=>setSelectedModel(event.target.value)} className="h-9 max-w-full rounded border border-border bg-surface px-2 text-xs"><option value="">All models</option>{[...new Set(rows.map(row=>row.model).filter(value=>value!=='—'))].map(value=><option key={value} value={value}>{value}</option>)}</select>
        <button type="button" aria-label={`Refresh activity for ${account.accountLabel}`} onClick={()=>setRetry(value=>value+1)} className="flex size-9 items-center justify-center rounded border border-border"><span aria-hidden="true" className="material-symbols-outlined" style={{fontSize:18}}>refresh</span></button>
      </div>
      {error ? <p role="alert" className="text-xs text-amber-500">Activity unavailable. Refresh to retry.</p> : !data ? <p role="status" className="text-xs text-text-muted">Loading recorded activity…</p> : <>
        <p className="mb-2 text-xs">{imageCount(data.counts?.dispatches)} dispatches · {imageCount(data.counts?.images)} validated images · {imageCount(data.counts?.quota_rejected)} quota refusals · {imageCount(data.counts?.outcome_unknown)} unknown</p>
        <ActivityChart insights={data} />
      </>}
      <p className="mt-2 text-[10px] text-text-muted">This credential’s retained activity only. Quota may be shared; external use is unobserved. These counts do not measure remaining capacity.</p>
    </div>}
  </details>;
}
