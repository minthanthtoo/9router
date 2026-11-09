import {readImageLearningScope} from "./imageLearningScope.js";
import { estimateImageQuotaLearning, imageQuotaWaitSource } from "../../../sse/services/imageQuotaLearning.js";
import { IMAGE_QUOTA_CONFIG, imagePolicyApplies } from "../../../../open-sse/config/imageQuotaConfig.js";
import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import {
  imageQuotaAccountReference,
  imageQuotaIdentity,
  imageQuotaIdentityGeneration,
  imageQuotaIdentityType,
} from "./imageQuotaIdentity.js";
import { imageQuotaLearningPredictionChecks, recordImageQuotaLearningPrediction } from "./imageQuotaLearningPrediction.js";
export { imageQuotaAccountReference, imageQuotaIdentity, imageQuotaIdentityGeneration, imageQuotaIdentityType } from "./imageQuotaIdentity.js";

const DURABLE_DRIVERS = new Set(["better-sqlite3", "node:sqlite", "bun:sqlite"]);
const IMAGE_REQUEST_TRACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_REQUEST_USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const IMAGE_REQUEST_TRACE_MAX_ROWS = 128;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRACE_OUTCOMES = new Set([
  "in_flight",
  "succeeded",
  "quota_rejected",
  "provider_rejected",
  "outcome_unknown",
]);
const TRACE_FAILURE_CLASSES = new Set([
  "image_quota",
  "authentication",
  "permission_or_model_access",
  "model_not_found",
  "rate_limited",
  "provider_timeout",
  "provider_server_error",
  "provider_rejected",
  "outcome_unknown",
]);
const TRACE_FALLBACK_ACTIONS = new Set([
  "pending",
  "try_next_account",
  "terminal",
  "reconcile_existing",
  "success",
]);
const RETRY_SOURCES = new Set(["codex_provider_reset", "codex_usage_window_reset", "provider_retry_info", "provider_retry_after", "gemini_documented_daily_reset", "gemini_quota_window_estimate", "unknown_quota_window_backoff", "provider_image_error"]);
function traceRetrySource(observations, retryAt) {
 const rows = parseJson(observations, []);
 return Array.isArray(rows) ? rows.find(row => row.retryAt === retryAt && RETRY_SOURCES.has(row.source))?.source : undefined;
}
const TRACE_CONFIDENCE = new Set(["provider_confirmed", "estimated", "unknown"]);
const IMAGE_REQUEST_ENTRY_POINTS = new Set([
  "images_generations",
  "images_edits",
  "responses",
  "chat_completions",
  "admin_model_sample",
  "unknown",
]);
const IMAGE_REQUEST_OPERATIONS = new Set(["generate", "edit"]);

export class ImageQuotaStoreUnavailableError extends Error {
  constructor(message = "Image quota state requires a native SQLite driver") {
    super(message);
    this.name = "ImageQuotaStoreUnavailableError";
    this.code = "IMAGE_QUOTA_STORE_UNAVAILABLE";
  }
}

export class ImageSupplierBudgetError extends Error {
  constructor(code, details = {}) {
    super(code === "IMAGE_SUPPLIER_BUDGET_EXHAUSTED"
      ? "Image supplier spend budget is exhausted"
      : "Image supplier spend budget is unavailable");
    this.name = "ImageSupplierBudgetError";
    this.code = code;
    this.details = details;
  }
}

function requireDurableAdapter(db) {
  if (!DURABLE_DRIVERS.has(db?.driver)) throw new ImageQuotaStoreUnavailableError();
}

function safeMicroUsd(value, allowZero = false) {
  return Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1);
}

function canonicalUtc(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safePriceShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowed = new Set(["model", "operation", "outputCount", "resolution", "quality", "inputUnits", "outputUnits"]);
  const shape = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) return null;
    if (typeof item === "string" && item.length <= 80) shape[key] = item;
    else if (Number.isSafeInteger(item) && item >= 0) shape[key] = item;
    else return null;
  }
  if (!shape.model || !["generate", "edit"].includes(shape.operation) || !safeMicroUsd(shape.outputCount)) return null;
  const json = stringifyJson(shape);
  return json.length <= 1024 ? json : null;
}

function safeAdd(left, right) {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) throw new ImageSupplierBudgetError("IMAGE_SUPPLIER_BUDGET_UNAVAILABLE");
  return total;
}

function acquireImageAdmissionLock(db) {
  const result = db.run("UPDATE imageQuotaAdmissionState SET revision = revision + 1 WHERE id = 1");
  if (Number(result?.changes) !== 1) throw new ImageSupplierBudgetError("IMAGE_SUPPLIER_BUDGET_UNAVAILABLE");
}

function exposureCharge(row) {
  const reserved = Number(row.reservedMaxMicrousd);
  if (!safeMicroUsd(reserved, true)) throw new ImageSupplierBudgetError("IMAGE_SUPPLIER_BUDGET_UNAVAILABLE");
  if (row.state === "open") return reserved;
  if (row.state === "provisional") {
    if (row.calculatedMicrousd != null && !safeMicroUsd(Number(row.calculatedMicrousd), true)) {
      throw new ImageSupplierBudgetError("IMAGE_SUPPLIER_BUDGET_UNAVAILABLE");
    }
    return Math.max(reserved, row.calculatedMicrousd == null ? 0 : Number(row.calculatedMicrousd));
  }
  if (row.state === "confirmed") {
    if (row.billedMicrousd == null || !safeMicroUsd(Number(row.billedMicrousd), true)) {
      throw new ImageSupplierBudgetError("IMAGE_SUPPLIER_BUDGET_UNAVAILABLE");
    }
    return Number(row.billedMicrousd);
  }
  return 0;
}

function supplierBudgetObligation(db, budget, day, month) {
  const rows = db.all(
    `SELECT state, reservedMaxMicrousd, calculatedMicrousd, billedMicrousd, dispatchDay, dispatchMonth,
            pilotId, currency, scale
     FROM imageSupplierExposureAllocations WHERE budgetId = ?`, [budget.id],
  );
  let daily = 0;
  let monthly = 0;
  let pilot = 0;
  for (const row of rows) {
    if (row.pilotId !== budget.pilotId || row.currency !== "USD" || Number(row.scale) !== 6
      || !/^\d{4}-\d\d-\d\d$/.test(row.dispatchDay) || row.dispatchMonth !== row.dispatchDay.slice(0, 7)) {
      throw new ImageSupplierBudgetError("IMAGE_SUPPLIER_BUDGET_UNAVAILABLE", { budgetId: budget.id });
    }
    const amount = exposureCharge(row);
    if (row.state === "open" || row.state === "provisional" || row.state === "confirmed") {
      pilot = safeAdd(pilot, amount);
      if (row.state === "open" || row.dispatchDay === day) daily = safeAdd(daily, amount);
      if (row.state === "open" || row.dispatchMonth === month) monthly = safeAdd(monthly, amount);
    }
  }
  return { daily, monthly, pilot };
}

function validateBudgetScope(db, budgetScope, estimate, pricingVersion, pricingDigest, priceShape, now, submission) {
  const installationId = boundedText(budgetScope?.installationBudgetId, 120);
  const projectId = boundedText(budgetScope?.projectBudgetId, 120);
  const serializedShape = safePriceShape(priceShape);
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(installationId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(projectId)
    || installationId === projectId
    || !safeMicroUsd(estimate) || !boundedText(pricingVersion, 120)
    || !/^[a-f0-9]{64}$/i.test(String(pricingDigest || "")) || !serializedShape
    || !submission.supplierIdentity || priceShape.model !== submission.model || priceShape.operation !== submission.operation) {
    throw new ImageSupplierBudgetError("IMAGE_SUPPLIER_BUDGET_UNAVAILABLE");
  }

  const day = now.slice(0, 10);
  const month = day.slice(0, 7);
  const requested = [
    { id: installationId, scopeType: "installation" },
    { id: projectId, scopeType: "billing_project" },
  ];
  const budgets = requested.map(({ id, scopeType }) => {
    const budget = db.get("SELECT * FROM imageSupplierBudgets WHERE id = ?", [id]);
    if (!budget || budget.scopeType !== scopeType || Number(budget.enabled) !== 1
      || (scopeType === "billing_project" && budget.scopeKey !== submission.supplierIdentity)
      || budget.currency !== "USD" || Number(budget.scale) !== 6
      || budget.pricingPolicyVersion !== boundedText(pricingVersion, 120)
      || !canonicalUtc(budget.pilotStartsAt) || !canonicalUtc(budget.pilotEndsAt)
      || Date.parse(now) < Date.parse(budget.pilotStartsAt) || Date.parse(now) >= Date.parse(budget.pilotEndsAt)) {
      throw new ImageSupplierBudgetError("IMAGE_SUPPLIER_BUDGET_UNAVAILABLE", { budgetId: id });
    }
    const limits = [budget.dailyLimitMicrousd, budget.monthlyLimitMicrousd, budget.pilotLimitMicrousd, budget.maxSubmissionMicrousd];
    if (limits.some((limit) => !safeMicroUsd(Number(limit), true))) {
      throw new ImageSupplierBudgetError("IMAGE_SUPPLIER_BUDGET_UNAVAILABLE", { budgetId: id });
    }
    const obligation = supplierBudgetObligation(db, budget, day, month);
    if (estimate > Number(budget.maxSubmissionMicrousd)) {
      throw new ImageSupplierBudgetError("IMAGE_SUPPLIER_BUDGET_EXHAUSTED", {
        budgetId: id, limitType: "max_submission", currentObligation: estimate,
        limit: Number(budget.maxSubmissionMicrousd),
      });
    }
    for (const [limitType, currentObligation, limit] of [
      ["daily", obligation.daily, Number(budget.dailyLimitMicrousd)],
      ["monthly", obligation.monthly, Number(budget.monthlyLimitMicrousd)],
      ["pilot", obligation.pilot, Number(budget.pilotLimitMicrousd)],
    ]) {
      if (safeAdd(currentObligation, estimate) > limit) {
        throw new ImageSupplierBudgetError("IMAGE_SUPPLIER_BUDGET_EXHAUSTED", {
          budgetId: id, limitType, currentObligation, limit,
        });
      }
    }
    return budget;
  });
  return { budgets, serializedShape, day, month, estimate, pricingVersion: boundedText(pricingVersion, 120), pricingDigest: String(pricingDigest).toLowerCase() };
}

function addExposureAdjustment(db, allocation, nextState, evidence, now) {
  const revision = Number(allocation.revision) + 1;
  const result = db.run(
    `UPDATE imageSupplierExposureAllocations
     SET state = ?, calculatedMicrousd = ?, billedMicrousd = ?, revision = ?, updatedAt = ?
     WHERE submissionId = ? AND budgetId = ? AND revision = ?`,
    [nextState, evidence.calculatedMicrousd ?? allocation.calculatedMicrousd,
      evidence.billedMicrousd ?? allocation.billedMicrousd, revision, now,
      allocation.submissionId, allocation.budgetId, allocation.revision],
  );
  if (Number(result?.changes) !== 1) throw new ImageSupplierBudgetError("IMAGE_SUPPLIER_BUDGET_UNAVAILABLE");
  db.run(
    `INSERT INTO imageSupplierExposureAdjustments
      (id, submissionId, budgetId, allocationRevision, evidenceSource, evidenceReference, evidenceDigest,
       observedAt, principal, previousState, nextState, previousCalculatedMicrousd, nextCalculatedMicrousd,
       previousBilledMicrousd, nextBilledMicrousd, reason, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), allocation.submissionId, allocation.budgetId, revision, evidence.evidenceSource,
      evidence.evidenceReference, evidence.evidenceDigest || null, evidence.observedAt,
      evidence.principal || "system", allocation.state, nextState,
      allocation.calculatedMicrousd ?? null, evidence.calculatedMicrousd ?? allocation.calculatedMicrousd ?? null,
      allocation.billedMicrousd ?? null, evidence.billedMicrousd ?? allocation.billedMicrousd ?? null,
      evidence.reason || null, now],
  );
  return revision;
}

function boundedText(value, max = 200) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function safeProviderUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "reasoning_tokens", "cached_tokens"]) {
    const count = value[key];
    if (Number.isSafeInteger(count) && count >= 0) usage[key] = count;
  }
  for (const key of ["prompt_tokens_details", "completion_tokens_details"]) {
    if (!Array.isArray(value[key])) continue;
    usage[key] = value[key].slice(0, 8).flatMap((detail) => {
      if (!detail || typeof detail !== "object" || Array.isArray(detail)) return [];
      const safe = {};
      const modality = typeof detail.modality === "string" ? detail.modality.toUpperCase() : null;
      const tokenCount = detail.token_count ?? detail.tokens;
      if (["TEXT", "IMAGE", "AUDIO", "VIDEO", "OTHER"].includes(modality)) safe.modality = modality;
      if (Number.isSafeInteger(tokenCount) && tokenCount >= 0) safe.token_count = tokenCount;
      return Object.keys(safe).length ? [safe] : [];
    });
  }
  return Object.keys(usage).length ? usage : null;
}

function safeProviderRequestId(value) {
  const requestId = boundedText(value, 160);
  return /^[A-Za-z0-9._:-]{1,160}$/.test(requestId) ? requestId : null;
}

function imageQuotaIdentityAliases(connection) {
  const canonical = imageQuotaIdentity(connection);
  const local = `connection:${boundedText(connection?.id, 160)}`;
  return canonical === local ? [local] : [canonical, local];
}

function imageQuotaProbeRows(connection, rows) {
  const identities = imageQuotaIdentityAliases(connection);
  const generation = imageQuotaIdentityGeneration(connection);
  const unique = new Map();
  for (const row of rows || []) {
    if (row.provider !== connection.provider || !identities.includes(row.supplierIdentity)
      || (row.supplierIdentity !== identities.at(-1) && Number(row.identityGeneration) !== generation)
      || !row.quotaGroupId || !row.constraintId) {
      throw new TypeError("Image quota probe scope does not match its connection");
    }
    unique.set(JSON.stringify([row.supplierIdentity, row.identityGeneration, row.quotaGroupId, row.constraintId]), row);
  }
  return [...unique.values()];
}

function rowApplies(row, capability, model) {
  if (row.capability !== capability) return false;
  const models = parseJson(row.appliesToModels, []);
  return Array.isArray(models) && (models.includes("*") || !model || models.includes(model));
}

function isExpired(row, nowMs) {
  if (!row.retryAt) return false;
  const retryMs = Date.parse(row.retryAt);
  return Number.isFinite(retryMs) && retryMs <= nowMs;
}

function storedImageQuotaObservations(attempt) {
  const stored = parseJson(attempt.quotaObservations, null);
  const rows = Array.isArray(stored) ? stored : attempt.quotaGroupId && attempt.constraintId
    ? [{
        quotaGroupId: attempt.quotaGroupId,
        constraintId: attempt.constraintId,
        model: attempt.model,
        appliesToModels: [attempt.model],
        retryAt: attempt.retryAt,
        confidence: attempt.confidence,
      }]
    : [];
  return rows.flatMap((row) => {
    const quotaGroupId = boundedText(row?.quotaGroupId, 120);
    const constraintId = boundedText(row?.constraintId, 120);
    if (!quotaGroupId || !constraintId) return [];
    const suppliedModels = Array.isArray(row.appliesToModels)
      ? row.appliesToModels.filter((value) => typeof value === "string" && value.length > 0 && value.length <= 256).slice(0, 32)
      : [];
    const model = boundedText(row.model, 256) || boundedText(attempt.model, 256);
    const retryAt = row.retryAt && Number.isFinite(Date.parse(row.retryAt))
      ? new Date(row.retryAt).toISOString()
      : null;
    return [{
      quotaGroupId,
      constraintId,
      model,
      appliesToModels: suppliedModels.length ? [...new Set(suppliedModels)] : [model],
      retryAt,
      confidence: TRACE_CONFIDENCE.has(row.confidence) ? row.confidence : "unknown",
      resolved: row.resolved === true,
    }];
  });
}

function markImageQuotaAttemptResolved(db, attempt, constraints, now) {
  const keys = new Set((constraints || []).map((row) => JSON.stringify([row.quotaGroupId, row.constraintId])));
  const observations = storedImageQuotaObservations(attempt).map((row) =>
    !keys.size || keys.has(JSON.stringify([row.quotaGroupId, row.constraintId]))
      ? { ...row, resolved: true }
      : row,
  );
  if (!observations.length) return;
  db.run(
    `UPDATE imageQuotaRequestAttempts SET quotaObservations = ?, quotaLockResolvedAt = ?, updatedAt = ?
     WHERE id = ? AND quotaLockResolvedAt IS NULL`,
    [stringifyJson(observations), observations.every((row) => row.resolved) ? now : null, now, attempt.id],
  );
}

function markImageQuotaSubmissionResolved(db, submission, constraints, now) {
  const keys = new Set((constraints || []).map((row) => JSON.stringify([row.quotaGroupId, row.constraintId])));
  const observations = storedImageQuotaObservations(submission).map((row) =>
    !keys.size || keys.has(JSON.stringify([row.quotaGroupId, row.constraintId]))
      ? { ...row, resolved: true }
      : row,
  );
  if (!observations.length) return;
  db.run(
    `UPDATE imageQuotaRequestSubmissions SET quotaObservations = ?, quotaLockResolvedAt = ?, updatedAt = ?
     WHERE id = ? AND quotaLockResolvedAt IS NULL`,
    [stringifyJson(observations), observations.every((row) => row.resolved) ? now : null, now, submission.id],
  );
}

function safeTraceQuotaObservations(observations, fallback, model) {
  const rows = Array.isArray(observations) && observations.length ? observations : [fallback];
  return rows.flatMap((row) => {
    const quotaGroupId = /^[A-Za-z0-9._:-]{1,120}$/.test(String(row?.quotaGroupId || "")) ? row.quotaGroupId : null;
    const constraintId = /^[A-Za-z0-9._:-]{1,120}$/.test(String(row?.constraintId || "")) ? row.constraintId : null;
    if (!quotaGroupId || !constraintId) return [];
    const suppliedModels = Array.isArray(row.appliesToModels)
      ? row.appliesToModels.filter((value) => typeof value === "string" && value.length > 0 && value.length <= 256).slice(0, 32)
      : [];
    const retryAt = row.retryAt && Number.isFinite(Date.parse(row.retryAt))
      ? new Date(row.retryAt).toISOString()
      : null;
    return [{
      quotaGroupId,
      constraintId,
      model: boundedText(row.model, 256) || model,
      appliesToModels: suppliedModels.length ? [...new Set(suppliedModels)] : [model],
      retryAt,
      confidence: TRACE_CONFIDENCE.has(row.confidence) ? row.confidence : "unknown",
      source: RETRY_SOURCES.has(row.source) ? row.source : null,
      resolved: false,
    }];
  });
}

function admissionQuotaFallbackEntries(db) {
  const state = db.get("SELECT quotaObservations FROM imageQuotaAdmissionState WHERE id = 1");
  // A malformed entry may be the only durable quota lock; never drop it as an empty state.
  const entries = parseJson(state?.quotaObservations, null);
  if (!Array.isArray(entries) || !entries.every((row) =>
    row && typeof row === "object" && UUID_RE.test(String(row.id || ""))
      && /^[a-z0-9_-]{1,80}$/.test(String(row.provider || ""))
      && boundedText(row.supplierIdentity, 256)
      && Number.isSafeInteger(Number(row.identityGeneration)) && Number(row.identityGeneration) > 0
      && /^[A-Za-z0-9._:-]{1,120}$/.test(String(row.quotaGroupId || ""))
      && /^[A-Za-z0-9._:-]{1,120}$/.test(String(row.constraintId || ""))
      && row.capability === "image_generation",
  )) {
    throw new ImageQuotaStoreUnavailableError("Image quota admission state is missing or invalid");
  }
  return entries;
}

function admissionQuotaRecords(db, provider) {
  return admissionQuotaFallbackEntries(db).filter((row) => row.provider === provider).map((row) => ({
    ...row,
    completedAt: row.observedAt,
    quotaObservations: stringifyJson([{
      quotaGroupId: row.quotaGroupId,
      constraintId: row.constraintId,
      model: row.model,
      appliesToModels: row.appliesToModels,
      retryAt: row.retryAt,
      confidence: row.confidence,
      resolved: false,
    }]),
    revision: Number(row.revision) || 1,
    quotaRecordSource: "admission",
  }));
}

function removeAdmissionQuotaFallbacks(db, scopes) {
  const keys = new Map((scopes || []).map((row) => [JSON.stringify([
    row.provider, row.supplierIdentity, Number(row.identityGeneration), row.quotaGroupId, row.constraintId,
  ]), row]));
  if (!keys.size) return;
  const entries = admissionQuotaFallbackEntries(db);
  const unresolved = entries.filter((row) => {
    const scope = keys.get(JSON.stringify([
      row.provider, row.supplierIdentity, Number(row.identityGeneration), row.quotaGroupId, row.constraintId,
    ]));
    const expectedRevision = scope?.fallbackAdmissionRevisions?.[row.id];
    return !scope || (scope.fallbackAdmissionRevisions && expectedRevision === undefined)
      || (expectedRevision !== undefined && Number(expectedRevision) !== Number(row.revision));
  });
  if (unresolved.length !== entries.length) {
    db.run("UPDATE imageQuotaAdmissionState SET quotaObservations = ? WHERE id = 1", [stringifyJson(unresolved)]);
  }
}

function persistAdmissionQuotaFallback(db, connection, observations, requestId) {
  const identity = imageQuotaIdentity(connection);
  const generation = imageQuotaIdentityGeneration(connection);
  const now = new Date().toISOString();
  const safeObservations = safeTraceQuotaObservations(
    observations,
    observations[0],
    boundedText(observations[0]?.model, 256),
  );
  db.transaction(() => {
    db.run("UPDATE imageQuotaAdmissionState SET revision = revision + 1 WHERE id = 1");
    const entries = admissionQuotaFallbackEntries(db);
    const byKey = new Map(entries.map((row) => [JSON.stringify([
      row.provider, row.supplierIdentity, Number(row.identityGeneration), row.quotaGroupId, row.constraintId,
    ]), row]));
    for (const observation of safeObservations) {
      const key = JSON.stringify([
        connection.provider, identity, generation, observation.quotaGroupId, observation.constraintId,
      ]);
      let current = byKey.get(key);
      const canonical = db.get(
        `SELECT retryAt, confidence FROM imageQuotaConstraints
         WHERE provider = ? AND supplierIdentity = ? AND identityGeneration = ? AND quotaGroupId = ? AND constraintId = ? AND state = 'blocked'`,
        [connection.provider, identity, generation, observation.quotaGroupId, observation.constraintId],
      );
      if (canonical) {
        const canonicalResetMs = Date.parse(canonical.retryAt);
        const currentResetMs = Date.parse(current?.retryAt);
        const keepCanonicalReset = !current || (
          (Number.isFinite(canonicalResetMs) && Number.isFinite(currentResetMs) && canonicalResetMs > currentResetMs)
          || (!Number.isFinite(canonicalResetMs) && current?.confidence !== "provider_confirmed")
        );
        current = {
          ...(current || {}),
          retryAt: keepCanonicalReset ? canonical.retryAt : current?.retryAt,
          confidence: keepCanonicalReset ? canonical.confidence : current?.confidence,
        };
      }
      const currentResetMs = Date.parse(current?.retryAt);
      const reportedResetMs = Date.parse(observation.retryAt);
      const keepCurrentReset = current && (
        (Number.isFinite(currentResetMs) && Number.isFinite(reportedResetMs) && currentResetMs > reportedResetMs)
        || (!Number.isFinite(currentResetMs) && observation.confidence !== "provider_confirmed")
      );
      byKey.set(key, {
        id: current?.id || randomUUID(),
        provider: connection.provider,
        supplierIdentity: identity,
        identityGeneration: generation,
        capability: "image_generation",
        quotaGroupId: observation.quotaGroupId,
        constraintId: observation.constraintId,
        model: observation.model,
        appliesToModels: observation.appliesToModels,
        retryAt: keepCurrentReset ? current.retryAt : observation.retryAt,
        confidence: keepCurrentReset ? current.confidence : observation.confidence,
        observedAt: now,
        source: "quota_admission_state_fallback",
        requestId: boundedText(requestId, 120),
        revision: (Number(current?.revision) || 0) + 1,
      });
    }
    db.run("UPDATE imageQuotaAdmissionState SET quotaObservations = ? WHERE id = 1", [stringifyJson([...byKey.values()])]);
  });
}

function mergeImageQuotaRows(rows, quotaRecords, connection, capability, model) {
  const identities = imageQuotaIdentityAliases(connection);
  const generation = imageQuotaIdentityGeneration(connection);
  const matchesIdentity = (row) => identities.includes(row.supplierIdentity)
    && (row.supplierIdentity === identities.at(-1) || Number(row.identityGeneration) === generation);
  const merged = new Map((rows || [])
    .filter((row) => matchesIdentity(row) && rowApplies(row, capability, model))
    .map((row) => [JSON.stringify([row.supplierIdentity, row.identityGeneration, row.quotaGroupId, row.constraintId]), {
      ...row,
      fallbackAttemptIds: [],
      fallbackSubmissionIds: [],
      fallbackAdmissionIds: [],
      fallbackAdmissionRevisions: {},
    }]));

  for (const record of quotaRecords || []) {
    if (!matchesIdentity(record)) continue;
    for (const observation of storedImageQuotaObservations(record).filter((row) => !row.resolved)) {
      const quota = {
        provider: record.provider,
        supplierIdentity: record.supplierIdentity,
        identityGeneration: Number(record.identityGeneration) || generation,
        capability: "image_generation",
        quotaGroupId: observation.quotaGroupId,
        constraintId: observation.constraintId,
      };
      if (!rowApplies({ ...quota, appliesToModels: stringifyJson(observation.appliesToModels) }, capability, model)) continue;
      const key = JSON.stringify([quota.supplierIdentity, quota.identityGeneration, quota.quotaGroupId, quota.constraintId]);
      const observedAt = record.completedAt || record.startedAt || record.dispatchedAt;
      const observedMs = Date.parse(observedAt);
      let current = merged.get(key);
      if (!current) {
        current = {
          ...quota,
          observedModel: observation.model || record.model,
          appliesToModels: stringifyJson(observation.appliesToModels),
          state: "blocked",
          confidence: observation.confidence === "provider_confirmed" ? "provider_confirmed" : "estimated",
          observedAt,
          retryAt: observation.retryAt,
          source: record.quotaRecordSource === "submission" ? "quota_submission_fallback"
            : record.quotaRecordSource === "admission" ? "quota_admission_state_fallback" : "quota_attempt_trace_fallback",
          revision: Number(record.revision) || 1,
          updatedAt: observedAt,
          fallbackAttemptIds: [],
          fallbackSubmissionIds: [],
          fallbackAdmissionIds: [],
          fallbackAdmissionRevisions: {},
        };
        merged.set(key, current);
      } else if (!current.observedAt || !Number.isFinite(observedMs) || observedMs >= Date.parse(current.observedAt)) {
        const currentResetMs = Date.parse(current.retryAt);
        const reportedResetMs = Date.parse(observation.retryAt);
        const keepCurrentReset = current.state === "blocked" && (
          (Number.isFinite(currentResetMs) && Number.isFinite(reportedResetMs) && currentResetMs > reportedResetMs)
          || (!Number.isFinite(currentResetMs) && observation.confidence !== "provider_confirmed")
        );
        if (!keepCurrentReset) {
          current.retryAt = observation.retryAt;
          current.confidence = observation.confidence === "provider_confirmed" ? "provider_confirmed" : "estimated";
        }
        current.observedModel = observation.model || record.model;
        current.appliesToModels = stringifyJson(observation.appliesToModels);
        current.observedAt = observedAt;
        current.updatedAt = observedAt;
      }
      const fallbackIds = record.quotaRecordSource === "submission" ? current.fallbackSubmissionIds
        : record.quotaRecordSource === "admission" ? current.fallbackAdmissionIds : current.fallbackAttemptIds;
      if (!fallbackIds.includes(record.id)) fallbackIds.push(record.id);
      if (record.quotaRecordSource === "admission") {
        current.fallbackAdmissionRevisions[record.id] = Number(record.revision) || 1;
      }
    }
  }
  return [...merged.values()];
}

export async function getImageQuotaState(connections, provider, capability, model, nowMs = Date.now()) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  const rows = db.all(
    `SELECT * FROM imageQuotaConstraints WHERE provider = ? AND state = 'blocked' ORDER BY retryAt`,
    [provider],
  );
  const policies = db.all(
    `SELECT * FROM imageQuotaPolicies WHERE provider = ? AND capability = ? ORDER BY quotaGroupId`,
    [provider, capability],
  );
  const activeLeases = db.all(
    `SELECT provider, supplierIdentity, identityGeneration, quotaGroupId, constraintId, leaseExpiresAt, dispatchedAt
     FROM imageQuotaProbeLeases WHERE provider = ? AND (leaseExpiresAt > ? OR dispatchedAt IS NOT NULL)`,
    [provider, new Date(nowMs).toISOString()],
  );
  const quotaAttempts = db.all(
    `SELECT id, provider, model, supplierIdentity, identityGeneration, outcome, failureClass,
            quotaGroupId, constraintId, retryAt, confidence, quotaObservations, quotaLockResolvedAt,
            startedAt, completedAt
     FROM imageQuotaRequestAttempts
     WHERE provider = ? AND outcome = 'quota_rejected' AND failureClass = 'image_quota'
       AND quotaLockResolvedAt IS NULL
     ORDER BY COALESCE(completedAt, startedAt), id`,
    [provider],
  );
  const quotaSubmissions = db.all(
    `SELECT id, provider, model, supplierIdentity, identityGeneration, outcome, failureClass,
            quotaGroupId, constraintId, retryAt, confidence, quotaObservations, quotaLockResolvedAt,
            dispatchedAt, completedAt
     FROM imageQuotaRequestSubmissions
     WHERE provider = ? AND outcome = 'quota_rejected' AND failureClass = 'image_quota'
       AND quotaLockResolvedAt IS NULL
     ORDER BY COALESCE(completedAt, dispatchedAt), id`,
    [provider],
  );
  const quotaRecords = [
    ...quotaAttempts.map((row) => ({ ...row, quotaRecordSource: "attempt" })),
    ...quotaSubmissions.map((row) => ({ ...row, quotaRecordSource: "submission" })),
    ...admissionQuotaRecords(db, provider),
  ].sort((a, b) => Date.parse(a.completedAt || a.startedAt || a.dispatchedAt) - Date.parse(b.completedAt || b.startedAt || b.dispatchedAt));
  const result = new Map();
  for (const connection of connections || []) {
    const identities = imageQuotaIdentityAliases(connection);
    const generation = imageQuotaIdentityGeneration(connection);
    // Local restrictions belong to this connection even after account identity enrichment increments its generation.
    const matchesIdentity = (row) => identities.includes(row.supplierIdentity)
      && (row.supplierIdentity === identities.at(-1) || Number(row.identityGeneration) === generation);
    const applicable = mergeImageQuotaRows(rows, quotaRecords, connection, capability, model);
    const applicablePolicies = policies.filter(matchesIdentity);
    const blockingRows = applicable.filter((row) => !isExpired(row, nowMs));
    const expiredRows = applicable.filter((row) => isExpired(row, nowMs));
    const probeInProgressRows = expiredRows.flatMap((row) => {
      const lease = activeLeases.find((candidate) =>
        candidate.supplierIdentity === row.supplierIdentity
        && Number(candidate.identityGeneration) === Number(row.identityGeneration)
        && candidate.quotaGroupId === row.quotaGroupId
        && candidate.constraintId === row.constraintId,
      );
      return lease ? [{ ...row, probeLeaseExpiresAt: lease.leaseExpiresAt, probeDispatchedAt: lease.dispatchedAt }] : [];
    });
    const orderedPolicies = applicablePolicies.filter(policy => imagePolicyApplies(policy, provider, model)).sort((a, b) => b.revision - a.revision);
    const manualPolicy = orderedPolicies.find((policy) => policy.policyState === "paused") || null;
    const policy = manualPolicy || orderedPolicies[0] || null;
    const policyRevision = orderedPolicies.reduce((max, row) => Math.max(max, Number(row.revision) || 0), 0);
    result.set(connection.id, {
      identity: imageQuotaIdentity(connection),
      generation,
      blockingRows,
      expiredRows,
      probeInProgressRows,
      policies: applicablePolicies,
      policy,
      manualPolicy,
      policyRevision,
    });
  }
  return result;
}

export async function recordImageQuotaObservations(connection, observations, requestId, attemptNumber = null) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  const rows = Array.isArray(observations) ? observations : [];
  if (!connection?.id || !rows.length || rows.some((observation) =>
    observation?.capability !== "image_generation"
      || !/^[A-Za-z0-9._:-]{1,120}$/.test(String(observation?.quotaGroupId || ""))
      || !/^[A-Za-z0-9._:-]{1,120}$/.test(String(observation?.constraintId || "")),
  )) {
    throw new TypeError("Incomplete image quota observation");
  }

  const identity = imageQuotaIdentity(connection);
  const generation = imageQuotaIdentityGeneration(connection);
  const now = new Date().toISOString();
  const results = [];
  try {
    db.transaction(() => {
      // Take the writer reservation before reading a revision shared with admission and policy changes.
      db.run("UPDATE imageQuotaAdmissionState SET revision = revision + 1 WHERE id = 1");
      const fallbackEntries = admissionQuotaFallbackEntries(db);
      for (const observation of rows) {
        const current = db.get(
          `SELECT revision, state, retryAt, confidence, source FROM imageQuotaConstraints
           WHERE provider = ? AND supplierIdentity = ? AND identityGeneration = ? AND quotaGroupId = ? AND constraintId = ?`,
          [connection.provider, identity, generation, observation.quotaGroupId, observation.constraintId],
        );
        const fallback = fallbackEntries.find((entry) => entry.provider === connection.provider
          && entry.supplierIdentity === identity && Number(entry.identityGeneration) === generation
          && entry.quotaGroupId === observation.quotaGroupId && entry.constraintId === observation.constraintId);
        const fallbackResetMs = Date.parse(fallback?.retryAt);
        const currentResetMs = Date.parse(current?.retryAt);
        const keepCanonicalReset = current && fallback && (
          (Number.isFinite(currentResetMs) && Number.isFinite(fallbackResetMs) && currentResetMs > fallbackResetMs)
          || (!Number.isFinite(currentResetMs) && fallback.confidence !== "provider_confirmed")
        );
        const resetSource = keepCanonicalReset ? current : fallback || current;
        const revision = (Number(current?.revision) || 0) + 1;
        const reportedResetMs = Date.parse(observation.retryAt);
        // A repeated rejection cannot shorten an outstanding restriction or turn an unknown reset into an estimate.
        const resetSourceMs = Date.parse(resetSource?.retryAt);
        const keepCurrentReset = resetSource && (
          (Number.isFinite(resetSourceMs) && Number.isFinite(reportedResetMs) && resetSourceMs > reportedResetMs)
          || (!Number.isFinite(resetSourceMs) && observation.confidence !== "provider_confirmed")
        );
        const retryAt = keepCurrentReset ? resetSource.retryAt
          : Number.isFinite(reportedResetMs) ? new Date(reportedResetMs).toISOString() : null;
        const confidence = keepCurrentReset ? resetSource.confidence
          : observation.confidence === "provider_confirmed" ? "provider_confirmed" : "estimated";
        const source = keepCurrentReset ? resetSource.source : boundedText(observation.source, 80) || "provider_image_error";
        db.run(
          `INSERT INTO imageQuotaConstraints
            (provider, supplierIdentity, identityGeneration, capability, quotaGroupId, constraintId,
             observedModel, appliesToModels, state, confidence, observedAt, retryAt, source, revision, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'blocked', ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, supplierIdentity, identityGeneration, quotaGroupId, constraintId)
           DO UPDATE SET capability=excluded.capability, observedModel=excluded.observedModel,
             appliesToModels=excluded.appliesToModels,
             state='blocked', confidence=excluded.confidence, observedAt=excluded.observedAt,
             retryAt=excluded.retryAt, source=excluded.source, revision=excluded.revision,
             updatedAt=excluded.updatedAt`,
          [
            connection.provider,
            identity,
            generation,
            observation.capability,
            observation.quotaGroupId,
            observation.constraintId,
            boundedText(observation.model, 256) || null,
            stringifyJson(Array.isArray(observation.appliesToModels) ? observation.appliesToModels : ["*"]),
            confidence,
            observation.observedAt || now,
            retryAt,
            source,
            revision,
            now,
          ],
        );
        results.push({
          provider: connection.provider,
          supplierIdentity: identity,
          identityGeneration: generation,
          quotaGroupId: observation.quotaGroupId,
          constraintId: observation.constraintId,
          revision,
          requestId: boundedText(requestId, 120),
        });
      }
      if (Number.isSafeInteger(attemptNumber) && attemptNumber > 0) {
        const attempt = db.get(
          `SELECT * FROM imageQuotaRequestAttempts
           WHERE routerRequestId = ? AND attemptNumber = ? AND provider = ? AND supplierIdentity = ?
             AND identityGeneration = ? AND outcome = 'quota_rejected' AND quotaLockResolvedAt IS NULL`,
          [requestId, attemptNumber, connection.provider, identity, generation],
        );
        if (attempt) markImageQuotaAttemptResolved(db, attempt, rows, now);
      }
      const submissions = db.all(
        `SELECT * FROM imageQuotaRequestSubmissions
         WHERE routerRequestId = ? AND provider = ? AND supplierIdentity = ? AND identityGeneration = ?
           AND outcome = 'quota_rejected' AND quotaLockResolvedAt IS NULL`,
        [requestId, connection.provider, identity, generation],
      );
      for (const submission of submissions) markImageQuotaSubmissionResolved(db, submission, rows, now);
      removeAdmissionQuotaFallbacks(db, rows.map((observation) => ({
        provider: connection.provider,
        supplierIdentity: identity,
        identityGeneration: generation,
        quotaGroupId: observation.quotaGroupId,
        constraintId: observation.constraintId,
      })));
    });
  } catch (error) {
    persistAdmissionQuotaFallback(db, connection, rows, requestId);
    const fallbackEntries = admissionQuotaFallbackEntries(db);
    return rows.map((observation) => {
      const entry = fallbackEntries.find((row) => row.provider === connection.provider
        && row.supplierIdentity === identity && Number(row.identityGeneration) === generation
        && row.quotaGroupId === observation.quotaGroupId && row.constraintId === observation.constraintId);
      if (!entry) throw error;
      return {
        provider: connection.provider,
        supplierIdentity: identity,
        identityGeneration: generation,
        quotaGroupId: observation.quotaGroupId,
        constraintId: observation.constraintId,
        revision: Number(entry.revision) || 1,
        requestId: boundedText(requestId, 120),
        source: entry.source,
      };
    });
  }
  return results;
}

export async function recordImageQuotaObservation(connection, observation, requestId, attemptNumber = null) {
  const observations = Array.isArray(observation?.constraints) && observation.constraints.length
    ? observation.constraints
    : [observation];
  const results = await recordImageQuotaObservations(connection, observations, requestId, attemptNumber);
  return results[0] || null;
}

export async function acquireImageQuotaProbeLeases(connection, rows, owner, leaseMs, nowMs = Date.now()) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  const uniqueRows = imageQuotaProbeRows(connection, rows);
  if (!uniqueRows.length) return { acquired: false, leaseExpiresAt: null };
  const now = new Date(nowMs).toISOString();
  const leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
  let result = { acquired: false, leaseExpiresAt: null };

  db.transaction(() => {
    db.run("UPDATE imageQuotaAdmissionState SET revision = revision + 1 WHERE id = 1");
    const admissionFallbacks = admissionQuotaFallbackEntries(db);
    for (const row of uniqueRows) {
      let current = db.get(
        `SELECT state, revision, retryAt FROM imageQuotaConstraints
         WHERE provider = ? AND supplierIdentity = ? AND identityGeneration = ? AND quotaGroupId = ? AND constraintId = ?`,
        [connection.provider, row.supplierIdentity, row.identityGeneration, row.quotaGroupId, row.constraintId],
      );
      const fallbackIds = [...new Set((row.fallbackAttemptIds || []).filter((id) => UUID_RE.test(String(id))))];
      const fallbackSubmissionIds = [...new Set((row.fallbackSubmissionIds || []).filter((id) => UUID_RE.test(String(id))))];
      const fallbackAdmissionIds = [...new Set((row.fallbackAdmissionIds || []).filter((id) => UUID_RE.test(String(id))))];
      const admissionMatches = fallbackAdmissionIds.map((id) => admissionFallbacks.find((entry) => entry.id === id));
      const currentAdmissionScope = admissionFallbacks.filter((entry) => entry.provider === connection.provider
        && entry.supplierIdentity === row.supplierIdentity && Number(entry.identityGeneration) === Number(row.identityGeneration)
        && entry.quotaGroupId === row.quotaGroupId && entry.constraintId === row.constraintId);
      const admissionRevisionSnapshot = row.fallbackAdmissionRevisions || {};
      if (currentAdmissionScope.length !== Object.keys(admissionRevisionSnapshot).length
        || currentAdmissionScope.some((entry) => Number(admissionRevisionSnapshot[entry.id]) !== Number(entry.revision))) return;
      if (fallbackAdmissionIds.length && admissionMatches.some((entry, index) => !entry
        || entry.provider !== connection.provider || entry.supplierIdentity !== row.supplierIdentity
        || Number(entry.identityGeneration) !== Number(row.identityGeneration)
        || entry.quotaGroupId !== row.quotaGroupId || entry.constraintId !== row.constraintId
        || Number(entry.revision) !== Number(row.fallbackAdmissionRevisions?.[fallbackAdmissionIds[index]]))) return;
      if (!current && (fallbackIds.length || fallbackSubmissionIds.length || fallbackAdmissionIds.length)) {
        let supportedByTrace = false;
        if (fallbackIds.length) {
          const placeholders = fallbackIds.map(() => "?").join(", ");
          const attempts = db.all(
            `SELECT * FROM imageQuotaRequestAttempts
             WHERE id IN (${placeholders}) AND provider = ? AND supplierIdentity = ? AND identityGeneration = ?
               AND outcome = 'quota_rejected' AND failureClass = 'image_quota' AND quotaLockResolvedAt IS NULL`,
            [...fallbackIds, connection.provider, row.supplierIdentity, Number(row.identityGeneration)],
          );
          supportedByTrace = attempts.some((attempt) => storedImageQuotaObservations(attempt).some((quota) =>
            !quota.resolved && quota.quotaGroupId === row.quotaGroupId && quota.constraintId === row.constraintId,
          ));
        }
        if (!supportedByTrace && fallbackSubmissionIds.length) {
          const placeholders = fallbackSubmissionIds.map(() => "?").join(", ");
          const submissions = db.all(
            `SELECT * FROM imageQuotaRequestSubmissions
             WHERE id IN (${placeholders}) AND provider = ? AND supplierIdentity = ? AND identityGeneration = ?
               AND outcome = 'quota_rejected' AND failureClass = 'image_quota' AND quotaLockResolvedAt IS NULL`,
            [...fallbackSubmissionIds, connection.provider, row.supplierIdentity, Number(row.identityGeneration)],
          );
          supportedByTrace = submissions.some((submission) => storedImageQuotaObservations(submission).some((quota) =>
            !quota.resolved && quota.quotaGroupId === row.quotaGroupId && quota.constraintId === row.constraintId,
          ));
        }
        if (!supportedByTrace && fallbackAdmissionIds.length) supportedByTrace = admissionMatches.length > 0;
        if (!supportedByTrace) return;
        const now = new Date(nowMs).toISOString();
        db.run(
          `INSERT OR IGNORE INTO imageQuotaConstraints
            (provider, supplierIdentity, identityGeneration, capability, quotaGroupId, constraintId,
             observedModel, appliesToModels, state, confidence, observedAt, retryAt, source, revision, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'blocked', ?, ?, ?, ?, ?, ?)`,
          [connection.provider, row.supplierIdentity, Number(row.identityGeneration), row.capability,
            row.quotaGroupId, row.constraintId, row.observedModel || null,
            stringifyJson(parseJson(row.appliesToModels, [])),
            row.confidence === "provider_confirmed" ? "provider_confirmed" : "estimated",
            row.observedAt || now, row.retryAt || null, row.source || "quota_attempt_trace_fallback",
            Number(row.revision) || 1, now],
        );
        current = db.get(
          `SELECT state, revision, retryAt FROM imageQuotaConstraints
           WHERE provider = ? AND supplierIdentity = ? AND identityGeneration = ? AND quotaGroupId = ? AND constraintId = ?`,
          [connection.provider, row.supplierIdentity, row.identityGeneration, row.quotaGroupId, row.constraintId],
        );
      }
      if (!current || current.state !== "blocked" || Number(current.revision) !== Number(row.revision) || !isExpired(current, nowMs)) return;
    }
    const conflicts = uniqueRows
      .map((row) => ({ row, lease: db.get(
        `SELECT leaseOwner, leaseExpiresAt, dispatchedAt FROM imageQuotaProbeLeases
         WHERE provider = ? AND supplierIdentity = ? AND identityGeneration = ? AND quotaGroupId = ? AND constraintId = ?`,
        [connection.provider, row.supplierIdentity, row.identityGeneration, row.quotaGroupId, row.constraintId],
      ) }))
      .filter(({ lease }) => lease && (lease.dispatchedAt || (lease.leaseOwner !== owner && Date.parse(lease.leaseExpiresAt) > nowMs)));
    if (conflicts.length) {
      result = {
        acquired: false,
        leaseExpiresAt: conflicts.map(({ lease }) => lease.leaseExpiresAt).sort()[0],
      };
      return;
    }

    for (const row of uniqueRows) {
      db.run(
        `INSERT INTO imageQuotaProbeLeases
          (provider, supplierIdentity, identityGeneration, quotaGroupId, constraintId, leaseOwner, leaseExpiresAt, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, supplierIdentity, identityGeneration, quotaGroupId, constraintId)
         DO UPDATE SET leaseOwner=excluded.leaseOwner, leaseExpiresAt=excluded.leaseExpiresAt, createdAt=excluded.createdAt`,
        [connection.provider, row.supplierIdentity, row.identityGeneration, row.quotaGroupId, row.constraintId, owner, leaseExpiresAt, now],
      );
    }
    result = { acquired: true, leaseExpiresAt };
  });
  return result;
}

export async function finishImageQuotaProbe(connection, rows, owner, { success = false } = {}) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  const scopedRows = imageQuotaProbeRows(connection, rows);
  db.transaction(() => {
    db.run("UPDATE imageQuotaAdmissionState SET revision = revision + 1 WHERE id = 1");
    for (const row of scopedRows) {
      if (success) {
        const deleted = db.run(
          `DELETE FROM imageQuotaConstraints
           WHERE provider = ? AND supplierIdentity = ? AND identityGeneration = ?
             AND quotaGroupId = ? AND constraintId = ? AND revision = ? AND state = 'blocked'
             AND EXISTS (
               SELECT 1 FROM imageQuotaProbeLeases AS lease
               WHERE lease.provider = imageQuotaConstraints.provider
                 AND lease.supplierIdentity = imageQuotaConstraints.supplierIdentity
                 AND lease.identityGeneration = imageQuotaConstraints.identityGeneration
                 AND lease.quotaGroupId = imageQuotaConstraints.quotaGroupId
                 AND lease.constraintId = imageQuotaConstraints.constraintId
                 AND lease.leaseOwner = ?
                 AND lease.dispatchedAt IS NOT NULL
             )`,
          [connection.provider, row.supplierIdentity, row.identityGeneration, row.quotaGroupId, row.constraintId, Number(row.revision), owner],
        );
        if (Number(deleted?.changes) > 0) {
          const fallbackIds = [...new Set((row.fallbackAttemptIds || []).filter((id) => UUID_RE.test(String(id))))];
          for (const id of fallbackIds) {
            const attempt = db.get(
              `SELECT * FROM imageQuotaRequestAttempts WHERE id = ? AND quotaLockResolvedAt IS NULL`,
              [id],
            );
            if (attempt) markImageQuotaAttemptResolved(db, attempt, [row], new Date().toISOString());
          }
          const fallbackSubmissionIds = [...new Set((row.fallbackSubmissionIds || []).filter((id) => UUID_RE.test(String(id))))];
          for (const id of fallbackSubmissionIds) {
            const submission = db.get(
              `SELECT * FROM imageQuotaRequestSubmissions WHERE id = ? AND quotaLockResolvedAt IS NULL`,
              [id],
            );
            if (submission) markImageQuotaSubmissionResolved(db, submission, [row], new Date().toISOString());
          }
          removeAdmissionQuotaFallbacks(db, [row]);
        }
      }
      db.run(
        `DELETE FROM imageQuotaProbeLeases
         WHERE provider = ? AND supplierIdentity = ? AND identityGeneration = ?
           AND quotaGroupId = ? AND constraintId = ? AND leaseOwner = ?`,
        [connection.provider, row.supplierIdentity, row.identityGeneration, row.quotaGroupId, row.constraintId, owner],
      );
    }
  });
}

export async function listImageQuotaConstraints() {
  const db = await getAdapter();
  requireDurableAdapter(db);
  const rows = db.all("SELECT * FROM imageQuotaConstraints ORDER BY provider, quotaGroupId, retryAt");
  return rows.map((row) => ({
    ...row,
    appliesToModels: parseJson(row.appliesToModels, []),
  }));
}

export class ImageQuotaPolicyConflictError extends Error {
  constructor(code, message, current = null) {
    super(message);
    this.name = "ImageQuotaPolicyConflictError";
    this.code = code;
    this.current = current;
  }
}

/**
 * Commit one scoped image pause/resume, its audit row, and its idempotency
 * receipt in one short transaction. The idempotency key is scoped to a caller
 * principal; it never doubles as authorization.
 */
export async function writeImageQuotaPolicy({
  connection,
  capability,
  quotaGroupId,
  action,
  reason = "",
  principal,
  idempotencyKey,
  requestHash,
  expectedRevision,
}) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  if (!connection?.id || !connection?.provider || !capability || !quotaGroupId || !principal || !idempotencyKey || !requestHash) {
    throw new TypeError("Incomplete image quota policy request");
  }
  if (action !== "pause" && action !== "resume") throw new TypeError("Invalid image quota policy action");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError("Invalid image quota policy revision");

  const identity = imageQuotaIdentity(connection);
  const identities = imageQuotaIdentityAliases(connection);
  const identityPlaceholders = identities.map(() => "?").join(", ");
  const generation = imageQuotaIdentityGeneration(connection);
  const now = new Date().toISOString();
  const nextState = action === "pause" ? "paused" : "enabled";
  let receipt;

  db.transaction(() => {
    db.run("UPDATE imageQuotaAdmissionState SET revision = revision + 1 WHERE id = 1");
    const previousReceipt = db.get(
      `SELECT requestHash, receipt FROM imageQuotaIdempotency WHERE principal = ? AND idempotencyKey = ?`,
      [principal, idempotencyKey],
    );
    if (previousReceipt) {
      if (previousReceipt.requestHash !== requestHash) {
        throw new ImageQuotaPolicyConflictError("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different request");
      }
      receipt = { ...parseJson(previousReceipt.receipt, {}), replayed: true };
      return;
    }

    const currentRows = db.all(
      `SELECT policyState, revision FROM imageQuotaPolicies
       WHERE provider = ? AND supplierIdentity IN (${identityPlaceholders})
         AND (identityGeneration = ? OR supplierIdentity = ?) AND capability = ? AND quotaGroupId = ?`,
      [connection.provider, ...identities, generation, identities.at(-1), capability, quotaGroupId],
    );
    const currentRevision = currentRows.reduce((max, row) => Math.max(max, Number(row.revision) || 0), 0);
    const previousState = currentRows.some((row) => row.policyState === "paused") ? "paused" : "enabled";
    if (currentRevision !== expectedRevision) {
      throw new ImageQuotaPolicyConflictError("STATE_REVISION_CONFLICT", "Image policy changed since it was loaded", {
        policyState: previousState,
        revision: currentRevision,
      });
    }

    const revision = currentRevision + 1;
    db.run(
      `UPDATE imageQuotaPolicies SET policyState = ?, revision = ?, reason = ?, updatedBy = ?, updatedAt = ?
       WHERE provider = ? AND supplierIdentity IN (${identityPlaceholders})
         AND (identityGeneration = ? OR supplierIdentity = ?) AND capability = ? AND quotaGroupId = ?`,
      [nextState, revision, boundedText(reason, 240) || null, boundedText(principal, 160), now,
        connection.provider, ...identities, generation, identities.at(-1), capability, quotaGroupId],
    );
    db.run(
      `INSERT INTO imageQuotaPolicies
        (provider, supplierIdentity, identityGeneration, capability, quotaGroupId, policyState, revision, reason, updatedBy, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, supplierIdentity, identityGeneration, capability, quotaGroupId)
       DO UPDATE SET policyState=excluded.policyState, revision=excluded.revision,
         reason=excluded.reason, updatedBy=excluded.updatedBy, updatedAt=excluded.updatedAt`,
      [connection.provider, identity, generation, capability, quotaGroupId, nextState, revision,
        boundedText(reason, 240) || null, boundedText(principal, 160), now],
    );

    db.run(
      `INSERT INTO imageQuotaPolicyAudit
        (id, provider, supplierIdentity, identityGeneration, capability, quotaGroupId,
         action, previousState, nextState, revision, reason, actor, idempotencyKey, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), connection.provider, identity, generation, capability, quotaGroupId,
        action, previousState, nextState, revision, boundedText(reason, 240) || null,
        boundedText(principal, 160), boundedText(idempotencyKey, 120), now],
    );

    receipt = {
      provider: connection.provider,
      connectionId: connection.id,
      capability,
      quotaGroupId,
      policyState: nextState,
      revision,
      updatedAt: now,
      replayed: false,
    };
    db.run(
      `INSERT INTO imageQuotaIdempotency(principal, idempotencyKey, requestHash, receipt, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
      [boundedText(principal, 160), boundedText(idempotencyKey, 120), requestHash, stringifyJson(receipt), now],
    );
  });

  return receipt;
}

/**
 * Serialize the final policy/quota check with management writes. The short
 * singleton update obtains SQLite's write lock; the external provider request
 * starts only after this admission transaction commits.
 */
export async function admitImageQuotaRequest(connection, capability, model, probeOwner = null) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  const provider = connection?.provider;
  if (!connection?.id || !provider || !capability) return { allowed: false, reason: "invalid_connection" };
  const nowMs = Date.now();
  let result = { allowed: false, reason: "connection_changed" };

  db.transaction(() => {
    db.run("UPDATE imageQuotaAdmissionState SET revision = revision + 1 WHERE id = 1");
    const row = db.get("SELECT id, provider, isActive, data FROM providerConnections WHERE id = ?", [connection.id]);
    if (!row || row.provider !== provider || Number(row.isActive) !== 1) {
      result = { allowed: false, reason: "account_disabled" };
      return;
    }

    const currentData = parseJson(row.data, {});
    const currentConnection = { ...currentData, id: row.id, provider: row.provider, isActive: true };
    if (imageQuotaIdentity(currentConnection) !== imageQuotaIdentity(connection)
      || imageQuotaIdentityGeneration(currentConnection) !== imageQuotaIdentityGeneration(connection)) {
      result = { allowed: false, reason: "connection_changed" };
      return;
    }

    const enabledModels = currentConnection.providerSpecificData?.enabledModels;
    if (provider === "codex" && Array.isArray(enabledModels) && enabledModels.length
      && model && !enabledModels.includes(model)) {
      result = { allowed: false, reason: "model_not_enabled" };
      return;
    }

    const identities = imageQuotaIdentityAliases(currentConnection);
    const identityPlaceholders = identities.map(() => "?").join(", ");
    const generation = imageQuotaIdentityGeneration(currentConnection);
    const policyRows = db.all(
      `SELECT policyState, quotaGroupId, revision FROM imageQuotaPolicies
       WHERE provider = ? AND supplierIdentity IN (${identityPlaceholders})
         AND (identityGeneration = ? OR supplierIdentity = ?) AND capability = ?`,
      [provider, ...identities, generation, identities.at(-1), capability],
    );
    const paused = policyRows.find((policy) => policy.policyState === "paused" && imagePolicyApplies(policy, provider, model));
    if (paused) {
      result = { allowed: false, reason: "manual_paused", revision: Number(paused.revision) || 0 };
      return;
    }

    const constraints = db.all(
      `SELECT * FROM imageQuotaConstraints WHERE provider = ? AND supplierIdentity IN (${identityPlaceholders})
       AND (identityGeneration = ? OR supplierIdentity = ?) AND capability = ? AND state = 'blocked'`,
      [provider, ...identities, generation, identities.at(-1), capability],
    );
    const fallbackAttempts = db.all(
      `SELECT * FROM imageQuotaRequestAttempts
       WHERE provider = ? AND supplierIdentity IN (${identityPlaceholders})
         AND (identityGeneration = ? OR supplierIdentity = ?)
         AND outcome = 'quota_rejected' AND failureClass = 'image_quota' AND quotaLockResolvedAt IS NULL`,
      [provider, ...identities, generation, identities.at(-1)],
    );
    const fallbackSubmissions = db.all(
      `SELECT * FROM imageQuotaRequestSubmissions
       WHERE provider = ? AND supplierIdentity IN (${identityPlaceholders})
         AND (identityGeneration = ? OR supplierIdentity = ?)
         AND outcome = 'quota_rejected' AND failureClass = 'image_quota' AND quotaLockResolvedAt IS NULL`,
      [provider, ...identities, generation, identities.at(-1)],
    );
    const quotaRecords = [
      ...fallbackAttempts.map((row) => ({ ...row, quotaRecordSource: "attempt" })),
      ...fallbackSubmissions.map((row) => ({ ...row, quotaRecordSource: "submission" })),
      ...admissionQuotaRecords(db, provider),
    ];
    const quotaRows = mergeImageQuotaRows(constraints, quotaRecords, currentConnection, capability, model);
    const blocked = quotaRows.some((quota) => !isExpired(quota, nowMs));
    if (blocked) {
      result = { allowed: false, reason: "quota_blocked" };
      return;
    }
    // A reservation may expire before dispatch. Once dispatch is committed,
    // only a definite result may release it: time passing cannot prove that
    // the provider stopped generating after a timeout or process crash.
    const recovering = new Map(quotaRows
      .filter((quota) => isExpired(quota, nowMs))
      .map((quota) => [JSON.stringify([quota.supplierIdentity, quota.identityGeneration, quota.quotaGroupId, quota.constraintId]), quota]));
    const leases = [...recovering.values()].map((quota) => ({ quota, lease: db.get(
      `SELECT leaseOwner, leaseExpiresAt, dispatchedAt FROM imageQuotaProbeLeases
       WHERE provider = ? AND supplierIdentity = ? AND identityGeneration = ? AND quotaGroupId = ? AND constraintId = ?`,
      [provider, quota.supplierIdentity, quota.identityGeneration, quota.quotaGroupId, quota.constraintId],
    ) }));
    if (leases.some(({ lease }) => !probeOwner || !lease || lease.leaseOwner !== probeOwner
      || lease.dispatchedAt || Date.parse(lease.leaseExpiresAt) <= nowMs)) {
      result = { allowed: false, reason: "probe_not_owned" };
      return;
    }
    for (const { quota } of leases) {
      db.run(
        `UPDATE imageQuotaProbeLeases SET dispatchedAt = ?
         WHERE provider = ? AND supplierIdentity = ? AND identityGeneration = ? AND quotaGroupId = ? AND constraintId = ? AND leaseOwner = ?`,
        [new Date(nowMs).toISOString(), provider, quota.supplierIdentity, quota.identityGeneration, quota.quotaGroupId, quota.constraintId, probeOwner],
      );
    }
    result = { allowed: true, reason: null };
  });

  return result;
}

/** A disabled budget still fences routes when its policy is missing. */
export async function hasImageSupplierBudgets() {
  const db = await getAdapter();
  return Boolean(db.get("SELECT id FROM imageSupplierBudgets LIMIT 1"));
}

export async function getImageSupplierBudgetOverview(nowMs = Date.now()) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  const now = new Date(nowMs).toISOString();
  const day = now.slice(0, 10);
  const month = day.slice(0, 7);
  return db.all("SELECT * FROM imageSupplierBudgets ORDER BY scopeType, id").map((budget) => {
    const limits = {
      daily: Number(budget.dailyLimitMicrousd),
      monthly: Number(budget.monthlyLimitMicrousd),
      pilot: Number(budget.pilotLimitMicrousd),
      perSubmission: Number(budget.maxSubmissionMicrousd),
    };
    if (budget.currency !== "USD" || Number(budget.scale) !== 6
      || !Number.isSafeInteger(Number(budget.revision)) || Number(budget.revision) < 1
      || Object.values(limits).some((value) => !safeMicroUsd(value, true))) {
      throw new ImageSupplierBudgetError("IMAGE_SUPPLIER_BUDGET_UNAVAILABLE", { budgetId: budget.id });
    }
    const obligation = supplierBudgetObligation(db, budget, day, month);
    const allocations = db.all(
      `SELECT state, reservedMaxMicrousd, calculatedMicrousd, billedMicrousd
       FROM imageSupplierExposureAllocations WHERE budgetId = ?`, [budget.id],
    );
    let openMicrousd = 0;
    let provisionalMicrousd = 0;
    let confirmedBilledMicrousd = 0;
    for (const allocation of allocations) {
      const amount = exposureCharge(allocation);
      if (allocation.state === "open") openMicrousd = safeAdd(openMicrousd, amount);
      if (allocation.state === "provisional") provisionalMicrousd = safeAdd(provisionalMicrousd, amount);
      if (allocation.state === "confirmed") confirmedBilledMicrousd = safeAdd(confirmedBilledMicrousd, amount);
    }
    const remaining = Object.fromEntries(["daily", "monthly", "pilot"].map((period) => [
      period,
      Math.max(0, limits[period] - obligation[period]),
    ]));
    const pilotActive = canonicalUtc(budget.pilotStartsAt) && canonicalUtc(budget.pilotEndsAt)
      && Date.parse(now) >= Date.parse(budget.pilotStartsAt) && Date.parse(now) < Date.parse(budget.pilotEndsAt);
    const enabled = Number(budget.enabled) === 1;
    const exhausted = limits.perSubmission === 0 || remaining.daily === 0 || remaining.monthly === 0 || remaining.pilot === 0;
    return {
      id: budget.id,
      scopeType: budget.scopeType,
      scopeKey: budget.scopeKey,
      currency: budget.currency,
      scale: Number(budget.scale),
      enabled,
      revision: Number(budget.revision),
      pricingPolicyVersion: budget.pricingPolicyVersion,
      pilotId: budget.pilotId,
      pilotStartsAt: budget.pilotStartsAt,
      pilotEndsAt: budget.pilotEndsAt,
      pilotActive,
      status: !enabled ? "disabled" : !pilotActive ? "outside_window" : exhausted ? "limit_reached" : "active",
      limitsMicrousd: limits,
      obligationMicrousd: obligation,
      remainingMicrousd: remaining,
      openMicrousd,
      provisionalMicrousd,
      confirmedBilledMicrousd,
      updatedAt: budget.updatedAt,
    };
  });
}

/** Configure one finite supplier budget without resetting its stable scope or pilot identity. */
export async function configureImageSupplierBudget(params) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  const id = boundedText(params?.id, 120);
  const scopeType = params?.scopeType;
  const scopeKey = boundedText(params?.scopeKey, 160);
  const pricingPolicyVersion = boundedText(params?.pricingPolicyVersion, 120);
  const pilotId = boundedText(params?.pilotId, 120);
  const enabled = params?.enabled;
  const limits = [params?.dailyLimitMicrousd, params?.monthlyLimitMicrousd,
    params?.pilotLimitMicrousd, params?.maxSubmissionMicrousd];
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(id) || !["installation", "billing_project"].includes(scopeType)
    || !/^[A-Za-z0-9._:-]{1,160}$/.test(scopeKey)
    || !/^[A-Za-z0-9._:-]{1,120}$/.test(pricingPolicyVersion) || !/^[A-Za-z0-9._:-]{1,120}$/.test(pilotId)
    || ![true, false, 0, 1].includes(enabled) || params?.currency !== "USD" || params?.scale !== 6
    || limits.some((value) => !safeMicroUsd(value, true))
    || !canonicalUtc(params?.pilotStartsAt) || !canonicalUtc(params?.pilotEndsAt)
    || Date.parse(params.pilotStartsAt) >= Date.parse(params.pilotEndsAt)) {
    throw new TypeError("Invalid image supplier budget configuration");
  }
  const now = new Date().toISOString();
  const normalizedEnabled = enabled === true || enabled === 1 ? 1 : 0;
  db.transaction(() => {
    acquireImageAdmissionLock(db);
    const current = db.get("SELECT * FROM imageSupplierBudgets WHERE id = ?", [id]);
    const scope = db.get("SELECT id FROM imageSupplierBudgets WHERE scopeType = ? AND scopeKey = ?", [scopeType, scopeKey]);
    if (scope && scope.id !== id) throw new TypeError("Image supplier budget scope identity is immutable");
    if (current && (current.scopeType !== scopeType || current.scopeKey !== scopeKey
      || current.pilotId !== pilotId || current.pilotStartsAt !== params.pilotStartsAt)) {
      throw new TypeError("Image supplier budget identity cannot be reset");
    }
    const revision = current ? Number(current.revision) + 1 : 1;
    db.run(
      `INSERT INTO imageSupplierBudgets
        (id, scopeType, scopeKey, currency, scale, enabled, revision, pricingPolicyVersion,
         dailyLimitMicrousd, monthlyLimitMicrousd, pilotLimitMicrousd, maxSubmissionMicrousd,
         pilotId, pilotStartsAt, pilotEndsAt, createdAt, updatedAt)
       VALUES (?, ?, ?, 'USD', 6, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, revision = excluded.revision,
         pricingPolicyVersion = excluded.pricingPolicyVersion, dailyLimitMicrousd = excluded.dailyLimitMicrousd,
         monthlyLimitMicrousd = excluded.monthlyLimitMicrousd, pilotLimitMicrousd = excluded.pilotLimitMicrousd,
         maxSubmissionMicrousd = excluded.maxSubmissionMicrousd, pilotEndsAt = excluded.pilotEndsAt,
         updatedAt = excluded.updatedAt`,
      [id, scopeType, scopeKey, normalizedEnabled, revision, pricingPolicyVersion, ...limits,
        pilotId, params.pilotStartsAt, params.pilotEndsAt, current?.createdAt || now, now],
    );
  });
  return db.get("SELECT * FROM imageSupplierBudgets WHERE id = ?", [id]);
}

/**
 * Persist a content-free account-attempt marker before provider dispatch.
 * Trace writes are best-effort at the request boundary; callers must catch
 * storage failures and continue serving inference.
 */
export async function beginImageRequestAttempt({
  routerRequestId,
  clientOperationId = null,
  attemptNumber,
  provider,
  model,
  connectionId,
  connection = null,
  quotaGroupId = null,
}) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  if (!UUID_RE.test(String(routerRequestId || ""))
    || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 1024
    || !/^[a-z0-9_-]{1,80}$/.test(String(provider || ""))
    || !boundedText(model, 256)
    || !boundedText(connectionId, 160)) {
    throw new TypeError("Invalid image request attempt identity");
  }

  const operationId = UUID_RE.test(String(clientOperationId || "")) ? clientOperationId : null;
  const safeQuotaGroupId = /^[A-Za-z0-9._:-]{1,120}$/.test(String(quotaGroupId || "")) ? quotaGroupId : null;
  const quotaConnection = connection?.id === connectionId && connection.provider === provider
    ? connection
    : { id: connectionId, provider };
  const supplierIdentity = imageQuotaIdentity(quotaConnection);
  const identityGeneration = imageQuotaIdentityGeneration(quotaConnection);
  const now = new Date().toISOString();
  const id = randomUUID();
  db.transaction(() => {
    db.run(
      `DELETE FROM imageQuotaRequestAttempts WHERE startedAt < ?
       AND outcome NOT IN ('in_flight', 'outcome_unknown')
       AND NOT (outcome = 'quota_rejected' AND quotaLockResolvedAt IS NULL)`,
      [new Date(Date.now() - IMAGE_REQUEST_TRACE_RETENTION_MS).toISOString()],
    );
    db.run(
      `INSERT OR IGNORE INTO imageQuotaRequestAttempts
        (id, routerRequestId, clientOperationId, attemptNumber, provider, model, connectionId,
         supplierIdentity, identityGeneration, quotaObservations, quotaLockResolvedAt,
         outcome, httpStatus, failureClass, quotaGroupId, constraintId, retryAt, confidence,
         fallbackAction, startedAt, completedAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'in_flight', NULL, NULL, ?, NULL, NULL, NULL, 'pending', ?, NULL, ?)`,
      [id, routerRequestId, operationId, attemptNumber, provider, boundedText(model, 256),
        boundedText(connectionId, 160), supplierIdentity, identityGeneration, safeQuotaGroupId, now, now],
    );
    const existing = db.get(
      `SELECT clientOperationId, provider, model, connectionId FROM imageQuotaRequestAttempts
       WHERE routerRequestId = ? AND attemptNumber = ?`,
      [routerRequestId, attemptNumber],
    );
    if (!existing || existing.provider !== provider || existing.model !== boundedText(model, 256)
      || existing.connectionId !== boundedText(connectionId, 160)
      || existing.clientOperationId !== operationId) {
      throw new Error("Image request attempt identity conflict");
    }
  });
  return { routerRequestId, attemptNumber, clientOperationId: operationId };
}

/** Complete one attempt exactly once; later cleanup/telemetry cannot rewrite its outcome. */
export async function finishImageRequestAttempt({
  routerRequestId,
  attemptNumber,
  outcome,
  httpStatus = null,
  failureClass = null,
  quotaGroupId = null,
  constraintId = null,
  retryAt = null,
  confidence = null,
  quotaObservations = null,
  fallbackAction = "terminal",
}) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  if (!UUID_RE.test(String(routerRequestId || ""))
    || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 1024
    || !TRACE_OUTCOMES.has(outcome)
    || !TRACE_FALLBACK_ACTIONS.has(fallbackAction)) {
    throw new TypeError("Invalid image request attempt outcome");
  }
  const status = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
  const safeFailure = TRACE_FAILURE_CLASSES.has(failureClass) ? failureClass : null;
  const safeGroup = /^[A-Za-z0-9._:-]{1,120}$/.test(String(quotaGroupId || "")) ? quotaGroupId : null;
  const safeConstraint = /^[A-Za-z0-9._:-]{1,120}$/.test(String(constraintId || "")) ? constraintId : null;
  const safeConfidence = TRACE_CONFIDENCE.has(confidence) ? confidence : null;
  const parsedRetryAt = retryAt && Number.isFinite(Date.parse(retryAt))
    ? new Date(retryAt).toISOString()
    : null;
  const now = new Date().toISOString();
  let changed = false;
  db.transaction(() => {
    const attempt = db.get(
      `SELECT model FROM imageQuotaRequestAttempts WHERE routerRequestId = ? AND attemptNumber = ? AND outcome = 'in_flight'`,
      [routerRequestId, attemptNumber],
    );
    const safeObservations = outcome === "quota_rejected"
      ? safeTraceQuotaObservations(quotaObservations, {
          quotaGroupId: safeGroup,
          constraintId: safeConstraint,
          model: attempt?.model,
          retryAt: parsedRetryAt,
          confidence: safeConfidence,
        }, boundedText(attempt?.model, 256))
      : [];
    const result = db.run(
      `UPDATE imageQuotaRequestAttempts
       SET outcome = ?, httpStatus = ?, failureClass = ?, quotaGroupId = COALESCE(?, quotaGroupId),
           constraintId = ?, retryAt = ?, confidence = ?, fallbackAction = ?, completedAt = ?, updatedAt = ?,
           quotaObservations = ?
       WHERE routerRequestId = ? AND attemptNumber = ? AND outcome = 'in_flight'`,
      [outcome, status, safeFailure, safeGroup, safeConstraint, parsedRetryAt, safeConfidence,
        fallbackAction, now, now, safeObservations.length ? stringifyJson(safeObservations) : null, routerRequestId, attemptNumber],
    );
    changed = Number(result?.changes) > 0;
  });
  return changed;
}

function localImageCapacityBlock(db, provider, supplierIdentity, model, policies, now) {
  const blocks = [];
  for (const policy of policies) {
    const scope = "provider = ? AND supplierIdentity = ?" + (policy.model === "*" ? "" : " AND model = ?");
    const params = [provider, supplierIdentity, ...(policy.model === "*" ? [] : [model])];
    if (policy.maxConcurrent) {
      const active = db.get(`SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions WHERE ${scope} AND outcome IN ('in_flight', 'outcome_unknown')`, params);
      if (Number(active.n) >= policy.maxConcurrent) blocks.push(null);
    }
    for (const window of policy.windows || []) {
      const cutoff = new Date(Date.parse(now) - window.seconds * 1000).toISOString();
      const usage = db.get(`SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions WHERE ${scope} AND dispatchedAt > ?`, [...params, cutoff]);
      if (Number(usage.n) >= window.requests) {
        const next = db.get(`SELECT dispatchedAt FROM imageQuotaRequestSubmissions WHERE ${scope} AND dispatchedAt > ? ORDER BY dispatchedAt ASC LIMIT 1 OFFSET ?`, [...params, cutoff, Number(usage.n) - window.requests]);
        blocks.push(new Date(Date.parse(next.dispatchedAt) + window.seconds * 1000).toISOString());
      }
    }
  }
  if (!blocks.length) return null;
  const retryAt = blocks.includes(null) ? null : blocks.sort().at(-1);
  return { state: "local_capacity_limited", source: "local_policy", retryAt,
    confidence: retryAt ? "estimated" : "unknown", observedAt: now, retryScope: "new_request_after_check" };
}

/** Shared supplier occupancy, including uncertain submissions until resolved. */
export async function getImageSupplierLoads(connections, provider) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  const rows = db.all(`SELECT supplierIdentity, COUNT(*) AS active FROM imageQuotaRequestSubmissions
    WHERE provider = ? AND outcome IN ('in_flight', 'outcome_unknown') GROUP BY supplierIdentity`, [provider]);
  const loads = new Map(rows.map((row) => [row.supplierIdentity, Number(row.active)]));
  return new Map(connections.map((connection) => [connection.id, loads.get(imageQuotaIdentity(connection)) || 0]));
}

/** Advisory read only; dispatch rechecks atomically when reserving the submission. */
export async function getLocalImageCapacity(connection, model = null, nowMs = Date.now()) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  const policies = IMAGE_QUOTA_CONFIG.localLimits.filter((policy) => policy.provider === connection.provider
    && (policy.model === "*" || policy.model === model));
  return localImageCapacityBlock(db, connection.provider, imageQuotaIdentity(connection), model, policies, new Date(nowMs).toISOString());
}

/** Persist one row for each physical provider request immediately before dispatch. */
export async function beginImageRequestSubmission({
  routerRequestId,
  clientOperationId = null,
  attemptNumber,
  submissionNumber,
  provider,
  requestedModel,
  model,
  connectionId,
  connection = null,
  entryPoint = "unknown",
  operation = "generate",
  quotaGroupId = null,
  budgetScope = null,
  estimatedMaxMicrousd = null,
  pricingVersion = null,
  pricingDigest = null,
  priceShape = null,
}) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  if (!UUID_RE.test(String(routerRequestId || ""))
    || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 1024
    || !Number.isSafeInteger(submissionNumber) || submissionNumber < 1 || submissionNumber > 1024
    || !/^[a-z0-9_-]{1,80}$/.test(String(provider || ""))
    || !boundedText(requestedModel, 256)
    || !boundedText(model, 256)
    || !boundedText(connectionId, 160)
    || !IMAGE_REQUEST_ENTRY_POINTS.has(entryPoint)
    || !IMAGE_REQUEST_OPERATIONS.has(operation)) {
    throw new TypeError("Invalid image provider submission identity");
  }

  const operationId = UUID_RE.test(String(clientOperationId || "")) ? clientOperationId : null;
  const safeQuotaGroupId = /^[A-Za-z0-9._:-]{1,120}$/.test(String(quotaGroupId || "")) ? quotaGroupId : null;
  const safeRequestedModel = boundedText(requestedModel, 256);
  const safeModel = boundedText(model, 256);
  const safeConnectionId = boundedText(connectionId, 160);
  const quotaConnection = connection?.id === connectionId && connection.provider === provider ? connection : null;
  if (safeQuotaGroupId && !quotaConnection) throw new TypeError("Image quota submission requires its supplier identity");
  const supplierIdentity = quotaConnection ? imageQuotaIdentity(quotaConnection) : null;
  const identityGeneration = quotaConnection ? imageQuotaIdentityGeneration(quotaConnection) : null;
  const now = new Date().toISOString();
  const id = randomUUID();
  db.transaction(() => {
    // Acquire the cross-process SQLite write lock before reading any admission totals.
    acquireImageAdmissionLock(db);
    db.run(
      `UPDATE imageQuotaRequestSubmissions
       SET clientOperationId = NULL, providerRequestId = NULL, usageJson = NULL, traceScrubbedAt = ?
       WHERE dispatchedAt < ? AND traceScrubbedAt IS NULL
       AND outcome IN ('succeeded', 'provider_rejected', 'quota_rejected')
       AND NOT (outcome = 'quota_rejected' AND quotaLockResolvedAt IS NULL)
       AND id NOT IN (SELECT submissionId FROM imageSupplierExposureAllocations)`,
      [now, new Date(Date.now() - IMAGE_REQUEST_TRACE_RETENTION_MS).toISOString()],
    );
    const policies = IMAGE_QUOTA_CONFIG.localLimits.filter((policy) => policy.provider === provider
      && (policy.model === "*" || policy.model === safeModel));
    if (policies.length && !supplierIdentity) throw new TypeError("Local image limits require a supplier identity");
    const existingSubmission = db.get("SELECT id FROM imageQuotaRequestSubmissions WHERE routerRequestId = ? AND submissionNumber = ?", [routerRequestId, submissionNumber]);
    if (existingSubmission) throw new Error("Image capacity reservation already exists; reconcile before redispatch");
    const block = localImageCapacityBlock(db, provider, supplierIdentity, safeModel, policies, now);
    if (block) {
      const error = new Error("Configured local image capacity is unavailable");
      error.code = "IMAGE_LOCAL_CAPACITY";
      error.availability = block;
      throw error;
    }

    // Configuring or disabling a budget must never reopen unbudgeted dispatch.
    if (budgetScope == null && (estimatedMaxMicrousd != null || pricingVersion != null
      || pricingDigest != null || priceShape != null
      || db.get("SELECT id FROM imageSupplierBudgets LIMIT 1"))) {
      throw new ImageSupplierBudgetError("IMAGE_SUPPLIER_BUDGET_UNAVAILABLE");
    }
    const budgetAdmission = budgetScope == null ? null
      : validateBudgetScope(db, budgetScope, estimatedMaxMicrousd, pricingVersion, pricingDigest, priceShape, now,
        { supplierIdentity, model: safeModel, operation });
    db.run(
      `INSERT INTO imageQuotaRequestSubmissions
        (id, routerRequestId, clientOperationId, attemptNumber, submissionNumber, provider, requestedModel, model,
         connectionId, supplierIdentity, identityGeneration, entryPoint, operation, outcome, httpStatus, failureClass, quotaGroupId,
         constraintId, retryAt, confidence, quotaObservations, quotaLockResolvedAt, providerRequestId, outputCount, usageJson,
         dispatchedAt, completedAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_flight', NULL, NULL, ?, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, NULL, ?, NULL, ?)`,
      [id, routerRequestId, operationId, attemptNumber, submissionNumber, provider, safeRequestedModel, safeModel,
        safeConnectionId, supplierIdentity, identityGeneration, entryPoint, operation, safeQuotaGroupId, now, now],
    );
    const existing = db.get(
      `SELECT clientOperationId, attemptNumber, provider, requestedModel, model, connectionId, entryPoint, operation
       FROM imageQuotaRequestSubmissions WHERE routerRequestId = ? AND submissionNumber = ?`,
      [routerRequestId, submissionNumber],
    );
    if (!existing || existing.clientOperationId !== operationId
      || Number(existing.attemptNumber) !== attemptNumber || existing.provider !== provider
      || existing.requestedModel !== safeRequestedModel || existing.model !== safeModel || existing.connectionId !== safeConnectionId
      || existing.entryPoint !== entryPoint || existing.operation !== operation) {
      throw new Error("Image provider submission identity conflict");
    }
    if (budgetAdmission) {
      for (const budget of budgetAdmission.budgets) {
        db.run(
          `INSERT INTO imageSupplierExposureAllocations
            (submissionId, budgetId, pilotId, pricingVersion, pricingDigest, priceShapeJson, currency, scale,
             reservedMaxMicrousd, state, calculatedMicrousd, billedMicrousd, dispatchDay, dispatchMonth,
             reservedAt, revision, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, 'USD', 6, ?, 'open', NULL, NULL, ?, ?, ?, 1, ?)`,
          [id, budget.id, budget.pilotId, budgetAdmission.pricingVersion, budgetAdmission.pricingDigest,
            budgetAdmission.serializedShape, budgetAdmission.estimate, budgetAdmission.day,
            budgetAdmission.month, now, now],
        );
      }
    }
  });
  return { routerRequestId, submissionNumber, submissionId: id };
}

/** Finish an already-dispatched submission once; failures leave it visibly unresolved. */
export async function finishImageRequestSubmission({
  routerRequestId,
  submissionNumber,
  outcome,
  httpStatus = null,
  failureClass = null,
  quotaGroupId = null,
  constraintId = null,
  retryAt = null,
  confidence = null,
  providerRequestId = null,
  outputCount = null,
  usage = null,
  calculatedMicrousd = null,
  quotaObservations = null,
}) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  if (!UUID_RE.test(String(routerRequestId || ""))
    || !Number.isSafeInteger(submissionNumber) || submissionNumber < 1 || submissionNumber > 1024
    || !TRACE_OUTCOMES.has(outcome)) {
    throw new TypeError("Invalid image provider submission outcome");
  }
  const status = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
  const safeFailure = TRACE_FAILURE_CLASSES.has(failureClass) ? failureClass : null;
  const safeGroup = /^[A-Za-z0-9._:-]{1,120}$/.test(String(quotaGroupId || "")) ? quotaGroupId : null;
  const safeConstraint = /^[A-Za-z0-9._:-]{1,120}$/.test(String(constraintId || "")) ? constraintId : null;
  const parsedRetryAt = retryAt && Number.isFinite(Date.parse(retryAt))
    ? new Date(retryAt).toISOString()
    : null;
  const safeConfidence = TRACE_CONFIDENCE.has(confidence) ? confidence : null;
  const safeRequestId = safeProviderRequestId(providerRequestId);
  const safeOutputCount = Number.isSafeInteger(outputCount) && outputCount >= 0 && outputCount <= 16
    ? outputCount
    : null;
  const safeUsage = safeProviderUsage(usage);
  const safeCalculatedMicrousd = safeMicroUsd(calculatedMicrousd, true) ? calculatedMicrousd : null;
  const now = new Date().toISOString();
  let result;
  db.transaction(() => {
    acquireImageAdmissionLock(db);
    const submission = db.get(
      `SELECT id, provider, supplierIdentity, identityGeneration, model, dispatchedAt FROM imageQuotaRequestSubmissions
       WHERE routerRequestId = ? AND submissionNumber = ? AND outcome = 'in_flight'`,
      [routerRequestId, submissionNumber],
    );
    const safeObservations = outcome === "quota_rejected"
      ? safeTraceQuotaObservations(quotaObservations, {
          quotaGroupId: safeGroup,
          constraintId: safeConstraint,
          model: submission?.model,
          retryAt: parsedRetryAt,
          confidence: safeConfidence,
        }, boundedText(submission?.model, 256))
      : [];
    result = db.run(
      `UPDATE imageQuotaRequestSubmissions
       SET outcome = ?, httpStatus = ?, failureClass = ?, quotaGroupId = COALESCE(?, quotaGroupId),
           constraintId = ?, retryAt = ?, confidence = ?, quotaObservations = ?, quotaLockResolvedAt = NULL,
           providerRequestId = ?, outputCount = ?, usageJson = ?, completedAt = ?, updatedAt = ?
       WHERE routerRequestId = ? AND submissionNumber = ? AND outcome = 'in_flight'`,
      [outcome, status, safeFailure, safeGroup, safeConstraint, parsedRetryAt, safeConfidence,
        safeObservations.length ? stringifyJson(safeObservations) : null, safeRequestId, safeOutputCount,
        safeUsage ? stringifyJson(safeUsage) : null, now, now, routerRequestId, submissionNumber],
    );
    if (Number(result?.changes) > 0 && submission?.supplierIdentity) {
      db.exec("SAVEPOINT image_quota_learning_capture");
      try {
        recordImageQuotaLearningPrediction(db, submission, outcome, now);
        db.exec("RELEASE SAVEPOINT image_quota_learning_capture");
      } catch {
        db.exec("ROLLBACK TO SAVEPOINT image_quota_learning_capture");
        db.exec("RELEASE SAVEPOINT image_quota_learning_capture");
        console.warn("[IMAGE_QUOTA] Prospective learning capture unavailable");
      }
    }
    if (Number(result?.changes) > 0 && outcome === "succeeded") {
      const allocations = db.all(
        "SELECT * FROM imageSupplierExposureAllocations WHERE submissionId = ? AND state = 'open'",
        [db.get("SELECT id FROM imageQuotaRequestSubmissions WHERE routerRequestId = ? AND submissionNumber = ?", [routerRequestId, submissionNumber])?.id],
      );
      for (const allocation of allocations) {
        addExposureAdjustment(db, allocation, "provisional", {
          evidenceSource: "submission_outcome",
          evidenceReference: `${routerRequestId}:${submissionNumber}:succeeded`,
          evidenceDigest: null,
          observedAt: now,
          principal: "router",
          reason: "provider_success",
          calculatedMicrousd: safeCalculatedMicrousd,
        }, now);
      }
    }
  });
  return Number(result?.changes) > 0;
}

/** Apply provider billing or explicit no-charge evidence without replaying inference. */
export async function reconcileImageSupplierExposure({ submissionId, budgetId, evidence }) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  const safeSubmissionId = boundedText(submissionId, 120);
  const safeBudgetId = boundedText(budgetId, 120);
  const source = boundedText(evidence?.evidenceSource, 80);
  const reference = boundedText(evidence?.evidenceReference, 160);
  const observedAt = evidence?.observedAt;
  const nextState = evidence?.nextState;
  const calculated = evidence?.calculatedMicrousd;
  const billed = evidence?.billedMicrousd;
  const digest = evidence?.evidenceDigest ?? null;
  if (!safeSubmissionId || !safeBudgetId || !/^[a-z][a-z0-9_.-]{1,79}$/.test(source) || !reference
    || !canonicalUtc(observedAt) || !["confirmed", "released"].includes(nextState)
    || (digest !== null && !/^[a-f0-9]{64}$/i.test(String(digest)))
    || (calculated != null && !safeMicroUsd(calculated, true))
    || (nextState === "confirmed" && !safeMicroUsd(billed, true))
    || (nextState === "released" && billed != null)
    || (nextState === "released" && evidence?.zeroBillableCost !== true)) {
    throw new TypeError("Invalid image supplier exposure evidence");
  }
  const now = new Date().toISOString();
  let result;
  db.transaction(() => {
    acquireImageAdmissionLock(db);
    const priorEvidence = db.get(
      `SELECT evidenceDigest, nextState, nextCalculatedMicrousd, nextBilledMicrousd FROM imageSupplierExposureAdjustments
       WHERE budgetId = ? AND evidenceSource = ? AND evidenceReference = ? AND submissionId = ?`,
      [safeBudgetId, source, reference, safeSubmissionId],
    );
    const allocation = db.get(
      "SELECT * FROM imageSupplierExposureAllocations WHERE submissionId = ? AND budgetId = ?",
      [safeSubmissionId, safeBudgetId],
    );
    if (!allocation) throw new ImageSupplierBudgetError("IMAGE_SUPPLIER_BUDGET_UNAVAILABLE", { budgetId: safeBudgetId });
    if (priorEvidence) {
      const expectedCalculated = calculated ?? (allocation.calculatedMicrousd == null ? null : Number(allocation.calculatedMicrousd));
      const expectedBilled = nextState === "confirmed" ? billed : (allocation.billedMicrousd == null ? null : Number(allocation.billedMicrousd));
      if ((priorEvidence.evidenceDigest || null) !== digest || priorEvidence.nextState !== nextState
        || (priorEvidence.nextCalculatedMicrousd == null ? null : Number(priorEvidence.nextCalculatedMicrousd)) !== expectedCalculated
        || (priorEvidence.nextBilledMicrousd == null ? null : Number(priorEvidence.nextBilledMicrousd)) !== expectedBilled) {
        throw new ImageSupplierBudgetError("IMAGE_SUPPLIER_BUDGET_UNAVAILABLE", { budgetId: safeBudgetId, reason: "evidence_conflict" });
      }
      result = { ...allocation, replayed: true };
      return;
    }
    if (!Number.isSafeInteger(evidence?.expectedRevision) || Number(allocation.revision) !== evidence.expectedRevision
      || !["open", "provisional"].includes(allocation.state)) {
      throw new ImageSupplierBudgetError("IMAGE_SUPPLIER_BUDGET_UNAVAILABLE", { budgetId: safeBudgetId, reason: "revision_conflict" });
    }
    const adjustmentEvidence = {
      evidenceSource: source,
      evidenceReference: reference,
      evidenceDigest: digest,
      observedAt,
      principal: boundedText(evidence?.principal, 160) || "operator",
      reason: boundedText(evidence?.reason, 240) || (nextState === "released" ? "confirmed_no_charge" : "provider_billing_confirmed"),
      calculatedMicrousd: calculated,
      billedMicrousd: nextState === "confirmed" ? billed : null,
    };
    addExposureAdjustment(db, allocation, nextState, adjustmentEvidence, now);
    if (nextState === "confirmed" && billed > Number(allocation.reservedMaxMicrousd)) {
      db.run(
        `UPDATE imageSupplierBudgets SET enabled = 0, revision = revision + 1, updatedAt = ?
         WHERE id IN (SELECT budgetId FROM imageSupplierExposureAllocations WHERE submissionId = ?)`,
        [now, safeSubmissionId],
      );
    }
    result = db.get(
      "SELECT * FROM imageSupplierExposureAllocations WHERE submissionId = ? AND budgetId = ?",
      [safeSubmissionId, safeBudgetId],
    );
  });
  return result;
}

/** Counts only image-provider submissions observed during the last 24 hours. */
export async function getImageRequestUsageSummary(connections, provider, nowMs = Date.now()) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  if (!/^[a-z0-9_-]{1,80}$/.test(String(provider || ""))) throw new TypeError("Invalid image usage provider");
  const ids = [...new Set((connections || []).map((connection) => boundedText(connection?.id, 160)).filter(Boolean))];
  const summaries = new Map();
  for (const id of ids) {
    summaries.set(id, {
      windowStartedAt: new Date(nowMs - IMAGE_REQUEST_USAGE_WINDOW_MS).toISOString(),
      windowSeconds: IMAGE_REQUEST_USAGE_WINDOW_MS / 1000,
      dispatchedRequests: 0,
      validatedImages: 0,
      quotaRejections: 0,
      unknownOutcomes: 0,
      trackingStartedAt: null,
      observedAt: null,
    });
  }
  if (!ids.length) return summaries;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db.all(
    `SELECT connectionId, COUNT(*) AS dispatchedRequests,
            SUM(CASE WHEN outputCount IS NOT NULL THEN outputCount ELSE 0 END) AS validatedImages,
            SUM(CASE WHEN outcome = 'quota_rejected' THEN 1 ELSE 0 END) AS quotaRejections,
            SUM(CASE WHEN outcome IN ('outcome_unknown', 'in_flight') THEN 1 ELSE 0 END) AS unknownOutcomes,
            MIN(dispatchedAt) AS trackingStartedAt, MAX(updatedAt) AS observedAt
     FROM imageQuotaRequestSubmissions
     WHERE provider = ? AND connectionId IN (${placeholders}) AND dispatchedAt >= ?
     GROUP BY connectionId`,
    [provider, ...ids, new Date(nowMs - IMAGE_REQUEST_USAGE_WINDOW_MS).toISOString()],
  );
  for (const row of rows) {
    summaries.set(row.connectionId, {
      windowStartedAt: new Date(nowMs - IMAGE_REQUEST_USAGE_WINDOW_MS).toISOString(),
      windowSeconds: IMAGE_REQUEST_USAGE_WINDOW_MS / 1000,
      dispatchedRequests: Number(row.dispatchedRequests) || 0,
      validatedImages: Number(row.validatedImages) || 0,
      quotaRejections: Number(row.quotaRejections) || 0,
      unknownOutcomes: Number(row.unknownOutcomes) || 0,
      trackingStartedAt: row.trackingStartedAt || null,
      observedAt: row.observedAt || null,
    });
  }
  return summaries;
}

/** Passive, bounded trace read. It never refreshes a credential or contacts a provider. */
export async function getImageRequestTrace({ routerRequestId = null, clientOperationId = null } = {}) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  const hasRouterId = UUID_RE.test(String(routerRequestId || ""));
  const hasOperationId = UUID_RE.test(String(clientOperationId || ""));
  if (hasRouterId === hasOperationId) throw new TypeError("Provide exactly one valid image request identifier");

  const column = hasRouterId ? "routerRequestId" : "clientOperationId";
  const value = hasRouterId ? routerRequestId : clientOperationId;
  const cutoff = new Date(Date.now() - IMAGE_REQUEST_TRACE_RETENTION_MS).toISOString();
  const rows = db.all(
    `SELECT routerRequestId, clientOperationId, attemptNumber, provider, model, connectionId,
            outcome, httpStatus, failureClass, quotaGroupId, constraintId, retryAt, confidence,
            fallbackAction, startedAt, completedAt
     FROM imageQuotaRequestAttempts WHERE ${column} = ? AND (startedAt >= ?
       OR outcome IN ('in_flight', 'outcome_unknown')
       OR (outcome = 'quota_rejected' AND quotaLockResolvedAt IS NULL))
     ORDER BY startedAt DESC, attemptNumber ASC LIMIT ?`,
    [value, cutoff, IMAGE_REQUEST_TRACE_MAX_ROWS + 1],
  );
  const submissionRows = db.all(
    `SELECT routerRequestId, clientOperationId, attemptNumber, submissionNumber, provider, requestedModel, model,
            connectionId, entryPoint, operation, outcome, httpStatus, failureClass, quotaGroupId,
            constraintId, retryAt, confidence, providerRequestId, outputCount, usageJson,
            dispatchedAt, completedAt
     FROM imageQuotaRequestSubmissions WHERE ${column} = ? AND (dispatchedAt >= ?
       OR outcome IN ('in_flight', 'outcome_unknown')
       OR (outcome = 'quota_rejected' AND quotaLockResolvedAt IS NULL))
     ORDER BY dispatchedAt DESC, submissionNumber ASC LIMIT ?`,
    [value, cutoff, IMAGE_REQUEST_TRACE_MAX_ROWS + 1],
  );
  const truncated = rows.length > IMAGE_REQUEST_TRACE_MAX_ROWS
    || submissionRows.length > IMAGE_REQUEST_TRACE_MAX_ROWS;
  const requests = new Map();
  for (const row of rows.slice(0, IMAGE_REQUEST_TRACE_MAX_ROWS)) {
    let request = requests.get(row.routerRequestId);
    if (!request) {
      request = {
        router_request_id: row.routerRequestId,
        client_operation_id: row.clientOperationId,
        attempts: [],
        submissions: [],
      };
      requests.set(row.routerRequestId, request);
    }
    request.attempts.push({
      sequence: Number(row.attemptNumber),
      provider: row.provider,
      model: row.model,
      account_ref: imageQuotaAccountReference(row.connectionId),
      outcome: TRACE_OUTCOMES.has(row.outcome) ? row.outcome : "outcome_unknown",
      http_status: row.httpStatus !== null && row.httpStatus !== undefined && Number.isInteger(Number(row.httpStatus))
        ? Number(row.httpStatus)
        : null,
      failure_class: TRACE_FAILURE_CLASSES.has(row.failureClass) ? row.failureClass : null,
      quota_group_id: row.quotaGroupId || null,
      constraint_id: row.constraintId || null,
      retry_at: row.retryAt || null,
      confidence: TRACE_CONFIDENCE.has(row.confidence) ? row.confidence : "unknown",
      fallback_action: TRACE_FALLBACK_ACTIONS.has(row.fallbackAction) ? row.fallbackAction : "pending",
      started_at: row.startedAt,
      completed_at: row.completedAt || null,
    });
  }
  for (const row of submissionRows.slice(0, IMAGE_REQUEST_TRACE_MAX_ROWS)) {
    let request = requests.get(row.routerRequestId);
    if (!request) {
      request = {
        router_request_id: row.routerRequestId,
        client_operation_id: row.clientOperationId,
        attempts: [],
        submissions: [],
      };
      requests.set(row.routerRequestId, request);
    }
    const providerUsage = safeProviderUsage(parseJson(row.usageJson, null));
    request.submissions.push({
      sequence: Number(row.submissionNumber),
      attempt_sequence: Number(row.attemptNumber),
      provider: row.provider,
      requested_model: row.requestedModel,
      model: row.model,
      account_ref: imageQuotaAccountReference(row.connectionId),
      entry_point: IMAGE_REQUEST_ENTRY_POINTS.has(row.entryPoint) ? row.entryPoint : "unknown",
      operation: IMAGE_REQUEST_OPERATIONS.has(row.operation) ? row.operation : "generate",
      outcome: TRACE_OUTCOMES.has(row.outcome) ? row.outcome : "outcome_unknown",
      http_status: row.httpStatus !== null && row.httpStatus !== undefined && Number.isInteger(Number(row.httpStatus))
        ? Number(row.httpStatus)
        : null,
      failure_class: TRACE_FAILURE_CLASSES.has(row.failureClass) ? row.failureClass : null,
      quota_group_id: row.quotaGroupId || null,
      constraint_id: row.constraintId || null,
      retry_at: row.retryAt || null,
      confidence: TRACE_CONFIDENCE.has(row.confidence) ? row.confidence : "unknown",
      provider_request_id: safeProviderRequestId(row.providerRequestId),
      output_count: row.outputCount !== null && row.outputCount !== undefined
        && Number.isSafeInteger(Number(row.outputCount)) && Number(row.outputCount) >= 0
        ? Number(row.outputCount)
        : null,
      provider_usage: providerUsage ? { status: "reported", counters: providerUsage } : { status: "unknown", counters: null },
      dispatched_at: row.dispatchedAt,
      completed_at: row.completedAt || null,
    });
  }

  return {
    schema_version: "9router.image_request_trace.v2",
    status: rows.length || submissionRows.length ? "found" : "not_found",
    lookup: hasRouterId
      ? { router_request_id: routerRequestId }
      : { client_operation_id: clientOperationId },
    requests: [...requests.values()],
    truncated,
    retention_days: 7,
  };
}

const IMAGE_LEARNING_HISTORY_LIMIT = 200;

/** Batch account summaries, derived from the existing submission authority only. */
export async function getImageLearningSummaries(connections, provider, nowMs = Date.now(), { history = false } = {}) {
  const db = await getAdapter();
  requireDurableAdapter(db);
  if (!/^[a-z0-9_-]{1,80}$/.test(String(provider || "")) || !Number.isFinite(nowMs)) {
    throw new TypeError("Invalid image learning scope");
  }
  const ids = [...new Set((connections || []).filter((connection) => connection?.provider === provider)
    .map((connection) => boundedText(connection?.id, 160)).filter(Boolean))];
  const output = new Map(ids.map((id) => [id, {
    counts: { calls24h: 0, callsTotal: 0 }, models: [], coverage: { recordedSince: null, priorHistoryComplete: false },
    scope: { kind: "connection_local", identityEvidence: "connection_local", linkedCredentials: 1 },
  }]));
  if (!ids.length) return output;

  const groups = new Map();
  for (const connection of (connections || []).filter((entry) => output.has(entry?.id))) {
    const identity = imageQuotaIdentity(connection);
    const generation = imageQuotaIdentityGeneration(connection);
    const key = JSON.stringify([identity, generation]);
    if (!groups.has(key)) groups.set(key, { identity, generation, evidence: imageQuotaIdentityType(connection), connections: [] });
    groups.get(key).connections.push(connection);
  }

  const cutoff = new Date(nowMs - IMAGE_REQUEST_USAGE_WINDOW_MS).toISOString();
  for (const group of groups.values()) {
    const connectionIds = [...new Set(group.connections.map((connection) => connection.id).filter(Boolean))];
    const legacyIdentityScope = connectionIds.length
      ? `(supplierIdentity = ? AND identityGeneration = ?) OR (supplierIdentity IS NULL AND connectionId IN (${connectionIds.map(() => "?").join(", ")}))`
      : "supplierIdentity = ? AND identityGeneration = ?";
    const totals = db.all(
      "SELECT model, COUNT(*) AS callsTotal, SUM(CASE WHEN dispatchedAt >= ? THEN 1 ELSE 0 END) AS calls24h, " +
        "SUM(CASE WHEN outcome = 'succeeded' THEN 1 ELSE 0 END) AS successfulCalls, " +
        "SUM(COALESCE(outputCount, 0)) AS images, SUM(CASE WHEN outcome = 'quota_rejected' THEN 1 ELSE 0 END) AS quotaRejections, " +
        "SUM(CASE WHEN outcome IN ('in_flight', 'outcome_unknown') THEN 1 ELSE 0 END) AS unknownOutcomes, " +
        `MIN(dispatchedAt) AS recordedSince, MAX(CASE WHEN outcome = 'succeeded' THEN dispatchedAt END) AS lastSuccessfulAt ` +
        `FROM imageQuotaRequestSubmissions WHERE provider = ? AND (${legacyIdentityScope}) GROUP BY model ORDER BY model`,
      [cutoff, provider, group.identity, group.generation, ...(connectionIds.length ? connectionIds : [])],
    );
    const groupSummary = {
      counts: { calls24h: 0, callsTotal: 0 }, models: [], coverage: { recordedSince: null, priorHistoryComplete: false },
      scope: { kind: group.evidence === "connection_local" ? "credential" : "quota_group",
        identityEvidence: group.evidence, linkedCredentials: group.connections.length },
    };
    for (const total of totals) {
      const callsTotal = Number(total.callsTotal) || 0;
      const selected=readImageLearningScope(db,provider,group.identity,group.generation,total.model,{connectionIds,limit:IMAGE_LEARNING_HISTORY_LIMIT});
      const events=selected.events;
      const learning = estimateImageQuotaLearning(events, { truncated: selected.truncated, now: nowMs });
      learning.quotaScope=selected.scope;learning.estimate.quotaScope=selected.scope.kind;
      if(selected.scope.ambiguous){learning.estimate={...learning.estimate,state:'ambiguous',windowSeconds:null,callLimit:null,remainingPercentage:null,resetAt:null};learning.diagnostics.fits=[];learning.diagnostics.fixedResetFits=[];learning.learnedNextCheck=null;if(learning.nextCheck?.source==='learned_window')learning.nextCheck=null;}
      const lastRejection = db.get(
        "SELECT dispatchedAt, completedAt, retryAt, confidence, quotaObservations FROM imageQuotaRequestSubmissions " +
          `WHERE provider = ? AND (${legacyIdentityScope}) AND model = ? AND outcome = 'quota_rejected' ` +
          "ORDER BY COALESCE(completedAt, dispatchedAt) DESC, id DESC LIMIT 1",
        [provider, group.identity, group.generation, ...(connectionIds.length ? connectionIds : []), total.model],
      );
      if (lastRejection && selected.scope.kind!=="shared_image_quota") {
        const confidence = TRACE_CONFIDENCE.has(lastRejection.confidence) ? lastRejection.confidence : "unknown";
        learning.last429 = { at: lastRejection.completedAt || lastRejection.dispatchedAt, retryAt: lastRejection.retryAt || null, confidence };
        const superseded = total.lastSuccessfulAt && Date.parse(total.lastSuccessfulAt) > Date.parse(learning.last429.at);
        if (lastRejection.retryAt && !superseded) learning.nextCheck = { at: lastRejection.retryAt, confidence, source: imageQuotaWaitSource(confidence, traceRetrySource(lastRejection.quotaObservations, lastRejection.retryAt)) };
        else if (learning.nextCheck?.source !== "learned_window") learning.nextCheck = null;
      }
      const counts = Object.fromEntries(["calls24h", "callsTotal", "successfulCalls", "images", "quotaRejections", "unknownOutcomes"]
        .map((key) => [key, Number(total[key]) || 0]));
      groupSummary.counts.calls24h += counts.calls24h;
      groupSummary.counts.callsTotal += counts.callsTotal;
      if (!groupSummary.coverage.recordedSince || total.recordedSince < groupSummary.coverage.recordedSince) {
        groupSummary.coverage.recordedSince = total.recordedSince;
      }
      const historyEvents = history ? events.map((event) => ({ at: event.dispatchedAt, completedAt: event.completedAt || null,
        outcome: TRACE_OUTCOMES.has(event.outcome) ? event.outcome : "outcome_unknown",
        httpStatus: event.httpStatus ?? null, retryAt: event.retryAt || null,
        confidence: TRACE_CONFIDENCE.has(event.confidence) ? event.confidence : "unknown", outputCount: event.outputCount ?? null })) : null;
      groupSummary.models.push({ model: total.model, counts, ...learning,
        forecastChecks: imageQuotaLearningPredictionChecks(db, provider, group.identity, group.generation, selected.predictionModel),
        ...(history ? { history: historyEvents, historyTruncated: selected.truncated } : {}) });
    }
    for (const connection of group.connections) output.set(connection.id, groupSummary);
  }
  return output;
}

/** Bounded, sanitized passive history. Coverage explicitly excludes pre-upgrade deletions. */
export async function getImageLearningHistory(connection, { nowMs = Date.now(), model = null } = {}) {
  const summaries = await getImageLearningSummaries([connection], connection?.provider, nowMs, { history: true });
  const summary = summaries.get(connection?.id);
  if (!summary) throw new TypeError("Invalid image learning connection");
  return { connectionId: connection.id, provider: connection.provider, scope: summary.scope,
    counts: summary.counts, coverage: summary.coverage,
    models: model ? summary.models.filter((entry) => entry.model === model) : summary.models };
}
