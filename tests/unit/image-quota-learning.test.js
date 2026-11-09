import { describe, expect, it } from "vitest";
import { estimateImageQuotaLearning } from "../../src/sse/services/imageQuotaLearning.js";

const start = Date.parse("2026-11-01T00:00:00.000Z");
function event(seconds, outcome, extra = {}) {
  return { dispatchedAt: new Date(start + seconds * 1000).toISOString(), outcome, ...extra };
}
describe("passive image quota learning", () => {
  it("never turns a provider wait alone into a window estimate", () => {
    const result = estimateImageQuotaLearning([event(0, "quota_rejected", { retryAt: new Date(start + 18000_000).toISOString(), confidence: "provider_confirmed" })]);
    expect(result.estimate).toMatchObject({ state: "learning", windowSeconds: null, callLimit: null, confidence: "unknown" });
    expect(result.nextCheck).toMatchObject({ source: "provider_retry_after" });
  });
  it.each([["provider_confirmed", "provider_retry_after"], ["estimated", "router_backoff"], ["unknown", "unknown"], [undefined, "unknown"]])("labels %s wait evidence as %s", (confidence, source) => {
    const result = estimateImageQuotaLearning([event(0, "quota_rejected", { retryAt: new Date(start + 60000).toISOString(), confidence })]);
    expect(result.nextCheck.source).toBe(source);
  });
  it("keeps indistinguishable candidate windows ambiguous despite repeated recoveries", () => {
    const events = [0, 86400, 172800, 259200].flatMap((offset) => [
      event(offset, "succeeded"), event(offset + 1, "succeeded"), event(offset + 2, "succeeded"), event(offset + 3, "quota_rejected"),
    ]);
    expect(estimateImageQuotaLearning([...events, event(345600, "succeeded")]).estimate).toMatchObject({ state: "ambiguous", windowSeconds: null, callLimit: null });
  });
  it("fits only distinguishable rolling windows, with low observational confidence", () => {
    const events = [0, 61, 122, 183].flatMap((offset) => [
      event(offset, "succeeded"), event(offset + 1, "succeeded"), event(offset + 2, "succeeded"), event(offset + 3, "quota_rejected"),
    ]);
    expect(estimateImageQuotaLearning([...events, event(244, "succeeded")]).estimate).toMatchObject({ state: "estimated", windowSeconds: 60, callLimit: 3, confidence: "low" });
  });
  it("predicts a low-confidence next check from an exhausted learned window without granting admission", () => {
    const events = [0, 61, 122, 183].flatMap((offset) => [event(offset, "succeeded"), event(offset + 1, "succeeded"), event(offset + 2, "succeeded"), event(offset + 3, "quota_rejected")]);
    const result = estimateImageQuotaLearning(events);
    expect(result.nextCheck).toEqual({ at: new Date(start + 244000).toISOString(), confidence: "estimated", source: "learned_window" });
    const providerWait = new Date(start + 999000).toISOString();
    events[events.length - 1].retryAt = providerWait;
    events[events.length - 1].confidence = "provider_confirmed";
    expect(estimateImageQuotaLearning(events).nextCheck).toMatchObject({ at: providerWait, source: "provider_retry_after" });
    expect(estimateImageQuotaLearning([...events, event(244, "succeeded")]).nextCheck).toMatchObject({
      at: new Date(start + 245000).toISOString(), confidence: "estimated", source: "learned_window",
    });
  });
  it("counts actual observations after a wait once per rejection, not as an exact recovery instant", () => {
    const events = [event(0, "quota_rejected", { retryAt: new Date(start + 60000).toISOString() }), event(61, "quota_rejected"), event(62, "succeeded")];
    expect(estimateImageQuotaLearning(events).predictionChecks).toEqual({ succeeded: 0, rejected: 1 });
  });
  it("fits a bounded recent sample after each candidate window warms up", () => {
    let offset = 0;
    const offsets = Array.from({ length: 20 }, (_, i) => { offset += [61, 90, 400, 65, 1100, 77, 180][i % 7]; return offset; });
    const events = offsets.flatMap((offset) => [
      event(offset, "succeeded"), event(offset + 1, "succeeded"), event(offset + 2, "succeeded"), event(offset + 3, "quota_rejected"),
    ]);
    const result = estimateImageQuotaLearning([...events, event(offset + 61, "succeeded")], { truncated: true });
    expect(result.estimate).toMatchObject({ state: "estimated", windowSeconds: 60, callLimit: 3, confidence: "low" });
    expect(result.estimate.reason).toMatch(/partial|bounded/i);
    expect(result.estimate.reason).toMatch(/successful dispatches/i);
  });
  it("keeps periodic bounded evidence ambiguous when several warmed windows fit", () => {
    const events = Array.from({ length: 20 }, (_, i) => i * 61).flatMap((offset) => [
      event(offset, "succeeded"), event(offset + 1, "succeeded"), event(offset + 2, "succeeded"), event(offset + 3, "quota_rejected"),
    ]);
    expect(estimateImageQuotaLearning([...events, event(1220, "succeeded")], { truncated: true }).estimate.state).toBe("ambiguous");
  });
  it("keeps an incomplete warmup sample learning", () => {
    const events = [0, 1, 2, 3].flatMap((offset) => [event(offset, "succeeded"), event(offset + 0.1, "quota_rejected")]);
    expect(estimateImageQuotaLearning(events, { truncated: true }).estimate.state).toBe("learning");
  });
  it("clears a superseded next check but preserves the last provider rejection", () => {
    const result = estimateImageQuotaLearning([event(0, "quota_rejected", { retryAt: new Date(start + 60000).toISOString() }), event(61, "succeeded")]);
    expect(result.nextCheck).toBeNull();
    expect(result.last429).toMatchObject({ at: new Date(start).toISOString() });
  });
  it("counts one subsequent request once when it checks multiple reported waits", () => {
    const retryAt = new Date(start + 60000).toISOString();
    const result = estimateImageQuotaLearning([event(0, "quota_rejected", { retryAt }), event(1, "quota_rejected", { retryAt }), event(61, "succeeded")]);
    expect(result.predictionChecks).toEqual({ succeeded: 1, rejected: 0 });
  });
  it("refuses a fit with unknown dispatch consumption", () => {
    const events = [0, 61, 122, 183].flatMap((offset) => [event(offset, "succeeded"), event(offset + 1, "succeeded"), event(offset + 2, "quota_rejected")]);
    events.push(event(123.5, "outcome_unknown"));
    expect(estimateImageQuotaLearning(events).estimate.state).toBe("learning");
  });
});
