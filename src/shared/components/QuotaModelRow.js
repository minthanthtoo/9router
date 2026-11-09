"use client";
import { useEffect, useId, useRef, useState } from 'react';
import QuotaRowLayout from './QuotaRowLayout';

export default function QuotaModelRow({ id, name, status, measurement, reset, allow, actions, analysis, receipt, interaction, keepOpen = false, testing = false, disabled = false, quickActions, onHide }) {
  const [localTray, setLocalTray] = useState(null), [localChart, setLocalChart] = useState(null);
  const tray = interaction?.tray ?? localTray, chart = interaction?.chart ?? localChart;
  const setTray = interaction?.setTray || setLocalTray, setChart = interaction?.setChart || setLocalChart;
  const open = tray === id;
  const rowPanelsOpen = open || chart === id;
  const motionId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const row = useRef(null), panel = useRef(null), trigger = useRef(null), timer = useRef(null), pointerMode = useRef(false), hoverTimer=useRef(null);
  const [chartSeen,setChartSeen]=useState(false);
  useEffect(()=>{if(chart===id)setChartSeen(true);},[chart,id]);
  const cancel = () => {clearTimeout(timer.current);clearTimeout(hoverTimer.current);};
  const enter = event=>{cancel();if(event.pointerType!=="touch")hoverTimer.current=setTimeout(()=>setTray(id),80);};
  const close = () => { cancel(); setTray(null); };
  const closeRow = () => { close(); if (chart === id) setChart(null); };
  const leave = event => { cancel(); if(event?.pointerType==='touch'||event?.relatedTarget?.nodeType&&row.current?.contains(event.relatedTarget))return; timer.current = setTimeout(() => {
    if (!keepOpen && (pointerMode.current || !row.current?.contains(document.activeElement) && document.activeElement !== trigger.current)) setTray(null);
  }, 80); };
  useEffect(() => () => {clearTimeout(timer.current);clearTimeout(hoverTimer.current);}, []);
  useEffect(()=>{if(testing)setChart(id);},[testing,id]);
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!keepOpen && !row.current?.contains(event.target)) close(); };
    const key = event => { if (event.key === 'Escape' && !keepOpen) { event.preventDefault(); close(); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [open, keepOpen]);
  return <div ref={row} className={`quota-model-item min-w-0 ${open?'is-open':''} ${testing?"quota-model-testing":""}`} aria-busy={testing||undefined} style={{viewTransitionName:`quota-row-${motionId}`}} onPointerEnter={enter} onPointerLeave={leave}>
    <div className="quota-model-bar"><div data-model-disabled={disabled||undefined} className={`quota-model-line ${disabled?"quota-model-disabled":""}`}><QuotaRowLayout
      identity={<strong className="block truncate" title={name}>{name}</strong>}
      measurement={measurement} reset={reset}
      actions={<button ref={trigger} type="button" aria-label={`Actions for ${name}`} aria-expanded={rowPanelsOpen} onPointerEnter={enter} onPointerDown={()=>{pointerMode.current=true;}} onKeyDown={()=>{pointerMode.current=false;}} onFocus={cancel} onBlur={leave} onClick={() => { cancel(); if(rowPanelsOpen)closeRow();else setTray(id); }} className="quota-model-action-trigger flex size-7 shrink-0 items-center justify-center rounded-lg text-text-muted"><span aria-hidden="true" className={`material-symbols-outlined text-lg transition-transform motion-reduce:transition-none ${rowPanelsOpen ? 'rotate-180' : ''}`}>chevron_right</span></button>}
    >{receipt && <div role="status" className="w-full text-xs text-amber-500">{receipt}</div>}</QuotaRowLayout></div>
    <div ref={panel} aria-hidden={!open} inert={!open?true:undefined} role="group" onPointerEnter={cancel} aria-label={`Secondary actions for ${name}`} onKeyDown={()=>{pointerMode.current=false;}} onPointerDown={()=>{pointerMode.current=true;}} onFocus={cancel} onBlur={leave} className="quota-model-actions-panel">
      <div className="quota-model-action-strip">
        <button type="button" aria-label={`Activity for ${name}`} title="Activity" aria-expanded={chart===id} onClick={()=>setChart(chart===id?null:id)} className="quota-model-icon text-blue-500"><span aria-hidden="true" className="material-symbols-outlined">bar_chart</span></button>
        {quickActions}
        {allow}
        {onHide&&<button type="button" aria-label={`Hide ${name}`} title="Hide model row" disabled={keepOpen} onClick={onHide} className="quota-model-icon text-text-muted"><span aria-hidden="true" className="material-symbols-outlined">visibility_off</span></button>}
      </div>
    </div></div>
    <div className={`quota-model-chart ${chart===id?"is-open":""}`} aria-hidden={chart!==id} inert={chart!==id?true:undefined}><div><section aria-label={`Analysis for ${name}`} className="quota-model-chart-surface">{(chart===id||chartSeen)&&<>{(status||actions)&&<div className="quota-model-action-details">{status&&<div className="mb-1 text-text-muted">{status}</div>}{actions}</div>}{analysis}</>}</section></div></div>
  </div>;
}
