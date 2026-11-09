import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admitImageQuotaRequest: vi.fn(),
  beginImageRequestAttempt: vi.fn(),
  beginImageRequestSubmission: vi.fn(),
  clearAccountError: vi.fn(),
  finishImageRequestAttempt: vi.fn(),
  finishImageRequestSubmission: vi.fn(),
  finishImageQuotaRecovery: vi.fn(),
  getComboModels: vi.fn(),
  getImageQuotaPoolAvailability: vi.fn(),
  getKeyAccessContext: vi.fn(),
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  getSettings: vi.fn(),
  handleComboChat: vi.fn(),
  handleImageGenerationCore: vi.fn(),
  isValidApiKey: vi.fn(),
  getApiKeyByKey: vi.fn(),
  recordImageQuotaBlock: vi.fn(),
  imageQuotaEnabled: true,
  imageQuotaMaxSubmissions: 32,
  imageQuotaRequestTimeoutMs: 80_000,
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  admitImageQuotaRequest: mocks.admitImageQuotaRequest,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: () => null,
  finishImageQuotaRecovery: mocks.finishImageQuotaRecovery,
  getImageQuotaPoolAvailability: mocks.getImageQuotaPoolAvailability,
  getProviderCredentials: mocks.getProviderCredentials,
  isValidApiKey: mocks.isValidApiKey,
  markAccountUnavailable: vi.fn(),
  recordImageQuotaBlock: mocks.recordImageQuotaBlock,
}));
vi.mock("../../src/lib/localDb.js", () => ({ getSettings: mocks.getSettings }));
vi.mock("../../src/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: mocks.getApiKeyByKey }));
vi.mock("../../src/lib/db/repos/imageQuotaRepo.js", () => ({
  hasImageSupplierBudgets: vi.fn(async () => false),
  beginImageRequestAttempt: mocks.beginImageRequestAttempt,
  beginImageRequestSubmission: mocks.beginImageRequestSubmission,
  finishImageRequestAttempt: mocks.finishImageRequestAttempt,
  finishImageRequestSubmission: mocks.finishImageRequestSubmission,
  imageQuotaIdentity: (connection) => `connection:${connection?.id || "unknown"}`,
  imageQuotaIdentityGeneration: () => 1,
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getComboModels: mocks.getComboModels,
  getModelInfo: mocks.getModelInfo,
}));
vi.mock("../../src/sse/services/keyAccess.js", () => ({
  extractClientApiKey: (request) => request.headers.get("x-api-key"),
  enforceKeyAccess: vi.fn(async () => null),
  getKeyAccessContext: mocks.getKeyAccessContext,
}));
vi.mock("../../open-sse/handlers/imageGenerationCore.js", () => ({ handleImageGenerationCore: mocks.handleImageGenerationCore }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("../../open-sse/services/combo.js", () => ({ handleComboChat: mocks.handleComboChat }));
vi.mock("../../src/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../src/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("../../open-sse/config/imageQuotaConfig.js", () => ({
  IMAGE_QUOTA_CONFIG: {
    get enabled() { return mocks.imageQuotaEnabled; },
    get maxSubmissionsPerRequest() { return mocks.imageQuotaMaxSubmissions; },
    get requestTimeoutMs() { return mocks.imageQuotaRequestTimeoutMs; },
    unknownResetBackoffMs: 60 * 60 * 1000,
    probeLeaseMs: 2 * 60 * 1000,
    providers: {
      antigravity: { capability: "image_generation", quotaGroupId: "antigravity.image_generation" },
      codex: { capability: "image_generation", quotaGroupId: "codex.image_generation" },
      gemini: { capability: "image_generation", quotaGroupId: "gemini_api.image_generation" },
    },
  },
}));

import { handleImageGeneration } from "../../src/sse/handlers/imageGeneration.js";

afterEach(() => vi.unstubAllEnvs());

describe("image request attempt accounting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("IMAGE_SUPPLIER_ADMISSION_JSON", "");
    mocks.getApiKeyByKey.mockResolvedValue({ id: "hualogu-test", isActive: true });
    mocks.imageQuotaEnabled = true;
    mocks.imageQuotaMaxSubmissions = 32;
    mocks.imageQuotaRequestTimeoutMs = 80_000;
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.admitImageQuotaRequest.mockResolvedValue({ allowed: true });
    mocks.beginImageRequestAttempt.mockResolvedValue({});
    mocks.beginImageRequestSubmission.mockResolvedValue({ routerRequestId: "7c928d8e-f790-42ec-8bdf-2ee049c06f1e", submissionNumber: 1 });
    mocks.finishImageRequestAttempt.mockResolvedValue(true);
    mocks.finishImageRequestSubmission.mockResolvedValue(true);
    mocks.getComboModels.mockResolvedValue([
      "sdwebui/first",
      "comfyui/second",
      "sdwebui/third",
      "codex/gpt-image-2",
    ]);
    mocks.getModelInfo.mockImplementation((modelStr) => {
      const [provider, ...modelParts] = modelStr.split("/");
      return { provider, model: modelParts.join("/") };
    });
    mocks.getKeyAccessContext.mockResolvedValue({});
    mocks.getProviderCredentials.mockResolvedValue({
      connectionId: "codex-connection",
      accessToken: "test-token",
      _connection: { id: "codex-connection", provider: "codex", providerSpecificData: {} },
    });
    mocks.handleComboChat.mockImplementation(async ({ body, models, handleSingleModel }) => {
      let result;
      for (const model of models) {
        result = await handleSingleModel(body, model);
        if (result.ok) return result;
      }
      return result;
    });
    mocks.handleImageGenerationCore.mockImplementation(async ({ modelInfo, onProviderDispatch }) => {
      if (modelInfo.provider === "codex") {
        const dispatchBlocked = onProviderDispatch?.();
        if (dispatchBlocked) {
          return { success: false, status: 503, dispatchBlocked, acceptance: "rejected_before_acceptance" };
        }
        return { success: true, response: new Response("{}", { headers: { "content-type": "application/json" } }) };
      }
      return { success: false, status: 503, error: "temporary provider failure" };
    });
  });


  const protectSupplier = () => vi.stubEnv("IMAGE_SUPPLIER_ADMISSION_JSON", JSON.stringify({
    installationBudgetId: "installation", pricingVersion: "synthetic-v1", pricingDigest: "a".repeat(64),
    callerKeyIds: ["hualogu-test"], projects: [{ supplierIdentity: "gemini_api_project:test-project", budgetId: "project" }],
    routes: [{ provider: "gemini", model: "synthetic-image", operation: "generate", resolution: "1K",
      maxRequestBytes: 4096, maxOutputTokens: 256, estimatedMaxMicrousd: 35 }],
  }));
  const supplierRequest = (model = "gemini/synthetic-image") => new Request("http://router.invalid/v1/images/generations", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": "synthetic" },
    body: JSON.stringify({ model, prompt: "fixture", max_output_tokens: 999999 }),
  });

  it("passes trusted project budgets and bounded request pricing into each protected submission", async () => {
    protectSupplier();
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getProviderCredentials.mockResolvedValue({ connectionId: "gemini-key", apiKey: "synthetic",
      _connection: { id: "gemini-key", provider: "gemini", projectId: "test-project" } });
    mocks.handleImageGenerationCore.mockImplementation(async ({ body, onProviderDispatch, onImageSubmissionStart }) => {
      expect(body.max_output_tokens).toBe(256);
      onProviderDispatch();
      await onImageSubmissionStart();
      return { success: true, response: new Response("{}", { headers: { "content-type": "application/json" } }) };
    });
    expect((await handleImageGeneration(supplierRequest())).status).toBe(200);
    expect(mocks.beginImageRequestSubmission).toHaveBeenCalledWith(expect.objectContaining({
      budgetScope: { installationBudgetId: "installation", projectBudgetId: "project" },
      estimatedMaxMicrousd: 35, pricingVersion: "synthetic-v1", pricingDigest: "a".repeat(64),
      priceShape: expect.objectContaining({ model: "synthetic-image", operation: "generate", outputUnits: 256 }),
    }));
  });

  it.each(["IMAGE_SUPPLIER_BUDGET_EXHAUSTED", "IMAGE_SUPPLIER_BUDGET_UNAVAILABLE"])(
    "returns safe terminal %s metadata without account rotation", async (code) => {
      protectSupplier();
      mocks.getComboModels.mockResolvedValue(null);
      mocks.getProviderCredentials.mockResolvedValue({ connectionId: "gemini-key", apiKey: "synthetic",
        _connection: { id: "gemini-key", provider: "gemini", projectId: "test-project" } });
      mocks.beginImageRequestSubmission.mockRejectedValue(Object.assign(new Error("private budget amount"), { code }));
      mocks.handleImageGenerationCore.mockImplementation(async ({ onProviderDispatch, onImageSubmissionStart }) => {
        onProviderDispatch();
        return { success: false, status: 503, dispatchBlocked: await onImageSubmissionStart() };
      });
      const response = await handleImageGeneration(supplierRequest());
      expect(response.status).toBe(503);
      const payload = await response.json();
      expect(payload.error).toMatchObject({ code: code.toLowerCase(), retry_scope: "none", retry_at: null,
        availability_source: "local_policy" });
      expect(JSON.stringify(payload)).not.toContain("private budget");
      expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
      expect(mocks.recordImageQuotaBlock).not.toHaveBeenCalled();
    });

  it("excludes unprotected no-auth providers when supplier policy is configured", async () => {
    protectSupplier();
    mocks.getComboModels.mockResolvedValue(null);
    const response = await handleImageGeneration(supplierRequest("sdwebui/image"));
    expect(response.status).toBe(503);
    expect(mocks.handleImageGenerationCore).not.toHaveBeenCalled();
  });

  it("refuses unknown policy callers before selecting a provider", async () => {
    protectSupplier();
    mocks.getApiKeyByKey.mockResolvedValue(null);
    expect((await handleImageGeneration(supplierRequest())).status).toBe(503);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.handleImageGenerationCore).not.toHaveBeenCalled();
  });

  it("rotates a local capacity refusal without recording a provider quota strike", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getProviderCredentials.mockResolvedValueOnce({ connectionId: "account-a", _connection: { id: "account-a", provider: "codex" } })
      .mockResolvedValueOnce({ connectionId: "account-b", _connection: { id: "account-b", provider: "codex" } });
    const blocked = Object.assign(new Error("local policy"), { code: "IMAGE_LOCAL_CAPACITY", availability: {
      retryAt: null, confidence: "unknown", source: "local_policy", state: "local_capacity_limited",
    } });
    mocks.beginImageRequestSubmission.mockRejectedValueOnce(blocked);
    mocks.handleImageGenerationCore.mockImplementation(async ({ onProviderDispatch, onImageSubmissionStart }) => {
      onProviderDispatch();
      const ticket = await onImageSubmissionStart();
      return typeof ticket === "string" ? { dispatchBlocked: ticket, status: 503, success: false }
        : { success: true, response: new Response("{}", { headers: { "content-type": "application/json" } }) };
    });
    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.beginImageRequestSubmission).toHaveBeenCalledTimes(2);
    expect(mocks.getProviderCredentials.mock.calls[1][1].has("account-a")).toBe(true);
    expect(mocks.recordImageQuotaBlock).not.toHaveBeenCalled();
  });

  it("reports local capacity metadata when no alternate account is selectable", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    const retryAt = new Date(Date.now() + 60000).toISOString();
    mocks.getProviderCredentials.mockResolvedValueOnce({ connectionId: "account-a", _connection: { id: "account-a", provider: "codex" } }).mockResolvedValue(null);
    mocks.getImageQuotaPoolAvailability.mockResolvedValue({ hasConnections: true, allBlocked: false });
    mocks.beginImageRequestSubmission.mockRejectedValue(Object.assign(new Error("local policy"), {
      code: "IMAGE_LOCAL_CAPACITY", availability: { retryAt, source: "local_policy", confidence: "estimated" },
    }));
    mocks.handleImageGenerationCore.mockImplementation(async ({ onImageSubmissionStart }) => ({
      dispatchBlocked: await onImageSubmissionStart(), success: false, status: 503,
    }));
    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatchObject({ availability_source: "local_policy", retry_at: retryAt, availability_state: "local_capacity_limited" });
    expect(response.headers.get("Retry-After")).not.toBeNull();
    expect(mocks.recordImageQuotaBlock).not.toHaveBeenCalled();
  });

  it("lets a supported provider run after three earlier non-quota combo routes", async () => {
    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "image-combo", prompt: "a landscape" }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.getProviderCredentials.mock.calls[0][0]).toBe("codex");
    expect(mocks.handleImageGenerationCore.mock.calls.map(([input]) => input.modelInfo.provider)).toEqual([
      "sdwebui", "comfyui", "sdwebui", "codex",
    ]);
  });

  it("fails closed before provider dispatch when durable submission accounting is unavailable", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.beginImageRequestSubmission.mockRejectedValue(new Error("sqlite unavailable"));
    mocks.handleImageGenerationCore.mockImplementation(async ({ onProviderDispatch, onImageSubmissionStart }) => {
      const blocked = onProviderDispatch?.();
      if (blocked) return { success: false, status: 503, dispatchBlocked: blocked };
      const ticket = await onImageSubmissionStart?.();
      if (typeof ticket === "string") return { success: false, status: 503, dispatchBlocked: ticket };
      return { success: true, response: new Response("{}") };
    });

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "image_accounting_unavailable" } });
    expect(mocks.beginImageRequestSubmission).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      requestedModel: "codex/gpt-image-2",
      model: "gpt-image-2",
      connectionId: "codex-connection",
      entryPoint: "images_generations",
      operation: "generate",
    }));
  });

  it("fails closed before provider dispatch when quota admission storage is unavailable", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.admitImageQuotaRequest.mockRejectedValue(new Error("sqlite unavailable"));

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "image_route_unavailable" } });
    expect(mocks.admitImageQuotaRequest).toHaveBeenCalledTimes(1);
    expect(mocks.handleImageGenerationCore).not.toHaveBeenCalled();
  });

  it("rotates through an 18-account pool and returns the final account's single image", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    const accounts = Array.from({ length: 18 }, (_, index) => ({
      connectionId: `account-${String(index + 1).padStart(2, "0")}`,
      accessToken: "test-token",
      _connection: {
        id: `account-${String(index + 1).padStart(2, "0")}`,
        provider: "codex",
        providerSpecificData: {},
      },
    }));
    mocks.getProviderCredentials.mockImplementation(async (_provider, excluded = new Set()) => {
      const excludedIds = excluded instanceof Set ? excluded : new Set(excluded ? [excluded] : []);
      return accounts.find((account) => !excludedIds.has(account.connectionId)) || {
        allRateLimited: true,
        imageQuotaAvailability: { retryAt: null, confidence: "unknown" },
      };
    });
    let dispatched = 0;
    mocks.handleImageGenerationCore.mockImplementation(async ({ credentials, onProviderDispatch }) => {
      const blocked = onProviderDispatch?.();
      if (blocked) return { success: false, status: 503, dispatchBlocked: blocked };
      dispatched += 1;
      if (credentials.connectionId !== "account-18") {
        return {
          success: false,
          status: 429,
          error: "quota reached",
          quotaObservation: {
            capability: "image_generation",
            quotaGroupId: "codex.image_generation",
            constraintId: "usage_limit",
            appliesToModels: ["*"],
            model: "gpt-image-2",
            observedAt: new Date().toISOString(),
            retryAt: new Date(Date.now() + 60_000).toISOString(),
            confidence: "provider_confirmed",
          },
        };
      }
      return {
        success: true,
        response: new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), {
          headers: { "content-type": "application/json" },
        }),
      };
    });

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Image-Quota-Failover")).toBe("true");
    expect(await response.json()).toMatchObject({ data: [{ b64_json: "aGVsbG8=" }] });
    expect(dispatched).toBe(18);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(18);
    expect(mocks.handleImageGenerationCore).toHaveBeenCalledTimes(18);
  });

  it("returns a deadline result without selecting or dispatching after the budget expires", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.imageQuotaRequestTimeoutMs = 0;

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));

    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ error: { code: "image_deadline_exceeded" } });
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.handleImageGenerationCore).not.toHaveBeenCalled();
  });

  it("does not dispatch another account after the budget expires while recording a quota rejection", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.imageQuotaRequestTimeoutMs = 30;
    mocks.recordImageQuotaBlock.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    mocks.handleImageGenerationCore.mockImplementationOnce(async ({ onProviderDispatch }) => {
      onProviderDispatch?.();
      return {
        success: false,
        status: 429,
        error: "quota reached",
        quotaObservation: {
          capability: "image_generation",
          quotaGroupId: "codex.image_generation",
          constraintId: "usage_limit",
          appliesToModels: ["*"],
          model: "gpt-image-2",
          observedAt: new Date().toISOString(),
          retryAt: new Date(Date.now() + 60_000).toISOString(),
          confidence: "provider_confirmed",
        },
      };
    });

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));

    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ error: { code: "image_deadline_exceeded" } });
    expect(mocks.handleImageGenerationCore).toHaveBeenCalledTimes(1);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it("propagates client cancellation to image execution without another submission", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    const client = new AbortController();
    let executionSignal;
    mocks.handleImageGenerationCore.mockImplementationOnce(async ({ signal }) => {
      executionSignal = signal;
      client.abort();
      return {
        success: false,
        status: 502,
        acceptance: "unknown",
        error: "cancelled after dispatch",
      };
    });

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
      signal: client.signal,
    }));

    expect(executionSignal).toBeDefined();
    expect(executionSignal.aborted).toBe(true);
    expect(await response.json()).toMatchObject({
      error: { code: "image_outcome_unknown", retry_scope: "reconcile_existing" },
    });
    expect(mocks.handleImageGenerationCore).toHaveBeenCalledTimes(1);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it("fails mapped image routes closed when quota management is disabled", async () => {
    mocks.imageQuotaEnabled = false;
    mocks.getComboModels.mockResolvedValue(null);

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toMatchObject({
      code: "image_route_unavailable",
      availability_state: "unavailable",
      retry_scope: "none",
    });
    expect(body.error.message).toContain("quota management is disabled");
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.handleImageGenerationCore).not.toHaveBeenCalled();
  });

  it("retains dispatched recovery ownership after an ambiguous image result", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getProviderCredentials.mockResolvedValueOnce({
      connectionId: "recovering-account",
      _connection: { id: "recovering-account", provider: "codex", providerSpecificData: {} },
      _imageQuotaProbe: { owner: "recovery-owner", rows: [{ constraintId: "usage_limit" }] },
    });
    mocks.handleImageGenerationCore.mockResolvedValueOnce({ success: false, status: 502, acceptance: "unknown" });
    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));
    expect(await response.json()).toMatchObject({ error: { code: "image_outcome_unknown", retry_scope: "reconcile_existing" } });
    expect(mocks.admitImageQuotaRequest).toHaveBeenCalledWith(expect.any(Object), "image_generation", "gpt-image-2", "recovery-owner");
    expect(mocks.finishImageQuotaRecovery).not.toHaveBeenCalled();
    expect(mocks.handleImageGenerationCore).toHaveBeenCalledTimes(1);
  });

  it("returns the completed image when account cleanup and recovery bookkeeping fail", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getProviderCredentials.mockResolvedValueOnce({
      connectionId: "codex-connection",
      accessToken: "test-token",
      _connection: { id: "codex-connection", provider: "codex", providerSpecificData: {} },
      _imageQuotaProbe: {
        owner: "probe-owner",
        rows: [{ quotaGroupId: "codex.image_generation", constraintId: "usage_limit", revision: 1 }],
      },
    });
    mocks.clearAccountError.mockRejectedValueOnce(new Error("connection update failed"));
    mocks.finishImageQuotaRecovery.mockRejectedValueOnce(new Error("quota store unavailable"));
    mocks.handleImageGenerationCore.mockImplementationOnce(async ({ onRequestSuccess }) => {
      await onRequestSuccess();
      return {
        success: true,
        response: new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), {
          headers: { "content-type": "application/json", "X-Request-ID": "provider-response-123" },
        }),
      };
    });

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("X-9Router-Request-ID")).toMatch(/^[0-9a-f-]{36}$/i);
    expect(response.headers.get("X-Request-ID")).toBe("provider-response-123");
    expect(await response.json()).toMatchObject({ data: [{ b64_json: "aGVsbG8=" }] });
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.handleImageGenerationCore).toHaveBeenCalledTimes(1);
    expect(mocks.clearAccountError).toHaveBeenCalledTimes(1);
    expect(mocks.finishImageQuotaRecovery).toHaveBeenCalledTimes(1);
  });

  it("does not wait for stuck cleanup or quota recovery after validating an image", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getProviderCredentials.mockResolvedValueOnce({
      connectionId: "codex-connection",
      accessToken: "test-token",
      _connection: { id: "codex-connection", provider: "codex", providerSpecificData: {} },
      _imageQuotaProbe: {
        owner: "probe-owner",
        rows: [{ quotaGroupId: "codex.image_generation", constraintId: "usage_limit", revision: 1 }],
      },
    });
    mocks.clearAccountError.mockImplementationOnce(() => new Promise(() => {}));
    mocks.finishImageQuotaRecovery.mockImplementationOnce(() => new Promise(() => {}));
    mocks.handleImageGenerationCore.mockImplementationOnce(async ({ onRequestSuccess }) => {
      await onRequestSuccess();
      return {
        success: true,
        response: new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), {
          headers: { "content-type": "application/json" },
        }),
      };
    });

    const pendingResponse = handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));
    const response = await Promise.race([
      pendingResponse,
      new Promise((resolve) => setTimeout(() => resolve(null), 250)),
    ]);

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [{ b64_json: "aGVsbG8=" }] });
    expect(mocks.clearAccountError).toHaveBeenCalledTimes(1);
    expect(mocks.finishImageQuotaRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.handleImageGenerationCore).toHaveBeenCalledTimes(1);
  });

  it("delivers the completed Codex SSE image while success cleanup is stuck", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getProviderCredentials.mockResolvedValueOnce({
      connectionId: "codex-connection",
      accessToken: "test-token",
      _connection: { id: "codex-connection", provider: "codex", providerSpecificData: {} },
      _imageQuotaProbe: {
        owner: "probe-owner",
        rows: [{ quotaGroupId: "codex.image_generation", constraintId: "usage_limit", revision: 1 }],
      },
    });
    mocks.clearAccountError.mockImplementationOnce(() => new Promise(() => {}));
    mocks.finishImageQuotaRecovery.mockImplementationOnce(() => new Promise(() => {}));
    const done = 'event: done\ndata: {"created":1,"data":[{"b64_json":"aGVsbG8="}]}\n\n';
    mocks.handleImageGenerationCore.mockImplementationOnce(async ({ onRequestSuccess }) => ({
      success: true,
      response: new Response(new ReadableStream({
        async start(controller) {
          await onRequestSuccess();
          controller.enqueue(new TextEncoder().encode(done));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } }),
    }));

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));
    const responseText = await Promise.race([
      response.text(),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 250)),
    ]);

    expect(responseText).toContain("event: done\n");
    expect(responseText).toContain('"b64_json":"aGVsbG8="');
    expect(mocks.clearAccountError).toHaveBeenCalledTimes(1);
    expect(mocks.finishImageQuotaRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.handleImageGenerationCore).toHaveBeenCalledTimes(1);
  });

  it("rotates after a confirmed image quota rejection and marks the successful response", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getProviderCredentials
      .mockResolvedValueOnce({
        connectionId: "quota-account",
        accessToken: "token-a",
        _connection: { id: "quota-account", provider: "codex", providerSpecificData: {} },
      })
      .mockResolvedValueOnce({
        connectionId: "ready-account",
        accessToken: "token-b",
        _connection: { id: "ready-account", provider: "codex", providerSpecificData: {} },
      });
    mocks.handleImageGenerationCore
      .mockResolvedValueOnce({
        success: false,
        status: 429,
        error: "Image generation account quota reached",
        quotaObservation: {
          capability: "image_generation",
          quotaGroupId: "codex.image_generation",
          constraintId: "usage_limit",
          observedAt: "2026-10-15T00:00:00.000Z",
          retryAt: "2026-10-22T00:00:00.000Z",
          confidence: "provider_confirmed",
        },
      })
      .mockResolvedValueOnce({
        success: true,
        response: new Response("{\"data\":[{\"b64_json\":\"aGVsbG8=\"}]}", { headers: { "content-type": "application/json" } }),
      });

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Hualogu-Operation-ID": "84d28c94-ef09-48f9-9c3b-31f2a4c13eac",
      },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Image-Quota-Failover")).toBe("true");
    expect(response.headers.get("X-9Router-Request-ID")).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await response.json()).toMatchObject({ data: [{ b64_json: "aGVsbG8=" }] });
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
    expect(mocks.handleImageGenerationCore).toHaveBeenCalledTimes(2);
    expect(mocks.beginImageRequestAttempt).toHaveBeenNthCalledWith(1, expect.objectContaining({
      clientOperationId: "84d28c94-ef09-48f9-9c3b-31f2a4c13eac",
      attemptNumber: 1,
      connectionId: "quota-account",
      provider: "codex",
      model: "gpt-image-2",
    }));
    expect(mocks.beginImageRequestAttempt).toHaveBeenNthCalledWith(2, expect.objectContaining({
      clientOperationId: "84d28c94-ef09-48f9-9c3b-31f2a4c13eac",
      attemptNumber: 2,
      connectionId: "ready-account",
    }));
    expect(mocks.finishImageRequestAttempt).toHaveBeenCalledTimes(2);
    expect(mocks.finishImageRequestAttempt.mock.calls.map(([attempt]) => attempt)).toEqual([
      expect.objectContaining({ outcome: "quota_rejected", failureClass: "image_quota", retryAt: "2026-10-22T00:00:00.000Z" }),
      expect.objectContaining({ outcome: "succeeded", fallbackAction: "success" }),
    ]);
    expect(mocks.recordImageQuotaBlock).toHaveBeenCalledWith(
      { id: "quota-account", provider: "codex", providerSpecificData: {} },
      expect.objectContaining({ constraintId: "usage_limit" }),
      expect.any(String),
      1,
    );
  });

  it("retries a safe Codex SSE quota rejection on the same request and returns one image", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getProviderCredentials
      .mockResolvedValueOnce({
        connectionId: "quota-stream-account",
        accessToken: "token-a",
        _connection: { id: "quota-stream-account", provider: "codex", providerSpecificData: {} },
      })
      .mockResolvedValueOnce({
        connectionId: "ready-stream-account",
        accessToken: "token-b",
        _connection: { id: "ready-stream-account", provider: "codex", providerSpecificData: {} },
      });
    const observation = {
      capability: "image_generation",
      quotaGroupId: "codex.image_generation",
      constraintId: "usage_limit",
      observedAt: "2026-10-15T00:00:00.000Z",
      retryAt: "2026-10-22T00:00:00.000Z",
      confidence: "provider_confirmed",
    };
    const encoder = new TextEncoder();
    mocks.handleImageGenerationCore
      .mockImplementationOnce(async ({ onQuotaObservation }) => ({
        success: true,
        response: new Response(new ReadableStream({
          async start(controller) {
            const fallback = await onQuotaObservation(observation, {
              canRetry: true,
              signal: new AbortController().signal,
              isCancelled: () => false,
            });
            controller.enqueue(encoder.encode(await fallback.text()));
            controller.close();
          },
        }), { headers: { "content-type": "text/event-stream" } }),
      }))
      .mockImplementationOnce(async ({ onRequestSuccess }) => {
        await onRequestSuccess();
        return {
          success: true,
          response: new Response(
          'event: done\ndata: {"created":1,"data":[{"b64_json":"aGVsbG8="}]}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
        };
      });

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({
        model: "codex/gpt-image-2",
        prompt: "a landscape",
        image: "data:image/png;base64,cmVmZXJlbmNl",
      }),
    }));
    const streamText = await response.text();

    expect(response.status).toBe(200);
    expect(streamText.match(/event: done\n/g)).toHaveLength(1);
    expect(streamText).not.toContain("event: error\n");
    expect(streamText).toContain('"b64_json":"aGVsbG8="');
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
    expect(mocks.getProviderCredentials.mock.calls[1][1]).toContain("quota-stream-account");
    expect(mocks.handleImageGenerationCore).toHaveBeenCalledTimes(2);
    expect(mocks.handleImageGenerationCore.mock.calls[1][0].body).toMatchObject({
      prompt: "a landscape",
      image: "data:image/png;base64,cmVmZXJlbmNl",
    });
    expect(mocks.recordImageQuotaBlock).toHaveBeenCalledWith(
      { id: "quota-stream-account", provider: "codex", providerSpecificData: {} },
      observation,
      expect.any(String),
      1,
    );
  });

  it("returns provider quota source and retry metadata when provider usage blocks the image pool", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getProviderCredentials.mockResolvedValue({
      allRateLimited: true,
      imageQuotaAvailability: {
        state: "provider_usage_blocked",
        retryAt: new Date(Date.now() + 60_000).toISOString(),
        confidence: "provider_confirmed",
        observedAt: "2026-10-15T00:00:00.000Z",
        source: "antigravity_usage",
      },
    });

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(body.error).toMatchObject({
      code: "image_pool_exhausted",
      availability_state: "provider_usage_blocked",
      availability_source: "antigravity_usage",
      availability_confidence: "provider_confirmed",
      retry_scope: "new_request_after_check",
      router_request_id: response.headers.get("X-9Router-Request-ID"),
    });
  });

  it("enforces image route policies before provider dispatch", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getProviderCredentials.mockResolvedValue({
      imageQuotaManualPaused: true,
      imageQuotaAvailability: {
        state: "manual_paused",
        retryAt: null,
        confidence: "unknown",
        retryScope: "none",
      },
    });

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toMatchObject({
      code: "image_pool_paused",
      availability_state: "manual_paused",
      retry_scope: "none",
    });
    expect(mocks.handleImageGenerationCore).not.toHaveBeenCalled();
  });

  it("returns the active recovery check and estimated lease expiry when no route is ready", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    const leaseExpiry = new Date(Date.now() + 60_000).toISOString();
    mocks.getProviderCredentials.mockResolvedValue({
      imageQuotaProbeInProgress: true,
      imageQuotaAvailability: {
        state: "probe_in_progress",
        retryAt: leaseExpiry,
        confidence: "estimated",
        observedAt: new Date().toISOString(),
        retryScope: "new_request_after_check",
      },
    });

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(body.error).toMatchObject({
      code: "image_route_unavailable",
      availability_state: "probe_in_progress",
      retry_at: leaseExpiry,
      availability_confidence: "estimated",
      retry_scope: "new_request_after_check",
    });
  });

  it("does not resubmit an image request when provider acceptance is unknown", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.handleImageGenerationCore.mockResolvedValue({
      success: false,
      status: 502,
      error: "connection reset",
      acceptance: "unknown",
    });

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error.code).toBe("image_outcome_unknown");
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it("turns an unexpected post-dispatch exception into a terminal unknown outcome", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.handleImageGenerationCore.mockImplementationOnce(async ({ onProviderDispatch }) => {
      onProviderDispatch?.();
      throw new Error("connection closed after upload");
    });

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex/gpt-image-2", prompt: "a landscape" }),
    }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "image_outcome_unknown" } });
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.handleImageGenerationCore).toHaveBeenCalledTimes(1);
  });

  it("does not rotate an unmapped credentialed image route after unknown acceptance", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getModelInfo.mockResolvedValueOnce({ provider: "openai", model: "image-model" });
    mocks.handleImageGenerationCore.mockResolvedValueOnce({
      success: false,
      status: 502,
      acceptance: "unknown",
    });

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/image-model", prompt: "a landscape" }),
    }));

    expect(await response.json()).toMatchObject({ error: { code: "image_outcome_unknown" } });
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.handleImageGenerationCore).toHaveBeenCalledTimes(1);
  });

  it("does not let an ambiguous no-auth image operation fall through a combo", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getModelInfo.mockResolvedValueOnce({ provider: "sdwebui", model: "image-model" });
    mocks.handleImageGenerationCore.mockResolvedValueOnce({
      success: false,
      status: 502,
      acceptance: "unknown",
    });

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "sdwebui/image-model", prompt: "a landscape" }),
    }));

    expect(await response.json()).toMatchObject({ error: { code: "image_outcome_unknown" } });
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.handleImageGenerationCore).toHaveBeenCalledTimes(1);
  });

  it("turns a post-dispatch exception on an unmapped route into an unknown outcome", async () => {
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getModelInfo.mockResolvedValueOnce({ provider: "openai", model: "image-model" });
    mocks.handleImageGenerationCore.mockImplementationOnce(async ({ onProviderDispatch }) => {
      onProviderDispatch?.();
      throw new Error("connection closed after upload");
    });

    const response = await handleImageGeneration(new Request("https://router.invalid/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/image-model", prompt: "a landscape" }),
    }));

    expect(await response.json()).toMatchObject({ error: { code: "image_outcome_unknown" } });
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.handleImageGenerationCore).toHaveBeenCalledTimes(1);
  });
});
