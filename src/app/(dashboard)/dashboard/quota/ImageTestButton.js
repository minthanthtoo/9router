"use client";

import { createPortal } from "react-dom";
import { useLayoutEffect, useRef, useState } from "react";
import { imageTestAllowed } from "./imageTestRun.mjs";
import ImageTestRunRecovery from "./ImageTestRunRecovery";

const ICON = {
  pending: "schedule",
  running: "progress_activity",
  succeeded: "check_circle",
  refused: "block",
  unknown: "help",
  cancelled: "close",
};
const COLOR = {
  succeeded: "text-emerald-500",
  refused: "text-amber-500",
  unknown: "text-violet-500",
  running: "text-primary",
  cancelled: "text-text-muted",
};
const REQUEST_COUNTS = [1, 2, 3, 5, 10, 20, 50, 100];
const REQUEST_CAPS = [5, 10, 20, 50, 100];
const SUBSCRIPTION_PROVIDERS = new Set(["codex", "antigravity", "gemini"]);

export default function ImageTestButton({ row, model, onComplete, runner, onInteractionChange, compact = false }) {
  const [confirm, setConfirm] = useState(false);
  const [mode, setMode] = useState("count");
  const [requestCount, setRequestCount] = useState(1);
  const [quotaLimitHits, setQuotaLimitHits] = useState(1);
  const [requestCap, setRequestCap] = useState(20);
  const [submitting, setSubmitting] = useState(false);
  const dialog = useRef(null);
  const trigger = useRef(null);
  const result = runner.resultFor(row.connectionId, model, row.provider);
  const held = runner.isBlocked?.(row.connectionId, model);
  const disabled = !imageTestAllowed(row, model) || runner.busy || runner.unknown || held || submitting;
  const authType = String(row.authType || "").toLowerCase().replaceAll("_", "-");
  const quotaModeAvailable = SUBSCRIPTION_PROVIDERS.has(row.provider) && !["apikey", "api-key"].includes(authType);
  const confirmation = (value) => {
    setConfirm(value);
    onInteractionChange?.(value);
  };

  useLayoutEffect(() => {
    if (!confirm) return undefined;
    const element = dialog.current;
    if (!element || element.open) return undefined;
    element.showModal();
    return () => {
      if (element.open) element.close();
    };
  }, [confirm]);

  const close = () => {
    confirmation(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };

  const test = async () => {
    setSubmitting(true);
    confirmation(false);
    try {
      const options = mode === "count"
        ? { requestMode: "count", requestCount }
        : { requestMode: "until_quota", requestCount: requestCap, quotaLimitHits };
      const job = await runner.run([{
        connectionId: row.connectionId,
        accountLabel: row.accountLabel,
        provider: row.provider,
        model,
      }], null, options);
      if (job) onComplete?.();
    } finally {
      setSubmitting(false);
      onInteractionChange?.(false);
    }
  };

  const hint = result
    ? `${result.state}${result.status ? ` · HTTP ${result.status}` : ""}${result.message ? ` · ${result.message}` : ""}${result.retryAt ? ` · next check ${new Date(result.retryAt).toLocaleString()} (${result.retryConfidence})` : ""}`
    : "Send one image request; provider allowance or charges may apply.";
  const actionLabel = mode === "count" ? `Run ${requestCount} request${requestCount === 1 ? "" : "s"}` : `Stop after ${quotaLimitHits} quota hit${quotaLimitHits === 1 ? "" : "s"}`;

  return <span className="relative inline-flex items-center gap-1 text-xs">
    <button ref={trigger} type="button" aria-label={`Test image ${model || "model"} on ${row.accountLabel}`} title={held ? "This account/model has an unconfirmed earlier result. Check its saved outcome." : runner.job?.state === "paused" ? "Review the paused batch before starting another test." : runner.unknown ? "Review the saved run before starting another test." : hint} disabled={disabled} onClick={() => confirmation(true)} data-test-state={result?.state || "untested"} className={`flex ${compact ? "size-7 border-0" : "size-10 border border-current"} shrink-0 items-center justify-center rounded hover:bg-primary/5 disabled:opacity-60 ${COLOR[result?.state] || "text-primary"}`}>
      <span aria-hidden="true" className={`material-symbols-outlined ${result?.state === "running" ? "motion-safe:animate-spin" : ""}`} style={{ fontSize: 18 }}>{ICON[result?.state] || "play_arrow"}</span>
    </button>
    <ImageTestRunRecovery runner={runner} held={held} onInteractionChange={onInteractionChange} compactTrigger={compact} />
    {confirm && createPortal(<dialog ref={dialog} aria-label="Confirm image test" onCancel={(event) => { event.preventDefault(); close(); }} className="m-auto w-[min(26rem,calc(100vw-24px))] max-h-[min(90dvh,38rem)] overflow-y-auto rounded-xl border border-border bg-surface p-0 text-text-main shadow-xl backdrop:bg-black/50">
      <header className="flex items-start justify-between gap-3 border-b border-border-subtle px-4 py-3">
        <div className="min-w-0"><h2 className="truncate font-semibold" title={model}>{model}</h2><p className="mt-1 text-xs text-text-muted">One image per request · allowance or charges may apply.</p></div>
        <button type="button" aria-label="Cancel image test" onClick={close} className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-text-muted hover:bg-surface-2"><span aria-hidden="true" className="material-symbols-outlined">close</span></button>
      </header>
      <div className="space-y-3 px-4 py-3">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium text-text-muted">Run policy</legend>
          <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
            <input type="radio" name={`image-test-mode-${row.connectionId}-${model}`} value="count" checked={mode === "count"} onChange={() => setMode("count")} />
            <span className="flex-1">Fixed request count</span>
            {mode === "count" && <select aria-label="Image request count" value={requestCount} onChange={(event) => setRequestCount(Number(event.target.value))} className="min-h-8 rounded-md border border-border bg-surface px-2" onClick={(event) => event.stopPropagation()}>{REQUEST_COUNTS.map((count) => <option key={count} value={count}>{count}</option>)}</select>}
          </label>
          {quotaModeAvailable && <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 has-[:checked]:border-amber-500 has-[:checked]:bg-amber-500/5">
            <input type="radio" name={`image-test-mode-${row.connectionId}-${model}`} value="until_quota" checked={mode === "until_quota"} onChange={() => setMode("until_quota")} />
            <span className="flex-1">Stop at confirmed quota limit</span>
            {mode === "until_quota" && <select aria-label="Confirmed quota limit hits" value={quotaLimitHits} onChange={(event) => setQuotaLimitHits(Number(event.target.value))} className="min-h-8 rounded-md border border-border bg-surface px-2" onClick={(event) => event.stopPropagation()}><option value={1}>1 hit</option><option value={2}>2 hits</option></select>}
          </label>}
        </fieldset>

        {mode === "count" ? <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-text-muted">Sends up to {requestCount} requests, one at a time. Stops on the first error or uncertain result.</p> : <div className="space-y-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-text-muted">
          <label className="flex items-center justify-between gap-3">Request cap <select aria-label="Maximum image requests" value={requestCap} onChange={(event) => setRequestCap(Number(event.target.value))} className="min-h-8 rounded-md border border-border bg-surface px-2 text-text-main">{REQUEST_CAPS.map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
          <p>Counts only confirmed image-quota 429 responses. A second hit waits for a provider-confirmed reset; without one, the run stops after the first hit. Other errors stop this model.</p>
        </div>}

        {runner.error && <p role="status" className="text-xs text-amber-500">{runner.error}</p>}
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-border-subtle bg-surface px-4 py-3">
        <button type="button" onClick={close} className="min-h-9 rounded-lg px-3 text-sm text-text-muted hover:bg-surface-2">Cancel</button>
        <button type="button" onClick={() => void test()} disabled={runner.busy || runner.unknown || submitting} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50">
          <span aria-hidden="true" className={`material-symbols-outlined text-base ${submitting ? "motion-safe:animate-spin" : ""}`}>{submitting ? "progress_activity" : "play_arrow"}</span>{submitting ? "Starting…" : actionLabel}
        </button>
      </footer>
    </dialog>, document.body)}
  </span>;
}
