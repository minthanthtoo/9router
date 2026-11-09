import { readImageSupplierPolicy } from "open-sse/config/imageSupplierConfig.js";
import geminiImageAdapter from "open-sse/handlers/imageProviders/gemini.js";
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { imageQuotaIdentity } from "@/lib/db/repos/imageQuotaIdentity.js";
import { getImageSupplierBudgetOverview, hasImageSupplierBudgets } from "@/lib/db/repos/imageQuotaRepo.js";
import { extractClientApiKey } from "./keyAccess.js";

function unavailable() {
  throw Object.assign(new Error("Image supplier admission is unavailable"), { code: "IMAGE_SUPPLIER_BUDGET_UNAVAILABLE" });
}

export async function getImageSupplierAdmissionStatus(nowMs = Date.now()) {
  let policy = null;
  const configured = Boolean(process.env.IMAGE_SUPPLIER_ADMISSION_JSON?.trim());
  try { policy = readImageSupplierPolicy(); } catch {
    return { generatedAt: new Date(nowMs).toISOString(), state: "invalid_policy", configured, callerCount: 0, routeCount: 0, budgets: [] };
  }
  let budgets;
  try { budgets = await getImageSupplierBudgetOverview(nowMs); } catch {
    return { generatedAt: new Date(nowMs).toISOString(), state: "unavailable", configured: Boolean(policy), callerCount: policy?.callerKeyIds.length || 0, routeCount: policy?.routes.length || 0, budgets: [] };
  }
  const required = policy ? [
    { id: policy.installationBudgetId, scopeType: "installation", scopeKey: null },
    ...policy.projects.map((project) => ({ id: project.budgetId, scopeType: "billing_project", scopeKey: project.supplierIdentity })),
  ] : [];
  const requiredIds = new Set(required.map((item) => item.id));
  const byId = new Map(budgets.map((budget) => [budget.id, budget]));
  const now = nowMs;
  const policyBudgetsReady = Boolean(policy) && required.every((item) => {
    const budget = byId.get(item.id);
    return budget && budget.scopeType === item.scopeType
      && (item.scopeKey === null || budget.scopeKey === item.scopeKey)
      && budget.enabled && budget.currency === "USD" && budget.scale === 6
      && budget.pricingPolicyVersion === policy.pricingVersion && budget.pilotActive
      && Date.parse(budget.pilotStartsAt) <= now && now < Date.parse(budget.pilotEndsAt);
  });
  const state = !policy
    ? (budgets.length ? "policy_missing_fenced" : "legacy_unprotected")
    : !policyBudgetsReady ? "budget_unavailable"
      : required.some(({ id }) => byId.get(id)?.status === "limit_reached") ? "budget_exhausted" : "protected";
  return {
    generatedAt: new Date(nowMs).toISOString(),
    state,
    configured: Boolean(policy),
    callerCount: policy?.callerKeyIds.length || 0,
    routeCount: policy?.routes.length || 0,
    budgets: budgets.map((budget, index) => ({
      reference: `budget-${index + 1}`,
      scopeType: budget.scopeType,
      inPolicy: requiredIds.has(budget.id),
      enabled: budget.enabled,
      status: budget.status,
      currency: budget.currency,
      scale: budget.scale,
      revision: budget.revision,
      pricingPolicyVersion: budget.pricingPolicyVersion,
      pilotStartsAt: budget.pilotStartsAt,
      pilotEndsAt: budget.pilotEndsAt,
      limitsMicrousd: budget.limitsMicrousd,
      obligationMicrousd: budget.obligationMicrousd,
      remainingMicrousd: budget.remainingMicrousd,
      openMicrousd: budget.openMicrousd,
      provisionalMicrousd: budget.provisionalMicrousd,
      confirmedBilledMicrousd: budget.confirmedBilledMicrousd,
      updatedAt: budget.updatedAt,
    })),
  };
}

export async function getImageSupplierContext(request) {
  let policy;
  try { policy = readImageSupplierPolicy(); } catch { unavailable(); }
  if (!policy) {
    if (await hasImageSupplierBudgets()) unavailable();
    return null;
  }
  const key = await getApiKeyByKey(extractClientApiKey(request));
  if (!key?.isActive || !policy.callerKeyIds.includes(key.id)) unavailable();
  return { policy, callerKeyId: key.id };
}

export function prepareImageSupplierAdmission(context, { provider, model, connection, body, operation }) {
  if (!context) return { body, submission: {} };
  const { policy } = context;
  if (provider !== "gemini" || connection?.provider !== provider || typeof body.prompt !== "string" || !body.prompt
    || (body.n != null && body.n !== 1)) unavailable();
  const project = policy.projects.find((item) => item.supplierIdentity === imageQuotaIdentity(connection));
  if (!project) unavailable();
  let requestBody;
  try { requestBody = geminiImageAdapter.buildBody(model, body); } catch { unavailable(); }
  const resolution = requestBody.generationConfig.imageConfig.imageSize;
  const route = policy.routes.find((item) => item.provider === provider && item.model === model
    && item.operation === operation && item.resolution === resolution);
  if (!route) unavailable();
  const boundedBody = { ...body, max_output_tokens: route.maxOutputTokens };
  requestBody = geminiImageAdapter.buildBody(model, boundedBody);
  const requestBytes = Buffer.byteLength(JSON.stringify(requestBody), "utf8");
  if (requestBytes > route.maxRequestBytes) unavailable();
  return {
    body: boundedBody,
    submission: {
      budgetScope: { installationBudgetId: policy.installationBudgetId, projectBudgetId: project.budgetId },
      estimatedMaxMicrousd: route.estimatedMaxMicrousd,
      pricingVersion: policy.pricingVersion, pricingDigest: policy.pricingDigest,
      priceShape: { model, operation, outputCount: 1, resolution, inputUnits: requestBytes, outputUnits: route.maxOutputTokens },
    },
  };
}
