import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { getExecutor } from "../executors/index.js";
import { getImageAdapter } from "./imageProviders/index.js";
import { hasUsableImagePayload, urlToBase64 } from "./imageProviders/_base.js";
import { classifyImageQuotaError } from "./imageProviders/quotaErrors.js";
import { IMAGE_QUOTA_CONFIG } from "../config/imageQuotaConfig.js";

function serializeRequestBody(requestBody) {
  if (typeof FormData !== "undefined" && requestBody instanceof FormData) return requestBody;
  if (typeof requestBody === "string") return requestBody;
  return JSON.stringify(requestBody);
}

async function notifyRequestSuccess(onRequestSuccess, log, signal) {
  if (!onRequestSuccess) return;
  const bookkeeping = Promise.resolve()
    .then(() => onRequestSuccess())
    .catch((error) => {
      // Provider success is already established. Account cleanup and quota
      // bookkeeping must never turn a completed image into a retryable failure.
      log?.warn?.("IMAGE", `Success bookkeeping failed: ${error?.code || error?.name || "error"}`);
    });
  if (!signal) {
    await bookkeeping;
    return;
  }
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = resolve;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try { await Promise.race([bookkeeping, aborted]); } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function awaitImageRequestSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) {
    return Promise.reject(Object.assign(new Error("Image request aborted"), { code: "IMAGE_REQUEST_ABORTED" }));
  }
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(Object.assign(new Error("Image request aborted"), { code: "IMAGE_REQUEST_ABORTED" }));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([Promise.resolve(promise), aborted])
    .finally(() => signal.removeEventListener("abort", onAbort));
}

function dispatchBlockReasonFromSignal(signal) {
  return signal?.reason?.code === "IMAGE_REQUEST_DEADLINE" ? "deadline" : "cancelled";
}

function acceptanceFromHttpStatus(status) {
  if (Number(status) === HTTP_STATUS.REQUEST_TIMEOUT) return "unknown";
  return Number(status) >= 400 && Number(status) < 500
    ? "rejected_before_acceptance"
    : "unknown";
}

function hasValidatedImageResult(provider, result) {
  return (provider !== "gemini" && !IMAGE_QUOTA_CONFIG.providers[provider]) || hasUsableImagePayload(result);
}

async function prepareImageSubmission(onProviderDispatch, onImageSubmissionStart) {
  const dispatchBlock = await onProviderDispatch?.();
  if (dispatchBlock) return { blocked: typeof dispatchBlock === "string" ? dispatchBlock : "attempt_limit" };
  const submission = await onImageSubmissionStart?.();
  if (typeof submission === "string") return { blocked: submission };
  if (submission?.blockedReason) return { blocked: submission.blockedReason };
  return { ticket: submission || null };
}

function finishImageSubmission(onImageSubmissionResult, ticket, result, log) {
  if (!ticket || !onImageSubmissionResult) return Promise.resolve(false);
  return Promise.resolve()
    .then(() => onImageSubmissionResult(ticket, result))
    .then((persisted) => persisted === true)
    .catch((error) => {
      // Provider response handling remains authoritative if diagnostic finalization fails.
      log?.warn?.("IMAGE", `Submission accounting update failed: ${error?.code || error?.name || "error"}`);
      return false;
    });
}

function providerRequestId(response) {
  const value = response?.headers?.get?.("x-request-id")
    || response?.headers?.get?.("request-id")
    || response?.headers?.get?.("x-goog-request-id");
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(value) ? value : null;
}

function invalidImageResult(provider) {
  return createErrorResult(
    HTTP_STATUS.BAD_GATEWAY,
    `${provider} returned no usable image`,
    null,
    null,
    { acceptance: "unknown" },
  );
}

function imageDispatchBlockedResult(reason) {
  const deadlineExceeded = reason === "deadline";
  const cancelled = reason === "cancelled";
  const status = deadlineExceeded || cancelled ? HTTP_STATUS.REQUEST_TIMEOUT : HTTP_STATUS.SERVICE_UNAVAILABLE;
  const message = deadlineExceeded
    ? "The image request exceeded its time budget before a result was available."
    : cancelled
      ? "The image request was cancelled before the next provider submission."
      : reason === "accounting_unavailable"
        ? "Image submission accounting is temporarily unavailable; no provider request was sent."
        : "The image request reached its configured provider submission limit.";
  return createErrorResult(status, message, null, null, {
    acceptance: "rejected_before_acceptance",
    dispatchBlocked: reason,
  });
}

/**
 * Core image generation handler — orchestrator only.
 * Provider-specific URL/headers/body/parse/normalize live in `./imageProviders/{id}.js`.
 *
 * @param {object} options
 * @param {object} options.body - Request body { model, prompt, n, size, ... }
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {object} [options.log] - Logger
 * @param {boolean} [options.streamToClient] - Pipe SSE to client (codex)
 * @param {boolean} [options.binaryOutput] - Return raw image bytes
 * @param {function} [options.onCredentialsRefreshed]
 * @param {function} [options.onRequestSuccess]
 * @param {function} [options.onUsage] - Receives exact provider-reported usage when available
 * @returns {Promise<{ success: boolean, response: Response, status?: number, error?: string }>}
 */
export async function handleImageGenerationCore({
  body,
  modelInfo,
  credentials,
  log,
  streamToClient = false,
  binaryOutput = false,
  onCredentialsRefreshed,
  onRequestSuccess,
  onUsage,
  onQuotaObservation,
  onProviderDispatch,
  onImageSubmissionStart,
  onImageSubmissionResult,
  signal,
}) {
  const { provider, model } = modelInfo;

  if (!body.prompt) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");
  }

  const adapter = getImageAdapter(provider);
  if (!adapter) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' does not support image generation`
    );
  }

  // Executor-delegating adapters: skip manual URL/headers/body, use the proven executor flow
  if (adapter.useExecutor && adapter.executeViaExecutor) {
    let submissionTicket = null;
    let responseRequestId = null;
    try {
      log?.debug?.("IMAGE", `${provider.toUpperCase()} | ${model} | prompt="${body.prompt.slice(0, 50)}..." (executor)`);
      const executed = await adapter.executeViaExecutor(model, body, credentials, log, signal, {
        onProviderDispatch,
        onImageSubmissionStart,
        onImageSubmissionResult: (ticket, result) => finishImageSubmission(onImageSubmissionResult, ticket, result, log),
      });
      const responseBody = executed?.imageSubmissionResult === true ? executed.body : executed;
      submissionTicket = executed?.imageSubmissionResult === true ? executed.submissionTicket : null;
      responseRequestId = executed?.imageSubmissionResult === true ? executed.providerRequestId : null;
      const normalized = adapter.normalize(responseBody, body.prompt);
      const finalBody = (normalized.created && Array.isArray(normalized.data)) ? normalized : responseBody;
      if (!hasValidatedImageResult(provider, finalBody)) {
        await finishImageSubmission(onImageSubmissionResult, submissionTicket, {
          outcome: "outcome_unknown",
          httpStatus: 200,
          failureClass: "outcome_unknown",
          providerRequestId: responseRequestId,
        }, log);
        return invalidImageResult(provider);
      }

      const usage = executed?.imageSubmissionResult === true ? executed.usage : null;
      if (usage && onUsage) {
        try { await onUsage(usage); } catch (error) {
          log?.warn?.("IMAGE", `Usage recording failed: ${error?.code || error?.name || "error"}`);
        }
      }
      const outputCount = Array.isArray(finalBody.data) ? finalBody.data.length : 1;

      if (binaryOutput) {
        const first = finalBody.data?.[0];
        let b64 = first?.b64_json;
        if (!b64 && first?.url) {
          try { b64 = await urlToBase64(first.url); } catch {}
        }
        if (b64) {
          const buf = Buffer.from(b64, "base64");
          const fmt = (body.output_format || "png").toLowerCase();
          const mime = fmt === "jpeg" || fmt === "jpg" ? "image/jpeg" : fmt === "webp" ? "image/webp" : "image/png";
          const result = {
            success: true,
            response: new Response(buf, {
              headers: { "Content-Type": mime, "Content-Disposition": `inline; filename="image.${fmt === "jpeg" ? "jpg" : fmt}"`, "Access-Control-Allow-Origin": "*" },
            }),
          };
          await finishImageSubmission(onImageSubmissionResult, submissionTicket, {
            outcome: "succeeded", httpStatus: 200, outputCount, usage, providerRequestId: responseRequestId,
          }, log);
          await notifyRequestSuccess(onRequestSuccess, log, signal);
          return result;
        }
        if (IMAGE_QUOTA_CONFIG.providers[provider]) return invalidImageResult(provider);
      }

      const result = {
        success: true,
        response: new Response(JSON.stringify(finalBody), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        }),
      };
      await finishImageSubmission(onImageSubmissionResult, submissionTicket, {
        outcome: "succeeded", httpStatus: 200, outputCount, usage, providerRequestId: responseRequestId,
      }, log);
      await notifyRequestSuccess(onRequestSuccess, log, signal);
      return result;
    } catch (error) {
      if (error?.imageDispatchBlocked) return imageDispatchBlockedResult(error.imageDispatchBlocked);
      const quotaObservation = classifyImageQuotaError({
        provider,
        status: error?.status,
        bodyText: error?.bodyText,
        headers: error?.headers,
        resetsAtMs: error?.resetsAtMs,
        model,
      });
      if (quotaObservation) {
        await finishImageSubmission(onImageSubmissionResult, error?.submissionTicket || submissionTicket, {
          outcome: "quota_rejected",
          httpStatus: Number(error.status) || HTTP_STATUS.RATE_LIMITED,
          failureClass: "image_quota",
          quotaGroupId: quotaObservation.quotaGroupId,
          constraintId: quotaObservation.constraintId,
          retryAt: quotaObservation.retryAt,
          confidence: quotaObservation.confidence,
          quotaObservations: quotaObservation.constraints || [quotaObservation],
          providerRequestId: error?.providerRequestId || responseRequestId,
        }, log);
        return createErrorResult(
          Number(error.status),
          "Image generation account quota reached",
          error.resetsAtMs,
          null,
          { quotaObservation, acceptance: "rejected_before_acceptance" },
        );
      }
      const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
      log?.debug?.("IMAGE", `Executor error: ${errMsg}`);
      const status = Number(error?.status) || HTTP_STATUS.BAD_GATEWAY;
      const accepted = acceptanceFromHttpStatus(status);
      await finishImageSubmission(onImageSubmissionResult, error?.submissionTicket || submissionTicket, {
        outcome: accepted === "unknown" ? "outcome_unknown" : "provider_rejected",
        httpStatus: status,
        failureClass: accepted === "unknown" ? "outcome_unknown" : status === 401 ? "authentication" : status === 403 ? "permission_or_model_access" : "provider_rejected",
        providerRequestId: error?.providerRequestId || responseRequestId,
      }, log);
      return createErrorResult(status, errMsg, error?.resetsAtMs, null, {
        acceptance: accepted,
      });
    }
  }

  let url;
  let headers;
  let requestBody;

  try {
    url = adapter.buildUrl(model, credentials, body);
    requestBody = await adapter.buildBody(model, body);
    headers = adapter.buildHeaders(credentials, requestBody, model, body);
  } catch (error) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, error.message || `Invalid ${provider} image request`);
  }

  log?.debug?.("IMAGE", `${provider.toUpperCase()} | ${model} | prompt="${body.prompt.slice(0, 50)}..."`);

  const initialDispatch = await prepareImageSubmission(onProviderDispatch, onImageSubmissionStart);
  if (initialDispatch.blocked) return imageDispatchBlockedResult(initialDispatch.blocked);
  let submissionTicket = initialDispatch.ticket;

  let providerResponse;
  try {
    providerResponse = await fetch(url, {
      method: "POST",
      headers,
      body: serializeRequestBody(requestBody),
      signal,
    });
  } catch (error) {
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    log?.debug?.("IMAGE", `Fetch error: ${errMsg}`);
    finishImageSubmission(onImageSubmissionResult, submissionTicket, {
      outcome: "outcome_unknown", failureClass: "outcome_unknown",
    }, log);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg, null, null, { acceptance: "unknown" });
  }

  // Handle 401/403 — try token refresh (skipped for noAuth providers)
  const executor = getExecutor(provider);
  if (
    !executor?.noAuth &&
    !adapter.noAuth &&
    (providerResponse.status === HTTP_STATUS.UNAUTHORIZED ||
      providerResponse.status === HTTP_STATUS.FORBIDDEN)
  ) {
    finishImageSubmission(onImageSubmissionResult, submissionTicket, {
      outcome: "provider_rejected",
      httpStatus: providerResponse.status,
      failureClass: providerResponse.status === HTTP_STATUS.UNAUTHORIZED ? "authentication" : "permission_or_model_access",
      providerRequestId: providerRequestId(providerResponse),
    }, log);
    submissionTicket = null;
    let retryWasDispatched = false;
    try {
      const newCredentials = await awaitImageRequestSignal(
        Promise.resolve().then(() => refreshWithRetry(
          () => executor.refreshCredentials(credentials, log),
          3,
          log,
        )),
        signal,
      );

      if (newCredentials?.accessToken || newCredentials?.apiKey) {
        log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed for image generation`);
        Object.assign(credentials, newCredentials);
        if (onCredentialsRefreshed) {
          await awaitImageRequestSignal(
            Promise.resolve().then(() => onCredentialsRefreshed(newCredentials)),
            signal,
          );
        }

        const retryBody = await awaitImageRequestSignal(
          Promise.resolve().then(() => adapter.buildBody(model, body)),
          signal,
        );
        const retryHeaders = adapter.buildHeaders(credentials, retryBody, model, body);
        const retryUrl = adapter.buildUrl(model, credentials, body);
        const retryDispatch = await prepareImageSubmission(onProviderDispatch, onImageSubmissionStart);
        if (retryDispatch.blocked) return imageDispatchBlockedResult(retryDispatch.blocked);
        submissionTicket = retryDispatch.ticket;
        retryWasDispatched = true;
        providerResponse = await fetch(retryUrl, {
          method: "POST",
          headers: retryHeaders,
          body: serializeRequestBody(retryBody),
          signal,
        });
      } else {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
      }
    } catch (error) {
      if (retryWasDispatched) {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | refreshed image submission outcome unknown`);
        finishImageSubmission(onImageSubmissionResult, submissionTicket, {
          outcome: "outcome_unknown", failureClass: "outcome_unknown",
        }, log);
        return createErrorResult(
          HTTP_STATUS.BAD_GATEWAY,
          "Image submission after token refresh has an unknown outcome",
          null,
          null,
          { acceptance: "unknown" },
        );
      }
      if (error?.code === "IMAGE_REQUEST_ABORTED") {
        return imageDispatchBlockedResult(dispatchBlockReasonFromSignal(signal));
      }
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`);
    }
  }

  if (!providerResponse.ok) {
    const { statusCode, message, resetsAtMs } = await parseUpstreamError(providerResponse.clone(), executor);
    const bodyText = await providerResponse.text().catch(() => "");
    const quotaObservation = classifyImageQuotaError({
      provider,
      status: statusCode,
      bodyText,
      headers: providerResponse.headers,
      resetsAtMs,
      model,
    });
    if (quotaObservation) {
      await finishImageSubmission(onImageSubmissionResult, submissionTicket, {
        outcome: "quota_rejected",
        httpStatus: statusCode,
        failureClass: "image_quota",
        quotaGroupId: quotaObservation.quotaGroupId,
        constraintId: quotaObservation.constraintId,
        retryAt: quotaObservation.retryAt,
        confidence: quotaObservation.confidence,
        quotaObservations: quotaObservation.constraints || [quotaObservation],
        providerRequestId: providerRequestId(providerResponse),
      }, log);
      return createErrorResult(
        statusCode,
        "Image generation account quota reached",
        resetsAtMs,
        null,
        { quotaObservation, acceptance: "rejected_before_acceptance" },
      );
    }
    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    log?.debug?.("IMAGE", `Provider error: ${errMsg}`);
    const acceptance = acceptanceFromHttpStatus(statusCode);
    finishImageSubmission(onImageSubmissionResult, submissionTicket, {
      outcome: acceptance === "unknown" ? "outcome_unknown" : "provider_rejected",
      httpStatus: statusCode,
      failureClass: acceptance === "unknown" ? "outcome_unknown"
        : statusCode === HTTP_STATUS.UNAUTHORIZED ? "authentication"
          : statusCode === HTTP_STATUS.FORBIDDEN ? "permission_or_model_access"
            : statusCode === HTTP_STATUS.RATE_LIMITED ? "rate_limited"
              : statusCode >= 500 ? "provider_server_error" : "provider_rejected",
      providerRequestId: providerRequestId(providerResponse),
    }, log);
    return createErrorResult(statusCode, errMsg, resetsAtMs, null, {
      acceptance,
    });
  }

  // Parse provider response — adapter may override (codex SSE / async polling / binary)
  let parsed;
  let capturedUsage = null;
  const reportUsage = async (usage) => {
    capturedUsage = usage;
    return onUsage?.(usage);
  };
  try {
    if (adapter.parseResponse) {
      parsed = await adapter.parseResponse(providerResponse, {
        headers,
        log,
        streamToClient,
        onRequestSuccess,
        onUsage: reportUsage,
        onQuotaObservation: async (observation, streamState = {}) => {
          return await onQuotaObservation?.(observation, { ...streamState, submissionTicket });
        },
        onImageSubmissionResult: (ticket, result) => finishImageSubmission(onImageSubmissionResult, ticket, result, log),
        submissionTicket,
        providerRequestId: providerRequestId(providerResponse),
        url,
        requestBody,
        model,
        body,
        signal,
      });
      // Codex streaming case: returns an SSE Response directly
      if (parsed?.sseResponse) {
        return { success: true, response: parsed.sseResponse };
      }
    } else {
      parsed = await providerResponse.json();
    }
  } catch (parseError) {
    const quotaObservation = classifyImageQuotaError({
      provider,
      status: parseError?.status,
      bodyText: parseError?.bodyText,
      headers: parseError?.headers,
      resetsAtMs: parseError?.resetsAtMs,
      model,
    });
    if (quotaObservation) {
      await finishImageSubmission(onImageSubmissionResult, submissionTicket, {
        outcome: "quota_rejected",
        httpStatus: Number(parseError.status) || HTTP_STATUS.RATE_LIMITED,
        failureClass: "image_quota",
        quotaGroupId: quotaObservation.quotaGroupId,
        constraintId: quotaObservation.constraintId,
        retryAt: quotaObservation.retryAt,
        confidence: quotaObservation.confidence,
        quotaObservations: quotaObservation.constraints || [quotaObservation],
        providerRequestId: providerRequestId(providerResponse),
      }, log);
      return createErrorResult(
        Number(parseError.status),
        "Image generation account quota reached",
        parseError.resetsAtMs,
        null,
        { quotaObservation, acceptance: "rejected_before_acceptance" },
      );
    }
    const acceptance = parseError?.acceptance || acceptanceFromHttpStatus(parseError?.status ?? providerResponse.status);
    finishImageSubmission(onImageSubmissionResult, submissionTicket, {
      outcome: acceptance === "unknown" ? "outcome_unknown" : "provider_rejected",
      httpStatus: Number(parseError?.status) || providerResponse.status,
      failureClass: acceptance === "unknown" ? "outcome_unknown" : "provider_rejected",
      providerRequestId: providerRequestId(providerResponse),
    }, log);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, parseError.message || `Invalid response from ${provider}`, null, null, {
      acceptance,
    });
  }

  // Normalize → OpenAI-compatible shape
  const normalized = adapter.normalize(parsed, body.prompt);

  // Already in OpenAI shape? skip re-normalize
  const finalBody = (normalized.created && Array.isArray(normalized.data)) ? normalized : parsed;
  if (!hasValidatedImageResult(provider, finalBody)) {
    finishImageSubmission(onImageSubmissionResult, submissionTicket, {
      outcome: "outcome_unknown",
      httpStatus: providerResponse.status,
      failureClass: "outcome_unknown",
      providerRequestId: providerRequestId(providerResponse),
      usage: capturedUsage,
    }, log);
    return invalidImageResult(provider);
  }
  const outputCount = Array.isArray(finalBody.data) ? finalBody.data.length : 1;
  finishImageSubmission(onImageSubmissionResult, submissionTicket, {
    outcome: "succeeded",
    httpStatus: providerResponse.status,
    outputCount,
    usage: capturedUsage,
    providerRequestId: providerRequestId(providerResponse),
  }, log);

  // Binary output: decode first b64_json (or fetch url) into raw bytes
  if (binaryOutput) {
    const first = finalBody.data?.[0];
    let b64 = first?.b64_json;
    if (!b64 && first?.url) {
      try { b64 = await urlToBase64(first.url); } catch {}
    }
    if (b64) {
      const buf = Buffer.from(b64, "base64");
      const fmt = (body.output_format || "png").toLowerCase();
      const mime = fmt === "jpeg" || fmt === "jpg" ? "image/jpeg" : fmt === "webp" ? "image/webp" : "image/png";
      const result = {
        success: true,
        response: new Response(buf, {
          headers: {
            "Content-Type": mime,
            "Content-Disposition": `inline; filename="image.${fmt === "jpeg" ? "jpg" : fmt}"`,
            "Access-Control-Allow-Origin": "*",
          },
        }),
      };
      await notifyRequestSuccess(onRequestSuccess, log, signal);
      return result;
    }
    if (IMAGE_QUOTA_CONFIG.providers[provider]) return invalidImageResult(provider);
  }

  const result = {
    success: true,
    response: new Response(JSON.stringify(finalBody), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
  await notifyRequestSuccess(onRequestSuccess, log, signal);
  return result;
}
