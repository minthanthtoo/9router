'use client';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Button from './Button';
import ProviderIcon from './ProviderIcon';
import QuotaRemainingMeter, { quotaRemainingColors } from './QuotaRemainingMeter';
import ImageHelp from '../../app/(dashboard)/dashboard/quota/ImageHelp';
import { rotationDirection, rotationMetricLabel } from '../utils/rotationPreview.mjs';
import styles from './rotationExplorer.module.css';
const divisions = { half: 'Equal count', median: 'Median', gap: 'Largest gap' };
const exact = value => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
export function remainingTime(value, now) {
  if (!Number.isFinite(value)) return 'Not reported';
  if (value <= now) return 'Due now · refresh needed';
  const minutes = Math.max(1, Math.ceil((value - now) / 60000));
  return minutes >= 1440 ? `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h` : minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}
const pct = value => `${Math.round(value * 10) / 10}%`;
function boundaryText(boundary, now) {
  const value = v => boundary.kind === 'reset' ? remainingTime(v, now) : pct(v);
  if (boundary.mode === 'half') return `Equal count · ranks ${boundary.startRank}–${boundary.endRank} of ${boundary.parentCount} by ${boundary.label}`;
  if (boundary.missing) return `${divisions[boundary.mode]} · ${boundary.missing} unreported values`;
  const cut = boundary.mode === 'median' ? `threshold ${value(boundary.threshold)}` : boundary.gap ? `gap ${boundary.kind === 'reset' ? remainingTime(now + boundary.gap.size, now) : `${Math.round(boundary.gap.size * 10) / 10} percentage points`}` : 'no gap';
  return `${divisions[boundary.mode]} · ${cut} · ${boundary.min === boundary.max ? `equal values ${value(boundary.min)}` : `${value(boundary.min)}–${value(boundary.max)}`}`;
}
function QuotaMeter({ value, label, missing }) {
  return <div className={styles.meter}>{Number.isFinite(value) ? <><strong className={quotaRemainingColors(value).text}>{pct(value)}</strong><div className={styles.meterTrack}><QuotaRemainingMeter value={value} label={`${label}: ${pct(value)} remaining`} /></div></> : <span className={styles.missing}>{missing}</span>}</div>;
}
function ResetValue({ value, now, missing }) {
  return Number.isFinite(value) ? <time dateTime={new Date(value).toISOString()} title={exact(value)}>Resets in {remainingTime(value, now)}</time> : <span className={styles.missing}>Reset: {missing.toLowerCase()}</span>;
}
export default function RotationPreviewExplorer({ preview, current, dirty, now, updating, provider, captureRef, emphasizedKey }) {
  const [stageId, setStageId] = useState('final'), [page, setPage] = useState(1), [selected, setSelected] = useState(null), [playing, setPlaying] = useState(false);
  const root = useRef(null), cards = useRef(new Map()), positions = useRef(null), lastContext = useRef('');
  const metrics = preview.metrics || [];
  const byId = useMemo(() => new Map(preview.rows.map(row => [row.id, row])), [preview]);
  const stages = useMemo(() => [...(preview.stages || []), { id: 'final', type: 'final', label: 'Final', groups: preview.groups.map(group => ({ key: `final-${group.segment}`, ids: preview.rows.filter(row => row.segment === group.segment).map(row => row.id), boundaries: group.boundaries, preferred: !group.waiting && !preview.fallback && group.segment === 1, waiting: group.waiting, priority: group.priority })) }], [preview]);
  const stage = stages.find(stage => stage.id === stageId) || stages.at(-1), stageIndex = stages.indexOf(stage);
  const ids = stage.groups.flatMap(group => group.ids), totalPages = Math.max(1, Math.ceil(ids.length / 10)), activePage = Math.min(page, totalPages);
  const pageIds = ids.slice((activePage - 1) * 10, activePage * 10), pageSet = new Set(pageIds);
  const windows = [...new Set(metrics.map(metric => metric.window))];
  const metricFor = (window, kind) => metrics.find(metric => metric.window === window && metric.kind === kind);
  const label = metric => rotationMetricLabel(metric, preview.sessionLabel);
  const activeKey = stage.type === 'sort' || stage.type === 'split' ? stage.rule.key : emphasizedKey;
  const missing = row => !row.observedAt ? 'No observation' : !row.fresh ? 'Old observation' : 'Not reported';
  const context = `${preview.model || ''}:${JSON.stringify(preview.sorts || [])}:${preview.policyEnabled}:${preview.resetPriorityEnabled}`;
  useEffect(() => {
    setPlaying(false);
    if (lastContext.current && lastContext.current !== context) { setStageId('final'); setPage(1); }
    lastContext.current = context;
    if (selected && !byId.has(selected)) setSelected(null);
  }, [context, byId]);
  const capture = () => { positions.current = new Map([...cards.current].map(([id, element]) => [id, element.getBoundingClientRect()])); };
  useLayoutEffect(() => { if (captureRef) captureRef.current = capture; return () => { if (captureRef) captureRef.current = null; }; });
  useLayoutEffect(() => {
    if (!positions.current || typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { positions.current = null; return; }
    for (const [id, element] of cards.current) {
      const before = positions.current.get(id), after = element.getBoundingClientRect();
      if (before && element.animate && (Math.abs(before.top - after.top) > 1 || Math.abs(before.left - after.left) > 1)) element.animate([{ transform: `translate(${before.left - after.left}px,${before.top - after.top}px)` }, { transform: 'translate(0,0)' }], { duration: 230, easing: 'ease-out' });
    }
    positions.current = null;
  }, [stage.id, preview]);
  const chooseStage = (id, replay = false) => {
    capture(); if (!replay) setPlaying(false);
    const next = stages.find(stage => stage.id === id);
    const index = next?.groups.flatMap(group => group.ids).indexOf(selected) ?? -1;
    setPage(index >= 0 ? Math.floor(index / 10) + 1 : 1); setStageId(id);
  };
  useEffect(() => {
    if (!playing || !current) return;
    if (stageIndex === stages.length - 1) { setPlaying(false); return; }
    const timer = setTimeout(() => chooseStage(stages[stageIndex + 1].id, true), 1100);
    return () => clearTimeout(timer);
  }, [playing, current, stageIndex, stages]);
  const pageChange = value => { setPlaying(false); setPage(value); root.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); root.current?.focus({ preventScroll: true }); };
  const stageLabel = step => step.type === 'sort' ? `${step.ruleIndex + 1 + Number(preview.resetPriorityEnabled)} ${label(metrics.find(metric => metric.key === step.rule.key))} · ${rotationDirection(metrics.find(metric => metric.key === step.rule.key), step.rule.direction)}` : step.type === 'split' ? `Split: ${divisions[step.division]}` : step.label;
  const groupName = (group, index) => group.waiting ? 'Waiting' : stage.type === 'final' ? preview.fallback ? 'Existing rotation' : group.preferred ? 'Preferred' : `Lower priority ${index + 1}` : group.key.startsWith('reset') ? `Expiring credits · Group ${index + 1}` : stage.type === 'eligible' ? 'Eligible accounts' : `Group ${index + 1}`;
  const scopes = [...new Set(preview.rows.map(row => row.scope).filter(Boolean))];
  const explanation = row => <div className={styles.explanation}>
    <p>{row.scope || 'Quota scope not reported'}</p>
    <ol>{stages.slice(0, stage.type === 'final' ? -1 : stageIndex + 1).filter(step => step.type !== 'eligible').map(step => {
      const group = step.groups.find(group => group.ids.includes(row.id)); if (!group) return null;
      const metric = step.rule && metrics.find(metric => metric.key === step.rule.key), value = metric && row.measurements?.[metric.key];
      return <li key={step.id}><strong>{stageLabel(step)}</strong><span>{group.waiting ? 'Short window exhausted · excluded from later sorts and dispatch' : step.type === 'sort' ? `${Number.isFinite(value) ? metric.kind === 'remaining' ? pct(value) : remainingTime(value, preview.observedAt) : missing(row)} · rank ${group.ids.indexOf(row.id) + 1} of ${group.ids.length} in this group` : step.type === 'credits' ? group.key.startsWith('reset') ? 'Qualifying unspent credit with reported expiry' : 'Regular priority; no qualifying credit condition' : group.boundaries.at(-1) ? boundaryText(group.boundaries.at(-1), preview.observedAt) : group.note || 'No split'}{group.note && step.type === 'sort' && ` · ${group.note}`}</span></li>;
    })}</ol>
    <p>{row.waiting ? `${row.reason} · not dispatchable.` : preview.fallback ? 'Existing account selection is used.' : stage.type !== 'final' ? 'This is an intermediate step. Final shows the selected group.' : row.segment === 1 ? `Selected group · ${preview.strategy === 'round-robin' ? `round robin switches after ${preview.stickyRequests} request${preview.stickyRequests === 1 ? '' : 's'}` : 'first eligible account selection'}` : 'Lower priority; eligibility or ranking must change before this group supplies requests.'}</p>
    <time dateTime={row.observedAt ? new Date(row.observedAt).toISOString() : undefined}>{row.observedAt ? `Observed ${exact(row.observedAt)}${!row.fresh ? ' · Old observation' : ''}` : 'No observation'}</time>
    <dl>{windows.map(window => { const metric = metricFor(window, 'remaining'), reset = row.measurements?.[`${window}-reset`], value = row.measurements?.[`${window}-remaining`];return <Fragment key={window}><dt>{label(metric)}</dt><dd>{Number.isFinite(value) ? pct(value) : missing(row)} · {Number.isFinite(reset) ? `Reset ${exact(reset)}` : 'Reset not reported'}</dd></Fragment>; })}</dl>
    {row.constraints?.length > windows.length && <details><summary>Reported constraints</summary><p>Remaining shows the lowest applicable percentage; reset shows the earliest applicable reset. These may come from different overlapping constraints.</p><ul>{row.constraints.map((quota,index) => <li key={index}>{quota.id} · {quota.scope} · {Number.isFinite(quota.remaining) ? pct(quota.remaining) : 'Remaining not reported'} · {Number.isFinite(quota.resetAt) ? exact(quota.resetAt) : 'Reset not reported'}</li>)}</ul></details>}
  </div>;
  const why = row => <details className={styles.why} open={selected === row.id} onToggle={event => { if (!event.currentTarget.open && selected === row.id) setSelected(null); }}><summary aria-label={`Why here: ${row.name}`} onClick={event => { event.preventDefault(); setPlaying(false); setSelected(selected === row.id ? null : row.id); }}>Why here?</summary>{selected === row.id && explanation(row)}</details>;
  const nextBadge = row => current && stage.type === 'final' && preview.nextId === row.id && <span className={styles.badge}>Next{dirty ? ' if applied' : ''}</span>;
  const refs = id => element => { if (element) cards.current.set(id,element); else cards.current.delete(id); };

  const pageNumbers = [...new Set([1,activePage-1,activePage,activePage+1,totalPages])].filter(value=>value>0&&value<=totalPages).sort((a,b)=>a-b);
  return <section ref={root} tabIndex={-1} aria-label="Account preview" className={styles.root} aria-busy={updating} onPointerDown={event => { if (playing && !event.target.closest('[data-play-control]')) setPlaying(false); }} onKeyDown={event => { if (playing && !event.target.closest('[data-play-control]')) setPlaying(false); }}>
    {preview.admission?.length>0&&<ol className={styles.admission} aria-label="Image eligibility checks">{preview.admission.map((step,index)=><li key={step.id}><span>{step.label}</span><strong>{step.ready}<small> / {index?preview.admission[index-1].ready:preview.total}</small></strong>{step.unreported>0&&<small title="Unreported allowance is unknown, not assumed full">{step.unreported} unknown</small>}</li>)}</ol>}
    <div className={styles.toolbar}><span className={styles.scope}>{scopes.length === 1 ? scopes[0] : scopes.length ? 'Account-specific allowance scopes · see Why here' : 'Quota scope not reported'}</span><span className={styles.badge}>{preview.strategy==='round-robin'?`Round robin · ${preview.stickyRequests} request${preview.stickyRequests===1?'':'s'}/account`:'Fill first'}{!preview.fallback?' · preferred group':''}</span></div>
    <div className={styles.outcome}>{preview.waitingCount>0&&<span>Waiting: {preview.waitingCount}</span>}<strong>{preview.eligible} ready</strong><span aria-hidden="true">→</span><strong>{preview.selectedCount} {preview.fallback?'in rotation':'preferred'}</strong><span aria-hidden="true">→</span><span>{current ? `Next${dirty?' if applied':''}: ${byId.get(preview.nextId)?.name || 'None eligible'}` : 'Next: updating'}</span></div>
    <div className="flex items-center gap-2 text-xs text-text-muted"><span>{preview.fallback?'Existing rotation':stage.type==='final'?`${preview.groups.filter(group=>!group.waiting).length} ready groups`:'Step preview'}</span><ImageHelp label="Selection mechanism"><p>{stage.type === 'final' ? preview.fallback ? 'Existing rotation applies. Editing rules does not enable the sequence.' : `Requests use the preferred group · ${preview.strategy==='round-robin'?`switch after ${preview.stickyRequests} requests`:'first eligible account'}. Lower groups supply requests after higher groups are excluded, blocked or reranked.` : stage.type==='sort'?'Accounts reorder inside their current groups, preserving earlier splits.':stage.type==='split'?'Divide each preceding group before the next sort.':'Select Final for the selected group.'}</p></ImageHelp></div>
    <div className={styles.quality}>{preview.quality.missing>0&&<span>{preview.quality.missing} no observation</span>}{preview.quality.old>0&&<span>{preview.quality.old} old observations</span>}{preview.quality.unreported>0&&<span>{preview.quality.unreported} quota not reported</span>}{!current&&<span>Previous preview · not valid for Apply</span>}</div>
    {stages.some(step=>['sort','split','waiting','credits'].includes(step.type))&&<div className={styles.walkthrough} role="group" aria-label="Order walkthrough">
      <Button size="sm" variant="ghost" disabled={stageIndex===0} onClick={()=>chooseStage(stages[stageIndex-1].id)}>Previous step</Button>
      <span role="status">{stage.type==='final'?'Final order':stageLabel(stage)}</span>
      <Button data-play-control="" size="sm" variant="ghost" disabled={!current || stages.length<2} onClick={()=>{if(playing){setPlaying(false);return;}chooseStage(stages[0].id,true);if(!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)setPlaying(true);}}>{playing?'Pause':'Play steps'}</Button>
      <Button size="sm" variant="ghost" disabled={stageIndex===stages.length-1} onClick={()=>chooseStage(stages[stageIndex+1].id)}>Next step</Button>
      {stage.type!=='final'&&<Button size="sm" variant="ghost" onClick={()=>chooseStage('final')}>Final order</Button>}
    </div>}
    <div className={styles.board}>{stage.groups.flatMap((group,index)=>{
      const visible=group.ids.filter(id=>pageSet.has(id));if(!visible.length)return [];
      return [<header key={`group-${group.key}`} className={`${styles.group} ${group.preferred?styles.preferred:''} ${emphasizedKey&&group.boundaries.length?styles.emphasizedGroup:''}`}><strong>{groupName(group,index)} · {group.ids.length} accounts</strong>{group.waiting&&<span>Short window exhausted · not dispatchable</span>}{group.boundaries.length>0&&<details className={styles.boundaries}><summary>Group boundaries · {group.boundaries.length}</summary>{group.boundaries.map((boundary,index)=><span key={index}>{boundaryText(boundary,preview.observedAt)}</span>)}</details>}{group.note&&!group.waiting&&<span>{group.note}</span>}</header>,...visible.map(id=>{const row=byId.get(id);return <article key={id} ref={refs(id)} data-account-id={id} aria-label={`Account ${row.name}`} className={`${styles.card} ${group.preferred?styles.preferredCard:''} ${selected===id?styles.selected:''}`}>
        <div className={styles.account}><span className={styles.rank}>{ids.indexOf(id)+1}</span>{provider&&<ProviderIcon providerId={provider} alt={provider} size={28} fallbackText={provider.slice(0,2).toUpperCase()} />}<div className={styles.identity}><strong title={`${row.name} · ${row.id}`}>{row.name}</strong></div>{nextBadge(row)}{row.waiting&&<span className={styles.waiting}>Waiting</span>}{row.resetRequired&&<span className={styles.waiting}>Reset before use</span>}</div>
        {row.priority&&<time className={styles.credit} dateTime={new Date(row.expiry).toISOString()} title={exact(row.expiry)}>Credit expires in {remainingTime(row.expiry,now)}</time>}
        <div className={styles.windows}>{windows.map(window=>{const metric=metricFor(window,'remaining'),resetMetric=metricFor(window,'reset');return <div key={window} className={styles.window}><div className={activeKey===metric?.key?styles.activeMetric:''}><span>{label(metric)}</span><QuotaMeter value={row.measurements?.[metric.key]} label={label(metric)} missing={missing(row)} /></div>{resetMetric&&<div className={activeKey===resetMetric.key?styles.activeMetric:''}><ResetValue value={row.measurements?.[resetMetric.key]} now={now} missing={missing(row)} /></div>}</div>;})}</div>
        <div className={styles.evidence}><span>{row.waiting ? row.reason || 'Short window exhausted' : !row.observedAt ? 'No observation' : !row.fresh ? 'Old observation' : 'Saved observation'}</span>{row.observedAt&&<time dateTime={new Date(row.observedAt).toISOString()} title={exact(row.observedAt)}>{new Date(row.observedAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</time>}</div>
        {why(row)}
      </article>})];
    })}</div>
    {!ids.length&&<p>No eligible accounts for this model.</p>}
    {totalPages>1&&<nav aria-label="Rotation preview pages" className={styles.pagination}><span>{ids.length} accounts · Page {activePage} of {totalPages}</span><Button size="sm" variant="ghost" disabled={activePage===1} onClick={()=>pageChange(activePage-1)}>Previous</Button>{pageNumbers.map((value,index)=><Fragment key={value}>{index>0&&value>pageNumbers[index-1]+1&&<span>…</span>}<button type="button" aria-current={value===activePage?'page':undefined} onClick={()=>pageChange(value)}>{value}</button></Fragment>)}<Button size="sm" variant="ghost" disabled={activePage===totalPages} onClick={()=>pageChange(activePage+1)}>Next</Button></nav>}
    {preview.blocked.length>0&&<details className={styles.unavailable}><summary>{preview.blocked.length} unavailable accounts</summary><ul>{preview.blocked.map(row=><li key={row.id}><span>{row.name}</span><strong>{row.gate&&`${preview.admission?.find(step=>step.id===row.gate)?.label || row.gate} · `}{row.reason}</strong></li>)}</ul></details>}
  </section>;
}
