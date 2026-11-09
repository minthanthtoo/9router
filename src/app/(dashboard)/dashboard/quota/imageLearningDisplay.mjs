export function selectImageLearning(row, model = "") {
  const learning = row?.learning;
  const models = Array.isArray(learning?.models) ? learning.models : [];
  const selected = model ? models.find((entry) => entry.model === model) : null;
  return { models: model ? models.filter((entry) => entry.model === model) : models,
    counts: model ? selected?.counts : learning?.counts,
    estimate: selected?.estimate || (!model && models.length === 1 ? models[0].estimate : null),
    nextCheck: selected?.nextCheck || (!model && models.length === 1 ? models[0].nextCheck : null) };
}

export function imageCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : "—";
}

export function estimateLabel(estimate) {
  if (estimate?.state !== "estimated" || !(estimate.windowSeconds > 0) || !(estimate.callLimit > 0)) return "Not enough history";
  const range = estimate.windowRangeSeconds;
  if (range && Number.isFinite(range.min) && Number.isFinite(range.max)) {
    const duration = value => value >= 3600 ? `${(value/3600).toFixed(1)}h` : value >= 60 ? `${(value/60).toFixed(1)}m` : `${value}s`;
    return `${estimate.quotaScope==='shared_image_quota'?'Shared quota · ':''}Estimate ${imageCount(estimate.callLimit)} requests / >${duration(range.min)}–${duration(range.max)} · low confidence`;
  }
  const seconds = estimate.windowSeconds;
  const window = seconds % 3600 === 0 ? `${seconds / 3600}h` : seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
  return `${estimate.quotaScope==='shared_image_quota'?'Shared quota · ':''}Estimated ${imageCount(estimate.callLimit)} requests / ${window} · ${estimate.confidence || "unknown"} confidence`;
}

export function hasImage429Evidence(nextAt, models = [], constraints = []) {
  const timestamp = nextAt ? Date.parse(nextAt) : NaN;
  if (!Number.isFinite(timestamp)) return false;
  const matches = (value) => Boolean(value) && Date.parse(value) === timestamp;
  return models.some((entry) => matches(entry.last429?.retryAt))
    || constraints.some((constraint) => constraint.state !== "probe_in_progress"
      && (constraint.httpStatus === 429 || ["provider_429", "provider_retry_after"].includes(constraint.source))
      && matches(constraint.retryAt));
}

export function imageNextCheck(account, entry) {
  if (account?.routeState === "model_scoped_limits" && entry?.model) {
    const applicable = (account.constraints || []).filter(constraint => constraint.appliesToModels?.includes("*") || constraint.appliesToModels?.includes(entry.model));
    if (!applicable.length) return entry.nextCheck || null;
    const unknown = applicable.find(constraint => !constraint.retryAt);
    const controlling = unknown || [...applicable].sort((a,b)=>Date.parse(b.retryAt)-Date.parse(a.retryAt))[0];
    return { at: controlling.retryAt || null, confidence: controlling.confidence || "unknown", source: controlling.source || "runtime_restriction" };
  }
  const restricted = ["quota_blocked", "probe_eligible", "probe_in_progress", "model_scoped_limits", "legacy_cooldown", "local_capacity_limited"].includes(account?.routeState);
  if (restricted && account?.nextKnownAt) return { at: account.nextKnownAt, confidence: account.availabilityConfidence || "unknown", source: account.availabilitySource || "runtime_restriction" };
  return entry?.nextCheck || (account?.nextKnownAt ? { at: account.nextKnownAt, confidence: account.availabilityConfidence || "unknown", source: account.availabilitySource || "runtime" } : null);
}

export function imageModelEvidence(account, entry, now = Date.now()) {
  const snapshot = account?.providerUsageEvidence;
  const windows = (snapshot?.windows || []).filter(window => window.scope === "image" && (!window.model || window.model === entry?.model));
  const age = snapshot?.observedAt ? now - Date.parse(snapshot.observedAt) : Infinity;
  const stale = age < 0 || age > 5 * 60_000;
  if (windows.length) return { kind: "reported", label: stale ? "Reported · stale" : "Provider reported", windows, stale, observedAt: snapshot.observedAt,
    shared: windows.some(window => !window.model) };
  const next = imageNextCheck(account, entry);
  if (next && next.source !== "learned_window") return { kind: "restriction", label: !next.at ? "Waiting · time unknown" : next.confidence === "provider_confirmed" ? "Provider wait" : "Estimated check", next };
  if (entry?.estimate?.state === "estimated") return { kind: "estimated", label: "Estimated · low confidence", estimate: entry.estimate };
  return { kind: "unknown", label: "Unknown", windows: [], observedAt: snapshot?.observedAt || null };
}
