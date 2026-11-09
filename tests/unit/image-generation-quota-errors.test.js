import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getExecutorMock, getImageAdapterMock, refreshWithRetryMock } = vi.hoisted(() => ({
  getExecutorMock: vi.fn(),
  getImageAdapterMock: vi.fn(),
  refreshWithRetryMock: vi.fn(),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry: refreshWithRetryMock }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: getExecutorMock }));
vi.mock("../../open-sse/handlers/imageProviders/index.js", () => ({ getImageAdapter: getImageAdapterMock }));
vi.mock("../../open-sse/handlers/imageProviders/_base.js", async (importOriginal) => ({
  ...await importOriginal(),
  urlToBase64: vi.fn(),
}));

import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { urlToBase64 } from "../../open-sse/handlers/imageProviders/_base.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import antigravityImageAdapter from "../../open-sse/handlers/imageProviders/antigravity.js";
import codexImageAdapter from "../../open-sse/handlers/imageProviders/codex.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  getExecutorMock.mockReturnValue({
    parseError: (response, bodyText) => ({ status: response.status, message: bodyText }),
  });
  getImageAdapterMock.mockReturnValue({
    buildUrl: () => "https://provider.invalid/images",
    buildBody: () => ({ prompt: "a landscape" }),
    buildHeaders: () => ({ "content-type": "application/json" }),
    normalize: (body) => body,
  });
});

describe("image provider quota metadata", () => {
  it.each(["gemini", "antigravity"])("keeps local-capacity refusal before any %s network dispatch", async (provider) => {
    const fetchMock = vi.fn(() => { throw new Error("must never send inference"); });
    vi.stubGlobal("fetch", fetchMock);
    if (provider === "antigravity") {
      const executor = new BaseExecutor("antigravity", {});
      executor.buildUrl = () => "https://provider.invalid/image";
      executor.transformRequest = (_model, body) => body;
      executor.buildHeaders = () => ({ "content-type": "application/json" });
      getExecutorMock.mockReturnValue(executor);
      getImageAdapterMock.mockReturnValue(antigravityImageAdapter);
    }
    const onImageSubmissionStart = vi.fn(async () => "local_capacity");
    const success = vi.fn();
    const result = await handleImageGenerationCore({
      body: { prompt: "synthetic fixture" }, modelInfo: { provider, model: "gemini-image" },
      credentials: { accessToken: "fixture" }, onImageSubmissionStart, onRequestSuccess: success,
    });
    expect(result).toMatchObject({ success: false, status: 503, dispatchBlocked: "local_capacity", acceptance: "rejected_before_acceptance" });
    expect(onImageSubmissionStart).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });

  it("preserves a completed Antigravity binary image when success bookkeeping fails", async () => {
    getImageAdapterMock.mockReturnValue({
      useExecutor: true,
      executeViaExecutor: vi.fn(async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: "aGVsbG8=" } }] } }] })),
      normalize: () => ({ created: 1, data: [{ b64_json: "aGVsbG8=" }] }),
    });
    const onRequestSuccess = vi.fn(() => { throw new Error("quota store unavailable"); });

    const result = await handleImageGenerationCore({
      body: { model: "gemini-image", prompt: "a landscape" },
      modelInfo: { provider: "antigravity", model: "gemini-image" },
      credentials: { accessToken: "test-token" },
      binaryOutput: true,
      onRequestSuccess,
    });

    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await result.response.arrayBuffer()).toString()).toBe("hello");
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
  });

  it("forwards the shared request signal and dispatch budget into executor adapters", async () => {
    const executeViaExecutor = vi.fn(async () => ({
      candidates: [{ content: { parts: [{ inlineData: { data: "aGVsbG8=" } }] } }],
    }));
    const signal = new AbortController().signal;
    const onProviderDispatch = vi.fn(() => null);
    getImageAdapterMock.mockReturnValue({
      useExecutor: true,
      executeViaExecutor,
      normalize: () => ({ created: 1, data: [{ b64_json: "aGVsbG8=" }] }),
    });

    const result = await handleImageGenerationCore({
      body: { model: "gemini-image", prompt: "a landscape" },
      modelInfo: { provider: "antigravity", model: "gemini-image" },
      credentials: { accessToken: "test-token" },
      signal,
      onProviderDispatch,
    });

    expect(result.success).toBe(true);
    expect(executeViaExecutor).toHaveBeenCalledWith(
      "gemini-image",
      expect.objectContaining({ prompt: "a landscape" }),
      expect.objectContaining({ accessToken: "test-token" }),
      undefined,
      signal,
      expect.objectContaining({
        onProviderDispatch,
        onImageSubmissionStart: undefined,
        onImageSubmissionResult: expect.any(Function),
      }),
    );
  });

  it("counts a token-refresh resubmission against the shared provider dispatch ceiling", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: "expired" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    refreshWithRetryMock.mockResolvedValueOnce({ accessToken: "refreshed-token" });
    const onProviderDispatch = vi.fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce("attempt_limit");

    const result = await handleImageGenerationCore({
      body: { model: "gpt-image-2", prompt: "a landscape", size: "1024x1024" },
      modelInfo: { provider: "codex", model: "gpt-image-2" },
      credentials: { accessToken: "expired-token", providerSpecificData: {} },
      onProviderDispatch,
    });

    expect(result).toMatchObject({
      success: false,
      status: 503,
      dispatchBlocked: "attempt_limit",
      acceptance: "rejected_before_acceptance",
    });
    expect(onProviderDispatch).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns unknown instead of retrying another account when the refreshed submission fails after dispatch", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "expired" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }))
      .mockRejectedValueOnce(new TypeError("connection closed after upload"));
    vi.stubGlobal("fetch", fetchMock);
    refreshWithRetryMock.mockResolvedValueOnce({ accessToken: "refreshed-token" });
    const onProviderDispatch = vi.fn(() => null);

    const result = await handleImageGenerationCore({
      body: { model: "gpt-image-2", prompt: "a landscape", size: "1024x1024" },
      modelInfo: { provider: "codex", model: "gpt-image-2" },
      credentials: { accessToken: "expired-token", providerSpecificData: {} },
      onProviderDispatch,
    });

    expect(result).toMatchObject({ success: false, status: 502, acceptance: "unknown" });
    expect(onProviderDispatch).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops waiting on token refresh when the request deadline expires", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: "expired" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    refreshWithRetryMock.mockReturnValueOnce(new Promise(() => {}));
    const onProviderDispatch = vi.fn(() => null);
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(Object.assign(new Error("deadline"), { code: "IMAGE_REQUEST_DEADLINE" })), 0);

    const result = await handleImageGenerationCore({
      body: { model: "gpt-image-2", prompt: "a landscape", size: "1024x1024" },
      modelInfo: { provider: "codex", model: "gpt-image-2" },
      credentials: { accessToken: "expired-token", providerSpecificData: {} },
      signal: deadline.signal,
      onProviderDispatch,
    });

    expect(result).toMatchObject({ success: false, status: 408, dispatchBlocked: "deadline" });
    expect(onProviderDispatch).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not mark quota recovery after an empty Antigravity response", async () => {
    getImageAdapterMock.mockReturnValue({
      useExecutor: true,
      executeViaExecutor: vi.fn(async () => ({ candidates: [] })),
      normalize: () => ({ created: 1, data: [{ b64_json: "" }] }),
    });
    const onRequestSuccess = vi.fn();

    const result = await handleImageGenerationCore({
      body: { model: "gemini-image", prompt: "a landscape" },
      modelInfo: { provider: "antigravity", model: "gemini-image" },
      credentials: { accessToken: "test-token" },
      onRequestSuccess,
    });

    expect(result).toMatchObject({ success: false, acceptance: "unknown" });
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("returns a validated image when post-success bookkeeping never settles before the deadline", async () => {
    const executeViaExecutor = vi.fn(async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: "aGVsbG8=" } }] } }] }));
    getImageAdapterMock.mockReturnValue({
      useExecutor: true,
      executeViaExecutor,
      normalize: () => ({ created: 1, data: [{ b64_json: "aGVsbG8=" }] }),
    });
    const deadline = new AbortController();
    const onRequestSuccess = vi.fn(() => new Promise(() => {}));

    setTimeout(() => deadline.abort(Object.assign(new Error("deadline"), { code: "IMAGE_REQUEST_DEADLINE" })), 0);
    const result = await handleImageGenerationCore({
      body: { model: "gemini-image", prompt: "a landscape" },
      modelInfo: { provider: "antigravity", model: "gemini-image" },
      credentials: { accessToken: "test-token" },
      signal: deadline.signal,
      onRequestSuccess,
    });

    expect(result.success).toBe(true);
    expect(await result.response.json()).toMatchObject({ data: [{ b64_json: "aGVsbG8=" }] });
    expect(executeViaExecutor).toHaveBeenCalledTimes(1);
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
  });

  it("does not mark quota recovery for a mapped provider response without image data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const onRequestSuccess = vi.fn();

    const result = await handleImageGenerationCore({
      body: { model: "gpt-image-2", prompt: "a landscape", size: "1024x1024" },
      modelInfo: { provider: "codex", model: "gpt-image-2" },
      credentials: { accessToken: "test-token" },
      onRequestSuccess,
    });

    expect(result).toMatchObject({ success: false, acceptance: "unknown" });
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("keeps an upstream request-timeout response ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "upstream timed out" } }), {
      status: 408,
      headers: { "content-type": "application/json" },
    })));

    const result = await handleImageGenerationCore({
      body: { model: "gpt-image-2", prompt: "a landscape", size: "1024x1024" },
      modelInfo: { provider: "codex", model: "gpt-image-2" },
      credentials: { accessToken: "test-token" },
    });

    expect(result).toMatchObject({ success: false, status: 408, acceptance: "unknown" });
  });

  it("does not report a binary image success when fetching its provider URL fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ url: "https://images.example.test/generated.png" }],
    }), { headers: { "content-type": "application/json" } })));
    urlToBase64.mockRejectedValueOnce(new Error("image download failed"));
    getImageAdapterMock.mockReturnValue({
      buildUrl: () => "https://api.example.test/images",
      buildBody: () => ({ prompt: "a landscape" }),
      buildHeaders: () => ({ "content-type": "application/json" }),
      normalize: (value) => value,
    });
    const onRequestSuccess = vi.fn();

    const result = await handleImageGenerationCore({
      body: { model: "gpt-image-2", prompt: "a landscape", size: "1024x1024" },
      modelInfo: { provider: "codex", model: "gpt-image-2" },
      credentials: { accessToken: "test-token" },
      binaryOutput: true,
      onRequestSuccess,
    });

    expect(result).toMatchObject({ success: false, acceptance: "unknown" });
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("delivers validated Codex JSON and SSE images when usage or cleanup callbacks fail", async () => {
    const events = [
      ["response.output_item.done", { item: { type: "image_generation_call", result: "aGVsbG8=" } }],
      ["response.completed", { response: { usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 } } }],
    ];
    const makeResponse = () => new Response(
      events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
    const onUsage = vi.fn(async () => { throw new Error("usage store unavailable"); });
    const onRequestSuccess = vi.fn(async () => { throw new Error("quota store unavailable"); });
    getImageAdapterMock.mockReturnValue(codexImageAdapter);
    const input = {
      body: { model: "gpt-image-2", prompt: "a landscape", size: "1024x1024" },
      modelInfo: { provider: "codex", model: "gpt-image-2" },
      credentials: { accessToken: "test-token" },
      onUsage,
      onRequestSuccess,
    };

    vi.stubGlobal("fetch", vi.fn(async () => makeResponse()));
    const streamed = await handleImageGenerationCore({ ...input, streamToClient: true });
    const streamText = await streamed.response.text();

    expect(streamed.success).toBe(true);
    expect(streamText).toContain("event: done\n");
    expect(streamText).not.toContain("event: error\n");

    vi.stubGlobal("fetch", vi.fn(async () => makeResponse()));
    const json = await handleImageGenerationCore(input);

    expect(json.success).toBe(true);
    expect(await json.response.json()).toMatchObject({ data: [{ b64_json: "aGVsbG8=" }] });
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(onRequestSuccess).toHaveBeenCalledTimes(2);
  });

  it("rotates a Codex SSE quota rejection inside the existing client stream", async () => {
    getImageAdapterMock.mockReturnValue(codexImageAdapter);
    const quotaError = {
      type: "usage_limit_reached",
      message: "The image generation quota is exhausted.",
      resets_at: Math.floor(Date.now() / 1000) + 7 * 86400,
    };
    const providerEvents = [
      ["response.failed", { response: { error: quotaError } }],
    ];
    const fallbackEvents = [
      ["progress", { stage: "image_generation_call.in_progress" }],
      ["done", { created: 1, data: [{ b64_json: "aGVsbG8=" }] }],
    ];
    const toSse = (events) => new Response(
      events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
    const onQuotaObservation = vi.fn(async (_observation, state) => {
      expect(state.canRetry).toBe(true);
      return toSse(fallbackEvents);
    });
    vi.stubGlobal("fetch", vi.fn(async () => toSse(providerEvents)));

    const result = await handleImageGenerationCore({
      body: { model: "gpt-image-2", prompt: "a landscape", image: "data:image/png;base64,cmVm" },
      modelInfo: { provider: "codex", model: "gpt-image-2" },
      credentials: { accessToken: "test-token" },
      streamToClient: true,
      onQuotaObservation,
    });
    const streamText = await result.response.text();

    expect(result.success).toBe(true);
    expect(onQuotaObservation).toHaveBeenCalledTimes(1);
    expect(onQuotaObservation.mock.calls[0][0]).toMatchObject({
      constraintId: "usage_limit",
      confidence: "provider_confirmed",
    });
    expect(streamText).toContain('"stage":"retrying_after_quota"');
    expect(streamText).toContain('"stage":"image_generation_call.in_progress"');
    expect(streamText).toContain('"b64_json":"aGVsbG8="');
    expect(streamText).not.toContain("image_quota_rejected");
  });

  it("does not retry Codex SSE quota errors after exposing a partial image", async () => {
    getImageAdapterMock.mockReturnValue(codexImageAdapter);
    const events = [
      ["response.image_generation_call.partial_image", { partial_image_b64: "cGFydGlhbA==", partial_image_index: 0 }],
      ["response.failed", { response: { error: { type: "usage_limit_reached", message: "limit reached" } } }],
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    )));
    const onQuotaObservation = vi.fn(async () => new Response([
      "event: done",
      `data: ${JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] })}`,
      "",
      "",
    ].join("\n"), { headers: { "Content-Type": "text/event-stream" } }));

    const result = await handleImageGenerationCore({
      body: { model: "gpt-image-2", prompt: "a landscape", size: "1024x1024" },
      modelInfo: { provider: "codex", model: "gpt-image-2" },
      credentials: { accessToken: "test-token" },
      streamToClient: true,
      onQuotaObservation,
    });
    const streamText = await result.response.text();

    expect(onQuotaObservation).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ canRetry: false }));
    expect(streamText).toContain("event: partial_image\n");
    expect(streamText).toContain("reconcile_existing");
    expect(streamText).not.toContain('"stage":"retrying_after_quota"');
    expect(streamText).not.toContain('"b64_json":"aGVsbG8="');
  });

  it("does not submit a fallback after the client cancels a Codex image stream", async () => {
    getImageAdapterMock.mockReturnValue(codexImageAdapter);
    let providerCancelled = false;
    const providerBody = new ReadableStream({ cancel() { providerCancelled = true; } });
    const fetchMock = vi.fn(async () => new Response(providerBody, {
      headers: { "Content-Type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onQuotaObservation = vi.fn();
    const clientController = new AbortController();

    const result = await handleImageGenerationCore({
      body: { model: "gpt-image-2", prompt: "a landscape", size: "1024x1024" },
      modelInfo: { provider: "codex", model: "gpt-image-2" },
      credentials: { accessToken: "test-token" },
      streamToClient: true,
      onQuotaObservation,
      signal: clientController.signal,
    });
    const clientReader = result.response.body.getReader();
    await clientReader.cancel("client disconnected");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].signal).toBe(clientController.signal);
    expect(providerCancelled).toBe(true);
    expect(onQuotaObservation).not.toHaveBeenCalled();
  });

  it("closes a Codex SSE stream with a terminal unknown result when the shared deadline expires", async () => {
    getImageAdapterMock.mockReturnValue(codexImageAdapter);
    let providerCancelled = false;
    const providerBody = new ReadableStream({ cancel() { providerCancelled = true; } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(providerBody, {
      headers: { "Content-Type": "text/event-stream" },
    })));
    const deadline = new AbortController();
    const result = await handleImageGenerationCore({
      body: { model: "gpt-image-2", prompt: "a landscape", size: "1024x1024" },
      modelInfo: { provider: "codex", model: "gpt-image-2" },
      credentials: { accessToken: "test-token" },
      streamToClient: true,
      signal: deadline.signal,
    });

    setTimeout(() => deadline.abort(Object.assign(new Error("deadline"), { code: "IMAGE_REQUEST_DEADLINE" })), 0);
    const streamText = await result.response.text();

    expect(streamText).toContain('"code":"image_outcome_unknown"');
    expect(streamText).toContain('"retry_scope":"reconcile_existing"');
    expect(providerCancelled).toBe(true);
  });

  it("reports an unknown outcome when the Codex provider stream fails after dispatch", async () => {
    getImageAdapterMock.mockReturnValue(codexImageAdapter);
    const providerBody = new ReadableStream({
      start(controller) { controller.error(new Error("provider stream disconnected")); },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(providerBody, {
      headers: { "Content-Type": "text/event-stream" },
    })));

    const result = await handleImageGenerationCore({
      body: { model: "gpt-image-2", prompt: "a landscape", size: "1024x1024" },
      modelInfo: { provider: "codex", model: "gpt-image-2" },
      credentials: { accessToken: "test-token" },
      streamToClient: true,
    });
    const streamText = await result.response.text();

    expect(streamText).toContain('"code":"image_outcome_unknown"');
    expect(streamText).toContain('"retry_scope":"reconcile_existing"');
  });

  it("keeps Codex usage-limit metadata on the internal failure result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: {
        type: "usage_limit_reached",
        message: "The image generation quota is exhausted.",
        resets_at: Math.floor(Date.now() / 1000) + 7 * 86400,
      },
    }), { status: 429, headers: { "content-type": "application/json" } })));

    const result = await handleImageGenerationCore({
      body: { model: "gpt-image-2", prompt: "a landscape", size: "1024x1024" },
      modelInfo: { provider: "codex", model: "gpt-image-2" },
      credentials: { accessToken: "test-token", providerSpecificData: {} },
    });

    expect(result).toMatchObject({
      success: false,
      status: 429,
      acceptance: "rejected_before_acceptance",
      quotaObservation: {
        capability: "image_generation",
        quotaGroupId: "codex.image_generation",
        constraintId: "usage_limit",
        confidence: "provider_confirmed",
      },
    });
    expect(result.error).toBe("Image generation account quota reached");
    expect(await result.response.json()).toMatchObject({
      error: { message: "Image generation account quota reached" },
    });
  });
});
