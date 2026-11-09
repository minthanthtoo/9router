export function getImageQuotaConstraintDisplay(constraint = {}) {
  const models = Array.isArray(constraint.appliesToModels)
    ? constraint.appliesToModels.filter((model) => typeof model === "string" && model.length > 0)
    : [];

  return {
    effectiveScope: models.includes("*")
      ? "All image models"
      : models.length > 0
        ? models.join(", ")
        : "Scope not reported",
    observedModel: typeof constraint.model === "string" && constraint.model.length > 0
      ? constraint.model
      : null,
  };
}

export function formatMicrousd(value) {
  if (!Number.isSafeInteger(value) || value < 0) return "—";
  return `$${Math.floor(value / 1_000_000).toLocaleString()}.${String(value % 1_000_000).padStart(6, "0")}`;
}
