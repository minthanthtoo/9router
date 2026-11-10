// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { recordRotationCredits, invalidateRotationSnapshot, claimCreditReset, finishCreditReset } from "@/lib/db/repos/providerRotationRepo.js";
import { getProviderConnectionById } from "@/lib/localDb";
import { consumeCodexRateLimitResetCredit, getCodexRateLimitResetCredits } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "../route.js";

const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];

function isAuthExpiredResult(result) {
  const values = [result?.message, result?.code, result?.raw?.detail, result?.raw?.error]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  return values.some((value) => AUTH_EXPIRED_PATTERNS.some((pattern) => value.includes(pattern)));
}

function isAuthExpiredError(error) {
  return isAuthExpiredResult({ message: error?.message });
}

function getResponseForConsumeResult(result, redeemRequestId) {
  if (result.ok) {
    return Response.json({
      code: result.code,
      reset: true,
      windows_reset: result.windowsReset,
      redeemRequestId,
      credit: result.raw?.credit || null,
    });
  }

  if (result.noCredit) {
    return Response.json({
      code: "no_credit",
      reset: false,
      windows_reset: result.windowsReset,
      message: "No Codex reset credits available.",
    }, { status: 409 });
  }

  return Response.json({
    code: result.code || "unknown_response",
    reset: false,
    windows_reset: result.windowsReset,
    message: result.message || "Codex reset credit consume returned an unexpected response.",
  }, { status: result.status >= 400 && result.status < 500 ? result.status : 502 });
}

async function getCodexConnection(connectionId) {
  const connection = await getProviderConnectionById(connectionId);
  if (!connection) {
    return { response: Response.json({ error: "Connection not found" }, { status: 404 }) };
  }

  if (connection.provider !== "codex") {
    return { response: Response.json({ error: "Codex reset credits are only available for Codex connections." }, { status: 400 }) };
  }

  const isOAuth = connection.authType === "oauth";
  const isAccessToken = connection.authType === "access_token";
  if (!isOAuth && !isAccessToken) {
    return { response: Response.json({ error: "Codex reset credits require an OAuth or access-token connection." }, { status: 400 }) };
  }

  const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
  const proxyOptions = {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: false,
  };

  return { connection, isOAuth, proxyOptions };
}

async function refreshCodexConnection(connection, proxyOptions) {
  try {
    const result = await refreshAndUpdateCredentials(connection, false, proxyOptions);
    return { connection: result.connection };
  } catch (refreshError) {
    console.error("[Codex Reset Credits API] Credential refresh failed:", refreshError);
    return { response: Response.json({ error: `Credential refresh failed: ${refreshError.message}` }, { status: 401 }) };
  }
}

export async function GET(_request, { params }) {
  let connection;
  try {
    const { connectionId } = await params;
    const resolved = await getCodexConnection(connectionId);
    if (resolved.response) return resolved.response;
    ({ connection } = resolved);
    const { isOAuth, proxyOptions } = resolved;

    if (isOAuth) {
      const refreshed = await refreshCodexConnection(connection, proxyOptions);
      if (refreshed.response) return refreshed.response;
      connection = refreshed.connection;
    }

    const rotationReadStartedAt = Date.now();
    let result;
    try {
      result = await getCodexRateLimitResetCredits(connection.accessToken, proxyOptions, connection.providerSpecificData);
    } catch (fetchError) {
      if (!isOAuth || !connection.refreshToken || !isAuthExpiredError(fetchError)) throw fetchError;
      const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions);
      connection = retryResult.connection;
      result = await getCodexRateLimitResetCredits(connection.accessToken, proxyOptions, connection.providerSpecificData);
    }

    await recordRotationCredits(connection, result, rotationReadStartedAt);
    return Response.json(result);
  } catch (error) {
    const provider = connection?.provider ?? "unknown";
    console.warn(`[Codex Reset Credits] ${provider}: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request, { params, automaticCycle = null }) {
  let connection, resetStarted = false, redeemRequestId = null;
  try {
    const { connectionId } = await params;
    const resolved = await getCodexConnection(connectionId);
    if (resolved.response) return resolved.response;
    ({ connection } = resolved);
    const { isOAuth, proxyOptions } = resolved;

    if (isOAuth) {
      const refreshed = await refreshCodexConnection(connection, proxyOptions);
      if (refreshed.response) return refreshed.response;
      connection = refreshed.connection;
    }

    // Server-generated redeem id prevents client-controlled replay
    redeemRequestId = await claimCreditReset(connection.id, automaticCycle);
    if (!redeemRequestId) return Response.json({ reset: false, code: 'reset_pending_review', message: 'A previous reset is pending or already attempted for this quota cycle.' }, { status: 409 });
    await invalidateRotationSnapshot(connection.id, true);
    resetStarted = true;
    let consumeResult = await consumeCodexRateLimitResetCredit(connection.accessToken, redeemRequestId, proxyOptions);

    if (isOAuth && isAuthExpiredResult(consumeResult) && connection.refreshToken) {
      try {
        const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions);
        connection = retryResult.connection;
        consumeResult = await consumeCodexRateLimitResetCredit(connection.accessToken, redeemRequestId, proxyOptions);
      } catch (retryError) {
        console.warn(`[Codex Reset Credits] force refresh failed: ${retryError.message}`);
      }
    }

    await finishCreditReset(redeemRequestId, consumeResult.ok ? 'confirmed' : consumeResult.noCredit || [400, 401, 403, 409, 422, 429].includes(consumeResult.status) ? 'rejected' : 'unknown', consumeResult.code);
    return getResponseForConsumeResult(consumeResult, redeemRequestId);
  } catch (error) {
    if (redeemRequestId) { try { await finishCreditReset(redeemRequestId, "unknown", "response_unconfirmed"); } catch {} }
    const provider = connection?.provider ?? "unknown";
    console.warn(`[Codex Reset Credits] ${provider}: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  } finally {
    if (resetStarted) { try { await invalidateRotationSnapshot(connection.id); } catch { console.warn("[Codex reset] Rotation snapshot remains unavailable"); } }
  }
}
