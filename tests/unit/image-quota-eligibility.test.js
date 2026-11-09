import { describe, expect, it } from "vitest";
import { effectiveImageQuotaEligibility } from "../../src/sse/services/imageQuotaEligibility.js";

describe("effective image quota eligibility", () => {
  const codex = {
    id: "codex-a",
    provider: "codex",
    isActive: true,
    providerSpecificData: { enabledModels: ["gpt-image-2"] },
  };

  it("keeps eligible accounts explicit that remaining quota is unknown", () => {
    expect(effectiveImageQuotaEligibility(codex, {})).toEqual({
      eligible: true,
      state: "eligible_unreported",
      retryAt: null,
      confidence: "unknown",
    });
  });

  it("uses a model-specific block and preserves unknown reset confidence", () => {
    expect(effectiveImageQuotaEligibility(codex, {
      blockingRows: [{ retryAt: null, confidence: "provider_confirmed" }],
    }, { model: "gpt-image-2" })).toMatchObject({
      eligible: false,
      state: "quota_blocked",
      retryAt: null,
      confidence: "unknown",
    });
  });

  it("preserves source, observation time, and confidence for provider-usage blocks", () => {
    expect(effectiveImageQuotaEligibility(codex, {}, {
      model: "gpt-image-2",
      nowMs: Date.parse("2026-10-15T00:00:00.000Z"),
      antigravityQuotaBlock: {
        retryAt: "2026-10-15T01:00:00.000Z",
        confidence: "estimated",
        observedAt: "2026-10-14T23:55:00.000Z",
        source: "quota_strike_circuit_breaker",
      },
    })).toEqual({
      eligible: false,
      state: "provider_usage_blocked",
      retryAt: "2026-10-15T01:00:00.000Z",
      confidence: "estimated",
      observedAt: "2026-10-14T23:55:00.000Z",
      source: "quota_strike_circuit_breaker",
    });
  });

  it("reports the independent causes before provider quota eligibility", () => {
    expect(effectiveImageQuotaEligibility({ ...codex, isActive: false }, {
      manualPolicy: { policyState: "paused" },
    }).state).toBe("account_disabled");

    expect(effectiveImageQuotaEligibility(codex, {
      manualPolicy: { policyState: "paused", revision: 2 },
    }).state).toBe("manual_paused");

    expect(effectiveImageQuotaEligibility(codex, {}, { model: "gpt-5.5" }).state)
      .toBe("model_not_enabled");
  });

  it("makes an expired block request-time probe eligible rather than claiming quota is available", () => {
    expect(effectiveImageQuotaEligibility(codex, {
      expiredRows: [{ retryAt: "2026-10-15T00:00:00.000Z" }],
    }, { nowMs: Date.parse("2026-10-15T01:00:00.000Z") })).toEqual({
      eligible: true,
      state: "probe_eligible",
      retryAt: null,
      confidence: "unknown",
    });
  });

  it("keeps a route unavailable while another request owns its reset probe lease", () => {
    expect(effectiveImageQuotaEligibility(codex, {
      expiredRows: [{ retryAt: "2026-10-15T00:00:00.000Z" }],
      probeInProgressRows: [{ probeLeaseExpiresAt: "2026-10-15T01:02:00.000Z" }],
    }, { nowMs: Date.parse("2026-10-15T01:00:00.000Z") })).toEqual({
      eligible: false,
      state: "probe_in_progress",
      retryAt: "2026-10-15T01:02:00.000Z",
      confidence: "estimated",
    });
  });

  it("does not advertise a reset or eligibility for a dispatched probe after lease expiry", () => {
    expect(effectiveImageQuotaEligibility(codex, {
      expiredRows: [{ retryAt: "2026-10-15T00:00:00.000Z" }],
      probeInProgressRows: [{ probeLeaseExpiresAt: "2026-10-15T01:02:00.000Z", probeDispatchedAt: "2026-10-15T01:00:00.000Z" }],
    }, { nowMs: Date.parse("2026-10-15T02:00:00.000Z") })).toEqual({
      eligible: false, state: "probe_in_progress", retryAt: null, confidence: "unknown",
    });
  });
});


describe("combined image quota constraints", () => {
  const nowMs = Date.parse("2026-10-21T00:00:00Z");
  const connection = { id: "a", provider: "antigravity", isActive: true };
  const hour = "2026-10-21T01:00:00Z";
  const week = "2026-10-28T00:00:00Z";
  const options = { nowMs, model: "image", antigravityQuotaBlock: {
    retryAt: hour, confidence: "provider_confirmed", source: "provider", observedAt: "2026-10-21T00:00:00Z",
  } };

  it("keeps the weekly reset beyond the provider hourly reset", () => {
    expect(effectiveImageQuotaEligibility(connection, { blockingRows: [{ retryAt: week, confidence: "provider_confirmed" }] }, options))
      .toMatchObject({ eligible: false, retryAt: week, confidence: "provider_confirmed" });
  });

  it("does not hide an unknown reset behind a known provider reset", () => {
    expect(effectiveImageQuotaEligibility(connection, { blockingRows: [{ retryAt: null }] }, options))
      .toMatchObject({ eligible: false, retryAt: null, confidence: "unknown" });
  });

  it("does not hide an uncertain dispatched probe behind a known reset", () => {
    expect(effectiveImageQuotaEligibility(connection, { probeInProgressRows: [{ probeDispatchedAt: "2026-10-20T00:00:00Z" }] }, options))
      .toMatchObject({ eligible: false, retryAt: null, confidence: "unknown" });
  });

  it("enforces both model-specific and all-model legacy locks", () => {
    expect(effectiveImageQuotaEligibility({ ...connection, modelLock_image: hour, modelLock___all: week }, {}, { nowMs, model: "image" }))
      .toMatchObject({ eligible: false, retryAt: week, confidence: "estimated" });
  });

  it("waits for every undispatched recovery lease", () => {
    expect(effectiveImageQuotaEligibility(connection, { probeInProgressRows: [
      { probeLeaseExpiresAt: hour }, { probeLeaseExpiresAt: week },
    ] }, { nowMs })).toMatchObject({ eligible: false, state: "probe_in_progress", retryAt: week, confidence: "estimated" });
  });

  it("does not let an expired model lock conceal an active global lock", () => {
    expect(effectiveImageQuotaEligibility({ ...connection, modelLock_image: "2026-10-20T00:00:00Z", modelLock___all: week }, {}, { nowMs, model: "image" }))
      .toMatchObject({ eligible: false, retryAt: week });
  });

  it("compares reset instants rather than timestamp strings", () => {
    expect(effectiveImageQuotaEligibility(connection, { blockingRows: [
      { retryAt: "2026-10-21T09:00:00+09:00", confidence: "provider_confirmed" },
      { retryAt: hour, confidence: "provider_confirmed" },
    ] }, { nowMs })).toMatchObject({ retryAt: hour });
  });
});
