import {accountModelAccess} from '../../shared/utils/textModelPermission.mjs';
function nextBlockedAt(rows) {
  if (!rows?.length || rows.some((row) => !row.retryAt || !Number.isFinite(Date.parse(row.retryAt)))) return null;
  return rows.map((row) => row.retryAt).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) || null;
}

/**
 * Shared read-only eligibility projection for selection and operator status.
 * An eligible route means 9Router may select it; quota capacity is unknown
 * unless a provider observation supplies it.
 */
export function effectiveImageQuotaEligibility(connection, state = {}, {
  model = null,
  nowMs = Date.now(),
  antigravityQuotaUntil = null,
  antigravityQuotaBlock = null,
} = {}) {
  if (!connection || connection.isActive === false) {
    return { eligible: false, state: "account_disabled", retryAt: null, confidence: "unknown" };
  }

  if (accountModelAccess(connection,model,state.modelAccess,nowMs).reason) return {eligible:false,state:'model_not_enabled',retryAt:null,confidence:'unknown'};

  if (state.manualPolicy?.policyState === "paused" || state.manualPolicy) {
    return {
      eligible: false,
      state: "manual_paused",
      retryAt: null,
      confidence: "unknown",
      revision: Number(state.manualPolicy?.revision) || 0,
    };
  }

  const blockers = (state.blockingRows || []).map((row) => ({
    state: "quota_blocked", retryAt: row.retryAt, confidence: row.confidence,
  }));
  const providerQuotaResetAt = antigravityQuotaBlock?.retryAt || antigravityQuotaUntil;
  if (providerQuotaResetAt && Date.parse(providerQuotaResetAt) > nowMs) {
    blockers.push({
      state: "provider_usage_blocked",
      retryAt: providerQuotaResetAt,
      confidence: antigravityQuotaBlock?.confidence || "unknown",
      observedAt: antigravityQuotaBlock?.observedAt || null,
      source: antigravityQuotaBlock?.source || "unknown",
    });
  }

  const legacyLocks = [connection.modelLock___all, model ? connection[`modelLock_${model}`] : null];
  for (const retryAt of legacyLocks) {
    if (retryAt && Date.parse(retryAt) > nowMs) {
      blockers.push({ state: "legacy_cooldown", retryAt, confidence: "estimated" });
    }
  }

  for (const row of state.probeInProgressRows || []) {
    if (row.probeDispatchedAt || Date.parse(row.probeLeaseExpiresAt) > nowMs) {
      blockers.push({
        state: "probe_in_progress",
        retryAt: row.probeDispatchedAt ? null : row.probeLeaseExpiresAt,
        confidence: row.probeDispatchedAt ? "unknown" : "estimated",
      });
    }
  }

  if (blockers.length) {
    // Every applicable constraint must clear; a dispatched probe has no safe retry time.
    const retryAt = nextBlockedAt(blockers);
    const controlling = retryAt
      ? blockers.find((row) => row.retryAt === retryAt)
      : blockers.find((row) => !row.retryAt || !Number.isFinite(Date.parse(row.retryAt)));
    return {
      ...controlling,
      eligible: false,
      retryAt,
      confidence: !retryAt || blockers.some((row) => !row.confidence || row.confidence === "unknown")
        ? "unknown"
        : blockers.some((row) => row.confidence !== "provider_confirmed") ? "estimated" : "provider_confirmed",
    };
  }

  if ((state.expiredRows || []).length) {
    return { eligible: true, state: "probe_eligible", retryAt: null, confidence: "unknown" };
  }

  return { eligible: true, state: "eligible_unreported", retryAt: null, confidence: "unknown" };
}
