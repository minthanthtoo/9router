"use client";
import { useEffect, useRef, useState } from 'react';
import { ActivityChart, timeRange, insightQuery, date } from './ImageActivityChart';
import ImageHelp from './ImageHelp';
import { imageCount } from './imageLearningDisplay.mjs';
export default function ImageModelActivity({ connection, model, row, live = false, revision, context }) {
  const [rangeHours, setRangeHours] = useState(24), [retry, setRetry] = useState(0);
  const [insights, setInsights] = useState(null), [insightsError, setInsightsError] = useState(''), [eventsLoading, setEventsLoading] = useState(false);
  const insightRequestGeneration = useRef(0);
  useEffect(() => {
    setEventsLoading(false);
    
    let active = true;
    const generation = ++insightRequestGeneration.current;
    const controller = new AbortController();
    const range = timeRange(rangeHours);
    const query = insightQuery(connection.id, range, model);
    if(!live)setInsights(null);
    setInsightsError("");
    fetch(`/api/private/image-quota/v1?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data?.error?.message || "Activity unavailable"); if (data.schema !== "image_quota_insights.v1" || data.scope?.connectionId !== connection.id || data.scope?.provider !== connection.provider || data.scope?.model !== model || data.scope?.kind !== "credential" || !Array.isArray(data.buckets)) throw new Error("Activity did not match this account"); return data; })
      .then((data) => { if (active && generation === insightRequestGeneration.current) setInsights(data); })
      .catch((error) => { if (active && generation === insightRequestGeneration.current && error.name !== "AbortError") setInsightsError(error.message || "Activity unavailable"); });
    return () => { active = false; controller.abort(); if (insightRequestGeneration.current === generation) insightRequestGeneration.current += 1; };
  }, [connection.id, connection.provider, model, rangeHours, retry]);

  useEffect(()=>{if(!live)return;const timer=setInterval(()=>setRetry(value=>value+1),2500);return()=>clearInterval(timer);},[live]);
  useEffect(()=>{if(revision!==undefined)setRetry(value=>value+1);},[revision]);

  const loadMoreEvents = async () => {
    const current = insights;
    const cursor = current?.events?.nextCursor;
    if (!current || !cursor || eventsLoading || current.events.items.length >= 500) return;
    const generation = insightRequestGeneration.current;
    const query = insightQuery(connection.id, current.range, current.scope.model, current.events.limit, cursor);
    setEventsLoading(true);
    setInsightsError("");
    try {
      const response = await fetch(`/api/private/image-quota/v1?${query}`, { cache: "no-store" });
      const page = await response.json();
      if (!response.ok || page.schema !== "image_quota_insights.v1" || page.scope?.connectionId !== connection.id
        || page.scope?.model !== current.scope.model || page.scope?.kind !== current.scope.kind
        || page.range?.from !== current.range.from || page.range?.to !== current.range.to
        || page.range?.bucketSeconds !== current.range.bucketSeconds || !Array.isArray(page.events?.items)) {
        throw new Error("Activity page did not match this account and range");
      }
      if (generation === insightRequestGeneration.current) {
        setInsights((previous) => previous && previous.range.from === current.range.from
          && previous.range.to === current.range.to && previous.scope.model === current.scope.model
          ? { ...previous, events: { ...previous.events, nextCursor: page.events.nextCursor,
            items: [...previous.events.items, ...page.events.items] } }
          : previous);
      }
    } catch (error) {
      if (generation === insightRequestGeneration.current) setInsightsError(error.message || "Activity unavailable");
    } finally {
      if (generation === insightRequestGeneration.current) setEventsLoading(false);
    }
  };

  return <div>
    <div className="mb-1.5 flex flex-wrap items-center gap-1.5"><strong>Activity</strong><ImageHelp label="Recorded activity"><p>This credential’s retained activity; retries count separately. External use is unobserved. Activity does not measure remaining allowance.</p>{context}{row?.providerUsageEvidence&&<div className="mt-2"><strong>Provider · {date(row.providerUsageEvidence.observedAt,true)}</strong><p>{row.providerUsageEvidence.source}</p>{(row.providerUsageEvidence.windows||[]).filter(window=>!window.model||window.model===model).map((window,index)=><p key={index}>{window.scope==='account'||!window.model?'Shared · ':''}{window.limitId}: {window.remainingPercentage??'Unknown'}{Number.isFinite(window.remainingPercentage)?'%':''} · reset {date(window.resetAt,true)}</p>)}</div>}{insights?.events?.items?.length>0&&<details className="mt-2"><summary className="cursor-pointer">Requests · {insights.events.items.length}{insights.events.truncated?'+':''}</summary><ol className="space-y-1">{insights.events.items.map((event,index)=><li key={`${event.dispatchedAt}-${index}`}><time dateTime={event.dispatchedAt}>{date(event.dispatchedAt,true)}</time> · {event.model} · {event.outcome.replaceAll('_',' ')}{event.httpStatus&&<> · HTTP {event.httpStatus}</>}{event.retryAt&&<> · check {date(event.retryAt,true)}</>}</li>)}</ol>{insights.events.nextCursor&&insights.events.items.length<500&&<button type="button" onClick={()=>void loadMoreEvents()} disabled={eventsLoading} className="min-h-9 px-2">{eventsLoading?'Loading…':'Load more'}</button>}{insights.events.nextCursor&&insights.events.items.length>=500&&<p>Use a shorter range to inspect earlier attempts.</p>}</details>}</ImageHelp>{live&&<span role="status" className="inline-flex items-center gap-1 text-primary"><span className="size-1.5 animate-pulse rounded-full bg-primary"/>Live</span>}{[[1,'1h'],[24,'24h'],[168,'7d']].map(([hours,label])=><button key={hours} type="button" aria-pressed={rangeHours===hours} onClick={()=>setRangeHours(hours)} className={`min-h-8 rounded-md border px-2 text-[10px] ${rangeHours===hours?'border-primary bg-primary/10 text-primary':'border-border text-text-muted'}`}>{label}</button>)}<button type="button" onClick={()=>setRetry(value=>value+1)} aria-label="Refresh saved activity" title="Refresh activity" className="ml-auto flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-2"><span aria-hidden="true" className="material-symbols-outlined text-base">refresh</span></button></div>
    {insightsError&&<p role="alert" className="text-amber-500">{insightsError}</p>}
    {!insights&&!insightsError&&<p role="status">Loading saved activity…</p>}
    {insights&&<><p className="mb-1 text-[10px] text-text-muted"><strong className="text-text-main">{imageCount(insights.counts?.dispatches)}</strong> requests · <strong className="text-text-main">{imageCount(insights.counts?.images)}</strong> images{insights.counts?.outcome_unknown>0&&<> · <strong className="text-violet-500">{imageCount(insights.counts.outcome_unknown)}</strong> unconfirmed</>}</p><ActivityChart insights={insights} compact/></>}
  </div>;
}
