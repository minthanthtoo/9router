import {recoveryIntervals,fixedResetFits,quotaHitSpans} from "./imageQuotaStatistics.js";
// Passive fits model successful dispatches, not every physical call's quota units.
const CANDIDATE_SECONDS = [60, 300, 900, 3600, 10800, 18000, 21600, 43200, 86400, 604800];

function observedRecoveries(events) {
  return recoveryIntervals(events).completed;
}

export function imageQuotaWaitSource(confidence, source) {
  if (["codex_provider_reset", "codex_usage_window_reset", "provider_retry_info", "provider_retry_after", "gemini_documented_daily_reset", "gemini_quota_window_estimate", "unknown_quota_window_backoff"].includes(source)) return source;
  return confidence === "provider_confirmed" ? "provider_retry_after" : confidence === "estimated" ? "router_backoff" : "unknown";
}

// Intersect order-statistic constraints for the fitted allowance; no periodicity assumption.
function feasibleWindow(events, limit, candidate, truncated) {
  let lower = 0, upper = 604800000;
  const first = Date.parse(events[0].dispatchedAt), prior = [];
  for (const event of events) {
    const at = Date.parse(event.dispatchedAt);
    const scored = !truncated || at >= first + candidate * 1000;
    if (truncated) {
      if (scored) upper = Math.min(upper, at - first);
      else lower = Math.max(lower, at - first);
    }
    if (scored && prior.length >= limit) {
      const age = at - prior[prior.length - limit];
      if (event.outcome === "succeeded") upper = Math.min(upper, age);
      if (event.outcome === "quota_rejected") lower = Math.max(lower, age);
    }
    if (event.outcome === "succeeded") prior.push(at);
  }
  return { min: lower / 1000, max: upper / 1000, minExclusive: true };
}

export function estimateImageQuotaLearning(history, { truncated = false, now = Date.now() } = {}) {
  let events = [...history].sort((a, b) => Date.parse(a.dispatchedAt) - Date.parse(b.dispatchedAt));
  const uncertain=events.filter(event=>['outcome_unknown','in_flight'].includes(event.outcome));
  const liveUncertainty=uncertain.some(event=>event.outcome==='in_flight'||!event.completedAt||!Number.isFinite(Date.parse(event.completedAt)));
  const safeAfter=!liveUncertainty&&uncertain.length?Math.max(...uncertain.map(event=>Date.parse(event.completedAt))):null;
  const excluded= safeAfter!==null?events.filter(event=>Date.parse(event.dispatchedAt)<=safeAfter).length:0;
  if(safeAfter!==null){events=events.filter(event=>Date.parse(event.dispatchedAt)>safeAfter);truncated=true;}
  const successes = events.filter((row) => row.outcome === "succeeded");
  const rejections = events.filter((row) => row.outcome === "quota_rejected");
  const last = [...rejections].sort((a, b) => Date.parse(a.completedAt || a.dispatchedAt) - Date.parse(b.completedAt || b.dispatchedAt)).at(-1);
  const last429 = last ? { at: last.completedAt || last.dispatchedAt, retryAt: last.retryAt || null, confidence: last.confidence || "unknown" } : null;
  const predictionChecks = { succeeded: 0, rejected: 0 };
  const checkedRequests = new Set();
  const outcomes = events.filter(event => ["succeeded", "quota_rejected"].includes(event.outcome));
  for (const rejection of rejections) {
    if (!rejection.retryAt) continue;
    let low=0,high=outcomes.length;
    // A request cannot check a wait hint that had not arrived when it was sent.
    const retry=Date.parse(rejection.retryAt), observed=Date.parse(rejection.completedAt||rejection.dispatchedAt);
    if(!Number.isFinite(retry)||!Number.isFinite(observed))continue;
    while(low<high){const middle=(low+high)>>>1,at=Date.parse(outcomes[middle].dispatchedAt);if(at<retry||at<=observed)low=middle+1;else high=middle;}
    const next=outcomes[low];
    if (next && !checkedRequests.has(next)) {
      checkedRequests.add(next);
      predictionChecks[next.outcome === "succeeded" ? "succeeded" : "rejected"]++;
    }
  }
  const superseded = last && successes.some((event) => Date.parse(event.dispatchedAt) > Date.parse(last.completedAt || last.dispatchedAt));
  const nextCheck = last?.retryAt && !superseded ? { at: last.retryAt, confidence: last.confidence || "unknown", source: imageQuotaWaitSource(last.confidence, last.retrySource) } : null;
  const diagnostics = {safePeriod:{from:events[0]?.dispatchedAt||null,afterUncertainty:safeAfter!==null?new Date(safeAfter).toISOString():null,excluded,liveUncertainty},method:"rolling_count_constraints",candidateCount:CANDIDATE_SECONDS.length,scoredCandidates:0,fits:[],recovery:recoveryIntervals(events),hitSpans:quotaHitSpans(events)};
  const estimate = { state: "learning", windowSeconds: null, callLimit: null, confidence: "unknown", sampleCount: events.length,
    reason: "Need at least six successes, three quota rejections and three observed recoveries. External use and image cost are unobserved." };
  if (liveUncertainty) {
    estimate.reason = "Unknown or in-flight calls prevent a reliable consumption fit.";
  } else if (successes.length >= 6 && rejections.length >= 3 && observedRecoveries(events) >= 3) {
    const fits = [];
    let scoredCandidates = 0;
    for (const seconds of CANDIDATE_SECONDS) {
      // Missing earlier calls cannot affect a rolling window after one full warmup.
      const scoreFrom = truncated ? Date.parse(events[0].dispatchedAt) + seconds * 1000 : -Infinity;
      const scored = events.filter((event) => Date.parse(event.dispatchedAt) >= scoreFrom);
      if (scored.filter((event) => event.outcome === "succeeded").length < 6
        || scored.filter((event) => event.outcome === "quota_rejected").length < 3
        || observedRecoveries(scored) < 3) continue;
      scoredCandidates++;
      let minimumLimit = 1;
      let maximumLimit = Infinity;
      const priorSuccesses = [];
      let oldest = 0;
      for (const event of events) {
        const at = Date.parse(event.dispatchedAt);
        while(oldest<priorSuccesses.length && priorSuccesses[oldest]<=at-seconds*1000)oldest++;
        const consumed = priorSuccesses.length-oldest;
        if (at >= scoreFrom) {
          if (event.outcome === "succeeded") minimumLimit = Math.max(minimumLimit, consumed + 1);
          else if (event.outcome === "quota_rejected") maximumLimit = Math.min(maximumLimit, consumed);
        }
        if (event.outcome === "succeeded") priorSuccesses.push(at);
      }
      if (minimumLimit === maximumLimit) fits.push({ windowSeconds: seconds, callLimit: minimumLimit });
    }
    diagnostics.scoredCandidates=scoredCandidates;
    diagnostics.fits=fits.map(fit=>({...fit,windowRangeSeconds:feasibleWindow(events,fit.callLimit,fit.windowSeconds,truncated)}));
    if (fits.length === 1) {
      Object.assign(estimate, fits[0], { windowRangeSeconds: feasibleWindow(events, fits[0].callLimit, fits[0].windowSeconds, truncated), method: "rolling_count_constraints", state: "estimated", confidence: "low", reason: "A candidate rolling window fits successful dispatches; its feasible range is not an exact duration. This does not establish quota units for every physical call. External use, shared identities and variable image cost remain unobserved; this is not an admission limit." });
    } else if (scoredCandidates) {
      estimate.state = "ambiguous";
      estimate.reason = fits.length ? "Multiple candidate rolling windows fit; no window or allowance can be distinguished." : "Observed successful dispatches do not consistently fit a candidate rolling window.";
    } else {
      estimate.reason = "Need six successes, three rejections and three recoveries after candidate-window warmup.";
    }
  }
  if (truncated) estimate.reason += " Partial coverage: bounded recent observations with candidate-window warmup; longer windows may be untested. Totals include all recorded calls.";
  diagnostics.fixedResetFits = fixedResetFits(events, CANDIDATE_SECONDS);
  if (diagnostics.fixedResetFits.length && estimate.state === "estimated") {
    Object.assign(estimate, {state:"ambiguous",windowSeconds:null,callLimit:null,confidence:"unknown",windowRangeSeconds:null,
      reason:"Both rolling and provider-anchored fixed periods fit. More irregularly timed observations are needed to distinguish them."});
  }
  let learnedNextCheck = null;
  if (estimate.state === "estimated" && events.length) {
    const latestAt = Date.parse(events.at(-1).dispatchedAt);
    const windowSeconds = estimate.windowRangeSeconds?.max || estimate.windowSeconds;
    const active = successes.map((event) => Date.parse(event.dispatchedAt))
      .filter((at) => at > latestAt - windowSeconds * 1000);
    if (active.length >= estimate.callLimit) {
      learnedNextCheck = { at: new Date(active[active.length - estimate.callLimit] + windowSeconds * 1000).toISOString(), confidence: "estimated", source: "learned_window" };
    }
  }
  // A display-only estimate from retained successes; never grants routing admission.
  if (estimate.state === 'estimated' && Number.isFinite(now)) {
    const seconds=estimate.windowRangeSeconds?.max || estimate.windowSeconds;
    const active=successes.map(event=>Date.parse(event.dispatchedAt)).filter(at=>at<=now&&at>now-seconds*1000).sort((a,b)=>a-b);
    const covered=!truncated || now-Date.parse(events[0]?.dispatchedAt)>=seconds*1000;
    if(covered){
      estimate.usedInWindow=active.length;
      estimate.remainingPercentage=Math.max(0,Math.round((estimate.callLimit-active.length)/estimate.callLimit*100));
      estimate.resetAt=active.length?new Date(active[0]+seconds*1000).toISOString():null;
      estimate.observedAt=new Date(now).toISOString();
    }
  }
  // Observed provider/backoff waits take precedence; a fit never grants admission.
  return { last429, estimate, nextCheck: nextCheck || learnedNextCheck, learnedNextCheck, predictionChecks, diagnostics };
}
