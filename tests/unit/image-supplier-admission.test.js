import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { getKey, hasBudgets, getBudgetOverview } = vi.hoisted(() => ({
  getKey: vi.fn(), hasBudgets: vi.fn(), getBudgetOverview: vi.fn(),
}));
vi.mock("../../src/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: getKey }));
vi.mock("../../src/lib/db/repos/imageQuotaRepo.js", () => ({
  hasImageSupplierBudgets: hasBudgets,
  getImageSupplierBudgetOverview: getBudgetOverview,
}));
vi.mock("../../src/sse/services/keyAccess.js", () => ({ extractClientApiKey: (request) => request.headers.get("x-api-key") }));
import { readImageSupplierPolicy } from "../../open-sse/config/imageSupplierConfig.js";
import { getImageSupplierAdmissionStatus, getImageSupplierContext, prepareImageSupplierAdmission } from "../../src/sse/services/imageSupplierAdmission.js";
import gemini from "../../open-sse/handlers/imageProviders/gemini.js";

const policy = () => ({
  installationBudgetId: "installation", pricingVersion: "synthetic-v1", pricingDigest: "a".repeat(64),
  callerKeyIds: ["hualogu-test"],
  projects: [{ supplierIdentity: "gemini_api_project:test-project", budgetId: "project" }],
  routes: ["generate", "edit"].map((operation) => ({ provider: "gemini", model: "synthetic-image", operation,
    resolution: "1K", maxRequestBytes: 4096, maxOutputTokens: 256, estimatedMaxMicrousd: 35 })),
});
const request = () => new Request("http://router.invalid/v1/images/generations", { headers: {
  "x-api-key": "synthetic", "x-project-id": "forged", "x-budget-id": "forged", "x-estimated-cost": "0",
} });
const input = () => ({ provider: "gemini", model: "synthetic-image", operation: "generate",
  connection: { provider: "gemini", id: "key-a", projectId: "test-project" }, body: { prompt: "fixture" } });

beforeEach(() => {
  vi.stubEnv("IMAGE_SUPPLIER_ADMISSION_JSON", JSON.stringify(policy()));
  getKey.mockReset().mockResolvedValue({ id: "hualogu-test", isActive: true });
  hasBudgets.mockReset().mockResolvedValue(false);
  getBudgetOverview.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("trusted image supplier policy", () => {
  it("projects pilot obligations without exposing budget or supplier identities", async () => {
    const now = Date.parse("2026-10-22T12:00:00.000Z");
    const common = {
      currency: "USD", scale: 6, enabled: true, revision: 1, pricingPolicyVersion: "synthetic-v1",
      pilotStartsAt: "2026-10-22T00:00:00.000Z", pilotEndsAt: "2026-10-23T00:00:00.000Z", pilotActive: true,
      status: "active", limitsMicrousd: { daily: 100, monthly: 200, pilot: 300, perSubmission: 40 },
      obligationMicrousd: { daily: 10, monthly: 20, pilot: 30 },
      remainingMicrousd: { daily: 90, monthly: 180, pilot: 270 },
      openMicrousd: 5, provisionalMicrousd: 3, confirmedBilledMicrousd: 2,
    };
    getBudgetOverview.mockResolvedValue([
      { ...common, id: "installation", scopeType: "installation", scopeKey: "private-router", pilotId: "private-pilot" },
      { ...common, id: "project", scopeType: "billing_project", scopeKey: "gemini_api_project:test-project", pilotId: "private-pilot" },
    ]);
    const status = await getImageSupplierAdmissionStatus(now);
    expect(status).toMatchObject({ state: "protected", configured: true, callerCount: 1, routeCount: 2,
      budgets: [{ scopeType: "installation", inPolicy: true, remainingMicrousd: { daily: 90 } },
        { scopeType: "billing_project", inPolicy: true }] });
    expect(JSON.stringify(status)).not.toContain("private-router");
    expect(JSON.stringify(status)).not.toContain("gemini_api_project:test-project");
    expect(JSON.stringify(status)).not.toContain("private-pilot");
  });

  it("distinguishes an invalid configured policy from an absent legacy policy", async () => {
    vi.stubEnv("IMAGE_SUPPLIER_ADMISSION_JSON", "{");
    expect(await getImageSupplierAdmissionStatus()).toMatchObject({ state: "invalid_policy", configured: true });
    vi.stubEnv("IMAGE_SUPPLIER_ADMISSION_JSON", "");
    getBudgetOverview.mockResolvedValue([]);
    expect(await getImageSupplierAdmissionStatus()).toMatchObject({ state: "legacy_unprotected", configured: false });
    getBudgetOverview.mockResolvedValue([{ id: "private-budget" }]);
    expect(await getImageSupplierAdmissionStatus()).toMatchObject({ state: "policy_missing_fenced", configured: false });
  });

  it("reports unavailable stored status without probing provider or caller credentials", async () => {
    getBudgetOverview.mockRejectedValue(new Error("private storage detail"));
    expect(await getImageSupplierAdmissionStatus()).toMatchObject({ state: "unavailable", configured: true, budgets: [] });
    expect(getKey).not.toHaveBeenCalled();
    expect(hasBudgets).not.toHaveBeenCalled();
  });

  it("has no default spend configuration", async () => {
    vi.stubEnv("IMAGE_SUPPLIER_ADMISSION_JSON", "");
    expect(await getImageSupplierContext(request())).toBeNull();
    expect(getKey).not.toHaveBeenCalled();
  });
  it.each(["null", "{}", "{", "[]"])("fails closed for invalid policy %s", async (raw) => {
    vi.stubEnv("IMAGE_SUPPLIER_ADMISSION_JSON", raw);
    await expect(getImageSupplierContext(request())).rejects.toMatchObject({ code: "IMAGE_SUPPLIER_BUDGET_UNAVAILABLE" });
  });
  it("does not reopen unprotected routes when policy is removed but durable budgets remain", async () => {
    vi.stubEnv("IMAGE_SUPPLIER_ADMISSION_JSON", "");
    hasBudgets.mockResolvedValue(true);
    await expect(getImageSupplierContext(request())).rejects.toMatchObject({ code: "IMAGE_SUPPLIER_BUDGET_UNAVAILABLE" });
    expect(getKey).not.toHaveBeenCalled();
  });
  it.each([null, { id: "other", isActive: true }, { id: "hualogu-test", isActive: false }])("requires an active allowed server key record: %j", async (key) => {
    getKey.mockResolvedValue(key);
    await expect(getImageSupplierContext(request())).rejects.toMatchObject({ code: "IMAGE_SUPPLIER_BUDGET_UNAVAILABLE" });
  });
  it("maps rotated keys from the same stored project to one budget and enforces output bound", async () => {
    const context = await getImageSupplierContext(request());
    const first = prepareImageSupplierAdmission(context, { ...input(), body: { prompt: "fixture", max_output_tokens: 999999 } });
    const second = prepareImageSupplierAdmission(context, { ...input(), connection: { ...input().connection, id: "key-b" } });
    expect(first.submission.budgetScope).toEqual({ installationBudgetId: "installation", projectBudgetId: "project" });
    expect(second.submission.budgetScope).toEqual(first.submission.budgetScope);
    expect(first.submission.estimatedMaxMicrousd).toBe(35);
    const transformed = gemini.buildBody("synthetic-image", first.body);
    expect(transformed.generationConfig.maxOutputTokens).toBe(256);
    expect(first.submission.priceShape.inputUnits).toBe(Buffer.byteLength(JSON.stringify(transformed)));
    expect(JSON.stringify(first.submission)).not.toContain("fixture");
  });
  it.each([
    { provider: "codex" }, { model: "unmapped" }, { connection: { provider: "gemini", id: "new-key" } },
    { connection: { provider: "gemini", projectId: "other-project" } }, { body: { prompt: "x", n: 2 } },
    { body: { prompt: "x", image_size: "4K" } }, { body: { prompt: "x".repeat(4096) } },
    { body: { prompt: { unsafe: "shape" } } },
  ])("rejects unsupported or unmapped dispatch shape %j", async (delta) => {
    const context = await getImageSupplierContext(request());
    expect(() => prepareImageSupplierAdmission(context, { ...input(), ...delta })).toThrow();
  });
  it("accounts for reference payload bytes and selects the edit price", async () => {
    const context = await getImageSupplierContext(request());
    const prepared = prepareImageSupplierAdmission(context, { ...input(), operation: "edit",
      body: { prompt: "fixture", image: "data:image/png;base64,aGVsbG8=" } });
    expect(prepared.submission.priceShape.operation).toBe("edit");
    expect(prepared.submission.priceShape.inputUnits).toBeGreaterThan(
      prepareImageSupplierAdmission(context, input()).submission.priceShape.inputUnits);
  });
  it.each(["estimatedMaxMicrousd", "maxRequestBytes", "maxOutputTokens"])("requires a finite explicit positive %s", (field) => {
    const config = policy();
    config.routes[0][field] = 0;
    vi.stubEnv("IMAGE_SUPPLIER_ADMISSION_JSON", JSON.stringify(config));
    expect(() => readImageSupplierPolicy()).toThrow();
  });
});
