// No default prices or funded limits: a policy only selects existing durable budgets.
export function readImageSupplierPolicy() {
  const raw = process.env.IMAGE_SUPPLIER_ADMISSION_JSON;
  if (raw == null || raw.trim() === "") return null;
  const invalid = () => { throw new TypeError("Invalid image supplier admission policy"); };
  if (raw.length > 32768) invalid();
  let policy;
  try { policy = JSON.parse(raw); } catch { invalid(); }
  const id = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(value);
  const positive = (value) => Number.isSafeInteger(value) && value > 0;
  const only = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
  if (!only(policy, ["installationBudgetId", "pricingVersion", "pricingDigest", "callerKeyIds", "projects", "routes"])
    || !id(policy.installationBudgetId) || !id(policy.pricingVersion)
    || typeof policy.pricingDigest !== "string" || !/^[a-f0-9]{64}$/i.test(policy.pricingDigest)
    || !Array.isArray(policy.callerKeyIds) || !policy.callerKeyIds.length || policy.callerKeyIds.length > 64
    || !policy.callerKeyIds.every(id) || new Set(policy.callerKeyIds).size !== policy.callerKeyIds.length
    || !Array.isArray(policy.projects) || !policy.projects.length || policy.projects.length > 64
    || !Array.isArray(policy.routes) || !policy.routes.length || policy.routes.length > 64) invalid();
  const projects = new Set();
  for (const project of policy.projects) {
    if (!only(project, ["supplierIdentity", "budgetId"]) || !id(project.budgetId)
      || project.budgetId === policy.installationBudgetId || typeof project.supplierIdentity !== "string"
      || !/^gemini_api_project:[a-z0-9-]{1,160}$/.test(project.supplierIdentity)
      || projects.has(project.supplierIdentity)) invalid();
    projects.add(project.supplierIdentity);
  }
  const routes = new Set();
  for (const route of policy.routes) {
    if (!only(route, ["provider", "model", "operation", "resolution", "maxRequestBytes", "maxOutputTokens", "estimatedMaxMicrousd"])
      || route.provider !== "gemini" || !id(route.model) || route.model.length > 80
      || !["generate", "edit"].includes(route.operation) || !["512", "1K", "2K", "4K"].includes(route.resolution)
      || !positive(route.maxRequestBytes) || !positive(route.maxOutputTokens)
      || !positive(route.estimatedMaxMicrousd)) invalid();
    const key = JSON.stringify([route.provider, route.model, route.operation, route.resolution]);
    if (routes.has(key)) invalid();
    routes.add(key);
  }
  return policy;
}
