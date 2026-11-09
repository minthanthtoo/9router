import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { getAdapter, clearAccountError, getProviderCredentials } = vi.hoisted(() => ({
  getAdapter: vi.fn(), clearAccountError: vi.fn(), getProviderCredentials: vi.fn(),
}));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter }));
vi.mock("../../src/lib/localDb.js", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials, clearAccountError, admitImageQuotaRequest: async () => ({ allowed: true }),
  extractApiKey: (request) => request.headers.get("x-api-key"), isValidApiKey: async () => true,
  markAccountUnavailable: vi.fn(), recordImageQuotaBlock: vi.fn(), finishImageQuotaRecovery: vi.fn(),
  getImageQuotaPoolAvailability: vi.fn(),
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "gemini", model: "synthetic-image" }), getComboModels: async () => null,
}));
vi.mock("open-sse/config/providerModels.js", () => ({ supportsImageEdit: () => true }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials, updateProviderCredentials: vi.fn(),
}));
vi.mock("../../src/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import { createNodeSqliteAdapter } from "../../src/lib/db/adapters/nodeSqliteAdapter.js";
import { MIGRATIONS } from "../../src/lib/db/migrations/index.js";
import { configureImageSupplierBudget } from "../../src/lib/db/repos/imageQuotaRepo.js";
import { handleImageGeneration } from "../../src/sse/handlers/imageGeneration.js";

let adapter;
let providerFetch;
const connection = { id: "supplier-key", provider: "gemini", projectId: "test-project" };
const policy = {
  installationBudgetId: "installation", pricingVersion: "synthetic-v1", pricingDigest: "a".repeat(64),
  callerKeyIds: ["hualogu-test"], projects: [{ supplierIdentity: "gemini_api_project:test-project", budgetId: "project" }],
  routes: ["generate", "edit"].map((operation) => ({ provider: "gemini", model: "synthetic-image", operation,
    resolution: "1K", maxRequestBytes: 4096, maxOutputTokens: 256, estimatedMaxMicrousd: 35 })),
};
function request(edit = false) {
  return new Request("http://router.invalid/v1/images/generations", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": "synthetic" },
    body: JSON.stringify({ model: "gemini/synthetic-image", prompt: "fixture", max_output_tokens: 999999,
      ...(edit ? { image: "data:image/png;base64,aGVsbG8=" } : {}) }),
  });
}
beforeEach(async () => {
  vi.stubEnv("IMAGE_SUPPLIER_ADMISSION_JSON", JSON.stringify(policy));
  vi.stubEnv("IMAGE_QUOTA_LOCAL_LIMITS_JSON", "[]");
  vi.stubEnv("IMAGE_QUOTA_ENABLED", "true");
  adapter = await createNodeSqliteAdapter(":memory:");
  for (const migration of MIGRATIONS) migration.up(adapter);
  getAdapter.mockReset().mockResolvedValue(adapter);
  adapter.run("INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES(?, ?, ?, ?, ?)",
    ["hualogu-test", "synthetic", "fixture", 1, new Date().toISOString()]);
  const now = Date.now();
  for (const [id, scopeType, scopeKey] of [["installation", "installation", "router"], ["project", "billing_project", "gemini_api_project:test-project"]]) {
    await configureImageSupplierBudget({ id, scopeType, scopeKey, enabled: true, currency: "USD", scale: 6,
      dailyLimitMicrousd: 35, monthlyLimitMicrousd: 35, pilotLimitMicrousd: 35, maxSubmissionMicrousd: 35,
      pricingPolicyVersion: "synthetic-v1", pilotId: "fixture", pilotStartsAt: new Date(now - 60_000).toISOString(),
      pilotEndsAt: new Date(now + 86_400_000).toISOString() });
  }
  getProviderCredentials.mockReset().mockResolvedValue({ connectionId: connection.id, apiKey: "fixture", _connection: connection });
  clearAccountError.mockReset().mockResolvedValue(undefined);
  providerFetch = vi.fn(async (_url, options) => {
    expect(JSON.parse(options.body).generationConfig.maxOutputTokens).toBe(256);
    expect(adapter.get("SELECT COUNT(*) AS n FROM imageSupplierExposureAllocations WHERE state = 'open'").n).toBe(2);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] } }] }),
      { headers: { "content-type": "application/json", "x-request-id": "provider-fixture" } });
  });
  vi.stubGlobal("fetch", providerFetch);
});
afterEach(() => {
  adapter?.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("incoming Images supplier admission with real SQLite and adapter", () => {
  it.each([false, true])("reserves before fetch, delivers one output and blocks the next unaffordable request (edit=%s)", async (edit) => {
    const first = await handleImageGeneration(request(edit));
    expect(first.status).toBe(200);
    expect((await first.json()).data[0].b64_json).toBe("aGVsbG8=");
    expect(adapter.get("SELECT COUNT(*) AS n FROM imageSupplierExposureAllocations WHERE state = 'provisional'").n).toBe(2);
    const denied = await handleImageGeneration(request(edit));
    expect(denied.status).toBe(503);
    expect((await denied.json()).error).toMatchObject({ code: "image_supplier_budget_exhausted", retry_scope: "none", retry_at: null });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(adapter.get("SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions").n).toBe(1);
    expect(adapter.get("SELECT COUNT(*) AS n FROM imageSupplierExposureAllocations").n).toBe(2);
  });
  it("retains uncertain exposure and refuses a fresh request without another provider dispatch", async () => {
    providerFetch.mockRejectedValue(new Error("response lost"));
    expect((await (await handleImageGeneration(request())).json()).error.code).toBe("image_outcome_unknown");
    expect(adapter.get("SELECT COUNT(*) AS n FROM imageSupplierExposureAllocations WHERE state = 'open'").n).toBe(2);
    expect((await (await handleImageGeneration(request())).json()).error.code).toBe("image_supplier_budget_exhausted");
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });
  it("delivers completed output when account cleanup throws", async () => {
    clearAccountError.mockRejectedValue(new Error("cleanup unavailable"));
    const response = await handleImageGeneration(request());
    expect(response.status).toBe(200);
    expect((await response.json()).data).toHaveLength(1);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(adapter.get("SELECT COUNT(*) AS n FROM imageSupplierExposureAllocations WHERE state = 'provisional'").n).toBe(2);
  });
  it("removing policy while budgets persist refuses before provider selection", async () => {
    vi.stubEnv("IMAGE_SUPPLIER_ADMISSION_JSON", "");
    const response = await handleImageGeneration(request());
    expect((await response.json()).error.code).toBe("image_supplier_budget_unavailable");
    expect(getProviderCredentials).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });
  it("rolls back submission admission and sends nothing when the store fails", async () => {
    const run = adapter.run.bind(adapter);
    vi.spyOn(adapter, "run").mockImplementation((sql, params) => {
      if (sql.includes("INSERT INTO imageQuotaRequestSubmissions")) throw new Error("store write failed");
      return run(sql, params);
    });
    const response = await handleImageGeneration(request());
    expect((await response.json()).error).toMatchObject({ code: "image_accounting_unavailable", retry_scope: "none" });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(adapter.get("SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions").n).toBe(0);
    expect(adapter.get("SELECT COUNT(*) AS n FROM imageSupplierExposureAllocations").n).toBe(0);
  });
  it("rejects a policy pointing at another project's budget before fetch", async () => {
    adapter.run("UPDATE imageSupplierBudgets SET scopeKey = ? WHERE id = ?", ["gemini_api_project:other-project", "project"]);
    const response = await handleImageGeneration(request());
    expect((await response.json()).error.code).toBe("image_supplier_budget_unavailable");
    expect(providerFetch).not.toHaveBeenCalled();
    expect(adapter.get("SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions").n).toBe(0);
    expect(adapter.get("SELECT COUNT(*) AS n FROM imageSupplierExposureAllocations").n).toBe(0);
  });
});
