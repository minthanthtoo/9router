const SOURCES = { codex: "codex_usage", antigravity: "antigravity_usage" };
const IMAGE_LIMITS = new Set(["image_gen", "imagegen_premium"]);
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const duration = value => Number.isSafeInteger(value) && value > 0 && value <= 31536000 ? value : null;
const percent = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
const identifier = value => typeof value === "string" && /^[a-z][a-z0-9_.-]{0,47}$/.test(value) && !/[a-z0-9]{28}/.test(value);

// Whitelist the saved/exported evidence; never retain provider payloads or credentials.
export function sanitizeImageUsageEvidence(value, provider) {
  if (!SOURCES[provider] || value?.source !== SOURCES[provider] || !timestamp(value.observedAt)) return null;
  const windows = (Array.isArray(value.windows) ? value.windows : []).slice(0, 30).flatMap(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const image = row.scope === "image" && (provider === "codex" ? IMAGE_LIMITS.has(row.limitId) : row.model === "gemini-3.1-flash-image");
    const shared = provider === "codex" && row.scope === "account" && ["session", "weekly"].includes(row.limitId);
    if (!image && !shared) return [];
    return [{ scope: image ? "image" : "account", limitId: provider === "codex" ? row.limitId : null,
      model: provider === "antigravity" ? "gemini-3.1-flash-image" : null,
      remainingPercentage: percent(row.remainingPercentage), resetAt: timestamp(row.resetAt), windowSeconds: duration(row.windowSeconds) }];
  });
  return { source: SOURCES[provider], observedAt: timestamp(value.observedAt), windows,
    limitIds: [...new Set((Array.isArray(value.limitIds) ? value.limitIds : []).filter(identifier))].slice(0, 50) };
}

export function imageUsageEvidence(provider, usage, now = Date.now()) {
  if (!SOURCES[provider] || !usage?.quotas || usage.message || usage.error) return null;
  const windows = Object.entries(usage.quotas).flatMap(([key, quota]) => {
    if (!quota || typeof quota !== "object" || Array.isArray(quota)) return [];
    const image = quota.quotaKind === "image_generation";
    const shared = provider === "codex" && ["session", "weekly"].includes(key);
    if (!image && !shared) return [];
    return [{ scope: image ? "image" : "account", limitId: quota.limitId || (shared ? key : null),
      model: provider === "antigravity" ? key : null,
      remainingPercentage: quota.quotaStatus === "unknown" ? null
        : percent(quota.remainingPercentage) ?? (percent(quota.used) === null || quota.total !== 100 ? null : 100 - quota.used),
      resetAt: quota.resetAt, windowSeconds: quota.windowSeconds }];
  });
  return sanitizeImageUsageEvidence({ source: SOURCES[provider], observedAt: new Date(now).toISOString(), windows, limitIds: usage.quotaAudit?.limitIds }, provider);
}
