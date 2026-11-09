// Codex (paid ChatGPT plans: Go/Plus/Pro/...) image generation via Responses API + SSE
import { randomUUID } from "node:crypto";
import { hasUsableImagePayload, isUsableBase64Image, nowSec } from "./_base.js";
import { PROVIDERS } from "../../config/providers.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";
import { CODEX_CLI_VERSION } from "../../config/appConstants.js";
import { classifyImageQuotaError, isCodexImageUsageFailure } from "./quotaErrors.js";

const CODEX_RESPONSES_URL = PROVIDERS["codex"].baseUrl;
const CODEX_IMAGES_GENERATIONS_URL = PROVIDER_MEDIA.codex.imageConfig.baseUrl;
const CODEX_USER_AGENT = `codex_cli_rs/${CODEX_CLI_VERSION}`;
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_MODEL_SUFFIX = "-image";
const CODEX_REF_DETAIL = "high";
// Only drives the image_generation tool call; any chat model on the plan works as host.
const CODEX_IMAGES_MAIN_MODEL = "gpt-6-sol";
const CODEX_TOOL_IMAGE_MODELS = new Set([
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
]);

function decodeOpenAIAuthClaims(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (b64.length % 4)) % 4;
    const payload = JSON.parse(Buffer.from(b64 + "=".repeat(pad), "base64").toString("utf8"));
    return payload?.["https://api.openai.com/auth"] || null;
  } catch {
    return null;
  }
}

function decodeAccountId(idToken) {
  return decodeOpenAIAuthClaims(idToken)?.chatgpt_account_id || null;
}

// Token claims first: the stored chatgptPlanType is only set at OAuth/import time and goes stale on plan changes.
function resolveChatgptPlanType(creds) {
  return decodeOpenAIAuthClaims(creds?.accessToken)?.chatgpt_plan_type
    || decodeOpenAIAuthClaims(creds?.idToken)?.chatgpt_plan_type
    || creds?.providerSpecificData?.chatgptPlanType
    || null;
}

function stripImageSuffix(model) {
  return model.endsWith(CODEX_MODEL_SUFFIX) ? model.slice(0, -CODEX_MODEL_SUFFIX.length) : model;
}

function resolveCodexImageModels(model) {
  if (CODEX_TOOL_IMAGE_MODELS.has(model)) {
    return { responsesModel: CODEX_IMAGES_MAIN_MODEL, toolModel: model };
  }
  return { responsesModel: stripImageSuffix(model), toolModel: null };
}

function hasImageRefs(body) {
  return Boolean(body?.image || (Array.isArray(body?.images) && body.images.length > 0));
}

function shouldUseNativeGeneration(model, body = {}) {
  // Native Codex has been observed returning one auto-sized PNG even when n,
  // size, or output_format requests something else. Do not silently reroute
  // those requests to a transport that cannot honor their output controls.
  return CODEX_TOOL_IMAGE_MODELS.has(model)
    && !hasImageRefs(body)
    && (body.n == null || body.n === 1)
    && (!body.size || body.size === "auto")
    && (!body.output_format || body.output_format.toLowerCase() === "png")
    && (!body.background || ["auto", "opaque"].includes(body.background))
    && (!body.quality || ["auto", "low", "medium", "high"].includes(body.quality))
    && body.output_compression == null;
}

function buildNativeGenerationBody(model, body) {
  return {
    model,
    prompt: body.prompt,
    n: 1,
    size: "auto",
    quality: body.quality || "auto",
    background: body.background || "auto",
    output_format: "png",
  };
}

function toDataUrl(input) {
  if (!input || typeof input !== "string") return null;
  if (/^data:image\//i.test(input) || /^https?:\/\//i.test(input)) return input;
  return `data:image/png;base64,${input}`;
}

function buildContent(prompt, refs, detail = CODEX_REF_DETAIL) {
  const content = [];
  refs.forEach((url, index) => {
    content.push({ type: "input_text", text: `<image name=image${index + 1}>` });
    content.push({ type: "input_image", image_url: url, detail });
    content.push({ type: "input_text", text: "</image>" });
  });
  content.push({ type: "input_text", text: prompt });
  return content;
}

function extractStreamError(data) {
  if (!data) return null;
  if (typeof data === "string") return data;
  if (data.error?.message) return data.error.message;
  if (data.response?.error?.message) return data.response.error.message;
  if (data.item?.error?.message) return data.item.error.message;
  if (data.response?.status_details?.error?.message) return data.response.status_details.error.message;
  if (typeof data.error === "string") return data.error;
  if (typeof data.message === "string") return data.message;
  return null;
}

function normalizeResponsesUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw.input_tokens ?? raw.prompt_tokens;
  const output = raw.output_tokens ?? raw.completion_tokens;
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) return null;

  const usage = {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: Number.isSafeInteger(raw.total_tokens) ? raw.total_tokens : input + output,
  };
  const cached = raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens;
  const reasoning = raw.output_tokens_details?.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens;
  if (Number.isSafeInteger(cached) && cached >= 0) usage.cached_tokens = cached;
  if (Number.isSafeInteger(reasoning) && reasoning >= 0) usage.reasoning_tokens = reasoning;
  return usage;
}

function nativeImageSseResponse(result) {
  return new Response(`event: done\ndata: ${JSON.stringify(result)}\n\n`, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// Parse Codex SSE stream → final base64 image. Optional callbacks for client streaming.
async function parseStream(response, log, callbacks = {}) {
  const reader = response.body.getReader();
  callbacks.onReader?.(reader);
  const decoder = new TextDecoder();
  let buffer = "";
  let imageB64 = null;
  let upstreamError = null;
  let assistantText = "";
  let lastEvent = null;
  let bytesReceived = 0;
  let lastProgressLogMs = 0;
  let usage = null;
  let failure = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesReceived += value?.byteLength || 0;
      buffer += decoder.decode(value, { stream: true });

      let sepIdx;
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);

        const lines = block.split("\n");
        let eventName = null;
        let dataStr = "";
        for (const line of lines) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
        }
        if (!eventName) continue;
        if (eventName !== lastEvent) {
          log?.info?.("IMAGE", `codex progress: ${eventName}`);
          lastEvent = eventName;
        }

        const now = Date.now();
        if (callbacks.onProgress && now - lastProgressLogMs > 200) {
          lastProgressLogMs = now;
          callbacks.onProgress({ stage: eventName, bytesReceived });
        }

        if ((eventName === "error" || eventName === "response.failed") && dataStr) {
          let data;
          try { data = JSON.parse(dataStr); } catch {}
          const error = data?.error || data?.response?.error || data;
          const err = new Error(error?.message || `Codex upstream failed (${eventName})`);
          for (const key of ["code", "type", "param"]) {
            if (typeof error?.[key] === "string") err[key] = error[key];
          }
          if (isCodexImageUsageFailure(error)) {
            failure = error;
            await reader.cancel();
            return { imageB64, usage, failure };
          }
          throw err;
        }

        if (eventName === "response.image_generation_call.partial_image" && dataStr) {
          try {
            const data = JSON.parse(dataStr);
            if (callbacks.onPartialImage && data?.partial_image_b64) {
              callbacks.onPartialImage({ b64_json: data.partial_image_b64, index: data.partial_image_index });
            }
          } catch {}
        }

        if (eventName === "response.output_text.delta" && dataStr) {
          try {
            assistantText += JSON.parse(dataStr)?.delta || "";
          } catch {}
        }

        if (eventName === "response.output_item.done" && dataStr) {
          try {
            const data = JSON.parse(dataStr);
            const item = data?.item;
            if (item?.type === "image_generation_call") {
              if (item.status === "failed" && isCodexImageUsageFailure(item.failure)) failure = item.failure;
              if (item.result) imageB64 = item.result;
              else upstreamError = extractStreamError(item) || upstreamError;
            } else if (item?.type === "message") {
              assistantText = item.content
                ?.map((part) => (typeof part === "string" ? part : part?.text || part?.output_text))
                .filter(Boolean)
                .join(" ") || assistantText;
            }
          } catch {}
        }

        if ((eventName === "response.completed" || eventName === "response.done") && dataStr) {
          try {
            const data = JSON.parse(dataStr);
            usage = normalizeResponsesUsage(data?.response?.usage ?? data?.usage) || usage;
            for (const item of data?.response?.output || data?.output || []) {
              if (item?.type === "image_generation_call" && item.result) imageB64 = item.result;
            }
          } catch {}
        }
      }
    }
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!imageB64 && !upstreamError && assistantText) {
    upstreamError = `Codex returned text instead of an image: "${assistantText.trim().slice(0, 300)}"`;
  }
  return { imageB64, usage, failure, error: upstreamError };
}

async function forwardQuotaFallbackResponse(response, controller, send, setActiveReader, signal) {
  const contentType = response?.headers?.get("content-type") || "";
  if (contentType.includes("text/event-stream") && response.body) {
    const reader = response.body.getReader();
    setActiveReader(reader);
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) controller.enqueue(value);
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    return;
  }

  let payload = null;
  try { payload = await response.json(); } catch {}
  const error = payload?.error && typeof payload.error === "object"
    ? payload.error
    : { message: `Image fallback failed with status ${response?.status || 502}.` };
  send("error", { ...error, http_status: response?.status || 502 });
}

async function waitForStreamSignal(promise, signal) {
  if (!signal) return promise;
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = resolve;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try { await Promise.race([promise, aborted]); } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

// SSE Response that pipes codex progress + partial + done events to client
function buildSseResponse(providerResponse, log, onSuccess, onUsage, onQuotaObservation, onImageSubmissionResult, submissionTicket, providerRequestId, model, clientSignal) {
  const abortController = new AbortController();
  let activeReader = null;
  let deadlineExpired = false;
  const abortFromClient = () => {
    if (clientSignal?.reason?.code === "IMAGE_REQUEST_DEADLINE") {
      deadlineExpired = true;
      try { activeReader?.cancel(clientSignal.reason).catch(() => {}); } catch {}
      return;
    }
    abortController.abort(clientSignal?.reason);
    try { activeReader?.cancel(clientSignal?.reason).catch(() => {}); } catch {}
  };
  if (clientSignal?.aborted) abortFromClient();
  else clientSignal?.addEventListener("abort", abortFromClient, { once: true });
  let partialImageSent = false;
  let submissionFinished = false;
  const finishSubmission = (result) => {
    if (submissionFinished || !submissionTicket || !onImageSubmissionResult) return Promise.resolve(false);
    submissionFinished = true;
    return Promise.resolve()
      .then(() => onImageSubmissionResult(submissionTicket, { ...result, providerRequestId }))
      .catch((error) => {
        log?.warn?.("IMAGE", `Submission accounting update failed: ${error?.code || error?.name || "error"}`);
        return false;
      });
  };
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event, data) => {
        if (!abortController.signal.aborted) {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        }
      };
      if (deadlineExpired) {
        finishSubmission({ outcome: "outcome_unknown", failureClass: "outcome_unknown" });
        send("error", {
          code: "image_outcome_unknown",
          message: "The image request may have been accepted before its time budget expired. Check the existing operation before submitting it again.",
          availability_state: "outcome_unknown",
          retry_scope: "reconcile_existing",
        });
        controller.close();
        return;
      }
      try {
        const { imageB64: b64, usage, failure, error: upstreamError } = await parseStream(providerResponse, log, {
          onReader: (reader) => { activeReader = reader; },
          onProgress: (info) => send("progress", info),
          onPartialImage: (info) => {
            partialImageSent = true;
            send("partial_image", info);
          },
        });
        const hasImage = isUsableBase64Image(b64);
        if (deadlineExpired && !hasImage && !failure) {
          finishSubmission({ outcome: "outcome_unknown", failureClass: "outcome_unknown" });
          send("error", {
            code: "image_outcome_unknown",
            message: "The image request may have been accepted before its time budget expired. Check the existing operation before submitting it again.",
            availability_state: "outcome_unknown",
            retry_scope: "reconcile_existing",
          });
          return;
        }
        if (!hasImage && failure) {
          const bodyText = JSON.stringify({ error: failure });
          const quotaObservation = classifyImageQuotaError({
            provider: "codex",
            status: 429,
            bodyText,
            headers: providerResponse.headers,
            model,
          });
          if (quotaObservation) {
            await finishSubmission({
              outcome: "quota_rejected",
              httpStatus: 429,
              failureClass: "image_quota",
              quotaGroupId: quotaObservation.quotaGroupId,
              constraintId: quotaObservation.constraintId,
              retryAt: quotaObservation.retryAt,
              confidence: quotaObservation.confidence,
              quotaObservations: quotaObservation.constraints || [quotaObservation],
            });
            const canRetry = !partialImageSent && !abortController.signal.aborted;
            let fallbackResponse = null;
            try {
              fallbackResponse = await onQuotaObservation?.(quotaObservation, {
                canRetry,
                signal: abortController.signal,
                isCancelled: () => abortController.signal.aborted,
              });
            } catch (error) {
              log?.warn?.("IMAGE", `Quota fallback coordination failed: ${error?.code || error?.name || "error"}`);
            }
            if (canRetry && fallbackResponse instanceof Response && !abortController.signal.aborted) {
              send("progress", { stage: "retrying_after_quota", retry_at: quotaObservation.retryAt });
              await forwardQuotaFallbackResponse(
                fallbackResponse,
                controller,
                send,
                (reader) => { activeReader = reader; },
                abortController.signal,
              );
            } else {
              send("error", {
                code: "image_quota_rejected",
                message: "The image service rejected this request because the account reached its image quota.",
                availability_state: "quota_blocked",
                retry_at: quotaObservation.retryAt,
                availability_confidence: quotaObservation.confidence,
                availability_source: quotaObservation.source,
                observed_at: quotaObservation.observedAt,
                retry_scope: partialImageSent ? "reconcile_existing" : "new_request_after_check",
              });
            }
          } else {
            finishSubmission({ outcome: "outcome_unknown", failureClass: "outcome_unknown" });
            send("error", {
              code: "image_outcome_unknown",
              message: "The image request may have been accepted before the provider stream failed. Check the existing operation before submitting it again.",
              availability_state: "outcome_unknown",
              retry_scope: "reconcile_existing",
            });
          }
        } else if (!hasImage) {
          finishSubmission({ outcome: "outcome_unknown", failureClass: "outcome_unknown" });
          send("error", { message: upstreamError || "Codex completed without an image. No upstream image result was provided.", availability_state: "outcome_unknown", retry_scope: "reconcile_existing" });
        } else {
          finishSubmission({ outcome: "succeeded", httpStatus: providerResponse.status, outputCount: 1, usage });
          if (usage && onUsage) {
            const usageRecording = Promise.resolve()
              .then(() => onUsage(usage))
              .catch((error) => log?.warn?.("IMAGE", `Usage recording failed: ${error?.code || error?.name || "error"}`));
            await waitForStreamSignal(usageRecording, clientSignal);
          }
          if (onSuccess) {
            const successBookkeeping = Promise.resolve()
              .then(() => onSuccess())
              .catch((error) => log?.warn?.("IMAGE", `Success bookkeeping failed: ${error?.code || error?.name || "error"}`));
            await waitForStreamSignal(successBookkeeping, clientSignal);
          }
          send("done", { created: nowSec(), data: [{ b64_json: b64 }] });
        }
      } catch (err) {
        finishSubmission({ outcome: "outcome_unknown", failureClass: "outcome_unknown" });
        if (deadlineExpired) {
          send("error", {
            code: "image_outcome_unknown",
            message: "The image request may have been accepted before its time budget expired. Check the existing operation before submitting it again.",
            availability_state: "outcome_unknown",
            retry_scope: "reconcile_existing",
          });
        } else {
          send("error", {
            code: "image_outcome_unknown",
            message: err?.message || "The image request may have been accepted before the provider stream failed. Check the existing operation before submitting it again.",
            ...(err?.code ? { provider_code: err.code } : {}),
            ...(err?.type ? { type: err.type } : {}),
            ...(err?.param ? { param: err.param } : {}),
            availability_state: "outcome_unknown",
            retry_scope: "reconcile_existing",
          });
        }
      } finally {
        clientSignal?.removeEventListener("abort", abortFromClient);
        if (!abortController.signal.aborted) controller.close();
      }
    },
    async cancel(reason) {
      abortController.abort(reason);
      try { await activeReader?.cancel(reason); } catch {}
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export default {
  stream: true,
  // ChatGPT Free accounts have the image_generation tool stripped server-side
  // (upstream returns 400 "Tool choice 'image_generation' must be specified with 'tools' parameter").
  // Unknown plan is allowed so accounts without plan claims keep working.
  canUseCredentials: (creds) => resolveChatgptPlanType(creds) !== "free",
  buildUrl: (model, creds, body) => shouldUseNativeGeneration(model, body)
    ? CODEX_IMAGES_GENERATIONS_URL
    : CODEX_RESPONSES_URL,
  buildHeaders: (creds, requestBody) => {
    const accountId = creds?.providerSpecificData?.chatgptAccountId || decodeAccountId(creds?.idToken);
    return {
      "accept": requestBody?.prompt && !requestBody?.input ? "application/json" : "text/event-stream, application/json",
      "authorization": `Bearer ${creds?.accessToken || ""}`,
      "chatgpt-account-id": accountId || "",
      "content-type": "application/json",
      "originator": CODEX_ORIGINATOR,
      "session_id": randomUUID(),
      "user-agent": CODEX_USER_AGENT,
      "version": CODEX_CLI_VERSION,
      "x-client-request-id": randomUUID(),
    };
  },
  buildBody: (model, body) => {
    if (shouldUseNativeGeneration(model, body)) return buildNativeGenerationBody(model, body);
    const refs = [];
    if (Array.isArray(body.images)) body.images.forEach((i) => { const u = toDataUrl(i); if (u) refs.push(u); });
    const single = toDataUrl(body.image);
    if (single) refs.push(single);
    const detail = body.image_detail || CODEX_REF_DETAIL;
    const { responsesModel, toolModel } = resolveCodexImageModels(model);
    const imgTool = { type: "image_generation", output_format: (body.output_format || "png").toLowerCase() };
    if (toolModel) {
      imgTool.action = refs.length > 0 ? "edit" : "generate";
      imgTool.model = toolModel;
    }
    if (body.size && body.size !== "") imgTool.size = body.size;
    if (body.quality && body.quality !== "") imgTool.quality = body.quality;
    if (body.background && body.background !== "") imgTool.background = body.background;
    return {
      model: responsesModel,
      instructions: "",
      input: [{ type: "message", role: "user", content: buildContent(body.prompt, refs, detail) }],
      tools: [imgTool],
      tool_choice: toolModel ? { type: "image_generation" } : "auto",
      parallel_tool_calls: false,
      prompt_cache_key: randomUUID(),
      stream: true,
      store: false,
      reasoning: null,
    };
  },
  // Custom: codex parses SSE → either pipe to client or collect b64
  async parseResponse(response, { log, streamToClient, onRequestSuccess, onUsage, onQuotaObservation, onImageSubmissionResult, submissionTicket, providerRequestId, model, signal, requestBody }) {
    if (requestBody?.prompt && !requestBody?.input) {
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Codex Images API returned invalid JSON.");
      }
      const data = Array.isArray(payload?.data) ? payload.data : [];
      if (!hasUsableImagePayload({ data })) {
        const error = payload?.error || {};
        const err = new Error(error.message || "Codex Images API returned no image.");
        for (const key of ["code", "type", "param"]) {
          if (typeof error[key] === "string") err[key] = error[key];
        }
        if (isCodexImageUsageFailure(error)) {
          err.status = 429;
          err.bodyText = JSON.stringify({ error });
          err.headers = response.headers;
        }
        throw err;
      }
      const result = { created: payload.created || nowSec(), data };
      const usage = normalizeResponsesUsage(payload.usage);
      if (streamToClient) {
        if (submissionTicket && onImageSubmissionResult) {
          await onImageSubmissionResult(submissionTicket, { outcome: "succeeded", httpStatus: response.status, outputCount: data.length, usage, providerRequestId });
        }
        for (const callback of [usage && onUsage ? () => onUsage(usage) : null, onRequestSuccess]) {
          if (callback) await waitForStreamSignal(Promise.resolve().then(callback).catch((error) => log?.warn?.("IMAGE", `Image bookkeeping failed: ${error?.code || error?.name || "error"}`)), signal);
        }
        return { sseResponse: nativeImageSseResponse(result) };
      }
      if (usage && onUsage) {
        try { await onUsage(usage); } catch (error) { log?.warn?.("IMAGE", `Usage recording failed: ${error?.code || error?.name || "error"}`); }
      }
      return result;
    }

    if (streamToClient) {
      return { sseResponse: buildSseResponse(response, log, onRequestSuccess, onUsage, onQuotaObservation, onImageSubmissionResult, submissionTicket, providerRequestId, model, signal) };
    }
    const { imageB64: b64, usage, failure, error: upstreamError } = await parseStream(response, log);
    if (!isUsableBase64Image(b64)) {
      if (isCodexImageUsageFailure(failure)) {
        const error = new Error(failure.message || "Codex image usage limit reached.");
        error.status = 429;
        error.bodyText = JSON.stringify({ error: failure });
        error.headers = response.headers;
        throw error;
      }
      throw new Error(upstreamError || "Codex completed without an image. No upstream image result was provided.");
    }
    if (usage && onUsage) {
      try { await onUsage(usage); } catch (error) {
        log?.warn?.("IMAGE", `Usage recording failed: ${error?.code || error?.name || "error"}`);
      }
    }
    return { created: nowSec(), data: [{ b64_json: b64 }] };
  },
  normalize: (responseBody) => responseBody,
};
