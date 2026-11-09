import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  getProviderConnections: vi.fn(),
  getDashboardAuthSession: vi.fn(),
  isAuthenticated: vi.fn(),
  getImageQuotaState: vi.fn(),
  getLocalImageCapacity: vi.fn(),
  getImageRequestTrace: vi.fn(),
  getImageRequestUsageSummary: vi.fn(),
  getImageLearningHistory: vi.fn(),
  getImageLearningSummaries: vi.fn(),
  getImageSupplierAdmissionStatus: vi.fn(),
  imageQuotaAccountReference: vi.fn(),
  imageQuotaIdentityType: vi.fn(),
  writeImageQuotaPolicy: vi.fn(),
  effectiveImageQuotaEligibility: vi.fn(),
  getAntigravityQuotaCache: vi.fn(),
  getAntigravityQuotaBlockForConnection: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => new Response(JSON.stringify(body), {
      status: init.status || 200,
      headers: init.headers,
    }),
  },
}));
vi.mock("../../src/lib/localDb.js", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getProviderConnections: mocks.getProviderConnections,
}));
vi.mock("../../src/lib/auth/dashboardSession.js", () => ({
  getDashboardAuthSession: mocks.getDashboardAuthSession,
}));
vi.mock("../../src/dashboardGuard.js", () => ({ isAuthenticated: mocks.isAuthenticated }));
vi.mock("../../src/lib/db/repos/imageQuotaRepo.js", () => ({
  getImageQuotaState: mocks.getImageQuotaState,
  getLocalImageCapacity: mocks.getLocalImageCapacity,
  getImageRequestTrace: mocks.getImageRequestTrace,
  getImageRequestUsageSummary: mocks.getImageRequestUsageSummary,
  getImageLearningHistory: mocks.getImageLearningHistory,
  getImageLearningSummaries: mocks.getImageLearningSummaries,
  imageQuotaAccountReference: mocks.imageQuotaAccountReference,
  imageQuotaIdentityType: mocks.imageQuotaIdentityType,
  writeImageQuotaPolicy: mocks.writeImageQuotaPolicy,
}));
vi.mock("../../src/sse/services/imageQuotaEligibility.js", () => ({
  effectiveImageQuotaEligibility: mocks.effectiveImageQuotaEligibility,
}));
vi.mock("../../src/sse/services/imageSupplierAdmission.js", () => ({
  getImageSupplierAdmissionStatus: mocks.getImageSupplierAdmissionStatus,
}));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: mocks.getAntigravityQuotaCache,
  getAntigravityQuotaBlockForConnection: mocks.getAntigravityQuotaBlockForConnection,
}));
vi.mock("open-sse/config/imageQuotaConfig.js", () => ({
  IMAGE_QUOTA_CONFIG: {
    providers: {
      antigravity: { capability: "image_generation", quotaGroupId: "antigravity.image_generation" },
      codex: { capability: "image_generation", quotaGroupId: "codex.image_generation" },
      gemini: { capability: "image_generation", quotaGroupId: "gemini_api.image_generation" },
    },
  },
  imagePolicyGroup: (provider, model = null) => {
    const base = {
      antigravity: "antigravity.image_generation",
      codex: "codex.image_generation",
      gemini: "gemini_api.image_generation",
    }[provider];
    return model ? `${base}:model:${model}` : base;
  },
}));

import { GET, PATCH } from "../../src/app/api/private/image-quota/v1/route.js";

const connection = {
  id: "codex-account-1",
  provider: "codex",
  isActive: true,
  name: "operator account",
  providerSpecificData: { chatgptAccountId: "private-account-identity" },
};

async function json(response) {
  return { status: response.status, body: await response.json() };
}

describe("image quota management route", () => {
  it("returns authenticated passive exact-model history without refreshing providers", async () => {
    mocks.isAuthenticated.mockResolvedValue(true);
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.getImageLearningHistory.mockResolvedValue({ connectionId: connection.id, provider: "codex", coverage: { priorHistoryComplete: false }, models: [] });
    const response = await GET(new Request(`http://localhost/api/private/image-quota/v1?history=${connection.id}&model=gpt-image-2`));
    expect(response.status).toBe(200);
    expect(mocks.getImageLearningHistory).toHaveBeenCalledWith(connection, { model: "gpt-image-2" });
    expect(mocks.getImageQuotaState).not.toHaveBeenCalled();
    expect(mocks.getImageSupplierAdmissionStatus).not.toHaveBeenCalled();
  });

  it("rejects duplicate history parameters and trace/history mixtures", async () => {
    mocks.isAuthenticated.mockResolvedValue(true);
    expect((await GET(new Request("http://localhost/api/private/image-quota/v1?history=a&history=b"))).status).toBe(400);
    expect((await GET(new Request("http://localhost/api/private/image-quota/v1?history=a&router_request_id=75111111-1111-4111-8111-111111111111"))).status).toBe(400);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AURIX_IMAGE_QUOTA_MANAGEMENT_TOKEN;
    mocks.isAuthenticated.mockResolvedValue(false);
    mocks.getDashboardAuthSession.mockResolvedValue({ sub: "operator-1" });
    mocks.getProviderConnections.mockResolvedValue([connection]);
    mocks.getImageLearningSummaries.mockResolvedValue(new Map([[connection.id, { counts: { calls24h: 2, callsTotal: 8 }, models: [], coverage: { recordedSince: null, priorHistoryComplete: false } }]]));
    mocks.getImageQuotaState.mockResolvedValue(new Map([[connection.id, {
      identity: "codex:private-account-identity",
      generation: 1,
      blockingRows: [],
      expiredRows: [],
      probeInProgressRows: [],
      policy: null,
      manualPolicy: null,
      policyRevision: 0,
    }]]));
    mocks.getImageRequestTrace.mockImplementation(async ({ routerRequestId, clientOperationId }) => ({
      schema_version: "9router.image_request_trace.v1",
      status: "found",
      lookup: routerRequestId ? { router_request_id: routerRequestId } : { client_operation_id: clientOperationId },
      requests: [],
      truncated: false,
      retention_days: 7,
    }));
    mocks.getImageRequestUsageSummary.mockResolvedValue(new Map());
    mocks.getImageSupplierAdmissionStatus.mockResolvedValue({
      generatedAt: "2026-10-22T00:00:00.000Z", state: "protected", configured: true,
      callerCount: 1, routeCount: 2, budgets: [],
    });
    mocks.getLocalImageCapacity.mockResolvedValue(null);
    mocks.imageQuotaIdentityType.mockReturnValue("provider_reported");
    mocks.imageQuotaAccountReference.mockImplementation((connectionId) =>
      `acct_${String(connectionId).replace(/[^a-f0-9]/gi, "").padEnd(24, "0").slice(0, 24).toLowerCase()}`);
    mocks.effectiveImageQuotaEligibility.mockReturnValue({
      eligible: true,
      state: "eligible_unreported",
      retryAt: null,
      confidence: "unknown",
    });
    mocks.getAntigravityQuotaCache.mockReturnValue(new Map());
    mocks.getAntigravityQuotaBlockForConnection.mockReturnValue(null);
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.writeImageQuotaPolicy.mockResolvedValue({
      connectionId: connection.id,
      capability: "image_generation",
      policyState: "paused",
      revision: 1,
      replayed: false,
    });
  });

  it("rejects requests without dashboard or AuriX credentials", async () => {
    const response = await GET(new Request("https://router.invalid/api/private/image-quota/v1"));
    const result = await json(response);
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe("unauthorized");
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();

    const update = await PATCH(new Request("https://router.invalid/api/private/image-quota/v1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "pause-unauth-001" },
      body: JSON.stringify({
        connectionId: connection.id,
        action: "pause",
        reason: "Operator review in progress",
        expectedRevision: 0,
      }),
    }));
    expect(update.status).toBe(401);
    expect(mocks.writeImageQuotaPolicy).not.toHaveBeenCalled();
  });

  it("rejects anonymous quota control when dashboard login is disabled", async () => {
    mocks.isAuthenticated.mockResolvedValue(true);
    mocks.getDashboardAuthSession.mockResolvedValue(null);

    const response = await GET(new Request("https://router.invalid/api/private/image-quota/v1"));
    const result = await json(response);
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe("unauthorized");
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();

    const update = await PATCH(new Request("https://router.invalid/api/private/image-quota/v1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "pause-login-disabled-001" },
      body: JSON.stringify({
        connectionId: connection.id,
        action: "pause",
        reason: "Anonymous control must remain denied",
        expectedRevision: 0,
      }),
    }));
    expect(update.status).toBe(401);
    expect(mocks.writeImageQuotaPolicy).not.toHaveBeenCalled();
  });

  it("returns a state-only projection to the AuriX service token", async () => {
    process.env.AURIX_IMAGE_QUOTA_MANAGEMENT_TOKEN = "router-service-token";
    const response = await GET(new Request("https://router.invalid/api/private/image-quota/v1?provider=codex", {
      headers: { Authorization: "Bearer router-service-token" },
    }));
    const result = await json(response);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      source: "router_state",
      provider: "codex",
      rows: [{ connectionId: connection.id, routeState: "eligible_unreported" }],
    });
    expect(JSON.stringify(result.body)).not.toContain("private-account-identity");
    expect(result.body.supplierAdmission).toBeUndefined();
    expect(mocks.getImageSupplierAdmissionStatus).not.toHaveBeenCalled();
    expect(mocks.getProviderConnections).toHaveBeenCalledWith({ provider: "codex" });
    expect(mocks.getAntigravityQuotaCache).toHaveBeenCalled();
  });

  it("projects local capacity without changing provider locks or generating requests", async () => {
    process.env.AURIX_IMAGE_QUOTA_MANAGEMENT_TOKEN = "router-service-token";
    const retryAt = "2026-10-28T00:00:00.000Z";
    mocks.getLocalImageCapacity.mockResolvedValue({ state: "local_capacity_limited", source: "local_policy", retryAt, confidence: "estimated" });
    const result = await json(await GET(new Request("https://router.invalid/api/private/image-quota/v1?provider=codex&model=gpt-image-2", {
      headers: { Authorization: "Bearer router-service-token" },
    })));
    expect(result.status).toBe(200);
    expect(result.body.rows[0]).toMatchObject({ routeState: "local_capacity_limited", eligible: false,
      nextKnownAt: retryAt, availabilityConfidence: "estimated", availabilitySource: "local_policy", constraints: [] });
    expect(mocks.writeImageQuotaPolicy).not.toHaveBeenCalled();
  });

  it("does not advertise a shorter provider reset than the local capacity reset", async () => {
    process.env.AURIX_IMAGE_QUOTA_MANAGEMENT_TOKEN = "router-service-token";
    mocks.effectiveImageQuotaEligibility.mockReturnValue({ eligible: false, state: "quota_blocked", retryAt: "2026-10-22T00:00:00Z", confidence: "provider_confirmed" });
    mocks.getLocalImageCapacity.mockResolvedValue({ state: "local_capacity_limited", source: "local_policy", retryAt: "2026-10-28T00:00:00Z", confidence: "estimated" });
    const result = await json(await GET(new Request("https://router.invalid/api/private/image-quota/v1?provider=codex&model=gpt-image-2", {
      headers: { Authorization: "Bearer router-service-token" },
    })));
    expect(result.body.rows[0]).toMatchObject({ eligible: false, nextKnownAt: "2026-10-28T00:00:00Z", availabilityConfidence: "estimated", availabilitySource: "mixed_quota_sources" });
  });

  it("includes saved per-credential image request counts in the status projection", async () => {
    process.env.AURIX_IMAGE_QUOTA_MANAGEMENT_TOKEN = "router-service-token";
    const requestUsage = {
      windowStartedAt: "2026-10-17T12:00:00.000Z",
      windowSeconds: 86_400,
      dispatchedRequests: 7,
      validatedImages: 4,
      quotaRejections: 2,
      unknownOutcomes: 1,
      trackingStartedAt: "2026-10-17T13:00:00.000Z",
      observedAt: "2026-10-18T11:00:00.000Z",
    };
    mocks.getImageRequestUsageSummary.mockResolvedValue(new Map([[connection.id, requestUsage]]));

    const response = await GET(new Request("https://router.invalid/api/private/image-quota/v1?provider=codex", {
      headers: { Authorization: "Bearer router-service-token" },
    }));
    const result = await json(response);

    expect(result.status).toBe(200);
    expect(result.body.rows[0]).toMatchObject({
      connectionId: connection.id,
      requestUsage,
    });
    expect(mocks.getImageRequestUsageSummary).toHaveBeenCalledWith([connection], "codex", expect.any(Number));
  });

  it("adds supplier exposure status only to the authenticated dashboard projection", async () => {
    mocks.isAuthenticated.mockResolvedValue(true);
    mocks.getDashboardAuthSession.mockResolvedValue({ sub: "operator-1" });
    mocks.getImageSupplierAdmissionStatus.mockResolvedValue({
      generatedAt: "2026-10-22T00:00:00.000Z", state: "budget_exhausted", configured: true,
      callerCount: 1, routeCount: 2, budgets: [{ reference: "budget-1", scopeType: "installation" }],
    });

    const result = await json(await GET(new Request("https://router.invalid/api/private/image-quota/v1?provider=gemini")));
    expect(result.status).toBe(200);
    expect(result.body.supplierAdmission).toMatchObject({ state: "budget_exhausted", budgets: [{ reference: "budget-1" }] });
    expect(mocks.getImageSupplierAdmissionStatus).toHaveBeenCalledOnce();
  });

  it("keeps quota status available when the separate supplier summary fails", async () => {
    mocks.isAuthenticated.mockResolvedValue(true);
    mocks.getImageSupplierAdmissionStatus.mockRejectedValue(new Error("private storage detail"));

    const result = await json(await GET(new Request("https://router.invalid/api/private/image-quota/v1?provider=codex")));
    expect(result.status).toBe(200);
    expect(result.body.rows).toHaveLength(1);
    expect(result.body.supplierAdmission).toMatchObject({ state: "unavailable", budgets: [] });
    expect(JSON.stringify(result.body)).not.toContain("private storage detail");
  });

  it("marks Gemini keys without a configured project identity as ineligible", async () => {
    process.env.AURIX_IMAGE_QUOTA_MANAGEMENT_TOKEN = "router-service-token";
    const gemini = { id: "gemini-key-without-project", provider: "gemini", isActive: true, providerSpecificData: {} };
    mocks.getProviderConnections.mockResolvedValue([gemini]);
    mocks.getImageQuotaState.mockResolvedValue(new Map([[gemini.id, {
      identity: `connection:${gemini.id}`,
      generation: 1,
      blockingRows: [],
      expiredRows: [],
      probeInProgressRows: [],
      policy: null,
      manualPolicy: null,
      policyRevision: 0,
    }]]));
    mocks.imageQuotaIdentityType.mockReturnValue("connection_local");

    const result = await json(await GET(new Request("https://router.invalid/api/private/image-quota/v1?provider=gemini", {
      headers: { Authorization: "Bearer router-service-token" },
    })));

    expect(result.status).toBe(200);
    expect(result.body.rows[0]).toMatchObject({
      routeState: "identity_required",
      projectIdentityConfigured: false,
      eligible: false,
      nextKnownAt: null,
    });
  });

  it("projects Gemini API keys as one quota group when they share a project", async () => {
    process.env.AURIX_IMAGE_QUOTA_MANAGEMENT_TOKEN = "router-service-token";
    const first = {
      id: "gemini-key-one",
      provider: "gemini",
      isActive: true,
      providerSpecificData: { googleCloudProjectId: "hualugo-images-prod" },
    };
    const second = {
      id: "gemini-key-two",
      provider: "gemini",
      isActive: true,
      providerSpecificData: { googleCloudProjectId: "HUALUGO-IMAGES-PROD" },
    };
    const state = {
      identity: "gemini_api_project:hualugo-images-prod",
      generation: 1,
      blockingRows: [],
      expiredRows: [],
      probeInProgressRows: [],
      policy: null,
      manualPolicy: null,
      policyRevision: 0,
    };
    mocks.getProviderConnections.mockResolvedValue([first, second]);
    mocks.getImageQuotaState.mockResolvedValue(new Map([[first.id, state], [second.id, state]]));
    mocks.imageQuotaIdentityType.mockReturnValue("operator_configured");

    const result = await json(await GET(new Request("https://router.invalid/api/private/image-quota/v1?provider=gemini", {
      headers: { Authorization: "Bearer router-service-token" },
    })));

    expect(result.status).toBe(200);
    expect(result.body.rows).toHaveLength(2);
    expect(result.body.rows.map((row) => row.linkedCredentialCount)).toEqual([2, 2]);
    expect(result.body.rows.every((row) => row.projectIdentityConfigured)).toBe(true);
  });

  it("projects provider usage source and reset evidence for the selected image model", async () => {
    process.env.AURIX_IMAGE_QUOTA_MANAGEMENT_TOKEN = "router-service-token";
    const antigravity = {
      ...connection,
      id: "antigravity-account-1",
      provider: "antigravity",
    };
    const retryAt = "2026-10-22T08:30:00.000Z";
    const observedAt = "2026-10-16T08:30:00.000Z";
    mocks.getProviderConnections.mockResolvedValue([antigravity]);
    mocks.getImageQuotaState.mockResolvedValue(new Map([[antigravity.id, {
      identity: "antigravity:provider-reported",
      generation: 1,
      blockingRows: [],
      expiredRows: [],
      probeInProgressRows: [],
      policy: null,
      manualPolicy: null,
      policyRevision: 0,
    }]]));
    mocks.getAntigravityQuotaBlockForConnection.mockReturnValue({
      state: "provider_usage_blocked",
      retryAt,
      confidence: "provider_confirmed",
      observedAt,
      source: "antigravity_usage",
    });
    mocks.effectiveImageQuotaEligibility.mockReturnValue({
      eligible: false,
      state: "provider_usage_blocked",
      retryAt,
      confidence: "provider_confirmed",
      observedAt,
      source: "antigravity_usage",
    });

    const response = await GET(new Request("https://router.invalid/api/private/image-quota/v1?provider=antigravity&model=gemini-3.1-flash-image", {
      headers: { Authorization: "Bearer router-service-token" },
    }));
    const result = await json(response);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      model: "gemini-3.1-flash-image",
      rows: [{
        routeState: "provider_usage_blocked",
        eligible: false,
        nextKnownAt: retryAt,
        availabilityConfidence: "provider_confirmed",
        availabilitySource: "antigravity_usage",
        observedAt,
      }],
    });
    expect(mocks.getAntigravityQuotaBlockForConnection).toHaveBeenCalledWith(
      antigravity.id,
      "gemini-3.1-flash-image",
      expect.any(Map),
    );
  });

  it("returns a passive request trace by router ID without reading provider state", async () => {
    process.env.AURIX_IMAGE_QUOTA_MANAGEMENT_TOKEN = "router-service-token";
    const routerRequestId = "7c928d8e-f790-42ec-8bdf-2ee049c06f1e";
    const response = await GET(new Request(`https://router.invalid/api/private/image-quota/v1?router_request_id=${routerRequestId}`, {
      headers: { Authorization: "Bearer router-service-token" },
    }));
    const result = await json(response);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: "found", lookup: { router_request_id: routerRequestId } });
    expect(mocks.getImageRequestTrace).toHaveBeenCalledWith({ routerRequestId });
    expect(mocks.getImageSupplierAdmissionStatus).not.toHaveBeenCalled();
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
    expect(mocks.getAntigravityQuotaCache).not.toHaveBeenCalled();
  });

  it("rejects ambiguous, duplicated, and malformed trace identifiers", async () => {
    process.env.AURIX_IMAGE_QUOTA_MANAGEMENT_TOKEN = "router-service-token";
    const headers = { Authorization: "Bearer router-service-token" };
    for (const query of [
      "router_request_id=7c928d8e-f790-42ec-8bdf-2ee049c06f1e&client_operation_id=84d28c94-ef09-48f9-9c3b-31f2a4c13eac",
      "router_request_id=bad",
      "router_request_id=7c928d8e-f790-42ec-8bdf-2ee049c06f1e&router_request_id=7c928d8e-f790-42ec-8bdf-2ee049c06f1e",
    ]) {
      const result = await json(await GET(new Request(`https://router.invalid/api/private/image-quota/v1?${query}`, { headers })));
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("invalid_trace_lookup");
    }
    expect(mocks.getImageRequestTrace).not.toHaveBeenCalled();
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
  });

  it("projects a sanitized recent provider failure without its raw message", async () => {
    process.env.AURIX_IMAGE_QUOTA_MANAGEMENT_TOKEN = "router-service-token";
    mocks.getProviderConnections.mockResolvedValue([{
      ...connection,
      testStatus: "unavailable",
      errorCode: 403,
      lastErrorAt: "2026-10-15T12:20:00Z",
      lastError: "private provider response and account details",
    }]);

    const response = await GET(new Request("https://router.invalid/api/private/image-quota/v1?provider=codex", {
      headers: { Authorization: "Bearer router-service-token" },
    }));
    const result = await json(response);

    expect(result.status).toBe(200);
    expect(result.body.rows[0]).toMatchObject({
      accountRef: expect.stringMatching(/^acct_[0-9a-f]{24}$/),
      accountEnabled: true,
      authenticationState: "unavailable",
      providerErrorStatus: 403,
      providerErrorClass: "permission_or_model_access",
      providerErrorObservedAt: "2026-10-15T12:20:00.000Z",
    });
    expect(JSON.stringify(result.body)).not.toContain("private provider response");
    expect(JSON.stringify(result.body)).not.toContain("private-account-identity");
  });

  it.each([
    ['["gpt-image-2"]', ["gpt-image-2"]],
    ['["*"]', ["*"]],
    [["gpt-image-2"], ["gpt-image-2"]],
    ['{"model":"gpt-image-2"}', []],
    ['invalid-json', []],
  ])("projects persisted model scope as an array (%s)", async (storedScope, expectedScope) => {
    process.env.AURIX_IMAGE_QUOTA_MANAGEMENT_TOKEN = "router-service-token";
    mocks.getImageQuotaState.mockResolvedValue(new Map([[connection.id, {
      identity: "codex:private-account-identity",
      generation: 1,
      blockingRows: [{
        constraintId: "weekly-limit",
        quotaGroupId: "codex.image_generation",
        observedModel: "gpt-image-2",
        appliesToModels: storedScope,
        retryAt: "2030-01-01T00:00:00.000Z",
        confidence: "provider_confirmed",
      }],
      expiredRows: [],
      probeInProgressRows: [],
      policy: null,
      policyRevision: 0,
    }]]));
    const response = await GET(new Request("https://router.invalid/api/private/image-quota/v1?provider=codex", {
      headers: { Authorization: "Bearer router-service-token" },
    }));
    const result = await json(response);
    expect(result.status).toBe(200);
    expect(result.body.rows[0].constraints[0].appliesToModels).toEqual(expectedScope);
  });

  it.each([false, true])("projects reserved or dispatched recovery probes (dispatched=%s)", async (dispatched) => {
    process.env.AURIX_IMAGE_QUOTA_MANAGEMENT_TOKEN = "router-service-token";
    const leaseExpiry = "2026-10-15T08:02:00.000Z";
    const expiredRow = {
      constraintId: "weekly-limit",
      quotaGroupId: "codex.image_generation",
      observedModel: "gpt-image-2",
      appliesToModels: ["gpt-image-2"],
      retryAt: "2026-10-15T08:00:00.000Z",
      confidence: "provider_confirmed",
      observedAt: "2026-10-14T08:00:00.000Z",
      revision: 3,
    };
    mocks.getImageQuotaState.mockResolvedValue(new Map([[connection.id, {
      identity: "codex:private-account-identity",
      generation: 1,
      blockingRows: [],
      expiredRows: [expiredRow],
      probeInProgressRows: [{ ...expiredRow, probeLeaseExpiresAt: leaseExpiry, probeDispatchedAt: dispatched ? "2026-10-15T08:00:00.000Z" : null }],
      policy: null,
      manualPolicy: null,
      policyRevision: 0,
    }]]));
    mocks.effectiveImageQuotaEligibility.mockReturnValue({
      eligible: false,
      state: "probe_in_progress",
      retryAt: dispatched ? null : leaseExpiry,
      confidence: dispatched ? "unknown" : "estimated",
    });

    const response = await GET(new Request("https://router.invalid/api/private/image-quota/v1?provider=codex", {
      headers: { Authorization: "Bearer router-service-token" },
    }));
    const result = await json(response);

    expect(result.body.rows[0]).toMatchObject({
      routeState: "probe_in_progress",
      eligible: null,
      nextKnownAt: dispatched ? null : leaseExpiry,
      availabilityConfidence: dispatched ? "unknown" : "estimated",
      constraints: [{ state: "probe_in_progress", retryAt: dispatched ? null : leaseExpiry, confidence: dispatched ? "unknown" : "estimated" }],
    });
  });

  it("commits only the requested image policy using server-derived provider scope", async () => {
    process.env.AURIX_IMAGE_QUOTA_MANAGEMENT_TOKEN = "router-service-token";
    const response = await PATCH(new Request("https://router.invalid/api/private/image-quota/v1", {
      method: "PATCH",
      headers: {
        Authorization: "Bearer router-service-token",
        "Content-Type": "application/json",
        "Idempotency-Key": "pause-00000001",
      },
      body: JSON.stringify({
        connectionId: connection.id,
        action: "pause",
        reason: "Operator review in progress",
        expectedRevision: 0,
      }),
    }));
    const result = await json(response);

    expect(result.status).toBe(200);
    expect(mocks.writeImageQuotaPolicy).toHaveBeenCalledWith(expect.objectContaining({
      connection,
      capability: "image_generation",
      quotaGroupId: "codex.image_generation",
      action: "pause",
      principal: "service:aurix",
      idempotencyKey: "pause-00000001",
      expectedRevision: 0,
    }));
  });

  it("rejects unexpected body fields before writing policy", async () => {
    process.env.AURIX_IMAGE_QUOTA_MANAGEMENT_TOKEN = "router-service-token";
    const response = await PATCH(new Request("https://router.invalid/api/private/image-quota/v1", {
      method: "PATCH",
      headers: {
        Authorization: "Bearer router-service-token",
        "Content-Type": "application/json",
        "Idempotency-Key": "pause-00000002",
      },
      body: JSON.stringify({
        connectionId: connection.id,
        action: "pause",
        reason: "Operator review in progress",
        expectedRevision: 0,
        isActive: false,
      }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.writeImageQuotaPolicy).not.toHaveBeenCalled();
  });

  it("rejects Gemini policy writes until the project identity is configured", async () => {
    process.env.AURIX_IMAGE_QUOTA_MANAGEMENT_TOKEN = "router-service-token";
    const gemini = { id: "gemini-key-without-project", provider: "gemini", providerSpecificData: {} };
    mocks.getProviderConnectionById.mockResolvedValue(gemini);
    const result = await json(await PATCH(new Request("https://router.invalid/api/private/image-quota/v1", {
      method: "PATCH",
      headers: {
        Authorization: "Bearer router-service-token",
        "Content-Type": "application/json",
        "Idempotency-Key": "pause-gemini-0001",
      },
      body: JSON.stringify({
        connectionId: gemini.id,
        action: "pause",
        reason: "Operator review in progress",
        expectedRevision: 0,
      }),
    })));

    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe("image_project_identity_required");
    expect(mocks.writeImageQuotaPolicy).not.toHaveBeenCalled();
  });
});
