'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Modal from './Modal';
import ImageHelp from '../../app/(dashboard)/dashboard/quota/ImageHelp';

export default function ResetPriorityControl({ value, onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  const panel = useRef(null);

  useEffect(() => {
    if (!open) return;
    const launcher = trigger.current;
    panel.current?.querySelector('input')?.focus();
    const trap = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen(false);
      }
      if (event.key === 'Tab') {
        const nodes = [...panel.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')];
        const first = nodes[0], last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', trap, true);
    return () => {
      document.removeEventListener('keydown', trap, true);
      launcher?.focus({ preventScroll: true });
    };
  }, [open]);

  const field = 'h-9 min-w-0 rounded-lg border border-border bg-surface px-2 text-sm text-text-main';
  return <>
    <button
      ref={trigger}
      type="button"
      disabled={disabled}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-pressed={value.enabled}
      aria-label={`Codex credit priority: ${value.enabled ? `on, expires within ${value.days} days` : 'off'}`}
      title={value.enabled ? `Credit priority on · earliest credit expiry first · within ${value.days} days` : "Credit priority off · configure expiring reset credits"}
      onClick={() => setOpen(true)}
      className={`inline-flex h-9 shrink-0 items-center gap-1 rounded-lg border px-2 text-sm transition-colors ${value.enabled ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-text-muted hover:bg-surface-2'}`}
    >
      <span aria-hidden="true" className={`material-symbols-outlined text-[18px] ${value.enabled ? 'text-amber-500' : ''}`}>hourglass_top</span>
      <span className="quota-sort-label">Credit priority</span>
      <span className={`rounded-full px-1.5 text-[10px] font-medium ${value.enabled ? 'bg-primary/15 text-primary' : 'bg-surface-2 text-text-muted'}`}>{value.enabled ? `≤${value.days}d` : 'Off'}</span>
    </button>
    {open && createPortal(
      <Modal isOpen onClose={() => setOpen(false)} title="Codex credit priority" size="sm">
        <div ref={panel} role="dialog" aria-modal="true" aria-label="Codex credit priority" className="space-y-4">
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-text-main">
              <span aria-hidden="true" className="material-symbols-outlined text-amber-500">hourglass_top</span>
              Codex user allowance
              <ImageHelp label="Credit priority"><p>Uses the latest saved Codex allowance read. Available reset credits that expire inside the selected window go first by earliest expiry. Accounts that do not match remain eligible and continue through the quota sorts. Automatic reset spends one available credit only when no ordinarily eligible account remains and the selected account has an exhausted applicable allowance. Requests wait for confirmed quota recovery. Unknown reset results are held for review.</p></ImageHelp>
            </div>
            <p className="mt-2 text-xs text-text-muted">Available credits expiring soon go first. Other eligible accounts keep their regular quota order.</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" role="switch" checked={value.enabled} disabled={disabled} onChange={event => onChange({ ...value, enabled: event.target.checked })} />
            Prioritize expiring credits
          </label>
          <label className="flex items-start gap-2 rounded-lg border border-amber-500/30 p-2 text-sm">
            <input type="checkbox" role="switch" checked={value.autoReset === true} disabled={disabled || !value.enabled} onChange={event => onChange({ ...value, autoReset: event.target.checked })} />
            <span>Allow automatic reset<span className="block text-xs text-text-muted">Spend 1 credit only when no account can serve without a reset.</span></span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex min-w-0 flex-col gap-1 text-xs text-text-muted">
              Credit expires within
              <select className={field} aria-label="Credit expires within days" disabled={disabled || !value.enabled} value={value.days} onChange={event => onChange({ ...value, days: Number(event.target.value) })}>
                {[1, 2, 3, 5, 7, 14, 30].map(days => <option key={days} value={days}>{days} days</option>)}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-text-muted">
              Only if weekly left
              <select className={field} aria-label="Optional weekly allowance cutoff" disabled={disabled || !value.enabled} value={value.weeklyBelow ?? ''} onChange={event => onChange({ ...value, weeklyBelow: event.target.value === '' ? null : Number(event.target.value) })}>
                <option value="">Any</option>
                {[0, 10, 20, 30, 50, 75, 100].map(amount => <option key={amount} value={amount}>≤{amount}%</option>)}
              </select>
            </label>
          </div>
          <button type="button" onClick={() => setOpen(false)} className="h-9 w-full rounded-lg bg-primary/10 text-sm text-primary">Done</button>
        </div>
      </Modal>, document.body
    )}
  </>;
}
