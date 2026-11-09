import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_QUOTA_CONFIG } from "../../open-sse/config/imageQuotaConfig.js";

afterEach(() => vi.unstubAllEnvs());

describe("image quota rollout gate", () => {
  it("keeps the current enabled default", () => {
    vi.stubEnv("IMAGE_QUOTA_ENABLED", "");
    expect(IMAGE_QUOTA_CONFIG.enabled).toBe(true);
  });

  it.each(["false", "FALSE", "0", "off"])("recognizes %s as a fail-closed disable value", (value) => {
    vi.stubEnv("IMAGE_QUOTA_ENABLED", value);
    expect(IMAGE_QUOTA_CONFIG.enabled).toBe(false);
  });

  it("defaults to a pool-sized submission ceiling and a caller-bounded request budget", () => {
    vi.stubEnv("IMAGE_QUOTA_MAX_SUBMISSIONS_PER_REQUEST", "");
    vi.stubEnv("IMAGE_QUOTA_REQUEST_TIMEOUT_MS", "");
    expect(IMAGE_QUOTA_CONFIG.maxSubmissionsPerRequest).toBe(32);
    expect(IMAGE_QUOTA_CONFIG.requestTimeoutMs).toBe(80_000);
  });

  it("bounds operator overrides and ignores malformed values", () => {
    vi.stubEnv("IMAGE_QUOTA_MAX_SUBMISSIONS_PER_REQUEST", "1000");
    vi.stubEnv("IMAGE_QUOTA_REQUEST_TIMEOUT_MS", "900000");
    expect(IMAGE_QUOTA_CONFIG.maxSubmissionsPerRequest).toBe(64);
    expect(IMAGE_QUOTA_CONFIG.requestTimeoutMs).toBe(300_000);

    vi.stubEnv("IMAGE_QUOTA_MAX_SUBMISSIONS_PER_REQUEST", "many");
    vi.stubEnv("IMAGE_QUOTA_REQUEST_TIMEOUT_MS", "0");
    expect(IMAGE_QUOTA_CONFIG.maxSubmissionsPerRequest).toBe(32);
    expect(IMAGE_QUOTA_CONFIG.requestTimeoutMs).toBe(80_000);
  });
});


describe("explicit local supplier limits", () => {
  it("does not invent a default supplier quota", () => {
    vi.stubEnv("IMAGE_QUOTA_LOCAL_LIMITS_JSON", "");
    expect(IMAGE_QUOTA_CONFIG.localLimits).toEqual([]);
  });
  it.each(["{", "null", "{}", '[{"provider":"gemini","model":"image","maxConcurrent":0}]',
    '[{"provider":"gemini","model":"image","windows":[{"seconds":604801,"requests":1}]}]',
    '[{"provider":"gemini","model":"image","maxConcurent":2}]'])("rejects malformed local policy %s", (raw) => {
    vi.stubEnv("IMAGE_QUOTA_LOCAL_LIMITS_JSON", raw);
    expect(() => IMAGE_QUOTA_CONFIG.localLimits).toThrow();
  });
});
