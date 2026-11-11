import { legacyRotationNext, applicableRotationQuotas, emptyRotation } from "@/shared/utils/rotationSequence.mjs";
import { readRotationSnapshots, chooseSequenceConnection } from "@/lib/db/repos/providerRotationRepo.js";
import { rotationPool } from "./providerRotation.js";
import {resolveImageRouting,resolveImageAccountPreference,resolveImageSelection} from "@/shared/utils/imageRouting.mjs";
import {selectImageRotation} from "@/lib/db/repos/imageRoutingRepo.js";
import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import {
  getAntigravityQuotaBlockForConnection,
  getAntigravityQuotaCache,
  getAntigravityModelQuota,
} from "./antigravityQuota.js";
import {
  acquireImageQuotaProbeLeases,
  admitImageQuotaRequest as admitImageQuotaRequestRepo,
  finishImageQuotaProbe,
  getImageQuotaState,
  getImageSupplierLoads,
  imageQuotaIdentity,
  imageQuotaIdentityGeneration,
  recordImageQuotaObservations,
} from "@/lib/db/repos/imageQuotaRepo.js";
import { IMAGE_QUOTA_CONFIG } from "open-sse/config/imageQuotaConfig.js";
import { effectiveImageQuotaEligibility } from "./imageQuotaEligibility.js";
import * as log from "../utils/logger.js";
import { normalizeGeminiProjectId } from "@/lib/geminiProjectId";
import { readTextModelPolicies } from '@/lib/db/repos/textModelPolicyRepo.js';
import { textModelPermissionReason, accountModelAccess } from '@/shared/utils/textModelPermission.mjs';

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function geminiQuotaProjectId(connection) {
  return normalizeGeminiProjectId(connection?.projectId
    || connection?.providerSpecificData?.googleCloudProjectId
    || connection?.providerSpecificData?.projectId);
}

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

function imageQuotaStateFor(connection, states) {
  return states?.get(connection.id) || {
    identity: null, generation: 1, blockingRows: [], expiredRows: [], manualPolicy: null, policyRevision: 0,
  };
}

function requestQuotaRejectionFor(connection, provider, model, rejections = []) {
  const identity = imageQuotaIdentity(connection);
  const generation = imageQuotaIdentityGeneration(connection);
  return rejections.find((rejection) => {
    if (rejection?.provider !== provider
      || rejection.identity !== identity
      || Number(rejection.identityGeneration) !== generation
      || !rejection.quotaGroupId
      || !rejection.constraintId) return false;
    const models = Array.isArray(rejection.appliesToModels) ? rejection.appliesToModels : [];
    return models.includes("*") || (model && models.includes(model));
  }) || null;
}

function currentRequestQuotaRejection(connection, provider, model, rejected, requestRejections) {
  if (rejected?.has(connection.id)) return rejected.get(connection.id);
  return requestQuotaRejectionFor(connection, provider, model, requestRejections)?.observation || null;
}

function imageQuotaResetAt(rows) {
  if (!rows?.length || rows.some((row) => !row.retryAt || !Number.isFinite(Date.parse(row.retryAt)))) return null;
  return rows.map((row) => row.retryAt).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) || null;
}

function antigravityQuotaResetAt(connection, model, quotaCache) {
  if (!connection || !model || !quotaCache) return null;
  return getAntigravityQuotaBlockForConnection(connection.id, model, quotaCache)?.retryAt || null;
}

function antigravityQuotaBlock(connection, model, quotaCache) {
  return connection?.provider === "antigravity" && quotaCache
    ? getAntigravityQuotaBlockForConnection(connection.id, model, quotaCache)
    : null;
}

function summarizeImageQuotaPool(connections, states, rejected = new Map(), requestRejections = [], provider = null, model = null, nowMs = Date.now(), quotaCache = null) {
  const candidates = [];
  const observations = [];
  const providerSources = new Set();
  let hasProviderUsage = false;
  let hasRouterQuota = false;
  let hasUnknown = false;
  let hasEstimated = false;

  for (const connection of connections) {
    const state = imageQuotaStateFor(connection, states);
    const rows = [...(state.blockingRows || [])];
    if (rows.length) hasRouterQuota = true;
    const providerBlock = provider === "antigravity"
      ? antigravityQuotaBlock(connection, model, quotaCache)
      : null;
    if (providerBlock) {
      hasProviderUsage = true;
      providerSources.add(providerBlock.source || "unknown");
      rows.push({ retryAt: providerBlock.retryAt, confidence: providerBlock.confidence, observedAt: providerBlock.observedAt });
    }
    const currentRejection = currentRequestQuotaRejection(connection, provider || connection.provider, model, rejected, requestRejections);
    if (currentRejection) {
      const observation = currentRejection;
      observations.push(observation);
      rows.push({ retryAt: observation.retryAt, confidence: observation.confidence, observedAt: observation.observedAt });
    }
    if (!rows.length) {
      hasUnknown = true;
      continue;
    }
    const eligibility = effectiveImageQuotaEligibility(connection, { ...state, blockingRows: rows }, { model, nowMs });
    const retryAt = eligibility.retryAt;
    if (!retryAt || Date.parse(retryAt) <= nowMs) {
      hasUnknown = true;
      continue;
    }
    if (eligibility.confidence === "unknown") hasUnknown = true;
    else if (eligibility.confidence !== "provider_confirmed") hasEstimated = true;
    const observedAt = rows.map((row) => row.observedAt).filter(Boolean).sort().at(-1) || null;
    candidates.push({ retryAt, observedAt });
  }

  const retryAt = candidates.length ? candidates.map((item) => item.retryAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0] : null;
  const observedAt = observations.map((item) => item.observedAt).concat(candidates.map((item) => item.observedAt))
    .filter(Boolean).sort().at(-1) || null;
  const source = hasProviderUsage && !hasRouterQuota && observations.length === 0
    ? providerSources.size === 1 ? [...providerSources][0] : "multiple_provider_sources"
    : hasProviderUsage ? "mixed_quota_sources"
      : hasRouterQuota ? "router_quota_constraints"
        : "provider_rejection";
  return {
    state: hasProviderUsage && !hasRouterQuota && observations.length === 0
      ? "provider_usage_blocked"
      : "quota_blocked",
    retryAt,
    confidence: hasUnknown ? "unknown" : hasEstimated ? "estimated" : "provider_confirmed",
    observedAt,
    retryScope: "new_request_after_check",
    source,
  };
}

export async function recordImageQuotaBlock(connection, observation, requestId, attemptNumber = null) {
  const observations = Array.isArray(observation?.constraints) && observation.constraints.length
    ? observation.constraints
    : [observation];
  return recordImageQuotaObservations(connection, observations, requestId, attemptNumber);
}

export async function finishImageQuotaRecovery(connection, rows, owner, result) {
  return finishImageQuotaProbe(connection, rows, owner, result);
}

export async function admitImageQuotaRequest(connection, capability, model, probeOwner = null) {
  return admitImageQuotaRequestRepo(connection, capability, model, probeOwner);
}

export async function getImageQuotaPoolAvailability(provider, model, rejected = new Map(), requestRejections = []) {
  const providerId = resolveProviderId(provider);
  const allConnections = await getProviderConnections({ provider: providerId, isActive: true });
  const projectIdentityConnections = providerId === "gemini"
    ? allConnections.filter((connection) => Boolean(geminiQuotaProjectId(connection)))
    : allConnections;
  const identityRequired = providerId === "gemini" && allConnections.length > 0 && projectIdentityConnections.length === 0;
  const connections = projectIdentityConnections.filter((connection) => {
    const enabled = connection.providerSpecificData?.enabledModels;
    return !(providerId === "codex" && Array.isArray(enabled) && enabled.length && !enabled.includes(model));
  });
  if (!connections.length) return { hasConnections: false, identityRequired, allBlocked: false, candidateCount: 0 };
  const states = await getImageQuotaState(connections, providerId, "image_generation", model);
  const candidates = connections.filter((connection) => {
    const state = imageQuotaStateFor(connection, states);
    if (currentRequestQuotaRejection(connection, providerId, model, rejected, requestRejections)) return false;
    return effectiveImageQuotaEligibility(connection, state, {
      model,
      antigravityQuotaBlock: antigravityQuotaBlock(
        connection,
        model,
        providerId === "antigravity" ? getAntigravityQuotaCache() : null,
      ),
    }).eligible;
  });
  const unpausedConnections = connections.filter((connection) => !imageQuotaStateFor(connection, states).manualPolicy);
  const allBlocked = unpausedConnections.length > 0 && unpausedConnections.every((connection) => {
    const state = imageQuotaStateFor(connection, states);
    if (currentRequestQuotaRejection(connection, providerId, model, rejected, requestRejections)) return true;
    return state.blockingRows.length > 0 || Boolean(antigravityQuotaBlock(
      connection,
      model,
      providerId === "antigravity" ? getAntigravityQuotaCache() : null,
    ));
  });
  const allPaused = connections.every((connection) => Boolean(imageQuotaStateFor(connection, states).manualPolicy));
  return {
    hasConnections: true,
    allBlocked,
    allPaused,
    candidateCount: candidates.length,
    state: allBlocked ? summarizeImageQuotaPool(
      unpausedConnections,
      states,
      rejected,
      requestRejections,
      providerId,
      model,
      Date.now(),
      providerId === "antigravity" ? getAntigravityQuotaCache() : null,
    ) : null,
  };
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const requestedModel = options?.requestedModel || model;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          strictProxy: resolvedProxy.strictProxy === true,
        },
      };
    }

    const allConnections = (await getProviderConnections({ provider: providerId, isActive: true }))
      .filter((connection) => !options?.requestState?.pinnedConnectionId || connection.id === options.requestState.pinnedConnectionId);
    const quotaAwareImage = options?.capability === "image_generation"
      && Boolean(IMAGE_QUOTA_CONFIG.providers[providerId]);
    const connections = quotaAwareImage && providerId === "gemini"
      ? allConnections.filter((connection) => Boolean(geminiQuotaProjectId(connection)))
      : allConnections;
    const textPolicies = options?.capability === 'chat' ? await readTextModelPolicies(connections) : null;
    const admissionSnapshots = options?.capability==='chat' || quotaAwareImage ? await readRotationSnapshots(connections) : {};
    const requestState = options?.requestState || {};
    requestState.unavailableReason=null;
    if(options?.capability==='chat' && !requestState.textRotationPolicy) requestState.textRotationPolicy=structuredClone((await getSettings()).providerStrategies?.[providerId]?.rotationSequence || emptyRotation());
    const automaticResetBlocked = new Set();
    let automaticResetReady = null;
    if (providerId === 'codex' && options?.capability === 'chat' && !options?.peekOnly) {
      const policy = requestState.textRotationPolicy;
      const candidates = connections.filter(c => !excludeSet.has(c.id) && (!isModelLockActive(c, model) || Number(c.errorCode) === 429) && !textModelPermissionReason(c, requestedModel, textPolicies?.get(c.id), admissionSnapshots[c.id]?.modelAccess));
      const { prepareAutomaticCreditReset } = await import('@/shared/services/automaticCreditReset.js');
      const prepared = await prepareAutomaticCreditReset(candidates, policy, options.requestedModel || model);
      prepared.blocked.forEach(id => automaticResetBlocked.add(id));
      automaticResetReady = prepared.readyId || null;
    }
    log.debug("AUTH", `${provider} | total connections: ${allConnections.length}, quota-ready: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (allConnections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }
    if (quotaAwareImage && providerId === "gemini" && connections.length === 0) {
      return { imageQuotaIdentityRequired: true };
    }
    const currentRequestRejected = options?.quotaRejected instanceof Map
      ? options.quotaRejected
      : new Map();
    const requestQuotaRejections = Array.isArray(options?.requestQuotaRejections)
      ? options.requestQuotaRejections
      : [];
    const wasRejectedForThisRequest = (connection) => Boolean(currentRequestQuotaRejection(
      connection,
      providerId,
      model,
      currentRequestRejected,
      requestQuotaRejections,
    ));
    const quotaStates = quotaAwareImage
      ? await getImageQuotaState(connections, providerId, "image_generation", model)
      : null;
    const subscriptionBlocked = connection => applicableRotationQuotas(admissionSnapshots[connection.id],providerId,options.requestedModel||model).some(quota=>quota.remaining===0);
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;
    const quotaRequestId = options?.quotaRequestId || null;
    let probeCandidate = null;
    let probeLeaseExpiresAt = null;
    let dispatchedProbePending = false;
    if (quotaAwareImage) {
      for (const connection of connections) {
        const state = imageQuotaStateFor(connection, quotaStates);
        if ((state.probeInProgressRows || []).some((row) => row.probeDispatchedAt)) dispatchedProbePending = true;
        const expiry = (state.probeInProgressRows || [])
          .map((row) => row.probeLeaseExpiresAt)
          .filter((value) => value && Date.parse(value) > Date.now())
          .sort()[0];
        if (expiry && (!probeLeaseExpiresAt || expiry < probeLeaseExpiresAt)) {
          probeLeaseExpiresAt = expiry;
        }
      }
    }
    const codexModelEnabled = (connection) => {
      return !accountModelAccess(connection,requestedModel,quotaAwareImage?undefined:admissionSnapshots[connection.id]?.modelAccess).reason;
    };

    if (quotaAwareImage && !options?.peekOnly && !requestState?.recoveryProbeClaimed && quotaRequestId) {
      const recoveryCandidates = connections
        .filter((connection) => !excludeSet.has(connection.id)
          && !wasRejectedForThisRequest(connection)
          && codexModelEnabled(connection)
          && !subscriptionBlocked(connection))
        .map((connection) => ({ connection, state: imageQuotaStateFor(connection, quotaStates) }))
        .filter(({ connection, state }) => state.expiredRows.length > 0
          && effectiveImageQuotaEligibility(connection, state, {
            model,
            antigravityQuotaBlock: antigravityQuotaBlock(connection, model, antigravityQuotaCache),
          }).state === "probe_eligible")
        .sort((a, b) => {
          const aAt = imageQuotaResetAt(a.state.expiredRows) || "9999";
          const bAt = imageQuotaResetAt(b.state.expiredRows) || "9999";
          return aAt.localeCompare(bAt);
        });

      for (const candidate of recoveryCandidates) {
        const lease = await acquireImageQuotaProbeLeases(
          candidate.connection,
          candidate.state.expiredRows,
          quotaRequestId,
          IMAGE_QUOTA_CONFIG.probeLeaseMs,
        );
        if (lease.acquired) {
          probeCandidate = candidate.connection;
          requestState.recoveryProbeClaimed = true;
          break;
        }
        if (lease.leaseExpiresAt && (!probeLeaseExpiresAt || lease.leaseExpiresAt < probeLeaseExpiresAt)) {
          probeLeaseExpiresAt = lease.leaseExpiresAt;
        }
      }
    }

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    let availableConnections = connections.filter(c => {
      if (automaticResetBlocked.has(c.id)) return false;
      if (excludeSet.has(c.id)) return false;
      if (textPolicies && textModelPermissionReason(c, requestedModel, textPolicies.get(c.id), admissionSnapshots[c.id]?.modelAccess)) return false;
      if (isModelLockActive(c, model)) return false;
      if (quotaAwareImage) {
        if (subscriptionBlocked(c)) return false;
        if (wasRejectedForThisRequest(c)) return false;
        const state = imageQuotaStateFor(c, quotaStates);
        const eligibility = effectiveImageQuotaEligibility(c, state, {
          model,
          antigravityQuotaBlock: antigravityQuotaBlock(c, model, antigravityQuotaCache),
        });
        if (!eligibility.eligible) return false;
        if (eligibility.state === "probe_eligible" && !options?.peekOnly && c.id !== probeCandidate?.id) return false;
      }
      if (accountModelAccess(c,requestedModel,quotaAwareImage?undefined:admissionSnapshots[c.id]?.modelAccess).reason) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (!quotaAwareImage && isAntigravity && model && antigravityQuotaCache) {
        const resetAt = antigravityQuotaResetAt(c, model, antigravityQuotaCache);
        if (resetAt) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${resetAt}`);
          return false;
        }
      }
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      if(options?.capability==='chat') requestState.unavailableReason="No account can serve the requested model right now.";
      if (quotaAwareImage) {
        const unpausedConnections = connections.filter((connection) => !imageQuotaStateFor(connection, quotaStates).manualPolicy);
        const allQuotaBlocked = unpausedConnections.length > 0 && unpausedConnections.every((connection) => {
          const state = imageQuotaStateFor(connection, quotaStates);
          if (wasRejectedForThisRequest(connection)) return true;
          return state.blockingRows.length > 0 || Boolean(antigravityQuotaBlock(connection, model, antigravityQuotaCache));
        });
        if (allQuotaBlocked) {
          const availability = summarizeImageQuotaPool(
            unpausedConnections,
            quotaStates,
            currentRequestRejected,
            requestQuotaRejections,
            providerId,
            model,
            Date.now(),
            antigravityQuotaCache,
          );
          return {
            allRateLimited: true,
            imageQuotaAvailability: availability,
            retryAfter: availability.retryAt,
            retryAfterHuman: availability.retryAt ? formatRetryAfter(availability.retryAt) : null,
            lastError: "Image generation quota is temporarily limited",
            lastErrorCode: 429,
          };
        }
        if (probeLeaseExpiresAt || dispatchedProbePending) {
          return {
            imageQuotaProbeInProgress: true,
            imageQuotaAvailability: {
              state: "probe_in_progress",
              retryAt: dispatchedProbePending ? null : probeLeaseExpiresAt,
              confidence: dispatchedProbePending ? "unknown" : "estimated",
              observedAt: new Date().toISOString(),
              retryScope: dispatchedProbePending ? "none" : "new_request_after_check",
            },
          };
        }
        if (connections.length > 0 && connections.every((connection) => Boolean(imageQuotaStateFor(connection, quotaStates).manualPolicy))) {
          return { imageQuotaManualPaused: true, imageQuotaAvailability: { state: "manual_paused", retryAt: null, confidence: "unknown", retryScope: "none" } };
        }
        if (connections.some((connection) => Boolean(imageQuotaStateFor(connection, quotaStates).manualPolicy))) {
          return { imageQuotaPolicyBlocked: true, imageQuotaAvailability: { state: "policy_blocked", retryAt: null, confidence: "unknown", retryScope: "none" } };
        }
      }
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const connQuotas = antigravityQuotaCache.get(c.id);
          const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
          const resetAt = quota?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const imageRule = resolveImageRouting(settings, providerId, model, options?.imageOperation);
    const imageSelection = resolveImageSelection(imageRule,providerOverride,settings);
    const strategy = imageSelection.strategy;

    const accountSequence = options?.imageOperation ? resolveImageAccountPreference(imageRule, providerOverride.rotationSequence, providerId) : requestState.textRotationPolicy || providerOverride.rotationSequence || emptyRotation();
    let connection;
    if (probeCandidate && availableConnections.includes(probeCandidate)) {
      connection = probeCandidate;
    }
    if (!connection && automaticResetReady) connection = availableConnections.find(c => c.id === automaticResetReady);
    // Pin to preferred connection if specified and available
    if (!connection && preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if ((!connection || connection !== probeCandidate) && (options?.capability === "chat" || options?.imageOperation) && (accountSequence || options?.imageOperation)) {
      try {
        const snapshots = quotaAwareImage ? admissionSnapshots : await readRotationSnapshots(availableConnections);
        const quotaModel = requestedModel;
        const pool = rotationPool(availableConnections, snapshots, accountSequence, { quotaAdmission: Boolean(options?.imageOperation), provider: providerId, model: quotaModel, lockModel: model, textPolicies });
        if (connection && !pool.ranked.some(row => row.connection.id === connection.id)) connection = null;
        // Account ranking precedes model-specific image rotation, without bypassing admission gates.
        availableConnections = pool.hasEvidence ? pool.candidates : pool.ranked.map(row => row.connection);
        if (!connection && pool.hasEvidence && !options?.imageOperation) connection = strategy !== "round-robin" ? pool.candidates[0] : await chooseSequenceConnection(pool.candidates, {
          provider: providerId, model: quotaModel, policy: accountSequence,
          stickyRequests: strategy === "round-robin" ? (providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3) : 1,
          peekOnly: Boolean(options?.peekOnly),
        });
        if (!connection && !availableConnections.length) {
          if(options?.capability==='chat') requestState.unavailableReason=`No eligible account: ${pool.blocked[0]?.reason || pool.waiting[0]?.reason || 'quota or model access unavailable'}.`;
          return null;
        }
      } catch (error) { log.warn("ROTATION", `Sequence unavailable; using existing strategy: ${error.message}`); }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      let rotationCandidates = availableConnections;
      if (quotaAwareImage && availableConnections.length > 1) {
        const loads = await getImageSupplierLoads(availableConnections, providerId);
        const minimum = Math.min(...availableConnections.map((candidate) => loads.get(candidate.id) || 0));
        rotationCandidates = availableConnections.filter((candidate) => (loads.get(candidate.id) || 0) === minimum);
      }
      const stickyLimit = imageSelection.stickyRequests;
      if (options?.imageOperation) {
        connection = await selectImageRotation(rotationCandidates, {provider:providerId,model,operation:options.imageOperation,stickyRequests:stickyLimit,peekOnly:Boolean(options?.peekOnly)});
      } else {
        // Sort by lastUsed (most recent first) to find current candidate
        const byRecency = [...rotationCandidates].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return 1;
          if (!b.lastUsedAt) return -1;
          return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
        });

        const current = byRecency[0];
        const currentCount = current?.consecutiveUseCount || 0;

        if (!options?.peekOnly && current && current.lastUsedAt && currentCount < stickyLimit) {
          // Stay with current account
          connection = current;
          // Update lastUsedAt and increment count (await to ensure persistence)
          await updateProviderConnection(connection.id, {
            lastUsedAt: new Date().toISOString(),
            consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
          });
        } else if (!options?.peekOnly) {
          // Pick the least recently used (excluding current if possible)
          const sortedByOldest = [...rotationCandidates].sort((a, b) => {
            if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
            if (!a.lastUsedAt) return -1;
            if (!b.lastUsedAt) return 1;
            return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
          });

          connection = sortedByOldest[0];

          // Update lastUsedAt and reset count to 1 (await to ensure persistence)
          await updateProviderConnection(connection.id, {
            lastUsedAt: new Date().toISOString(),
            consecutiveUseCount: 1
          });
        } else {
          connection = legacyRotationNext(rotationCandidates, "round-robin", stickyLimit);
        }
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        strictProxy: resolvedProxy.strictProxy === true,
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection,
      _imageQuotaProbe: probeCandidate?.id === connection.id
        ? {
            owner: quotaRequestId,
            rows: imageQuotaStateFor(connection, quotaStates).expiredRows,
          }
        : null,
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Apply a persistent account+model cooldown when the provider error policy requests one.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    cooldownMs = resolveProviderId(provider) === "antigravity"
      ? resetsAtMs - Date.now()
      : Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel, resolveProviderId(provider)));
  }
  if (!shouldFallback || cooldownMs <= 0) return { shouldFallback, cooldownMs: Math.max(0, cooldownMs || 0) };

  const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error";
  const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
