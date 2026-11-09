const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const PROJECT_NUMBER_RE = /^\d{6,20}$/;

/** Normalize a Google Cloud project ID or project number for quota grouping. */
export function normalizeGeminiProjectId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return PROJECT_ID_RE.test(normalized) || PROJECT_NUMBER_RE.test(normalized)
    ? normalized
    : null;
}

export function isValidGeminiProjectId(value) {
  return normalizeGeminiProjectId(value) !== null;
}
