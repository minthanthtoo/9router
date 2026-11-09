"use client";
import {useEffect,useRef,useState} from "react";
export function date(value, compact = false) {
  if (!value) return "Unknown";
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return "Unknown";
  return time.toLocaleString(undefined, compact
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { dateStyle: "medium", timeStyle: "short" });
}

export function timeRange(hours) {
  const to = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const from = new Date(to.getTime() - hours * 3_600_000);
  return { from: from.toISOString(), to: to.toISOString(), bucketSeconds: hours === 1 ? 60 : hours === 24 ? 600 : 3600 };
}

export function insightQuery(connectionId, range, model, eventsLimit = 50, eventsCursor = null) {
  const query = new URLSearchParams({ view: "insights", connection: connectionId, scope: "credential",
    from: range.from, to: range.to, bucketSeconds: String(range.bucketSeconds), eventsLimit: String(eventsLimit) });
  if (model) query.set("model", model);
  if (eventsCursor) query.set("eventsCursor", eventsCursor);
  return query;
}

const LABELS = {succeeded:"Succeeded",quota_rejected:"Quota limit",provider_rejected:"Rejected",outcome_unknown:"Unconfirmed",in_flight:"Running"};
const SERIES = [
  ["succeeded", "#16a34a"], ["quota_rejected", "#dc2626"], ["provider_rejected", "#d97706"],
  ["outcome_unknown", "#7c3aed"], ["in_flight", "#64748b"],
];

export function ActivityChart({ insights, compact = false }) {
  const plot=useRef(null),[width,setWidth]=useState(360);
  useEffect(()=>{
    if(!plot.current)return;
    const measure=()=>{const value=plot.current?.getBoundingClientRect().width;if(value>0)setWidth(Math.max(160,Math.round(value)));};
    measure();const observer=new ResizeObserver(measure);observer.observe(plot.current);return()=>observer.disconnect();
  },[insights]);
  const buckets = insights?.buckets || [];
  const max = Math.max(1, ...buckets.map((bucket) => bucket.counts.dispatches));
  if (!buckets.some((bucket) => bucket.counts.dispatches)) return <p className="text-xs text-text-muted">No recorded calls in this range.</p>;
  return <div ref={plot}>
    <svg role="img" aria-label="Image submission outcomes over time" viewBox={`0 0 ${width} 112`} preserveAspectRatio="none" className={`${compact?'h-24':'h-32'} w-full overflow-visible`}>
      {[0,Math.ceil(max/2),max].filter((value,index,all)=>all.indexOf(value)===index).map(value=><g key={value}><line x1="26" x2={width-6} y1={96-value/max*82} y2={96-value/max*82} stroke="currentColor" strokeOpacity={value===0?.35:.12} strokeDasharray={value===0?undefined:'3 4'}/><text x="21" y={99-value/max*82} textAnchor="end" fontSize="10" fill="currentColor" className="text-text-muted">{value}</text></g>)}
      {[0,.5,1].map(value=><line key={value} x1={26+value*(width-32)} x2={26+value*(width-32)} y1="10" y2="96" stroke="currentColor" strokeOpacity=".08"/>)}
      {buckets.map((bucket,index)=>{let accumulated=0;const count=bucket.counts.dispatches;return <g key={bucket.from} tabIndex={count?0:undefined} aria-label={`${date(bucket.from)}: ${count} requests`}><title>{date(bucket.from)} → {date(bucket.to)}: {count} requests; {SERIES.map(([key])=>`${bucket.counts[key]||0} ${key.replaceAll('_',' ')}`).join(' · ')}</title>{SERIES.map(([key,color])=>{const value=bucket.counts[key]||0;accumulated+=value;return value>0?<rect key={key} x={26+index*(width-32)/buckets.length} y={96-accumulated/max*82} width={Math.max(.25,(width-32)/buckets.length-1)} height={value/max*82} fill={color} rx=".5"/>:null;})}</g>;})}
    </svg>
    <div className={`mt-1 flex justify-between text-text-muted ${compact?'text-[10px]':'text-xs'}`}><time>{date(buckets[0]?.from, true)}</time><time>{date(buckets.at(-1)?.to, true)}</time></div>
    <div className={`mt-1 flex flex-wrap gap-x-2 ${compact?'gap-y-0.5 text-[10px]':'gap-y-1 text-xs'}`}>{SERIES.filter(([key])=>!compact||buckets.some(bucket=>bucket.counts[key]>0)).map(([key, color]) => <span key={key} className="inline-flex items-center gap-1"><i className={`${compact?'size-1.5':'size-2'} rounded-full`} style={{ backgroundColor: color }} />{LABELS[key]}</span>)}</div>
    {!compact && insights?.events?.items?.length > 0 && <div className={compact?'mt-2':'mt-3'}>
      <div className="relative h-5 border-b border-border" aria-label="Recent request timeline">
        {insights.events.items.map((event,index) => {
          const from=Date.parse(insights.range.from),span=Date.parse(insights.range.to)-from;
          const left=Math.max(0,Math.min(100,(Date.parse(event.dispatchedAt)-from)/span*100));
          const color=SERIES.find(([key])=>key===event.outcome)?.[1]||"#9ca3af";
          const detail=`${date(event.dispatchedAt)} · ${event.model}\n${event.outcome.replaceAll("_"," ")} · HTTP ${event.httpStatus||"—"} · ${event.outputCount||0} images${event.retryAt?`\nNext check: ${date(event.retryAt)} · ${event.confidence}; capacity unconfirmed`:""}`;
          return <span key={`${event.dispatchedAt}-${index}`} tabIndex={0} role="img" aria-label={detail} title={detail} className="absolute top-1 size-2 -translate-x-1/2 rounded-full focus:outline focus:outline-2 focus:outline-primary" style={{left:`${left}%`,backgroundColor:color}} />;
        })}
      </div>
      <p className="mt-1 text-xs text-text-muted">{insights.events.items.length} recent request points{insights.events.truncated?" · partial event history":""} · hover for outcome and retry timing</p>
    </div>}
    <div className="sr-only"><table><caption>Image activity buckets</caption><thead><tr><th>Time</th>{SERIES.map(([key]) => <th key={key}>{key}</th>)}<th>Validated images</th></tr></thead><tbody>{buckets.map((bucket) => <tr key={bucket.from}><th>{bucket.from}</th>{SERIES.map(([key]) => <td key={key}>{bucket.counts[key]}</td>)}<td>{bucket.counts.images}</td></tr>)}</tbody></table></div>
  </div>;
}

