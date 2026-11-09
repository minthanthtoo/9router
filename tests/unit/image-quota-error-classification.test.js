import { describe, expect, it } from "vitest";
import { classifyImageQuotaError } from "../../open-sse/handlers/imageProviders/quotaErrors.js";

const NOW = Date.parse("2026-10-15T00:00:00.000Z");

describe("provider image quota error classification", () => {
  it("recognizes Antigravity RESOURCE_EXHAUSTED and preserves its provider reset", () => {
    const result = classifyImageQuotaError({
      provider: "antigravity",
      status: 429,
      model: "gemini-3.1-flash-image",
      now: NOW,
      bodyText: JSON.stringify({
        error: {
          status: "RESOURCE_EXHAUSTED",
          message: "Image generation quota exhausted",
          details: [{ metadata: { quotaResetTimeStamp: "2026-10-18T12:00:00Z" } }],
        },
      }),
    });

    expect(result).toMatchObject({
      capability: "image_generation",
      quotaGroupId: "antigravity.image_generation",
      constraintId: "provider_image_quota",
      model: "gemini-3.1-flash-image",
      retryAt: "2026-10-18T12:00:00.000Z",
      confidence: "provider_confirmed",
      source: "provider_image_error",
    });
    expect(result).not.toHaveProperty("accountId");
    expect(result).not.toHaveProperty("bodyText");
  });

  it("keeps detail-free Antigravity throttles out of the quota state", () => {
    expect(classifyImageQuotaError({
      provider: "antigravity",
      status: 429,
      model: "gemini-3.1-flash-image",
      now: NOW,
      bodyText: JSON.stringify({ error: { message: "Request rejected" } }),
    })).toBeNull();
  });

  it("uses an estimated check time when Antigravity supplies quota metadata without a reset", () => {
    const result = classifyImageQuotaError({
      provider: "antigravity",
      status: 409,
      model: "gemini-3.1-flash-image",
      now: NOW,
      bodyText: JSON.stringify({ error: {
        status: "RESOURCE_EXHAUSTED",
        details: [{ metadata: { quotaMetric: "image_generation_requests" } }],
      } }),
    });

    expect(result.confidence).toBe("estimated");
    expect(result.retryAt).toBe(new Date(NOW + 60 * 60 * 1000).toISOString());
  });

  it("does not persist detail-free RESOURCE_EXHAUSTED errors as image quota", () => {
    expect(classifyImageQuotaError({
      provider: "antigravity",
      status: 429,
      model: "gemini-3.1-flash-image",
      now: NOW,
      bodyText: JSON.stringify({ error: {
        status: "RESOURCE_EXHAUSTED",
        message: "Quota Exhausted",
      } }),
    })).toBeNull();
  });

  it("does not persist generic Antigravity rate limits as image quota", () => {
    expect(classifyImageQuotaError({
      provider: "antigravity",
      status: 429,
      model: "gemini-3.1-flash-image",
      now: NOW,
      bodyText: JSON.stringify({ error: { message: "Rate limit exceeded; retry later" } }),
    })).toBeNull();
  });

  it("recognizes the Codex image usage-limit code and exact weekly reset", () => {
    const result = classifyImageQuotaError({
      provider: "codex",
      status: 429,
      model: "gpt-image-2",
      now: NOW,
      bodyText: JSON.stringify({
        error: { type: "usage_limit_reached", resets_at: Math.floor(NOW / 1000) + 7 * 86400 },
      }),
    });

    expect(result).toMatchObject({
      quotaGroupId: "codex.image_generation",
      constraintId: "usage_limit",
      confidence: "provider_confirmed",
      retryAt: new Date(NOW + 7 * 86400 * 1000).toISOString(),
    });
  });

  it("does not classify ordinary Codex 429 responses as image quota exhaustion", () => {
    expect(classifyImageQuotaError({
      provider: "codex",
      status: 429,
      model: "gpt-image-2",
      now: NOW,
      bodyText: JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }),
    })).toBeNull();
  });

  it("accepts HTTP-date Retry-After without reducing long reset durations", () => {
    const retryAt = "2026-10-20T00:00:00.000Z";
    const result = classifyImageQuotaError({
      provider: "codex",
      status: 429,
      model: "gpt-image-2",
      now: NOW,
      headers: new Headers({ "Retry-After": new Date(retryAt).toUTCString() }),
      bodyText: JSON.stringify({ error: { type: "usage_limit_reached" } }),
    });

    expect(result.retryAt).toBe(retryAt);
  });
});
