import {getImageQuotaAnalytics,parseImageAnalyticsQuery} from "@/lib/db/repos/imageQuotaAnalytics.js";
import { getImageQuotaInsights, getImageQuotaModelCatalog, parseImageInsightQuery, IMAGE_INSIGHT_LIMITS } from "@/lib/db/repos/imageQuotaInsights.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getProviderConnectionById, getProviderConnections } from "@/lib/localDb";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { isAuthenticated } from "@/dashboardGuard";
import {
  getImageQuotaState,
  getLocalImageCapacity,
  getImageRequestTrace,
  getImageRequestUsageSummary,
  getImageLearningHistory,
  getImageLearningSummaries,
  imageQuotaAccountReference,
  imageQuotaIdentityType,
  writeImageQuotaPolicy,
} from "@/lib/db/repos/imageQuotaRepo.js";
import { getImageSupplierAdmissionStatus } from "@/sse/services/imageSupplierAdmission.js";
import { effectiveImageQuotaEligibility } from "@/sse/services/imageQuotaEligibility.js";
import { getAntigravityQuotaBlockForConnection, getAntigravityQuotaCache } from "@/sse/services/antigravityQuota.js";
import { IMAGE_QUOTA_CONFIG, imagePolicyGroup } from "open-sse/config/imageQuotaConfig.js";
import { normalizeGeminiProjectId } from "@/lib/geminiProjectId";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import { sanitizeImageUsageEvidence } from "open-sse/services/usage/imageEvidence.js";

export const dynamic = "force-dynamic";

const CAPABILITY = "image_generation";
const ID_KEY_RE = /^[A-Za-z0-9._:-]{8,120}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function safeText(value, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function safeTimestamp(value) {
  const timestamp = safeText(value, 80);
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return null;
  return new Date(timestamp).toISOString();
}

function providerErrorStatus(connection) {
  const value = connection?.errorCode;
  const status = typeof value === "number" ? value : Number(value);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

function providerErrorClass(status) {
  if (status === null) return null;
  if (status === 401) return "authentication";
  if (status === 402) return "billing";
  if (status === 403) return "permission_or_model_access";
  if (status === 404) return "model_not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_server_error";
  return "provider_rejected";
}

function serviceTokenMatches(request) {
  const expected = process.env.AURIX_IMAGE_QUOTA_MANAGEMENT_TOKEN;
  const authorization = request.headers.get("authorization") || "";
  if (!expected || !authorization.startsWith("Bearer ")) return false;
  const supplied = authorization.slice(7);
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

async function authorize(request) {
  if (serviceTokenMatches(request)) return { principal: "service:aurix", source: "service" };
  if (!(await isAuthenticated(request))) return null;

  const session = await getDashboardAuthSession(request.cookies?.get?.("auth_token")?.value);
  if (!session) return null;
  const identity = session?.sub || session?.oidcEmail || session?.samlEmail || session?.email || "operator";
  return { principal: `dashboard:${safeText(String(identity), 140)}`, source: "dashboard" };
}

function connectionLabel(connection) {
  let value = safeText(connection?.displayName || connection?.name, 100);
  if (!value || /[A-Za-z0-9_-]{40,}/.test(value)) {
    value = `Account ${String(connection?.id || "").slice(0, 8)}`;
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    const [localPart, domain] = value.split("@");
    value = `${localPart.slice(0, 1)}•••@${domain}`;
  }
  return value;
}

function antigravityQuotaBlockFor(connection, model, cache) {
  if (!model || connection.provider !== "antigravity") return null;
  return getAntigravityQuotaBlockForConnection(connection.id, model, cache);
}

function projectConstraint(row, nowMs, probe = null) {
  const scope = parseJson(row.appliesToModels, []);
  const expired = row.retryAt && Date.parse(row.retryAt) <= nowMs;
  const pending = Boolean(probe?.probeDispatchedAt);
  const probeLeaseExpiresAt = probe?.probeLeaseExpiresAt || null;
  return {
    constraintId: row.constraintId,
    groupId: row.quotaGroupId,
    model: row.observedModel || null,
    appliesToModels: Array.isArray(scope) ? scope.filter((model) => typeof model === "string" && model.length > 0) : [],
    state: probe ? "probe_in_progress" : expired ? "probe_eligible" : "quota_blocked",
    retryAt: pending ? null : probeLeaseExpiresAt || row.retryAt || null,
    confidence: pending ? "unknown" : probeLeaseExpiresAt ? "estimated" : row.confidence || "unknown",
    observedAt: row.observedAt || null,
    source: row.source || "unknown",
    revision: Number(row.revision) || 0,
  };
}

async function getImageQuotaProjection(providerFilter, model, modelProvider = "") {
  const providers = providerFilter === "all"
    ? Object.keys(IMAGE_QUOTA_CONFIG.providers)
    : [providerFilter];
  const nowMs = Date.now();
  const antigravityCache = getAntigravityQuotaCache();
  const projected = [];

  for (const provider of providers) {
    const connections = await getProviderConnections({ provider });
    const scopedModel = model && (!modelProvider || modelProvider === provider) ? model : null;
    const states = await getImageQuotaState(connections, provider, CAPABILITY, scopedModel, nowMs);
    const requestUsage = await getImageRequestUsageSummary(connections, provider, nowMs);
    const learning = await getImageLearningSummaries(connections, provider, nowMs);
    const identityCounts = new Map();
    for (const connection of connections) {
      const state = states.get(connection.id);
      const key = `${state.identity}\n${state.generation}`;
      identityCounts.set(key, (identityCounts.get(key) || 0) + 1);
    }

    for (const connection of connections) {
      const state = states.get(connection.id);
      const lastErrorStatus = providerErrorStatus(connection);
      const activeProbes = new Map((state.probeInProgressRows || []).map((row) => [
        `${row.quotaGroupId}\n${row.constraintId}`,
        row,
      ]));
      const quotaConstraints = [...state.blockingRows, ...state.expiredRows]
        .map((row) => projectConstraint(
          row,
          nowMs,
          activeProbes.get(`${row.quotaGroupId}\n${row.constraintId}`) || null,
        ))
        .sort((a, b) => (a.retryAt || "9999").localeCompare(b.retryAt || "9999"));
      const providerQuotaBlock = antigravityQuotaBlockFor(connection, scopedModel, antigravityCache);
      let eligibility = effectiveImageQuotaEligibility(connection, state, {
        model: scopedModel,
        nowMs,
        antigravityQuotaBlock: providerQuotaBlock,
      });
      const localCapacity = await getLocalImageCapacity(connection, scopedModel, nowMs);
      if (localCapacity && eligibility.eligible) {
        eligibility = { eligible: false, ...localCapacity };
      } else if (localCapacity && !["manual_paused", "account_disabled", "model_not_enabled"].includes(eligibility.state)) {
        const retryAt = eligibility.retryAt && localCapacity.retryAt
          ? [eligibility.retryAt, localCapacity.retryAt].sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1)
          : null;
        eligibility = { ...eligibility, retryAt, source: "mixed_quota_sources",
          confidence: !retryAt || eligibility.confidence === "unknown" ? "unknown" : "estimated" };
      }
      const accountPolicies = (state.policies || []).filter(policy => policy.quotaGroupId === imagePolicyGroup(provider));
      const policy = accountPolicies.find(policy => policy.policyState === "paused") || accountPolicies.sort((a,b) => b.revision-a.revision)[0] || (!state.policies ? state.policy : null);
      const policyRevision = accountPolicies.reduce((max, policy) => Math.max(max, Number(policy.revision) || 0), !state.policies ? Number(state.policyRevision) || 0 : 0);
      const observedAt = quotaConstraints.map((constraint) => constraint.observedAt).filter(Boolean).sort().at(-1)
        || eligibility.observedAt
        || null;
      const groupKey = `${state.identity}\n${state.generation}`;
      const projectIdentityConfigured = provider !== "gemini" || Boolean(normalizeGeminiProjectId(
        connection.projectId || connection.providerSpecificData?.googleCloudProjectId || connection.providerSpecificData?.projectId,
      ));
      const hasGlobalBlock = quotaConstraints.some((constraint) => constraint.appliesToModels.includes("*"));
      const modelScopedLimits = !model && !hasGlobalBlock && quotaConstraints.length > 0;
      const routeState = !projectIdentityConfigured
        ? "identity_required"
        : modelScopedLimits && eligibility.state === "quota_blocked"
          ? "model_scoped_limits"
          : eligibility.state;
      const nextKnownAt = !projectIdentityConfigured
        ? null
        : model
        ? eligibility.retryAt || null
        : modelScopedLimits
          ? quotaConstraints.map((constraint) => constraint.retryAt).filter(Boolean).sort()[0] || null
          : eligibility.retryAt || null;

      projected.push({
        connectionId: connection.id,
        accountRef: imageQuotaAccountReference(connection.id),
        provider,
        accountLabel: connectionLabel(connection),
        accountEnabled: connection.isActive !== false,
        authenticationState: safeText(connection.testStatus || "unknown", 40),
        providerErrorStatus: lastErrorStatus,
        providerErrorClass: providerErrorClass(lastErrorStatus),
        providerErrorScope: lastErrorStatus === null ? null : "connection_wide",
        providerErrorObservedAt: safeTimestamp(connection.lastErrorAt),
        identityEvidence: imageQuotaIdentityType(connection),
        projectIdentityConfigured,
        linkedCredentialCount: identityCounts.get(groupKey) || 1,
        capability: CAPABILITY,
        quotaGroupId: IMAGE_QUOTA_CONFIG.providers[provider].quotaGroupId,
        routeState,
        eligible: !projectIdentityConfigured ? false : modelScopedLimits ? null : eligibility.eligible,
        nextKnownAt,
        availabilityConfidence: eligibility.confidence || "unknown",
        availabilitySource: eligibility.source || null,
        observedAt,
        constraints: quotaConstraints,
        requestUsage: requestUsage.get(connection.id) || null,
        learning: learning.get(connection.id),
        providerUsageEvidence: sanitizeImageUsageEvidence(connection.providerSpecificData?.imageQuotaUsageEvidence, provider),
        modelPolicies: (state.policies || []).filter(policy => policy.quotaGroupId.startsWith(`${imagePolicyGroup(provider)}:model:`)).map(policy => ({
          model: policy.quotaGroupId.slice(`${imagePolicyGroup(provider)}:model:`.length),
          state: policy.policyState, revision: Number(policy.revision) || 0, updatedAt: policy.updatedAt,
        })),
        manualPolicy: {
          state: policy?.policyState || "enabled",
          revision: policyRevision,
          reason: policy?.reason || null,
          updatedAt: policy?.updatedAt || null,
        },
      });
    }
  }

  return {
    capability: CAPABILITY,
    provider: providerFilter,
    model: model || null,
    modelProvider: model && modelProvider ? modelProvider : null,
    generatedAt: new Date(nowMs).toISOString(),
    source: "router_state",
    rows: projected,
  };
}

export async function GET(request) {
  const principal = await authorize(request);
  if (!principal) return json({ error: { code: "unauthorized", message: "Authentication required" } }, 401);

  const url = new URL(request.url);
  if (url.searchParams.has("view")) {
    if (url.searchParams.get("view") === "analytics") {
      let query;
      try {query=parseImageAnalyticsQuery(url.searchParams);} catch {return json({error:{code:"invalid_analytics_query"}},400);}
      try {
        if(query.connection){const connection=await getProviderConnectionById(query.connection);if(!connection||!IMAGE_QUOTA_CONFIG.providers[connection.provider]||query.provider&&connection.provider!==query.provider)return json({error:{code:"image_route_not_found"}},404);}
        return json(await getImageQuotaAnalytics(query));
      } catch {return json({error:{code:"image_analytics_unavailable"}},503);}
    }
    if (url.searchParams.get("view") === "capabilities" && [...url.searchParams.keys()].length === 1) {
      try {
        return json({ ...IMAGE_INSIGHT_LIMITS, views: ["insights"], providers: Object.keys(IMAGE_QUOTA_CONFIG.providers), models: await getImageQuotaModelCatalog() });
      } catch {
        return json({ error: { code: "image_catalog_unavailable", message: "Image model catalog is temporarily unavailable" } }, 503);
      }
    }
    let query;
    try { query = parseImageInsightQuery(url.searchParams); }
    catch { return json({ error: { code: "invalid_insight_query", message: "Invalid or excessive insight scope/range" } }, 400); }
    try {
      const connection = await getProviderConnectionById(query.connection);
      if (!connection || !IMAGE_QUOTA_CONFIG.providers[connection.provider]) return json({ error: { code: "image_route_not_found", message: "Configured image route was not found" } }, 404);
      return json(await getImageQuotaInsights(connection, query));
    }
    catch { return json({ error: { code: "image_insights_unavailable", message: "Image evidence is temporarily unavailable" } }, 503); }
  }
  const routerRequestIds = url.searchParams.getAll("router_request_id");
  const clientOperationIds = url.searchParams.getAll("client_operation_id");
  const traceLookupRequested = routerRequestIds.length > 0 || clientOperationIds.length > 0;
  if (traceLookupRequested) {
    const hasRouterId = routerRequestIds.length === 1 && UUID_RE.test(routerRequestIds[0]);
    const hasOperationId = clientOperationIds.length === 1 && UUID_RE.test(clientOperationIds[0]);
    if ((routerRequestIds.length > 0 && !hasRouterId)
      || (clientOperationIds.length > 0 && !hasOperationId)
      || (routerRequestIds.length > 0) === (clientOperationIds.length > 0)
      || [...url.searchParams.keys()].some((key) => !["router_request_id", "client_operation_id"].includes(key))) {
      return json({ error: { code: "invalid_trace_lookup", message: "Provide exactly one image request identifier" } }, 400);
    }
    try {
      const trace = await getImageRequestTrace(hasRouterId
        ? { routerRequestId: routerRequestIds[0] }
        : { clientOperationId: clientOperationIds[0] });
      return json(trace);
    } catch (error) {
      if (error instanceof TypeError) {
        return json({ error: { code: "invalid_trace_lookup", message: "Provide exactly one valid image request identifier" } }, 400);
      }
      console.warn("[IMAGE_QUOTA] Request trace unavailable", error?.code || error?.name || "error");
      return json({ error: { code: "image_request_trace_unavailable", message: "Image request trace is temporarily unavailable" } }, 503);
    }
  }

  if (url.searchParams.has("history")) {
    const historyIds = url.searchParams.getAll("history");
    const connectionId = historyIds[0];
    const models = url.searchParams.getAll("model");
    if ([...url.searchParams.keys()].some((key) => !["history", "model"].includes(key))
      || historyIds.length !== 1 || !connectionId || connectionId.length > 160
      || connectionId !== connectionId.trim() || models.length > 1 || (models[0]?.length || 0) > 256) {
      return json({ error: { code: "invalid_history_lookup", message: "Provide one connection and optional exact model" } }, 400);
    }
    try {
      const connection = await getProviderConnectionById(connectionId);
      if (!connection || !IMAGE_QUOTA_CONFIG.providers[connection.provider]) {
        return json({ error: { code: "image_route_not_found", message: "Configured image route was not found" } }, 404);
      }
      return json(await getImageLearningHistory(connection, { model: models[0] || null }));
    } catch (error) {
      console.warn("[IMAGE_QUOTA] Learning history unavailable", error?.code || error?.name || "error");
      return json({ error: { code: "image_learning_unavailable", message: "Image learning history is temporarily unavailable" } }, 503);
    }
  }

  const providerValues = url.searchParams.getAll("provider");
  const modelValues = url.searchParams.getAll("model");
  const modelProviderValues = url.searchParams.getAll("model_provider");
  if (providerValues.length > 1 || modelValues.length > 1 || modelProviderValues.length > 1) {
    return json({ error: { code: "invalid_image_quota_filter", message: "Use one provider and model filter" } }, 400);
  }
  const provider = safeText(providerValues[0] || "all", 80);
  const model = safeText(modelValues[0] || "", 256);
  const modelProvider = safeText(modelProviderValues[0] || "", 80);
  if (provider !== "all" && !IMAGE_QUOTA_CONFIG.providers[provider]) {
    return json({ error: { code: "unsupported_provider", message: "Image quota projection is not configured for this provider" } }, 400);
  }
  if ((modelProvider && !model) || (modelProvider && !IMAGE_QUOTA_CONFIG.providers[modelProvider])
    || (modelProvider && provider !== "all" && provider !== modelProvider)) {
    return json({ error: { code: "invalid_image_quota_filter", message: "The provider-qualified model filter is invalid" } }, 400);
  }

  try {
    const projection = await getImageQuotaProjection(provider, model, modelProvider);
    if (principal.source === "dashboard") {
      try {
        projection.supplierAdmission = await getImageSupplierAdmissionStatus();
      } catch {
        projection.supplierAdmission = {
          generatedAt: new Date().toISOString(),
          state: "unavailable",
          configured: false,
          callerCount: 0,
          routeCount: 0,
          budgets: [],
        };
      }
    }
    return json(projection);
  } catch (error) {
    console.warn("[IMAGE_QUOTA] Status projection unavailable", error?.code || error?.name || "error");
    return json({ error: { code: "image_quota_state_unavailable", message: "Image quota status is temporarily unavailable" } }, 503);
  }
}

export async function PATCH(request) {
  const principal = await authorize(request);
  if (!principal) return json({ error: { code: "unauthorized", message: "Authentication required" } }, 401);

  const idempotencyKey = safeText(request.headers.get("idempotency-key"), 120);
  if (!ID_KEY_RE.test(idempotencyKey)) {
    return json({ error: { code: "invalid_idempotency_key", message: "A valid Idempotency-Key header is required" } }, 400);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { code: "invalid_request", message: "A JSON request body is required" } }, 400);
  }
  const allowedFields = new Set(["connectionId", "model", "action", "reason", "expectedRevision"]);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowedFields.has(key))) {
    return json({ error: { code: "invalid_request", message: "Unexpected image policy fields" } }, 400);
  }

  const connectionId = safeText(body.connectionId, 160);
  const model = body.model == null ? null : safeText(body.model, 256);
  const action = safeText(body.action, 16);
  const reason = safeText(body.reason, 240);
  const expectedRevision = Number(body.expectedRevision);
  if (!connectionId || (body.model != null && (typeof body.model !== "string" || !model || model.length !== body.model.trim().length)) || !["pause", "resume"].includes(action) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || reason.length < 4) {
    return json({ error: { code: "invalid_request", message: "Connection, action, reason, and current revision are required" } }, 400);
  }

  try {
    const connection = await getProviderConnectionById(connectionId);
    if (!connection || !IMAGE_QUOTA_CONFIG.providers[connection.provider]) {
      return json({ error: { code: "image_route_not_found", message: "Configured image route was not found" } }, 404);
    }
    if (connection.provider === "gemini" && !normalizeGeminiProjectId(
      connection.projectId || connection.providerSpecificData?.googleCloudProjectId || connection.providerSpecificData?.projectId,
    )) {
      return json({
        error: {
          code: "image_project_identity_required",
          message: "Set the Google Cloud project ID before managing this Gemini image quota group",
        },
      }, 422);
    }
    const mapping = IMAGE_QUOTA_CONFIG.providers[connection.provider];
    const quotaGroupId = imagePolicyGroup(connection.provider, model);
    if (model) {
      const catalog = await getImageQuotaModelCatalog();
      if (!catalog.some(entry => entry.provider === connection.provider && entry.id === model)) {
        const saved = (await getImageQuotaState([connection], connection.provider, mapping.capability, model)).get(connection.id);
        if (!saved?.policies?.some(policy => policy.quotaGroupId === quotaGroupId)) {
          return json({ error: { code: "image_model_not_found", message: "Select an image model supported by this provider" } }, 422);
        }
      }
    }
    const requestHash = createHash("sha256").update(JSON.stringify({
      connectionId,
      provider: connection.provider,
      capability: mapping.capability,
      quotaGroupId,
      action,
      reason,
      expectedRevision,
    })).digest("hex");
    const receipt = await writeImageQuotaPolicy({
      connection,
      capability: mapping.capability,
      quotaGroupId,
      action,
      reason,
      principal: principal.principal,
      idempotencyKey,
      requestHash,
      expectedRevision,
    });
    return json({ receipt });
  } catch (error) {
    if (error?.code === "IDEMPOTENCY_KEY_REUSED") {
      return json({ error: { code: error.code, message: error.message } }, 409);
    }
    if (error?.code === "STATE_REVISION_CONFLICT") {
      return json({ error: { code: error.code, message: error.message, current: error.current } }, 409);
    }
    console.warn("[IMAGE_QUOTA] Policy update failed", error?.code || error?.name || "error");
    return json({ error: { code: "image_policy_commit_failed", message: "Image policy could not be committed" } }, 503);
  }
}
