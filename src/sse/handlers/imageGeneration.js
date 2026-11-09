import {resolveImageRouting} from '@/shared/utils/imageRouting.mjs';
import {
  getProviderCredentials,
  admitImageQuotaRequest,
  markAccountUnavailable,
  clearAccountError,
  recordImageQuotaBlock,
  finishImageQuotaRecovery,
  getImageQuotaPoolAvailability,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { getKeyAccessContext, enforceKeyAccess } from "../services/keyAccess.js";
import { getImageSupplierContext, prepareImageSupplierAdmission } from "../services/imageSupplierAdmission.js";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { getImageAdapter } from "open-sse/handlers/imageProviders/index.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { handleComboChat } from "open-sse/services/combo.js";
import * as log from "../utils/logger.js";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { randomUUID } from "node:crypto";
import { IMAGE_QUOTA_CONFIG } from "open-sse/config/imageQuotaConfig.js";
import { supportsImageEdit } from "open-sse/config/providerModels.js";
import {
  beginImageRequestAttempt,
  finishImageRequestAttempt,
  beginImageRequestSubmission,
  finishImageRequestSubmission,
  imageQuotaIdentity,
  imageQuotaIdentityGeneration,
} from "../../lib/db/repos/imageQuotaRepo.js";

// Providers that don't require credentials (noAuth)
const NO_AUTH_PROVIDERS = new Set(["sdwebui", "comfyui"]);
const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EDIT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_EDIT_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_EDIT_IMAGES = 4;
const EDIT_FORM_FIELDS = new Set([
  "model", "prompt", "n", "size", "quality", "style", "response_format", "output_format",
  "background", "image_detail", "aspect_ratio", "image_size", "max_output_tokens", "width",
  "height", "num_steps", "steps", "guidance", "strength", "output_compression", "partial_images", "user",
]);

function imageInputError(message, status = HTTP_STATUS.BAD_REQUEST) {
  return Object.assign(new Error(message), { status });
}

async function imageInputValue(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value.arrayBuffer !== "function") throw imageInputError("Image inputs must be image files or data strings.");
  const type = String(value.type || "").toLowerCase();
  if (!["image/png", "image/jpeg", "image/webp"].includes(type)) {
    throw imageInputError("Image files must be PNG, JPEG, or WebP.");
  }
  if (!Number.isSafeInteger(value.size) || value.size <= 0) throw imageInputError("Image files cannot be empty.");
  if (value.size > MAX_EDIT_IMAGE_BYTES) throw imageInputError("Each image file must be 10 MB or smaller.", HTTP_STATUS.CONTENT_TOO_LARGE);
  return `data:${type};base64,${Buffer.from(await value.arrayBuffer()).toString("base64")}`;
}

async function readImageRequestBody(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    try {
      const body = await request.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
      return body;
    } catch {
      throw imageInputError("Invalid JSON body");
    }
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_EDIT_REQUEST_BYTES) {
    throw imageInputError("Image edit request must be 32 MB or smaller.", HTTP_STATUS.CONTENT_TOO_LARGE);
  }

  // Count the stream too: chunked uploads do not have a trustworthy Content-Length.
  const chunks = [];
  let bytes = 0;
  const reader = request.body?.getReader();
  if (!reader) throw imageInputError("Missing multipart image edit body.");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_EDIT_REQUEST_BYTES) {
        await reader.cancel();
        throw imageInputError("Image edit request must be 32 MB or smaller.", HTTP_STATUS.CONTENT_TOO_LARGE);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let form;
  try { form = await new Response(Buffer.concat(chunks), { headers: { "content-type": contentType } }).formData(); }
  catch { throw imageInputError("Invalid multipart image edit body."); }
  const body = {};
  const images = [];
  let totalBytes = 0;
  for (const [name, value] of form.entries()) {
    if (name === "image" || name === "image[]") {
      if (images.length >= MAX_EDIT_IMAGES) throw imageInputError("At most four source images are supported.");
      const image = await imageInputValue(value);
      totalBytes += typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.size;
      if (totalBytes > MAX_EDIT_REQUEST_BYTES) throw imageInputError("Image edit inputs must total 32 MB or less.", HTTP_STATUS.CONTENT_TOO_LARGE);
      images.push(image);
    } else if (name === "mask") {
      if (Object.hasOwn(body, "mask_image")) throw imageInputError("Duplicate image edit mask.");
      const mask = await imageInputValue(value);
      totalBytes += typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.size;
      if (totalBytes > MAX_EDIT_REQUEST_BYTES) throw imageInputError("Image edit inputs must total 32 MB or less.", HTTP_STATUS.CONTENT_TOO_LARGE);
      body.mask_image = mask;
    } else if (typeof value === "string" && EDIT_FORM_FIELDS.has(name)) {
      if (Object.hasOwn(body, name)) throw imageInputError(`Duplicate image edit field: ${name}.`);
      body[name] = value;
    } else if (typeof value !== "string") {
      throw imageInputError(`Unsupported image edit file field: ${name}.`);
    }
  }
  if (images.length === 1) body.image = images[0];
  if (images.length > 1) body.images = images;
  for (const field of ["n", "max_output_tokens", "width", "height", "num_steps", "steps", "guidance", "strength", "output_compression", "partial_images"]) {
    if (body[field] !== undefined && body[field] !== "") {
      const value = Number(body[field]);
      if (!Number.isFinite(value)) throw imageInputError(`Invalid numeric image edit field: ${field}.`);
      body[field] = value;
    }
  }
  return body;
}

function hasImageReferences(body) {
  return (typeof body.image === "string" && Boolean(body.image.trim()))
    || (Array.isArray(body.images) && body.images.some((image) => typeof image === "string" && Boolean(image.trim())));
}

function traceFailureClass(status) {
  if (status === 401) return "authentication";
  if (status === 403) return "permission_or_model_access";
  if (status === 404) return "model_not_found";
  if (status === 408 || status === 504) return "provider_timeout";
  if (status === 429) return "rate_limited";
  if (Number.isInteger(status) && status >= 500 && status <= 599) return "provider_server_error";
  if (Number.isInteger(status) && status >= 400 && status <= 499) return "provider_rejected";
  return "outcome_unknown";
}

async function beginTraceAttempt(requestState, identity) {
  const attemptNumber = (Number(requestState.imageTraceAttemptNumber) || 0) + 1;
  requestState.imageTraceAttemptNumber = attemptNumber;
  if (attemptNumber > 1024) return null;
  try {
    await beginImageRequestAttempt({ ...identity, attemptNumber });
    return attemptNumber;
  } catch (error) {
    log.warn("IMAGE", `Attempt trace start failed: ${error?.code || error?.name || "error"}`);
    return null;
  }
}

function traceOutcomeWriter(routerRequestId, attemptNumber) {
  let completed = false;
  return async (outcome) => {
    if (!attemptNumber || completed) return;
    completed = true;
    try {
      await finishImageRequestAttempt({ routerRequestId, attemptNumber, ...outcome });
    } catch (error) {
      log.warn("IMAGE", `Attempt trace completion failed: ${error?.code || error?.name || "error"}`);
    }
  };
}

function startImageBookkeeping(task, label) {
  try {
    Promise.resolve(task()).catch((error) => {
      log.warn("IMAGE", `${label}: ${error?.code || error?.name || "error"}`);
    });
  } catch (error) {
    log.warn("IMAGE", `${label}: ${error?.code || error?.name || "error"}`);
  }
}

function completeUnknownTraceOnStreamEnd(response, finishTrace) {
  if (!response.body) {
    void finishTrace({ outcome: "outcome_unknown", failureClass: "outcome_unknown", fallbackAction: "reconcile_existing" });
    return response;
  }
  const reader = response.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          void finishTrace({ outcome: "outcome_unknown", failureClass: "outcome_unknown", fallbackAction: "reconcile_existing" });
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        void finishTrace({ outcome: "outcome_unknown", failureClass: "outcome_unknown", fallbackAction: "reconcile_existing" });
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally {
        void finishTrace({ outcome: "outcome_unknown", failureClass: "outcome_unknown", fallbackAction: "reconcile_existing" });
      }
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function createImageRequestBudget(clientSignal, timeoutMs) {
  const deadlineController = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  const timer = setTimeout(() => {
    deadlineController.abort(Object.assign(new Error("Image request deadline exceeded"), { code: "IMAGE_REQUEST_DEADLINE" }));
  }, timeoutMs);
  timer.unref?.();
  const signals = [deadlineController.signal, clientSignal].filter(Boolean);
  return {
    deadlineAt,
    deadlineSignal: deadlineController.signal,
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    dispose: () => clearTimeout(timer),
  };
}

function ensureImageRequestBudget(requestState, clientSignal) {
  if (!requestState.imageRequestBudget) {
    requestState.imageRequestBudget = createImageRequestBudget(clientSignal, IMAGE_QUOTA_CONFIG.requestTimeoutMs);
  }
  return requestState.imageRequestBudget;
}

function imageRequestAbortReason(requestState, clientSignal, internalSignal = null) {
  const budget = requestState?.imageRequestBudget;
  if (budget && (budget.deadlineSignal.aborted || Date.now() >= budget.deadlineAt)) return "deadline";
  if (clientSignal?.aborted || internalSignal?.aborted || budget?.signal?.aborted) return "cancelled";
  return null;
}

function imageRequestSignal(requestState, clientSignal, internalSignal = null) {
  const baseSignal = requestState?.imageRequestBudget?.signal || clientSignal;
  if (!internalSignal || internalSignal === baseSignal) return baseSignal;
  return baseSignal ? AbortSignal.any([baseSignal, internalSignal]) : internalSignal;
}

function imageRequestAbortResponse(requestState, requestId, model, clientSignal, internalSignal = null) {
  const reason = imageRequestAbortReason(requestState, clientSignal, internalSignal);
  if (!reason) return null;
  if (reason === "deadline") return imageDeadlineExceededResponse(requestId, model);
  return errorResponse(HTTP_STATUS.REQUEST_TIMEOUT, "Image request cancelled before the next provider submission.", {
    "X-9Router-Request-ID": requestId,
  });
}

function awaitImageRequestSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(Object.assign(new Error("Image request aborted"), { code: "IMAGE_REQUEST_ABORTED" }));
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(Object.assign(new Error("Image request aborted"), { code: "IMAGE_REQUEST_ABORTED" }));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

function finalizeImageRequestBudget(response, requestState) {
  const budget = requestState?.imageRequestBudget;
  if (!budget) return response;
  if (!response?.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    budget.dispose();
    return response;
  }

  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    budget.dispose();
  };
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { finish(); }
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function quotaErrorResponse(status, code, message, requestId, model, availability = {}) {
  const retryAt = typeof availability.retryAt === "string" ? availability.retryAt : null;
  const retryAtMs = retryAt ? Date.parse(retryAt) : NaN;
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "X-Request-ID": requestId,
    "X-9Router-Request-ID": requestId,
  };
  if (Number.isFinite(retryAtMs) && retryAtMs > Date.now()) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil((retryAtMs - Date.now()) / 1000)));
  }
  return new Response(JSON.stringify({ error: {
    code,
    message,
    request_id: requestId,
    router_request_id: requestId,
    model,
    availability_state: availability.state || "unknown",
    availability_source: availability.source || "unknown",
    retry_at: retryAt,
    availability_confidence: availability.confidence || "unknown",
    observed_at: availability.observedAt || new Date().toISOString(),
    retry_scope: availability.retryScope || "none",
  } }), { status, headers });
}

function imagePoolExhaustedResponse(requestId, model, availability) {
  return quotaErrorResponse(
    HTTP_STATUS.RATE_LIMITED,
    "image_pool_exhausted",
    "The selected image model is temporarily unavailable.",
    requestId,
    model,
    { ...availability, state: availability.state || "quota_blocked", retryScope: "new_request_after_check" },
  );
}

function imagePoolPausedResponse(requestId, model) {
  return quotaErrorResponse(
    HTTP_STATUS.SERVICE_UNAVAILABLE,
    "image_pool_paused",
    "Image generation is paused by an operator for the configured account pool.",
    requestId,
    model,
    { state: "manual_paused", confidence: "unknown", retryScope: "none" },
  );
}

function imageAttemptLimitResponse(requestId, model) {
  return quotaErrorResponse(
    HTTP_STATUS.SERVICE_UNAVAILABLE,
    "image_attempt_limit_reached",
    "The image request could not reach a ready account within the request retry limit.",
    requestId,
    model,
    { state: "attempt_limit_reached", retryScope: "none" },
  );
}

function imageAccountingUnavailableResponse(requestId, model) {
  return quotaErrorResponse(
    HTTP_STATUS.SERVICE_UNAVAILABLE,
    "image_accounting_unavailable",
    "Image request accounting is temporarily unavailable; no provider request was sent.",
    requestId,
    model,
    { state: "unavailable", confidence: "unknown", retryScope: "none" },
  );
}

function imageSupplierUnavailableResponse(requestId, model, exhausted = false) {
  return quotaErrorResponse(
    HTTP_STATUS.SERVICE_UNAVAILABLE,
    exhausted ? "image_supplier_budget_exhausted" : "image_supplier_budget_unavailable",
    exhausted ? "The image service spend limit has been reached."
      : "The image service spend configuration is unavailable.",
    requestId, model,
    { state: "unavailable", source: "local_policy", confidence: "unknown", retryScope: "none" },
  );
}

function imageDeadlineExceededResponse(requestId, model) {
  return quotaErrorResponse(
    HTTP_STATUS.REQUEST_TIMEOUT,
    "image_deadline_exceeded",
    "The image request exceeded its time budget before a result was available.",
    requestId,
    model,
    { state: "unknown", confidence: "unknown", retryScope: "new_request_after_check" },
  );
}

function imageRouteUnavailableResponse(requestId, model, availability = null) {
  return quotaErrorResponse(
    HTTP_STATUS.SERVICE_UNAVAILABLE,
    "image_route_unavailable",
    "The image route is temporarily unavailable.",
    requestId,
    model,
    availability || { state: "unknown", confidence: "unknown", retryScope: "none" },
  );
}

function imageProjectIdentityRequiredResponse(requestId, model) {
  return quotaErrorResponse(
    HTTP_STATUS.SERVICE_UNAVAILABLE,
    "image_project_identity_required",
    "Configure the Google Cloud project ID for the Gemini API key before routing image generation. Keys in one project share quota.",
    requestId,
    model,
    { state: "configuration_required", source: "router_configuration", confidence: "unknown", retryScope: "none" },
  );
}

function imageQuotaManagementDisabledResponse(requestId, model) {
  return quotaErrorResponse(
    HTTP_STATUS.SERVICE_UNAVAILABLE,
    "image_route_unavailable",
    "The image route is closed while image quota management is disabled.",
    requestId,
    model,
    { state: "unavailable", confidence: "unknown", retryScope: "none" },
  );
}

function imageOutcomeUnknownResponse(requestId, model) {
  return quotaErrorResponse(
    HTTP_STATUS.BAD_GATEWAY,
    "image_outcome_unknown",
    "The image service may have accepted this request. Check the existing operation before submitting it again.",
    requestId,
    model,
    { state: "outcome_unknown", retryScope: "reconcile_existing" },
  );
}

function withImageRequestHeaders(response, requestId, failover = false) {
  const headers = new Headers(response.headers);
  headers.set("X-9Router-Request-ID", requestId);
  if (failover) headers.set("X-Image-Quota-Failover", "true");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function releaseProbe(credentials, requestId, success = false) {
  const probe = credentials?._imageQuotaProbe;
  if (!probe?.rows?.length || !probe.owner) return Promise.resolve();
  return finishImageQuotaRecovery(credentials._connection || credentials, probe.rows, requestId, { success });
}

function rememberImageQuotaRejection(requestState, credentials, provider, model, observation) {
  const connection = credentials?._connection || credentials;
  if (!connection?.id || !provider || !observation?.quotaGroupId || !observation?.constraintId) return;
  const suppliedModels = Array.isArray(observation.appliesToModels)
    ? observation.appliesToModels.filter((value) => typeof value === "string" && value.length <= 256)
    : [];
  requestState.requestQuotaRejections ||= [];
  requestState.requestQuotaRejections.push({
    provider,
    identity: imageQuotaIdentity(connection),
    identityGeneration: imageQuotaIdentityGeneration(connection),
    quotaGroupId: observation.quotaGroupId,
    constraintId: observation.constraintId,
    appliesToModels: suppliedModels.length ? suppliedModels : [model],
    observation,
  });
}

function reserveImageProviderDispatch(requestState, provider, clientSignal, internalSignal = null) {
  const abortReason = imageRequestAbortReason(requestState, clientSignal, internalSignal);
  if (abortReason) return abortReason;
  const totalDispatches = Number(requestState.totalProviderDispatches) || 0;
  if (totalDispatches >= (requestState.submissionLimit || IMAGE_QUOTA_CONFIG.maxSubmissionsPerRequest)) return "attempt_limit";
  requestState.providerDispatchesByProvider ||= new Map();
  const dispatchCount = requestState.providerDispatchesByProvider.get(provider) || 0;
  if (dispatchCount >= (requestState.submissionLimit || IMAGE_QUOTA_CONFIG.maxSubmissionsPerRequest)) return "attempt_limit";
  requestState.providerDispatchesByProvider.set(provider, dispatchCount + 1);
  requestState.totalProviderDispatches = totalDispatches + 1;
  return null;
}

function recordImageRequestUsage({ provider, model, connectionId, apiKey, endpoint, usage }) {
  if (!usage || typeof usage !== "object") return;
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 0 ||
      !Number.isSafeInteger(completionTokens) || completionTokens < 0) {
    return;
  }

  try {
    Promise.resolve(saveRequestUsage({
      provider,
      model,
      connectionId: connectionId || undefined,
      apiKey: apiKey || undefined,
      endpoint: endpoint || null,
      tokens: usage,
      status: "success",
    })).catch(() => {});
  } catch {
    // Usage persistence is best-effort after a completed provider response.
  }
}

function imageRequestEntryPoint(endpoint, callType) {
  if (callType === "admin_model_sample") return callType;
  if (endpoint.endsWith("/images/edits")) return "images_edits";
  if (endpoint.endsWith("/images/generations")) return "images_generations";
  if (endpoint.endsWith("/responses")) return "responses";
  if (endpoint.endsWith("/chat/completions")) return "chat_completions";
  return "unknown";
}

/**
 * Handle image generation request
 * @param {Request} request
 */
export async function handleImageGeneration(request, { connectionId = null, singleSubmission = false } = {}) {
  let body;
  try {
    body = await readImageRequestBody(request);
  } catch (error) {
    return errorResponse(error?.status || HTTP_STATUS.BAD_REQUEST, error?.message || "Invalid image request body");
  }

  const url = new URL(request.url);
  const preferredConnectionId = connectionId || request.headers.get("x-connection-id") || null;
  const entryPoint = imageRequestEntryPoint(url.pathname, request.headers.get("x-hualogu-image-call-type"));
  const wantsStream = (request.headers.get("accept") || "").includes("text/event-stream");
  const binaryOutput = url.searchParams.get("response_format") === "binary";
  const modelStr = body.model;
  const quotaRequestId = randomUUID();
  const operationIdHeader = request.headers.get("x-hualogu-operation-id") || "";
  const clientOperationId = OPERATION_ID_RE.test(operationIdHeader) ? operationIdHeader : null;
  const quotaRequestState = {
    pinnedConnectionId: connectionId,
    submissionLimit: singleSubmission ? 1 : IMAGE_QUOTA_CONFIG.maxSubmissionsPerRequest,
    submissionsByProvider: new Map(),
    providerDispatchesByProvider: new Map(),
    totalProviderDispatches: 0,
    recoveryProbeClaimed: false,
    rejectedByRoute: new Map(),
    requestQuotaRejections: [],
    imageTraceAttemptNumber: 0,
    clientSignal: request.signal,
  };

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.prompt) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");
  if ((body.image != null && (typeof body.image !== "string" || !body.image.trim()))
    || (body.images != null && (!Array.isArray(body.images) || body.images.some((image) => typeof image !== "string" || !image.trim())))) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Source images must be non-empty image data strings or URLs.");
  }

  // Per-key access control: requested target, before combo expansion.
  const keyAccessDenied = await enforceKeyAccess(await getKeyAccessContext(request), modelStr);
  if (keyAccessDenied) return keyAccessDenied;

  try {
    quotaRequestState.supplierContext = await getImageSupplierContext(request);
  } catch {
    return imageSupplierUnavailableResponse(quotaRequestId, modelStr);
  }

  // Combo expansion: model may be a combo name → run fallback/round-robin across models
  const comboModels = connectionId ? null : await getComboModels(modelStr);
  try {
    let response;
    if (comboModels) {
      const comboStrategies = settings.comboStrategies || {};
      const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
      const comboStickyLimit = settings.comboStickyRoundRobinLimit;
      log.info("IMAGE", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      const comboResponse = await handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelImage(b, m, {
          wantsStream, binaryOutput, preferredConnectionId, apiKey, endpoint: url.pathname,
          quotaRequestId, quotaRequestState, clientSignal: request.signal, entryPoint,
          clientOperationId,
        }),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        preserveImageQuotaErrors: true,
      });
      response = withImageRequestHeaders(await comboResponse, quotaRequestId);
    } else {
      response = await handleSingleModelImage(body, modelStr, {
        wantsStream, binaryOutput, preferredConnectionId, apiKey, endpoint: url.pathname,
        quotaRequestId, quotaRequestState, clientSignal: request.signal, entryPoint,
        clientOperationId,
      });
    }
    return finalizeImageRequestBudget(response, quotaRequestState);
  } catch (error) {
    quotaRequestState.imageRequestBudget?.dispose();
    throw error;
  }
}

async function handleSingleModelImage(body, modelStr, {
  wantsStream,
  binaryOutput,
  preferredConnectionId,
  apiKey,
  endpoint,
  quotaRequestId,
  quotaRequestState,
  entryPoint,
  clientOperationId,
  clientSignal,
  internalExcludeConnectionIds,
  internalSignal,
} = {}) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) {
    return withImageRequestHeaders(errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format"), quotaRequestId);
  }

  const { provider, model } = modelInfo;
  const imageOperation = entryPoint === "images_edits" || hasImageReferences(body) ? "edit" : "generate";
  if (imageOperation === "edit" && !hasImageReferences(body)) {
    return withImageRequestHeaders(errorResponse(HTTP_STATUS.BAD_REQUEST, "An image edit requires at least one source image."), quotaRequestId);
  }
  if (imageOperation === "edit" && !supportsImageEdit(provider, model)) {
    return withImageRequestHeaders(errorResponse(HTTP_STATUS.BAD_REQUEST, "This model has no configured image-edit adapter. Choose a model marked for image editing."), quotaRequestId);
  }
  if (imageOperation === "edit" && !["gemini", "antigravity", "codex"].includes(provider)
    && (body.images?.length || 0) + (body.image ? 1 : 0) > 1) {
    return withImageRequestHeaders(errorResponse(HTTP_STATUS.BAD_REQUEST, "This image-edit adapter supports one source image per request."), quotaRequestId);
  }
  if (imageOperation === "edit" && !body.image && body.images?.length === 1) {
    body = { ...body, image: body.images[0], images: [] };
  }
  if (imageOperation === "edit" && ["gemini", "antigravity", "codex"].includes(provider)
    && (body.mask || body.mask_image || body.maskImage)) {
    return withImageRequestHeaders(errorResponse(HTTP_STATUS.BAD_REQUEST, "This image-edit adapter does not support masks."), quotaRequestId);
  }
  const routeKey = `${provider}/${model}`;
  const quotaProviderMapped = Boolean(IMAGE_QUOTA_CONFIG.providers[provider]);
  if (quotaRequestState?.supplierContext && !quotaProviderMapped) {
    return imageSupplierUnavailableResponse(quotaRequestId, body.model || modelStr);
  }
  if (quotaProviderMapped && !IMAGE_QUOTA_CONFIG.enabled) {
    // Keep a rollback fail-closed. Turning off quota management must not route
    // requests through the legacy image retry path or erase stored controls.
    return imageQuotaManagementDisabledResponse(quotaRequestId, body.model || modelStr);
  }
  quotaRequestState ||= {
    submissionsByProvider: new Map(),
    providerDispatchesByProvider: new Map(),
    totalProviderDispatches: 0,
    recoveryProbeClaimed: false,
    rejectedByRoute: new Map(),
    requestQuotaRejections: [],
    clientSignal,
  };
  quotaRequestState.rejectedByRoute ||= new Map();
  quotaRequestState.submissionsByProvider ||= new Map();
  quotaRequestState.providerDispatchesByProvider ||= new Map();
  quotaRequestState.requestQuotaRejections ||= [];
  quotaRequestState.imageTraceAttemptNumber ||= 0;
  let quotaRejected = quotaRequestState.rejectedByRoute.get(routeKey);
  if (!quotaRejected) {
    quotaRejected = new Map();
    quotaRequestState.rejectedByRoute.set(routeKey, quotaRejected);
  }

  // noAuth providers — no credential needed
  if (NO_AUTH_PROVIDERS.has(provider)) {
    const providerSignal = imageRequestSignal(quotaRequestState, clientSignal, internalSignal);
    const dispatchesBeforeAttempt = quotaRequestState.providerDispatchesByProvider.get(provider) || 0;
    let result;
    try {
      result = await handleImageGenerationCore({
        body,
        modelInfo: { provider, model },
        credentials: null,
        binaryOutput,
        signal: providerSignal,
        onProviderDispatch: () => reserveImageProviderDispatch(quotaRequestState, provider, clientSignal, internalSignal),
      });
    } catch (error) {
      const dispatchesAfterAttempt = quotaRequestState.providerDispatchesByProvider.get(provider) || 0;
      if (dispatchesAfterAttempt > dispatchesBeforeAttempt) {
        return withImageRequestHeaders(imageOutcomeUnknownResponse(quotaRequestId, body.model || modelStr), quotaRequestId);
      }
      throw error;
    }
    if (result.success) return withImageRequestHeaders(result.response, quotaRequestId);
    if (result.dispatchBlocked === "deadline") {
      return withImageRequestHeaders(imageDeadlineExceededResponse(quotaRequestId, body.model || modelStr), quotaRequestId);
    }
    if (result.dispatchBlocked === "attempt_limit") {
      return withImageRequestHeaders(imageAttemptLimitResponse(quotaRequestId, body.model || modelStr), quotaRequestId);
    }
    if (result.dispatchBlocked === "cancelled") {
      return withImageRequestHeaders(errorResponse(HTTP_STATUS.REQUEST_TIMEOUT, "Image request cancelled before provider dispatch."), quotaRequestId);
    }
    if (result.acceptance === "unknown") {
      return withImageRequestHeaders(imageOutcomeUnknownResponse(quotaRequestId, body.model || modelStr), quotaRequestId);
    }
    return withImageRequestHeaders(
      errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Image generation failed"),
      quotaRequestId,
    );
  }

  const retryQuota = resolveImageRouting(await getSettings(), provider, model, imageOperation)?.tryNextOnQuota !== false;

  // Credentialed providers — fallback loop
  const excludeConnectionIds = new Set(internalExcludeConnectionIds || []);
  const localCapacityBlocks = [];
  const localCapacityIdentities = new Set();
  const quotaProviderSupported = quotaProviderMapped;
  if (quotaProviderSupported) ensureImageRequestBudget(quotaRequestState, clientSignal);
  const quotaSubmissions = () => quotaRequestState.submissionsByProvider.get(provider) || 0;
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const abortedBeforeSelection = imageRequestAbortResponse(
      quotaRequestState,
      quotaRequestId,
      body.model || modelStr,
      clientSignal,
      internalSignal,
    );
    if (abortedBeforeSelection) return withImageRequestHeaders(abortedBeforeSelection, quotaRequestId);

    if (quotaProviderSupported && quotaSubmissions() >= (quotaRequestState.submissionLimit || IMAGE_QUOTA_CONFIG.maxSubmissionsPerRequest)) {
      try {
        const pool = await getImageQuotaPoolAvailability(provider, model, quotaRejected, quotaRequestState.requestQuotaRejections);
        if (pool.allBlocked) return imagePoolExhaustedResponse(quotaRequestId, body.model || modelStr, pool.state);
        if (pool.allPaused) return imagePoolPausedResponse(quotaRequestId, body.model || modelStr);
        if (pool.identityRequired) return withImageRequestHeaders(imageProjectIdentityRequiredResponse(quotaRequestId, body.model || modelStr), quotaRequestId);
        if (!pool.hasConnections) return imageRouteUnavailableResponse(quotaRequestId, body.model || modelStr);
      } catch (error) {
        log.warn("IMAGE", `Quota availability read failed: ${error?.code || error?.name || "error"}`);
        return imageRouteUnavailableResponse(quotaRequestId, body.model || modelStr);
      }
      return imageAttemptLimitResponse(quotaRequestId, body.model || modelStr);
    }

    let credentials;
    try {
      credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
        preferredConnectionId,
        imageOperation,
        capability: quotaProviderSupported ? "image_generation" : null,
        quotaRequestId,
        requestState: quotaRequestState,
        quotaRejected,
        requestQuotaRejections: quotaRequestState.requestQuotaRejections,
      });
    } catch (error) {
      log.warn("IMAGE", `Quota admission read failed: ${error?.code || error?.name || "error"}`);
      if (quotaProviderSupported) return imageRouteUnavailableResponse(quotaRequestId, body.model || modelStr);
      throw error;
    }

    const abortedAfterSelection = imageRequestAbortResponse(
      quotaRequestState,
      quotaRequestId,
      body.model || modelStr,
      clientSignal,
      internalSignal,
    );
    if (abortedAfterSelection) {
      try { await releaseProbe(credentials, quotaRequestId, false); } catch {}
      return withImageRequestHeaders(abortedAfterSelection, quotaRequestId);
    }

    if (credentials?.imageQuotaIdentityRequired) {
      return withImageRequestHeaders(imageProjectIdentityRequiredResponse(quotaRequestId, body.model || modelStr), quotaRequestId);
    }

    if (
      !credentials
      || credentials.allRateLimited
      || credentials.imageQuotaManualPaused
      || credentials.imageQuotaPolicyBlocked
      || credentials.imageQuotaProbeInProgress
    ) {
      if (credentials?.allRateLimited) {
        if (quotaProviderSupported && credentials.imageQuotaAvailability) {
          return imagePoolExhaustedResponse(quotaRequestId, body.model || modelStr, credentials.imageQuotaAvailability);
        }
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (credentials?.imageQuotaManualPaused) return imagePoolPausedResponse(quotaRequestId, body.model || modelStr);
      if (credentials?.imageQuotaPolicyBlocked) return imageRouteUnavailableResponse(quotaRequestId, body.model || modelStr, credentials.imageQuotaAvailability);
      if (credentials?.imageQuotaProbeInProgress) {
        return imageRouteUnavailableResponse(quotaRequestId, body.model || modelStr, credentials.imageQuotaAvailability);
      }
      if (excludeConnectionIds.size === 0) {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }
      if (quotaProviderSupported) {
        try {
          const pool = await getImageQuotaPoolAvailability(provider, model, quotaRejected, quotaRequestState.requestQuotaRejections);
          if (pool.allBlocked) return imagePoolExhaustedResponse(quotaRequestId, body.model || modelStr, pool.state);
          if (pool.allPaused) return imagePoolPausedResponse(quotaRequestId, body.model || modelStr);
          if (pool.identityRequired) return withImageRequestHeaders(imageProjectIdentityRequiredResponse(quotaRequestId, body.model || modelStr), quotaRequestId);
          if (!pool.hasConnections) return imageRouteUnavailableResponse(quotaRequestId, body.model || modelStr);
        } catch (error) {
          log.warn("IMAGE", `Quota availability read failed: ${error?.code || error?.name || "error"}`);
          return imageRouteUnavailableResponse(quotaRequestId, body.model || modelStr);
        }
        if (localCapacityBlocks.length) {
          const times = localCapacityBlocks.map((block) => block.retryAt).filter(Boolean).sort();
          return imageRouteUnavailableResponse(quotaRequestId, body.model || modelStr, {
            state: "local_capacity_limited", source: "local_policy", retryAt: times[0] || null,
            confidence: localCapacityBlocks.some((block) => !block.retryAt) ? "unknown" : "estimated",
            retryScope: "new_request_after_check",
          });
        }
        if (lastStatus === HTTP_STATUS.FORBIDDEN && lastError === "Account is not entitled to image generation") {
          return withImageRequestHeaders(
            errorResponse(HTTP_STATUS.FORBIDDEN, "No account entitled to image generation (ChatGPT Free plans are not supported)"),
            quotaRequestId,
          );
        }
        return imageAttemptLimitResponse(quotaRequestId, body.model || modelStr);
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    if (localCapacityIdentities.has(imageQuotaIdentity(credentials._connection || credentials))) {
      excludeConnectionIds.add(credentials.connectionId);
      continue;
    }
    let refreshedCredentials;
    try {
      refreshedCredentials = await awaitImageRequestSignal(
        checkAndRefreshToken(provider, credentials),
        imageRequestSignal(quotaRequestState, clientSignal, internalSignal),
      );
    } catch (error) {
      if (error?.code !== "IMAGE_REQUEST_ABORTED") throw error;
      try { await releaseProbe(credentials, quotaRequestId, false); } catch {}
      const aborted = imageRequestAbortResponse(quotaRequestState, quotaRequestId, body.model || modelStr, clientSignal, internalSignal);
      return aborted
        ? withImageRequestHeaders(aborted, quotaRequestId)
        : withImageRequestHeaders(errorResponse(HTTP_STATUS.REQUEST_TIMEOUT, "Image request cancelled before provider dispatch."), quotaRequestId);
    }

    const abortedAfterRefresh = imageRequestAbortResponse(
      quotaRequestState,
      quotaRequestId,
      body.model || modelStr,
      clientSignal,
      internalSignal,
    );
    if (abortedAfterRefresh) {
      try { await releaseProbe(credentials, quotaRequestId, false); } catch {}
      return withImageRequestHeaders(abortedAfterRefresh, quotaRequestId);
    }

    const imageAdapter = getImageAdapter(provider);
    if (imageAdapter?.canUseCredentials && !imageAdapter.canUseCredentials(refreshedCredentials)) {
      log.info("IMAGE", `Skipping ${provider} account without image-generation entitlement`);
      try { await releaseProbe(credentials, quotaRequestId, false); } catch {}
      excludeConnectionIds.add(credentials.connectionId);
      lastError = "Account is not entitled to image generation";
      lastStatus = HTTP_STATUS.FORBIDDEN;
      continue;
    }

    if (quotaProviderSupported) {
      let admission;
      try {
        admission = await admitImageQuotaRequest(credentials._connection || credentials, "image_generation", model, credentials._imageQuotaProbe?.owner || null);
      } catch (error) {
        log.warn("IMAGE", `Quota dispatch admission failed: ${error?.code || error?.name || "error"}`);
        return imageRouteUnavailableResponse(quotaRequestId, body.model || modelStr);
      }
      const abortedAfterAdmission = imageRequestAbortResponse(
        quotaRequestState,
        quotaRequestId,
        body.model || modelStr,
        clientSignal,
        internalSignal,
      );
      if (abortedAfterAdmission) {
        try { await releaseProbe(credentials, quotaRequestId, false); } catch {}
        return withImageRequestHeaders(abortedAfterAdmission, quotaRequestId);
      }
      if (!admission.allowed) {
        if (admission.reason === "manual_paused" || admission.reason === "quota_blocked"
          || admission.reason === "account_disabled" || admission.reason === "model_not_enabled") {
          excludeConnectionIds.add(credentials.connectionId);
          continue;
        }
        return imageRouteUnavailableResponse(quotaRequestId, body.model || modelStr);
      }
    }

    let supplierPrepared;
    try {
      supplierPrepared = prepareImageSupplierAdmission(quotaRequestState.supplierContext, {
        provider, model, connection: credentials._connection || credentials, body, operation: imageOperation,
      });
    } catch {
      try { await releaseProbe(credentials, quotaRequestId, false); } catch {}
      return imageSupplierUnavailableResponse(quotaRequestId, body.model || modelStr);
    }
    if (quotaProviderSupported) quotaRequestState.submissionsByProvider.set(provider, quotaSubmissions() + 1);

    const traceAttemptNumber = quotaProviderSupported
      ? await beginTraceAttempt(quotaRequestState, {
        routerRequestId: quotaRequestId,
        clientOperationId,
        provider,
        model,
        connectionId: credentials.connectionId || credentials._connection?.id,
        connection: credentials._connection || credentials,
        quotaGroupId: IMAGE_QUOTA_CONFIG.providers[provider].quotaGroupId,
      })
      : null;
    const finishTrace = traceOutcomeWriter(quotaRequestId, traceAttemptNumber);
    let localCapacityBlock = null;
    const onImageSubmissionStart = quotaProviderSupported ? async () => {
      try {
        return await beginImageRequestSubmission({
          routerRequestId: quotaRequestId,
          clientOperationId,
          attemptNumber: Number(traceAttemptNumber) || Number(quotaRequestState.imageTraceAttemptNumber) || 1,
          submissionNumber: Number(quotaRequestState.totalProviderDispatches) || 1,
          provider,
          requestedModel: modelStr,
          model,
          connectionId: credentials.connectionId || credentials._connection?.id,
          connection: credentials._connection || credentials,
          entryPoint: entryPoint || "unknown",
          operation: imageOperation,
          quotaGroupId: IMAGE_QUOTA_CONFIG.providers[provider].quotaGroupId,
          ...supplierPrepared.submission,
        });
      } catch (error) {
        if (error?.code === "IMAGE_LOCAL_CAPACITY") {
          localCapacityBlock = error.availability;
          return "local_capacity";
        }
        if (error?.code === "IMAGE_SUPPLIER_BUDGET_EXHAUSTED") return "supplier_budget_exhausted";
        if (error?.code === "IMAGE_SUPPLIER_BUDGET_UNAVAILABLE") return "supplier_budget_unavailable";
        log.warn("IMAGE", `Submission trace start failed: ${error?.code || error?.name || "error"}`);
        return "accounting_unavailable";
      }
    } : undefined;
    const onImageSubmissionResult = quotaProviderSupported
      ? (ticket, outcome) => finishImageRequestSubmission({ ...ticket, ...outcome })
      : undefined;
    const providerSignal = imageRequestSignal(quotaRequestState, clientSignal, internalSignal);
    const dispatchesBeforeAttempt = quotaRequestState.providerDispatchesByProvider.get(provider) || 0;
    const abortedBeforeDispatch = imageRequestAbortResponse(
      quotaRequestState,
      quotaRequestId,
      body.model || modelStr,
      clientSignal,
      internalSignal,
    );
    if (abortedBeforeDispatch) {
      if (quotaProviderSupported) {
        startImageBookkeeping(() => finishTrace({
          outcome: "provider_rejected",
          httpStatus: abortedBeforeDispatch.status,
          failureClass: abortedBeforeDispatch.status === HTTP_STATUS.REQUEST_TIMEOUT ? "provider_timeout" : "provider_rejected",
          fallbackAction: "terminal",
        }), "Attempt trace completion failed");
        try { await releaseProbe(credentials, quotaRequestId, false); } catch {}
      }
      return withImageRequestHeaders(abortedBeforeDispatch, quotaRequestId);
    }

    let result;
    try {
      result = await handleImageGenerationCore({
      body: supplierPrepared.body,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      streamToClient: wantsStream,
      binaryOutput,
      signal: providerSignal,
      onProviderDispatch: () => reserveImageProviderDispatch(quotaRequestState, provider, clientSignal, internalSignal),
      onImageSubmissionStart,
      onImageSubmissionResult,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active"
        });
      },
      onUsage: (usage) => {
        recordImageRequestUsage({
          provider,
          model,
          connectionId: credentials.connectionId,
          apiKey,
          endpoint,
          usage,
        });
      },
      onRequestSuccess: () => {
        startImageBookkeeping(
          () => finishTrace({ outcome: "succeeded", httpStatus: 200, fallbackAction: "success" }),
          "Attempt trace completion failed",
        );
        startImageBookkeeping(
          () => clearAccountError(credentials.connectionId, credentials, model),
          "Account cleanup after success failed",
        );
        if (refreshedCredentials.apiKey && refreshedCredentials.apiKey !== credentials.apiKey) {
          startImageBookkeeping(
            () => updateProviderCredentials(credentials.connectionId, { apiKey: refreshedCredentials.apiKey }),
            "Rotating image credential persistence failed",
          );
        }
        // For Codex SSE the core invokes this only after its final image event
        // is validated. Start lease completion without delaying the completed
        // image event; non-stream responses do the same after core validation.
        if (wantsStream && provider === "codex") {
          startImageBookkeeping(
            () => releaseProbe(credentials, quotaRequestId, true),
            "Quota probe completion could not be persisted",
          );
        }
      },
      onQuotaObservation: async (observation, streamState = {}) => {
        const willRetryStream = retryQuota && wantsStream && quotaProviderSupported && provider === "codex"
          && streamState.canRetry && !streamState.signal?.aborted && !streamState.isCancelled?.();
        await finishTrace({
          outcome: "quota_rejected",
          httpStatus: 429,
          failureClass: "image_quota",
          quotaGroupId: observation.quotaGroupId,
          constraintId: observation.constraintId,
          retryAt: observation.retryAt,
          confidence: observation.confidence,
          quotaObservations: observation.constraints || [observation],
          fallbackAction: willRetryStream ? "try_next_account" : "terminal",
        });
        quotaRejected.set(credentials.connectionId, observation);
        rememberImageQuotaRejection(quotaRequestState, credentials, provider, model, observation);
        try {
          await recordImageQuotaBlock(credentials._connection || credentials, observation, quotaRequestId, traceAttemptNumber);
        } catch (error) {
          log.warn("IMAGE", `Quota observation persistence failed: ${error?.code || error?.name || "error"}`);
        }
        try { await releaseProbe(credentials, quotaRequestId, false); } catch (error) {
          log.warn("IMAGE", `Quota probe release failed: ${error?.code || error?.name || "error"}`);
        }
        if (willRetryStream) {
          const nextExcluded = new Set(excludeConnectionIds);
          nextExcluded.add(credentials.connectionId);
          return handleSingleModelImage(body, modelStr, {
            wantsStream,
            binaryOutput,
            preferredConnectionId,
            apiKey,
            endpoint,
            quotaRequestId,
            quotaRequestState,
            clientOperationId,
            clientSignal,
            internalExcludeConnectionIds: nextExcluded,
            internalSignal: streamState.signal,
          });
        }
      },
      });
    } catch (error) {
      const dispatchesAfterAttempt = quotaRequestState.providerDispatchesByProvider.get(provider) || 0;
      if (dispatchesAfterAttempt > dispatchesBeforeAttempt) {
        if (quotaProviderSupported) {
          startImageBookkeeping(
            () => finishTrace({ outcome: "outcome_unknown", failureClass: "outcome_unknown", fallbackAction: "reconcile_existing" }),
            "Attempt trace completion failed",
          );
        }
        return withImageRequestHeaders(imageOutcomeUnknownResponse(quotaRequestId, body.model || modelStr), quotaRequestId);
      }
      if (quotaProviderSupported) {
        await finishTrace({
          outcome: "provider_rejected",
          httpStatus: HTTP_STATUS.BAD_GATEWAY,
          failureClass: "provider_rejected",
          fallbackAction: "terminal",
        });
        try { await releaseProbe(credentials, quotaRequestId, false); } catch {}
        return withImageRequestHeaders(errorResponse(HTTP_STATUS.BAD_GATEWAY, "Image request failed before provider dispatch."), quotaRequestId);
      }
      await finishTrace({ outcome: "outcome_unknown", failureClass: "outcome_unknown", fallbackAction: "reconcile_existing" });
      throw error;
    }

    if (result.dispatchBlocked) {
      if (quotaProviderSupported) {
        startImageBookkeeping(() => finishTrace({
          outcome: "provider_rejected",
          httpStatus: result.status,
          failureClass: result.dispatchBlocked === "deadline" ? "provider_timeout" : "provider_rejected",
          fallbackAction: "terminal",
        }), "Attempt trace completion failed");
        try { await releaseProbe(credentials, quotaRequestId, false); } catch {}
      }
      if (result.dispatchBlocked === "local_capacity" && localCapacityBlock) {
        localCapacityBlocks.push(localCapacityBlock);
        localCapacityIdentities.add(imageQuotaIdentity(credentials._connection || credentials));
        excludeConnectionIds.add(credentials.connectionId);
        continue;
      }
      if (result.dispatchBlocked === "deadline") {
        return withImageRequestHeaders(imageDeadlineExceededResponse(quotaRequestId, body.model || modelStr), quotaRequestId);
      }
      if (result.dispatchBlocked === "attempt_limit") {
        return withImageRequestHeaders(imageAttemptLimitResponse(quotaRequestId, body.model || modelStr), quotaRequestId);
      }
      if (result.dispatchBlocked === "accounting_unavailable") {
        return withImageRequestHeaders(imageAccountingUnavailableResponse(quotaRequestId, body.model || modelStr), quotaRequestId);
      }
      if (["supplier_budget_exhausted", "supplier_budget_unavailable"].includes(result.dispatchBlocked)) {
        return imageSupplierUnavailableResponse(quotaRequestId, body.model || modelStr,
          result.dispatchBlocked === "supplier_budget_exhausted");
      }
      return withImageRequestHeaders(
        errorResponse(HTTP_STATUS.REQUEST_TIMEOUT, "Image request cancelled before provider dispatch."),
        quotaRequestId,
      );
    }

    if (result.success) {
      const streamingResponse = result.response.headers.get("content-type")?.includes("text/event-stream");
      if (streamingResponse) {
        return withImageRequestHeaders(
          completeUnknownTraceOnStreamEnd(result.response, finishTrace),
          quotaRequestId,
          quotaProviderSupported && quotaRejected.size > 0,
        );
      }
      startImageBookkeeping(
        () => finishTrace({ outcome: "succeeded", httpStatus: result.response.status, fallbackAction: "success" }),
        "Attempt trace completion failed",
      );
      startImageBookkeeping(
        () => releaseProbe(credentials, quotaRequestId, true),
        "Quota probe completion could not be persisted",
      );
      return withImageRequestHeaders(
        result.response,
        quotaRequestId,
        quotaProviderSupported && quotaRejected.size > 0,
      );
    }

    if (result.quotaObservation && quotaProviderSupported) {
      await finishTrace({
        outcome: "quota_rejected",
        httpStatus: Number(result.status) || 429,
        failureClass: "image_quota",
        quotaGroupId: result.quotaObservation.quotaGroupId,
        constraintId: result.quotaObservation.constraintId,
        retryAt: result.quotaObservation.retryAt,
        confidence: result.quotaObservation.confidence,
        quotaObservations: result.quotaObservation.constraints || [result.quotaObservation],
        fallbackAction: retryQuota ? "try_next_account" : "terminal",
      });
      quotaRejected.set(credentials.connectionId, result.quotaObservation);
      rememberImageQuotaRejection(quotaRequestState, credentials, provider, model, result.quotaObservation);
      try {
        await recordImageQuotaBlock(credentials._connection || credentials, result.quotaObservation, quotaRequestId, traceAttemptNumber);
      } catch (error) {
        // A definite provider rejection remains excluded for this request. Do
        // not fail an otherwise deliverable fallback image because telemetry
        // persistence failed; later requests may rediscover this limit.
        log.warn("IMAGE", `Quota observation persistence failed: ${error?.code || error?.name || "error"}`);
      }
      try {
        await releaseProbe(credentials, quotaRequestId, false);
      } catch (error) {
        log.warn("IMAGE", `Quota probe release failed: ${error?.code || error?.name || "error"}`);
      }
      excludeConnectionIds.add(credentials.connectionId);
      lastError = "Image generation quota is temporarily limited";
      lastStatus = HTTP_STATUS.RATE_LIMITED;
      if (!retryQuota || quotaRequestState.submissionLimit === 1) {
        const payload = await result.response.clone().json().catch(() => ({}));
        const observation = result.quotaObservation;
        return withImageRequestHeaders(Response.json({...payload, error: {
          ...(payload.error && typeof payload.error === "object" ? payload.error : {}),
          retry_at: observation.retryAt || null,
          availability_source: observation.source || "unknown",
          availability_confidence: observation.confidence || "unknown",
          shared_image_quota: (observation.constraints || [observation]).some(row => row.appliesToModels?.includes("*")),
          quota_limit_hit: result.response.status === HTTP_STATUS.RATE_LIMITED,
        }}, {status: result.response.status}), quotaRequestId);
      }
      continue;
    }

    if (result.acceptance === "unknown") {
      // Keep a dispatched recovery reservation until its outcome is known.
      // Releasing it on timeout would admit another unverified probe.
      if (quotaProviderSupported) {
        startImageBookkeeping(
          () => finishTrace({ outcome: "outcome_unknown", httpStatus: result.status, failureClass: "outcome_unknown", fallbackAction: "reconcile_existing" }),
          "Attempt trace completion failed",
        );
      }
      return imageOutcomeUnknownResponse(quotaRequestId, body.model || modelStr);
    }

    try {
      await releaseProbe(credentials, quotaRequestId, false);
    } catch (error) {
      log.warn("IMAGE", `Quota probe release failed: ${error?.code || error?.name || "error"}`);
    }

    let shouldFallback;
    try {
      ({ shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model));
    } catch (error) {
      await finishTrace({ outcome: "provider_rejected", httpStatus: result.status, failureClass: traceFailureClass(result.status), fallbackAction: "terminal" });
      throw error;
    }

    if ((!retryQuota && Number(result.status) === 429) || quotaRequestState.submissionLimit === 1) {
      await finishTrace({ outcome: "provider_rejected", httpStatus: result.status, failureClass: traceFailureClass(result.status), fallbackAction: "terminal" });
      return withImageRequestHeaders(result.response, quotaRequestId);
    }

    if (shouldFallback) {
      await finishTrace({ outcome: "provider_rejected", httpStatus: result.status, failureClass: traceFailureClass(result.status), fallbackAction: "try_next_account" });
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    await finishTrace({ outcome: "provider_rejected", httpStatus: result.status, failureClass: traceFailureClass(result.status), fallbackAction: "terminal" });
    return withImageRequestHeaders(result.response, quotaRequestId);
  }
}
