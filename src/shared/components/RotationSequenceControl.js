'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import Modal from './Modal';
import Button from './Button';
import RotationPreviewExplorer from './RotationPreviewExplorer';
import QuotaSortBar from './QuotaSortBar';
import ResetPriorityControl from './ResetPriorityControl';
import ProviderIcon from './ProviderIcon';
import ImageHelp from '../../app/(dashboard)/dashboard/quota/ImageHelp';
import { getModelsByProviderId } from '../constants/models';
import { emptyRotation, rotationMetrics, validateRotation, availabilityGrouping, updateRotationSorts } from '../utils/rotationSequence.mjs';
import { previewIsCurrent } from '../utils/rotationPreview.mjs';
import styles from './rotationSequence.module.css';
const fieldClass = 'min-w-0 rounded-lg border border-border bg-background px-2 py-2 text-sm text-text-main';
const date = value => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
export default function RotationSequenceControl({ provider, initialSorts, compact = false, onPreview }) {
  const metrics = useMemo(() => rotationMetrics(provider), [provider]);
  const [open, setOpen] = useState(false), [saved, setSaved] = useState(null), [draft, setDraft] = useState(null);
  const [model, setModel] = useState(''), [preview, setPreview] = useState(null), [previewContext, setPreviewContext] = useState(null);
  const [emphasizedKey, setEmphasizedKey] = useState(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [now, setNow] = useState(Date.now);
  const contextEditor = useRef(null), modelField = useRef(null), capturePreview = useRef(null);
  const dialog = useRef(null), launcher = useRef(null), requestId = useRef(0), closing = useRef(null), busyRef = useRef(busy);
  busyRef.current = busy;
  const endpoint = `/api/providers/${encodeURIComponent(provider)}/rotation`;
  const models = useMemo(() => getModelsByProviderId(provider).filter(row => !['embedding', 'tts', 'stt', 'image', 'imageGen'].includes(row.kind || row.type)), [provider]);
  const defaultModel = models[0]?.id || '';
  const modelError = !model.trim() ? 'Choose a model for this preview.' : model.length > 256 || !/^[A-Za-z0-9._:/-]+$/.test(model) ? 'Use a valid model ID (letters, numbers, dots, dashes, slashes or underscores).' : '';
  const policy = draft || saved?.policy || emptyRotation();
  const context = JSON.stringify([policy, model]);
  const dirty = Boolean(saved && (saved.needsReview || JSON.stringify(policy) !== JSON.stringify(saved.policy)));
  let validation = '';
  try { validateRotation(policy, provider); } catch { validation = 'Add a sort or reset-credit priority before enabling the sequence.'; }
  const current = previewIsCurrent(preview, context, previewContext, now);
  const locked = ['load', 'save', 'refresh'].includes(busy);
  const endpointRequest = async (method, body) => {
    const response = await fetch(method === 'GET' ? `${endpoint}?summary=1` : endpoint, { method, cache: 'no-store', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Rotation request failed'); return result;
  };
  useEffect(() => {
    if (!metrics.length) return;
    let cancelled = false;
    const request = requestId.current;
    setSaved(null); setDraft(null); setModel(''); setPreview(null); setError('');
    fetch(`${endpoint}?summary=1`, { cache: 'no-store' }).then(async response => {
      const body = await response.json(); if (!response.ok) throw new Error(body.error);
      if (!cancelled && request === requestId.current) setSaved(body);
    }).catch(() => { if (!cancelled && request === requestId.current) setError('Could not load rotation. Open to retry.'); });
    return () => { cancelled = true; requestId.current++; };
  }, [endpoint, metrics.length]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => dialog.current?.focus());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const trap = event => {
      if(event.target.closest?.('[role="dialog"]')!==dialog.current)return;
      if (event.key === 'Escape') {
        const detail = event.target.closest?.('details');
        if (detail?.open) { event.preventDefault(); event.stopImmediatePropagation(); detail.open = false; detail.querySelector('summary')?.focus(); return; }
        event.preventDefault(); event.stopImmediatePropagation(); if (busyRef.current !== 'save') setOpen(false); return;
      }
      if (event.key !== 'Tab') return;
      const elements = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary')].filter(node => node.getClientRects().length && !node.closest('details:not([open]) > :not(summary)'));
      if (!elements.length) return;
      const first = elements[0], last = elements.at(-1);
      if (!dialog.current.contains(document.activeElement) || document.activeElement === dialog.current) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trap, true);
    return () => { requestId.current++; cancelAnimationFrame(frame); clearInterval(timer); document.removeEventListener('keydown', trap, true); closing.current = requestAnimationFrame(() => launcher.current?.focus()); };
  }, [open]);
  useEffect(() => () => cancelAnimationFrame(closing.current), []);
  const openEditor = async () => {
    const request = ++requestId.current;
    setOpen(true); setBusy('load'); setError(''); setNotice('');
    try {
      const loaded = await endpointRequest('GET'); if (request !== requestId.current) return;
      setSaved(loaded); 
      let stored = null;
      try { stored = JSON.parse(sessionStorage.getItem(`rotation-draft:${provider}`) || 'null'); if (stored) stored.policy = validateRotation(stored.policy, provider); } catch { stored = null; }
      setModel(previous => previous || (models.some(row => row.id === stored?.model) ? stored.model : defaultModel));
      const seed = (initialSorts || []).filter(sort => metrics.some(metric => metric.key === sort.key)).map(sort => ({ ...sort, division: sort.division || 'half' }));
      setDraft(previous => previous || stored?.policy || (seed.length ? { ...loaded.policy, sorts: seed } : loaded.policy));
      setPreview(null); setPreviewContext(null);
    } catch (failure) { if (request === requestId.current) setError(failure.message); }
    finally { if (request === requestId.current) setBusy(''); }
  };
  const change = next => { const changed = next.sorts.find(sort => JSON.stringify(sort) !== JSON.stringify(policy.sorts.find(previous => previous.key === sort.key))); setEmphasizedKey(changed?.key || null); capturePreview.current?.(); requestId.current++; setDraft(next); setError(''); setNotice(''); if (busy === 'preview') setBusy(''); };
  useEffect(() => { if (draft) { try { sessionStorage.setItem(`rotation-draft:${provider}`, JSON.stringify({ policy: draft, model })); } catch {} } }, [draft, model, provider]);
  const inspect = async action => {
    const request = ++requestId.current, payload = context;
    setBusy(action); setError(''); setNotice('');
    try {
      const result = await endpointRequest('POST', { action, policy, model });
      if (request !== requestId.current) return;
      setPreview(result.preview); setPreviewContext(payload); setNow(Date.now());
      onPreview?.({ provider, policy, model });
      if (result.errors?.length) setNotice(`${result.errors.length} account reads unavailable. Unknown values keep fallback order.`);
    } catch (failure) { if (request === requestId.current) setError(failure.message); }
    finally { if (request === requestId.current) setBusy(''); }
  };
  useEffect(() => {
    if (!open || !saved || modelError || validation || current || busy || error) return;
    const timer = setTimeout(() => void inspect('preview'), 300);
    return () => clearTimeout(timer);
  }, [open, saved, context, validation, modelError, current, busy, error]);
  useEffect(() => { if (!current || !emphasizedKey) return; const timer = setTimeout(() => setEmphasizedKey(null), 1800); return () => clearTimeout(timer); }, [current, emphasizedKey]);
  const apply = async () => {
    if (policy.enabled && !previewIsCurrent(preview, context, previewContext, Date.now())) { setPreviewContext(null); setNow(Date.now()); return; }
    setBusy('save'); setError('');
    try {
      const result = await endpointRequest('PATCH', { policy, revision: saved.revision });
      setSaved(result); setDraft(result.policy); setNotice(result.policy.enabled ? 'Sequence applied. Read-only quota monitoring started.' : 'Saved. Existing rotation remains active.');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(''); }
  };
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!autoOpened.current && saved && new URLSearchParams(window.location.search).get('rotation') === '1') { autoOpened.current = true; void openEditor(); }
  }, [saved]);
  if (!metrics.length) return null;
  const applyLabel = !policy.enabled ? saved?.policy.enabled ? 'Disable sequence' : 'Save disabled sequence' : saved?.policy.enabled ? 'Update sequence' : 'Enable sequence';
  const blocker = !saved ? 'Loading rotation…' : !dirty ? 'No unsaved changes' : validation || (policy.enabled && modelError ? modelError : policy.enabled && !current ? error ? 'Preview unavailable. Retry before applying.' : 'Updating preview…' : '');
  return <>
    <button ref={launcher} type="button" onClick={openEditor} className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-sm text-text-main hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary" aria-label={`Edit ${provider} rotation sequence`}>
      <span className="material-symbols-outlined text-[18px]" aria-hidden="true">sort</span><span>{compact ? 'Use for rotation' : 'Rotation sequence'}</span>
      {saved?.policy.enabled && <span className="rounded bg-primary/10 px-1.5 text-xs text-primary">Live</span>}
    </button>
    {open && createPortal(<Modal isOpen={open} onClose={() => { if (busy !== 'save') setOpen(false); }} title="Account rotation" size="full" className={styles.modal}>
      <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`${provider} account rotation`} className={styles.editor}>
        <div className={styles.body}>
          <div className="flex flex-wrap items-center gap-2">
            <ProviderIcon providerId={provider} alt="" size={24} /><strong className="capitalize">{provider}</strong>
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs">Live: {saved?.policy.enabled ? 'Sequence' : 'Existing rotation'}</span>
            {dirty && <span className="text-xs text-amber-600 dark:text-amber-300">Unsaved changes</span>}
            <div className="ml-auto"><ImageHelp label="Account rotation"><p>Eligibility first, priority group second, selection method last. The sort sequence chooses a group; round robin or fill first selects inside it. Image requests also check their model quota and held work before grouping. Inherited image settings reuse these rules with the allowance applicable to the image model, not an unrelated text quota. Missing observations retain fallback order. Editing does not enable the sequence. Unknown accepted image jobs cannot safely be replayed.</p></ImageHelp></div>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" role="switch" checked={policy.enabled} disabled={locked} onChange={event => change({ ...policy, enabled: event.target.checked })} />Use sort sequence</label>
          <div className={`${styles.sortArea} quota-sort-area`}>
           {provider==='codex'&&<div className="shrink-0 border-r border-border pr-2"><ResetPriorityControl value={policy.resetPriority} disabled={locked} onChange={resetPriority=>change({...policy,resetPriority})} /></div>}
           <div className="min-w-0 flex-1"><QuotaSortBar capacityReady={preview?.rows?.some(row=>row.capacityEstimate?.state==='observed')} resetPriority={policy.resetPriority.enabled} wrap sorts={policy.sorts} options={metrics} provider={provider} disabled={locked} hintId={`rotation-sort-hint-${provider}`} groupAvailability={availabilityGrouping(policy)} onGroupAvailabilityChange={groupAvailability=>change({...policy,groupAvailability})} onChange={sorts=>change(updateRotationSorts(policy,sorts))} /></div>
          </div>
          <p id={`rotation-sort-hint-${provider}`} className="sr-only">Click to cycle lowest or earliest, highest or latest, then off. Each later sort partitions the preceding group.</p>
          {validation && <p role="status" className="text-xs text-amber-600 dark:text-amber-300">{validation}</p>}
          <div className={styles.previewControls}>
            <details ref={contextEditor} className={styles.context}>
              <summary aria-label="Change preview model"><span className="material-symbols-outlined text-[16px]" aria-hidden="true">tune</span><span>{model || 'Choose model'}</span><span className="material-symbols-outlined text-[16px]" aria-hidden="true">expand_more</span></summary>
              <div className={styles.contextFields}><label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-text-muted">Model<input ref={modelField} className={fieldClass} list={`rotation-models-${provider}`} value={model} disabled={locked} aria-invalid={Boolean(modelError)} aria-describedby={modelError ? `rotation-model-error-${provider}` : undefined} placeholder="Choose model" onChange={event => { requestId.current++; setModel(event.target.value); setError(''); if (busy === 'preview') setBusy(''); }} /><datalist id={`rotation-models-${provider}`}>{models.map(row => <option key={row.id} value={row.id}>{row.name || row.id}</option>)}</datalist></label><Button size="sm" variant="ghost" onClick={() => { contextEditor.current.open = false; contextEditor.current.querySelector('summary').focus(); }}>Done</Button></div>
            </details>
            <Button size="sm" variant="secondary" icon="refresh" disabled={Boolean(busy) || !saved || Boolean(modelError) || Boolean(validation)} onClick={() => inspect('refresh')}>{busy === 'refresh' ? 'Reading…' : 'Read quotas'}</Button>
            <span className="text-xs text-text-muted">Saved observations · provider reads are manual</span>
          </div>
          {modelError && <p id={`rotation-model-error-${provider}`} role="alert" className="text-xs text-amber-600 dark:text-amber-300">{modelError} <button type="button" className="underline" onClick={() => { contextEditor.current.open = true; modelField.current.focus(); }}>Edit context</button></p>}
          {saved?.needsReview && <p role="alert" className="text-sm text-amber-600 dark:text-amber-300">Saved sequence needs review. Existing rotation is active.</p>}
          {error && <div role="alert" className="text-sm text-red-600 dark:text-red-300">{error} <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => { if (!saved) openEditor(); else if (modelError) { contextEditor.current.open = true; modelField.current.focus(); } else if (saved && !validation) inspect('preview'); else openEditor(); }}>Retry</Button></div>}
          {notice && <p role="status" className="text-xs text-text-muted">{notice}</p>}
          <div role="status" aria-live="polite" className="text-xs text-text-muted">{busy === 'preview' ? 'Updating preview from saved observations…' : modelError ? 'Preview needs a valid model context.' : !current ? preview ? 'Previous preview · update required' : 'Preparing preview…' : `Checked ${date(preview.observedAt)}`}</div>
          {preview && <RotationPreviewExplorer provider={provider} captureRef={capturePreview} emphasizedKey={emphasizedKey} preview={preview} current={current} dirty={dirty} now={now} updating={busy === 'preview'} />}
        </div>
        <footer className={styles.footer}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"><span>Live: {saved?.policy.enabled ? 'Sequence' : 'Existing rotation'}</span><span className="text-text-muted">{blocker || 'Preview ready · changes not yet applied'}</span><Link className="ml-auto text-primary underline" href={compact ? `/dashboard/providers/${provider}?rotation=1` : `/dashboard/quota?provider=${provider}&rotation=1`}>{compact ? 'Provider settings' : 'Quota cards'} →</Link></div>
          <div className="flex flex-wrap justify-end gap-2"><Button size="md" variant="ghost" disabled={locked || !saved || !dirty} onClick={() => change(saved.policy)}>Discard changes</Button><Button size="md" variant="ghost" disabled={busy === 'save'} onClick={() => setOpen(false)}>Close</Button><Button size="md" disabled={Boolean(busy) || Boolean(blocker)} onClick={apply}>{busy === 'save' ? 'Applying…' : applyLabel}</Button></div>
        </footer>
      </section>
    </Modal>, document.body)}
  </>;
}
