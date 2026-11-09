import { describe, expect, it } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

const log = { info() {}, warn() {}, error() {}, debug() {} };

function quotaResponse(code, { retryAt = null, confidence = "unknown", requestId = "request-1" } = {}) {
  return new Response(JSON.stringify({ error: {
    code,
    message: code === "image_pool_paused" ? "Images are paused" : "Image quota reached",
    request_id: requestId,
    retry_at: retryAt,
    availability_confidence: confidence,
    observed_at: "2026-10-15T00:00:00.000Z",
    retry_scope: code === "image_pool_paused" ? "none" : "new_request_after_check",
  } }), {
    status: code === "image_pool_exhausted" ? 429 : 503,
    headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
  });
}

async function responseJson(response) {
  return response.json();
}

describe("image combo quota response", () => {
  it("preserves the earliest known reset when every combo route is quota blocked", async () => {
    const earlierReset = new Date(Date.now() + 60_000).toISOString();
    const laterReset = new Date(Date.now() + 120_000).toISOString();
    const response = await handleComboChat({
      body: { model: "image-pool", prompt: "a tree" },
      models: ["codex/gpt-image-2", "antigravity/gemini-image"],
      comboName: "image-pool",
      autoSwitch: false,
      preserveImageQuotaErrors: true,
      handleSingleModel: async (_body, model) => model.startsWith("codex/")
        ? quotaResponse("image_pool_exhausted", { retryAt: laterReset, confidence: "provider_confirmed" })
        : quotaResponse("image_pool_exhausted", { retryAt: earlierReset, confidence: "estimated" }),
      log,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    await expect(responseJson(response)).resolves.toMatchObject({ error: {
      code: "image_pool_exhausted",
      model: "image-pool",
      retry_at: earlierReset,
      availability_state: "quota_blocked",
      availability_confidence: "estimated",
      retry_scope: "new_request_after_check",
    } });
  });

  it("preserves a fully operator-paused combo as a non-retryable status", async () => {
    const response = await handleComboChat({
      body: { model: "image-pool", prompt: "a tree" },
      models: ["codex/gpt-image-2", "antigravity/gemini-image"],
      comboName: "image-pool",
      autoSwitch: false,
      preserveImageQuotaErrors: true,
      handleSingleModel: async () => quotaResponse("image_pool_paused"),
      log,
    });

    expect(response.status).toBe(503);
    await expect(responseJson(response)).resolves.toMatchObject({ error: {
      code: "image_pool_paused",
      availability_state: "manual_paused",
      retry_at: null,
      retry_scope: "none",
    } });
  });

  it("does not label a mixed quota and transient failure as quota exhaustion", async () => {
    const response = await handleComboChat({
      body: { model: "image-pool", prompt: "a tree" },
      models: ["codex/gpt-image-2", "antigravity/gemini-image"],
      comboName: "image-pool",
      autoSwitch: false,
      preserveImageQuotaErrors: true,
      handleSingleModel: async (_body, model) => model.startsWith("codex/")
        ? quotaResponse("image_pool_exhausted", { retryAt: new Date(Date.now() + 60_000).toISOString() })
        : new Response(JSON.stringify({ error: { message: "Provider temporarily unavailable" } }), { status: 503 }),
      log,
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).not.toBe("image_pool_exhausted");
    expect(response.headers.get("retry-after")).toBeNull();
  });

  it("does not try another combo model after an image outcome is unknown", async () => {
    let calls = 0;
    const response = await handleComboChat({
      body: { model: "image-pool", prompt: "a tree" },
      models: ["codex/gpt-image-2", "antigravity/gemini-image"],
      comboName: "image-pool",
      autoSwitch: false,
      preserveImageQuotaErrors: true,
      handleSingleModel: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { code: "image_outcome_unknown", message: "May have been accepted" } }), { status: 502 });
      },
      log,
    });

    expect(calls).toBe(1);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "image_outcome_unknown" } });
  });

  it.each(["image_deadline_exceeded", "image_attempt_limit_reached", "image_supplier_budget_exhausted",
    "image_supplier_budget_unavailable"])(
    "does not bypass the shared request guard after %s",
    async (code) => {
      let calls = 0;
      const response = await handleComboChat({
        body: { model: "image-pool", prompt: "a tree" },
        models: ["codex/gpt-image-2", "antigravity/gemini-image"],
        comboName: "image-pool",
        autoSwitch: false,
        preserveImageQuotaErrors: true,
        handleSingleModel: async () => {
          calls += 1;
          return new Response(JSON.stringify({ error: { code, message: "Request budget exhausted" } }), { status: 503 });
        },
        log,
      });

      expect(calls).toBe(1);
      await expect(response.json()).resolves.toMatchObject({ error: { code } });
    },
  );
});
