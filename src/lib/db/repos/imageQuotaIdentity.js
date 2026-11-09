import { createHash } from "node:crypto";
import { normalizeGeminiProjectId } from "../../geminiProjectId.js";

function boundedText(value, max = 200) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

/** Stable display-only account reference; never use this value for authorization or writes. */
export function imageQuotaAccountReference(connectionId) {
  const id = boundedText(connectionId, 160);
  if (!id) return null;
  return `acct_${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 24)}`;
}

/**
 * Use only provider-reported or explicitly configured quota scopes. Unknown
 * account identity remains connection-local so separate credentials are not
 * assumed to share a quota pool.
 */
export function imageQuotaIdentity(connection) {
  const data = connection?.providerSpecificData || {};
  const provider = boundedText(connection?.provider, 80);
  if (provider === "gemini") {
    const project = normalizeGeminiProjectId(connection?.projectId || data.googleCloudProjectId || data.projectId);
    if (project) return `gemini_api_project:${project}`;
    return `connection:${boundedText(connection?.id, 160)}`;
  }
  const verified = connection?.providerSpecificData?.verifiedQuotaIdentity;
  if (verified?.verified === true) {
    const namespace = boundedText(verified.namespace, 80);
    const value = boundedText(verified.value, 160);
    if (namespace && value) return `verified:${namespace}:${value}`;
  }
  if (provider === "codex" && boundedText(data.chatgptAccountId, 160)) {
    const workspace = boundedText(data.workspaceId || data.chatgptWorkspaceId, 160);
    return `codex:${boundedText(data.chatgptAccountId, 160)}${workspace ? `:${workspace}` : ""}`;
  }
  if (provider === "antigravity" && boundedText(data.googleAccountId || data.googleAccountSub, 160)) {
    const account = boundedText(data.googleAccountId || data.googleAccountSub, 160);
    const project = boundedText(connection?.projectId || data.googleCloudProjectId, 160);
    return `antigravity:${account}${project ? `:${project}` : ""}`;
  }
  return `connection:${boundedText(connection?.id, 160)}`;
}

export function imageQuotaIdentityGeneration(connection) {
  // Gemini API quota identity is the Google Cloud project. Changing which key
  // represents a project must not split otherwise-shared project quota state.
  if (connection?.provider === "gemini" && normalizeGeminiProjectId(
    connection?.projectId || connection?.providerSpecificData?.googleCloudProjectId || connection?.providerSpecificData?.projectId,
  )) {
    return 1;
  }
  const value = Number(connection?.providerSpecificData?.imageQuotaIdentityGeneration ?? 1);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function imageQuotaIdentityType(connection) {
  if (connection?.provider === "gemini") {
    return normalizeGeminiProjectId(
      connection?.projectId || connection?.providerSpecificData?.googleCloudProjectId || connection?.providerSpecificData?.projectId,
    ) ? "operator_configured" : "connection_local";
  }
  if (connection?.providerSpecificData?.verifiedQuotaIdentity?.verified === true) return "operator_verified";
  const data = connection?.providerSpecificData || {};
  if (connection?.provider === "codex" && boundedText(data.chatgptAccountId, 160)) return "provider_reported";
  if (connection?.provider === "antigravity" && boundedText(data.googleAccountId || data.googleAccountSub, 160)) return "provider_reported";
  return "connection_local";
}
