import { describe, expect, it, vi, beforeEach } from "vitest";

let imageRemainingFraction = 0.42;
const proxyAwareFetch = vi.fn(async (url) => ({
  ok: true,
  status: 200,
  json: async () => url.includes(":loadCodeAssist")
    ? { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" }, paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } }
    : {
        models: {
          "gemini-3.8-flash-high": {
            displayName: "Gemini 3.8 Flash (High)",
            quotaInfo: { remainingFraction: 0.85, resetTime: "2026-08-25T12:00:00Z" },
          },
          "gemini-3.8-flash-medium": {
            displayName: "Gemini 3.8 Flash (Medium)",
            quotaInfo: { remainingFraction: 0.6, resetTime: "2026-08-25T12:00:00Z" },
          },
          "gemini-3.8-flash-low": {
            displayName: "Gemini 3.8 Flash (Low)",
            quotaInfo: { remainingFraction: 0.35, resetTime: "2026-08-25T12:00:00Z" },
          },
          "gemini-3.1-flash-image": {
            displayName: "Gemini 3.1 Flash Image",
            quotaInfo: {
              ...(imageRemainingFraction === undefined ? {} : { remainingFraction: imageRemainingFraction }),
              resetTime: "2026-08-25T12:00:00Z",
            },
          },
          "internal-model": {
            displayName: "Internal",
            isInternal: true,
            quotaInfo: { remainingFraction: 0.5 },
          },
        },
      },
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Antigravity quota tracker: Gemini 3.8 Flash usage bars", () => {
  beforeEach(() => {
    proxyAwareFetch.mockClear();
    imageRemainingFraction = 0.42;
  });

  it("returns Gemini 3.8 Flash tier quotas so the dashboard can render usage bars", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-3.8-flash-high"]).toMatchObject({
      used: 150,
      total: 1000,
      remainingPercentage: 85,
      displayName: "Gemini 3.8 Flash (High)",
    });
    expect(usage.quotas["gemini-3.8-flash-medium"]).toMatchObject({
      used: 400,
      total: 1000,
      remainingPercentage: 60,
    });
    expect(usage.quotas["gemini-3.8-flash-low"]).toMatchObject({
      used: 650,
      total: 1000,
      remainingPercentage: 35,
    });
  });

  it("keeps the Gemini image quota on a normalized percentage scale without calling it requests", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-3.1-flash-image"]).toMatchObject({
      used: 580,
      total: 1000,
      remainingPercentage: 42,
      displayUnit: "normalized_percentage",
      quotaStatus: "reported",
    });
  });

  it("keeps an image quota with no fraction unknown instead of treating it as exhausted", async () => {
    imageRemainingFraction = undefined;
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-3.1-flash-image"]).toMatchObject({
      used: 0,
      total: 0,
      remainingPercentage: null,
      displayUnit: "normalized_percentage",
      quotaStatus: "unknown",
    });
  });
});
