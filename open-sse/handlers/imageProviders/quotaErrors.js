import { createHash } from "node:crypto";
import { IMAGE_QUOTA_CONFIG } from "../../config/imageQuotaConfig.js";

const MAX_RETRY_AT_MS = 365 * 24 * 60 * 60 * 1000;

function parseJson(text) {
  if (typeof text !== "string" || text.length > 128 * 1024) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseFutureTimestamp(value, now) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return Number.isSafeInteger(ms) && ms > now && ms <= now + MAX_RETRY_AT_MS ? ms : null;
  }
  if (typeof value !== "string" || value.length > 80) return null;
  const ms = Date.parse(value);
  return Number.isSafeInteger(ms) && ms > now && ms <= now + MAX_RETRY_AT_MS ? ms : null;
}

function parseRetryDelay(value, now) {
  if (typeof value !== "string" || value.length > 40) return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)s$/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return parseFutureTimestamp(now + Math.ceil(seconds * 1000), now);
}

function antigravityResetAt(error, providerResetAtMs, headers, now) {
  if (parseFutureTimestamp(providerResetAtMs, now)) return providerResetAtMs;
  const details = Array.isArray(error?.details) ? error.details.slice(0, 32) : [];
  for (const detail of details) {
    const metadata = detail?.metadata && typeof detail.metadata === "object" ? detail.metadata : {};
    const reset = parseFutureTimestamp(metadata.quotaResetTimeStamp, now);
    if (reset) return reset;
    const delay = parseRetryDelay(detail?.retryDelay, now);
    if (delay) return delay;
  }
  const header = headers?.get?.("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) {
      const reset = parseFutureTimestamp(now + Math.ceil(seconds * 1000), now);
      if (reset) return reset;
    }
    const reset = parseFutureTimestamp(header, now);
    if (reset) return reset;
  }
  return null;
}

const CODEX_IMAGE_LIMIT_IDS = new Set(["image_gen", "imagegen_premium"]);
export function isCodexImageUsageFailure(error) {
  return error?.type === "usage_limit_reached"
    || error?.type === "usageLimitExceeded" && CODEX_IMAGE_LIMIT_IDS.has(error.limitId);
}

function codexResetAt(error, providerResetAtMs, headers, now) {
  const explicit = parseFutureTimestamp(providerResetAtMs, now)
    || parseFutureTimestamp(error?.resets_at ?? error?.resetsAt, now);
  if (explicit) return {at:explicit,source:"codex_provider_reset"};
  const snapshot=error?.rate_limits;
  if(CODEX_IMAGE_LIMIT_IDS.has(snapshot?.limit_id)) {
    const resets=[snapshot.primary,snapshot.secondary].filter(window=>typeof window?.used_percent==='number' && Number.isFinite(window.used_percent) && window.used_percent>=100)
      .map(window=>parseFutureTimestamp(window.resets_at,now)).filter(Boolean);
    if(resets.length)return {at:Math.max(...resets),source:"codex_usage_window_reset"};
  }
  if (typeof error?.resets_in_seconds === "number" && Number.isFinite(error.resets_in_seconds) && error.resets_in_seconds > 0) {
    const reset = parseFutureTimestamp(now + Math.ceil(error.resets_in_seconds * 1000), now);
    if (reset) return {at:reset,source:"codex_provider_reset"};
  }
  const reset=retryAfterAt(headers,now);
  return reset?{at:reset,source:"provider_retry_after"}:null;
}

function retryAfterAt(headers, now) {
  const value = headers?.get?.("retry-after");
  if (typeof value !== "string" || value.length > 80) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return parseFutureTimestamp(now + Math.ceil(seconds * 1000), now);
  }
  return parseFutureTimestamp(value, now);
}

function zonedMidnightUtc(year, month, day, timeZone) {
  const targetWallTime = Date.UTC(year, month - 1, day, 0, 0, 0);
  let candidate = targetWallTime;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]));
    const localWallTime = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    candidate = targetWallTime - (localWallTime - candidate);
  }
  return candidate;
}

function nextPacificMidnight(now) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(now))
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
  const nextDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return zonedMidnightUtc(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, nextDate.getUTCDate(), "America/Los_Angeles");
}

function estimatedQuotaWindowMs(quotaId) {
  const match = String(quotaId || "").match(/per(\d*)(second|minute|hour)s?/i);
  if (!match) return null;
  const count = match[1] ? Number(match[1]) : 1;
  if (!Number.isSafeInteger(count) || count <= 0 || count > 10_000) return null;
  const unit = match[2].toLowerCase();
  const multiplier = unit === "second" ? 1_000 : unit === "minute" ? 60_000 : 60 * 60_000;
  return count * multiplier;
}

function geminiRetryAt({ quotaId, retryInfoDelay, providerResetAtMs, headers, now }) {
  if (/(?:per[_-]?day|daily)/i.test(quotaId)) {
    const resetAt = nextPacificMidnight(now);
    return { retryAtMs: resetAt, confidence: "provider_confirmed", source: "gemini_documented_daily_reset" };
  }
  const retryInfoAt = parseRetryDelay(retryInfoDelay, now);
  if (retryInfoAt) return { retryAtMs: retryInfoAt, confidence: "provider_confirmed", source: "provider_retry_info" };
  const providerReset = parseFutureTimestamp(providerResetAtMs, now) || retryAfterAt(headers, now);
  if (providerReset) return { retryAtMs: providerReset, confidence: "provider_confirmed", source: "provider_retry_after" };

  const windowMs = estimatedQuotaWindowMs(quotaId);
  if (windowMs) {
    const retryAtMs = parseFutureTimestamp(now + windowMs, now);
    if (retryAtMs) return { retryAtMs, confidence: "estimated", source: "gemini_quota_window_estimate" };
  }
  return {
    retryAtMs: now + IMAGE_QUOTA_CONFIG.unknownResetBackoffMs,
    confidence: "estimated",
    source: "unknown_quota_window_backoff",
  };
}

function normalizedModel(value) {
  return typeof value === "string" ? value.trim().replace(/^models\//i, "").slice(0, 256) : "";
}

function geminiConstraintId({ quotaId, quotaMetric, model, location }) {
  const quotaKey = String(quotaId || quotaMetric).slice(0, 256);
  const label = quotaKey.toLowerCase().replace(/[^a-z0-9._:-]+/g, "_").slice(0, 64) || "quota";
  const scope = [quotaId, quotaMetric, model, location].map((part) => String(part || "")).join("\n");
  const hash = createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 16);
  return `gemini:${label}:${hash}`;
}

function classifyGeminiImageQuota({ error, model, resetsAtMs, headers, now, mapping }) {
  const requestModel = normalizedModel(model);
  if (!requestModel) return null;
  const details = Array.isArray(error?.details) ? error.details.slice(0, 32) : [];
  const quotaFailures = details.filter((detail) =>
    typeof detail?.["@type"] === "string"
    && detail["@type"].endsWith(".QuotaFailure")
    && Array.isArray(detail.violations),
  );
  if (!quotaFailures.length) return null;

  const retryInfo = details.find((detail) =>
    typeof detail?.["@type"] === "string" && detail["@type"].endsWith(".RetryInfo"),
  );
  const violations = quotaFailures.flatMap((quotaFailure) => quotaFailure.violations.slice(0, 32)).slice(0, 32);
  const constraints = [];
  for (const violation of violations) {
    const quotaMetric = typeof violation?.quotaMetric === "string" ? violation.quotaMetric.trim().slice(0, 200) : "";
    if (!/^generativelanguage\.googleapis\.com\/[A-Za-z0-9_.-]{1,160}$/i.test(quotaMetric)) continue;
    const dimensions = violation?.quotaDimensions && typeof violation.quotaDimensions === "object"
      && !Array.isArray(violation.quotaDimensions) ? violation.quotaDimensions : {};
    const dimensionModel = normalizedModel(dimensions.model);
    if (dimensionModel && dimensionModel.toLowerCase() !== requestModel.toLowerCase()) continue;

    const quotaId = typeof violation?.quotaId === "string" ? violation.quotaId.trim().slice(0, 200) : "";
    const scopeModel = dimensionModel || (/per[_-]?model/i.test(quotaId) ? requestModel : null);
    const appliesToModels = scopeModel ? [scopeModel] : ["*"];
    const retry = geminiRetryAt({
      quotaId,
      retryInfoDelay: retryInfo?.retryDelay,
      providerResetAtMs: resetsAtMs,
      headers,
      now,
    });
    constraints.push({
      capability: mapping.capability,
      quotaGroupId: mapping.quotaGroupId,
      constraintId: geminiConstraintId({
        quotaId,
        quotaMetric,
        model: scopeModel || "*",
        location: dimensions.location,
      }),
      model: requestModel,
      appliesToModels,
      observedAt: new Date(now).toISOString(),
      retryAt: new Date(retry.retryAtMs).toISOString(),
      confidence: retry.confidence,
      source: retry.source,
    });
  }
  if (!constraints.length) return null;

  const uniqueConstraints = [...new Map(constraints.map((constraint) => [constraint.constraintId, constraint])).values()];
  const retryAt = uniqueConstraints.map((constraint) => constraint.retryAt).sort().at(-1);
  return {
    ...uniqueConstraints[0],
    appliesToModels: uniqueConstraints.some((constraint) => constraint.appliesToModels.includes("*"))
      ? ["*"]
      : [requestModel],
    retryAt,
    confidence: uniqueConstraints.some((constraint) => constraint.confidence !== "provider_confirmed")
      ? "estimated"
      : "provider_confirmed",
    constraints: uniqueConstraints,
  };
}

/**
 * Classify only provider responses whose known error shape proves a quota
 * rejection. The result is internal routing metadata; it contains no raw body,
 * account identifier, or credential.
 */
export function classifyImageQuotaError({ provider, status, bodyText, headers, resetsAtMs, model, now = Date.now() }) {
  if (!IMAGE_QUOTA_CONFIG.enabled) return null;
  const mapping = IMAGE_QUOTA_CONFIG.providers[provider];
  if (!mapping || !mapping.acceptedStatuses.includes(Number(status))) return null;

  const payload = parseJson(bodyText);
  const error = payload?.error && typeof payload.error === "object" && !Array.isArray(payload.error)
    ? payload.error
    : payload;

  let confirmed = false;
  let retryAtMs = null;
  let codexRetry=null;
  if (provider === "antigravity") {
    const providerStatus = String(error?.status || error?.code || "").toUpperCase();
    const details = Array.isArray(error?.details) ? error.details.slice(0, 32) : [];
    const hasQuotaDetail = details.some((detail) =>
      detail?.metadata?.quotaResetTimeStamp
      || detail?.metadata?.quotaMetric
      || detail?.metadata?.quotaLimit,
    );
    // Antigravity can return a detail-free RESOURCE_EXHAUSTED for request-shape
    // and prompt-filtering failures. Generic 429 wording also covers short
    // bursts. Neither is strong enough evidence for a durable account block.
    confirmed = providerStatus === "QUOTA_EXCEEDED"
      || (providerStatus === "RESOURCE_EXHAUSTED" && hasQuotaDetail)
      || hasQuotaDetail;
    if (!confirmed) return null;
    retryAtMs = antigravityResetAt(error, resetsAtMs, headers, now);
  } else if (provider === "codex") {
    confirmed = isCodexImageUsageFailure(error);
    if (!confirmed) return null;
    codexRetry = codexResetAt(error, resetsAtMs, headers, now);
    retryAtMs = codexRetry?.at || null;
  } else if (provider === "gemini") {
    if (String(error?.status || "").toUpperCase() !== "RESOURCE_EXHAUSTED"
      && Number(error?.code || payload?.code) !== 429) return null;
    return classifyGeminiImageQuota({ error, model, resetsAtMs, headers, now, mapping });
  }

  return {
    capability: mapping.capability,
    quotaGroupId: mapping.quotaGroupId,
    constraintId: provider === "codex" && CODEX_IMAGE_LIMIT_IDS.has(error?.limitId || error?.rate_limits?.limit_id) ? error.limitId || error.rate_limits.limit_id : mapping.constraintId,
    model: typeof model === "string" ? model.slice(0, 256) : null,
    appliesToModels: ["*"],
    observedAt: new Date(now).toISOString(),
    retryAt: new Date(retryAtMs || now + IMAGE_QUOTA_CONFIG.unknownResetBackoffMs).toISOString(),
    confidence: retryAtMs ? "provider_confirmed" : "estimated",
    source: provider === "codex" ? codexRetry?.source || "unknown_quota_window_backoff" : "provider_image_error",
  };
}
