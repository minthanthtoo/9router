/**
 * Request-time image quota behavior.
 * Keep provider mappings and rollout limits in one place so provider support
 * can be enabled only where the upstream error shape is understood.
 */
function boundedPositiveInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(max, Math.max(min, value));
}

export const IMAGE_QUOTA_CONFIG = Object.freeze({
  // Default on for compatibility with the current rollout. Setting this to
  // false closes mapped image routes before dispatch; it does not bypass or
  // clear persisted quota blocks or operator pauses.
  get enabled() {
    return !["0", "false", "off"].includes(
      String(process.env.IMAGE_QUOTA_ENABLED || "").trim().toLowerCase(),
    );
  },
  // The default covers the current 18-account supplier pool while retaining a
  // hard ceiling for misconfigured or unexpectedly large pools.
  get maxSubmissionsPerRequest() {
    return boundedPositiveInteger("IMAGE_QUOTA_MAX_SUBMISSIONS_PER_REQUEST", 32, 1, 64);
  },
  // Hualogu's local image HTTP timeout is 110 seconds; keep router work
  // shorter and recheck caller/proxy deadlines before changing this budget.
  get requestTimeoutMs() {
    return boundedPositiveInteger("IMAGE_QUOTA_REQUEST_TIMEOUT_MS", 80_000, 1_000, 300_000);
  },
  // Operator-defined safeguards, never inferred provider subscription quotas.
  get localLimits() {
    const raw = process.env.IMAGE_QUOTA_LOCAL_LIMITS_JSON || "[]";
    if (raw.length > 16384) throw new TypeError("Invalid image local capacity policy");
    let policies;
    try { policies = JSON.parse(raw); } catch { throw new TypeError("Invalid image local capacity policy"); }
    const positive = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
    if (!Array.isArray(policies) || policies.length > 64) throw new TypeError("Invalid image local capacity policy");
    const scopes = new Set();
    for (const policy of policies) {
      if (!policy || !["gemini", "codex", "antigravity"].includes(policy.provider)
        || typeof policy.model !== "string" || !policy.model.trim() || policy.model.length > 256
        || Object.keys(policy).some((key) => !["provider", "model", "maxConcurrent", "windows"].includes(key))
        || (policy.maxConcurrent != null && !positive(policy.maxConcurrent, 10000))
        || (policy.windows != null && (!Array.isArray(policy.windows) || policy.windows.length > 8))
        || (!policy.maxConcurrent && !policy.windows?.length)
        || (policy.windows || []).some((window) => !window || !positive(window.seconds, 604800)
          || !positive(window.requests, 1000000) || Object.keys(window).some((key) => !["seconds", "requests"].includes(key)))) {
        throw new TypeError("Invalid image local capacity policy");
      }
      const scope = `${policy.provider}:${policy.model}`;
      if (scopes.has(scope)) throw new TypeError("Duplicate image local capacity policy");
      scopes.add(scope);
    }
    return policies;
  },
  unknownResetBackoffMs: 60 * 60 * 1000,
  probeLeaseMs: 2 * 60 * 1000,
  providers: Object.freeze({
    antigravity: Object.freeze({
      capability: "image_generation",
      quotaGroupId: "antigravity.image_generation",
      constraintId: "provider_image_quota",
      acceptedStatuses: Object.freeze([409, 429]),
    }),
    codex: Object.freeze({
      capability: "image_generation",
      quotaGroupId: "codex.image_generation",
      constraintId: "usage_limit",
      acceptedStatuses: Object.freeze([429]),
    }),
    gemini: Object.freeze({
      capability: "image_generation",
      quotaGroupId: "gemini_api.image_generation",
      constraintId: "google_api_quota",
      acceptedStatuses: Object.freeze([429]),
    }),
  }),
});

// Model gates share the existing policy store and account identity; quota constraints stay separate.
export function imagePolicyGroup(provider, model = null) {
  const base = IMAGE_QUOTA_CONFIG.providers[provider]?.quotaGroupId;
  return model ? `${base}:model:${model}` : base;
}

export function imagePolicyApplies(policy, provider, model = null) {
  return policy.quotaGroupId === imagePolicyGroup(provider)
    || Boolean(model && policy.quotaGroupId === imagePolicyGroup(provider, model));
}
