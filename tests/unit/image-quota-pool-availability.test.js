import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getImageQuotaState: vi.fn(),
  getImageSupplierLoads: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(async () => []),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: () => new Map(),
  getAntigravityModelQuota: () => null,
}));
vi.mock("@/lib/db/repos/imageQuotaRepo.js", () => ({
  acquireImageQuotaProbeLeases: vi.fn(),
  admitImageQuotaRequest: vi.fn(),
  finishImageQuotaProbe: vi.fn(),
  getImageQuotaState: mocks.getImageQuotaState,
  getImageSupplierLoads: mocks.getImageSupplierLoads,
  imageQuotaIdentity: (connection) => {
    const account = connection?.providerSpecificData?.chatgptAccountId;
    const workspace = connection?.providerSpecificData?.workspaceId;
    return account ? `codex:${account}${workspace ? `:${workspace}` : ""}` : `connection:${connection?.id}`;
  },
  imageQuotaIdentityGeneration: (connection) => Number(connection?.providerSpecificData?.imageQuotaIdentityGeneration) || 1,
  recordImageQuotaObservation: vi.fn(),
}));
vi.mock("open-sse/services/accountFallback.js", () => ({
  buildModelLockUpdate: vi.fn(),
  checkFallbackError: vi.fn(),
  formatRetryAfter: vi.fn((value) => value),
  getEarliestModelLockUntil: vi.fn(),
  isModelLockActive: vi.fn(() => false),
}));
vi.mock("open-sse/config/errorConfig.js", () => ({ MAX_RATE_LIMIT_COOLDOWN_MS: 60_000 }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

import { getImageQuotaPoolAvailability, getProviderCredentials } from "../../src/sse/services/auth.js";

const pausedAccount = { id: "paused", provider: "codex", isActive: true, providerSpecificData: {} };
const blockedAccount = { id: "blocked", provider: "codex", isActive: true, providerSpecificData: {} };
const retryAt = new Date(Date.now() + 60_000).toISOString();

describe("image quota pool availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({});
    mocks.getImageSupplierLoads.mockResolvedValue(new Map());
    mocks.getProviderConnections.mockResolvedValue([pausedAccount, blockedAccount]);
  });

  it.each(["round-robin", "fill-first"])("respects %s strategy while distributing busy image accounts", async (strategy) => {
    const busy = { ...blockedAccount, id: "busy", lastUsedAt: new Date().toISOString(), consecutiveUseCount: 1 };
    const idle = { ...blockedAccount, id: "idle" };
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: strategy });
    mocks.getProviderConnections.mockResolvedValue([busy, idle]);
    mocks.getImageQuotaState.mockResolvedValue(new Map([busy, idle].map((row) => [row.id, { blockingRows: [], expiredRows: [] }])));
    mocks.getImageSupplierLoads.mockResolvedValue(new Map([[busy.id, 3], [idle.id, 0]]));
    await expect(getProviderCredentials("codex", null, "gpt-image-2", { capability: "image_generation" }))
      .resolves.toMatchObject({ connectionId: strategy === "round-robin" ? idle.id : busy.id });
  });

  it.each([false, true])("preserves pinning and existing round-robin ties (pin=%s)", async (pinned) => {
    const first = { ...blockedAccount, id: "first", lastUsedAt: "2026-10-21T00:00:00Z", consecutiveUseCount: 3 };
    const oldest = { ...blockedAccount, id: "oldest", lastUsedAt: "2026-10-20T00:00:00Z" };
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin" });
    mocks.getProviderConnections.mockResolvedValue([first, oldest]);
    mocks.getImageQuotaState.mockResolvedValue(new Map([first, oldest].map((row) => [row.id, { blockingRows: [], expiredRows: [] }])));
    mocks.getImageSupplierLoads.mockResolvedValue(new Map([[first.id, 1], [oldest.id, 1]]));
    await expect(getProviderCredentials("codex", null, "gpt-image-2", {
      capability: "image_generation", ...(pinned ? { preferredConnectionId: first.id } : {}),
    })).resolves.toMatchObject({ connectionId: pinned ? first.id : oldest.id });
  });

  it.each(["legacy", "probe", "rejection"])("includes %s constraints in exhausted-pool retry metadata", async (kind) => {
    const later = new Date(Date.now() + 7 * 86400_000).toISOString();
    const connection = { ...blockedAccount, ...(kind === "legacy" ? { modelLock___all: later } : {}) };
    mocks.getProviderConnections.mockResolvedValue([connection]);
    mocks.getImageQuotaState.mockResolvedValue(new Map([[connection.id, {
      manualPolicy: null,
      blockingRows: [{ retryAt, confidence: "provider_confirmed" }],
      expiredRows: [],
      probeInProgressRows: kind === "probe" ? [{ probeDispatchedAt: new Date().toISOString() }] : [],
    }]]));
    const rejected = kind === "rejection" ? new Map([[connection.id, { retryAt: later, confidence: "provider_confirmed" }]]) : new Map();
    await expect(getImageQuotaPoolAvailability("codex", "gpt-image-2", rejected)).resolves.toMatchObject({
      allBlocked: true, candidateCount: 0,
      state: { retryAt: kind === "probe" ? null : later,
        confidence: kind === "probe" ? "unknown" : kind === "legacy" ? "estimated" : "provider_confirmed" },
    });
  });

  it("chooses the earliest alternative after each account's full constraints clear", async () => {
    const later = new Date(Date.now() + 7 * 86400_000).toISOString();
    const alternative = new Date(Date.now() + 2 * 86400_000).toISOString();
    const first = { ...blockedAccount, modelLock___all: later };
    const second = { ...blockedAccount, id: "alternative" };
    mocks.getProviderConnections.mockResolvedValue([first, second]);
    mocks.getImageQuotaState.mockResolvedValue(new Map([
      [first.id, { blockingRows: [{ retryAt, confidence: "provider_confirmed" }], expiredRows: [] }],
      [second.id, { blockingRows: [{ retryAt: alternative, confidence: "provider_confirmed" }], expiredRows: [] }],
    ]));
    await expect(getImageQuotaPoolAvailability("codex", "gpt-image-2")).resolves.toMatchObject({
      candidateCount: 0, allBlocked: true, state: { retryAt: alternative },
    });
  });

  it("reports quota exhaustion from unpaused accounts while excluding manually paused accounts", async () => {
    mocks.getImageQuotaState.mockResolvedValue(new Map([
      [pausedAccount.id, { manualPolicy: { policyState: "paused" }, blockingRows: [], expiredRows: [] }],
      [blockedAccount.id, {
        manualPolicy: null,
        blockingRows: [{ retryAt, confidence: "provider_confirmed", observedAt: "2026-10-15T00:00:00.000Z" }],
        expiredRows: [],
      }],
    ]));

    await expect(getImageQuotaPoolAvailability("codex", "gpt-image-2")).resolves.toMatchObject({
      hasConnections: true,
      allBlocked: true,
      allPaused: false,
      candidateCount: 0,
      state: { state: "quota_blocked", retryAt, confidence: "provider_confirmed" },
    });
  });

  it("reports a fully paused pool separately from quota exhaustion", async () => {
    mocks.getImageQuotaState.mockResolvedValue(new Map([
      [pausedAccount.id, { manualPolicy: { policyState: "paused" }, blockingRows: [], expiredRows: [] }],
      [blockedAccount.id, { manualPolicy: { policyState: "paused" }, blockingRows: [], expiredRows: [] }],
    ]));

    await expect(getImageQuotaPoolAvailability("codex", "gpt-image-2")).resolves.toMatchObject({
      allBlocked: false,
      allPaused: true,
      candidateCount: 0,
      state: null,
    });
  });

  it("routes concurrent requests to a healthy account while another account is being probed", async () => {
    const probing = { id: "probing", provider: "codex", isActive: true, priority: 1, providerSpecificData: {} };
    const healthy = { id: "healthy", provider: "codex", isActive: true, priority: 2, providerSpecificData: {} };
    const leaseExpiresAt = new Date(Date.now() + 120_000).toISOString();
    mocks.getProviderConnections.mockResolvedValue([probing, healthy]);
    mocks.getImageQuotaState.mockResolvedValue(new Map([
      [probing.id, {
        manualPolicy: null,
        blockingRows: [],
        expiredRows: [{ quotaGroupId: "codex.image_generation", constraintId: "usage_limit", retryAt: new Date(Date.now() - 60_000).toISOString() }],
        probeInProgressRows: [{ quotaGroupId: "codex.image_generation", constraintId: "usage_limit", probeLeaseExpiresAt: leaseExpiresAt }],
      }],
      [healthy.id, { manualPolicy: null, blockingRows: [], expiredRows: [], probeInProgressRows: [] }],
    ]));

    await expect(getProviderCredentials("codex", null, "gpt-image-2", {
      capability: "image_generation",
      quotaRequestId: "request-healthy",
      requestState: {},
    })).resolves.toMatchObject({ connectionId: healthy.id });
  });

  it("skips linked connections for the same quota identity after a confirmed rejection", async () => {
    const rejected = {
      id: "rejected-connection",
      provider: "codex",
      isActive: true,
      priority: 1,
      providerSpecificData: { chatgptAccountId: "supplier-account", workspaceId: "workspace-a" },
    };
    const linked = {
      id: "linked-connection",
      provider: "codex",
      isActive: true,
      priority: 2,
      providerSpecificData: { chatgptAccountId: "supplier-account", workspaceId: "workspace-a" },
    };
    const healthy = {
      id: "healthy-connection",
      provider: "codex",
      isActive: true,
      priority: 3,
      providerSpecificData: { chatgptAccountId: "other-account", workspaceId: "workspace-a" },
    };
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    const observation = {
      retryAt,
      observedAt: new Date().toISOString(),
      confidence: "provider_confirmed",
    };
    const rejection = {
      provider: "codex",
      identity: "codex:supplier-account:workspace-a",
      identityGeneration: 1,
      quotaGroupId: "codex.image_generation",
      constraintId: "usage_limit",
      appliesToModels: ["*"],
      observation,
    };
    mocks.getProviderConnections.mockResolvedValue([rejected, linked, healthy]);
    mocks.getImageQuotaState.mockResolvedValue(new Map([
      [rejected.id, { identity: rejection.identity, generation: 1, manualPolicy: null, blockingRows: [], expiredRows: [], probeInProgressRows: [] }],
      [linked.id, { identity: rejection.identity, generation: 1, manualPolicy: null, blockingRows: [], expiredRows: [], probeInProgressRows: [] }],
      [healthy.id, { identity: "codex:other-account:workspace-a", generation: 1, manualPolicy: null, blockingRows: [], expiredRows: [], probeInProgressRows: [] }],
    ]));

    await expect(getProviderCredentials("codex", null, "gpt-image-2", {
      capability: "image_generation",
      requestQuotaRejections: [rejection],
      quotaRequestId: "request-linked-scope",
      requestState: {},
    })).resolves.toMatchObject({ connectionId: healthy.id });

    await expect(getImageQuotaPoolAvailability("codex", "gpt-image-2", new Map(), [rejection])).resolves.toMatchObject({
      candidateCount: 1,
      allBlocked: false,
    });
  });

  it("keeps a rejection inside its declared model and identity-generation scope", async () => {
    const linked = {
      id: "next-generation-connection",
      provider: "codex",
      isActive: true,
      providerSpecificData: {
        chatgptAccountId: "supplier-account",
        workspaceId: "workspace-a",
        imageQuotaIdentityGeneration: 2,
      },
    };
    const rejection = {
      provider: "codex",
      identity: "codex:supplier-account:workspace-a",
      identityGeneration: 1,
      quotaGroupId: "codex.image_generation",
      constraintId: "usage_limit",
      appliesToModels: ["gpt-image-2"],
      observation: { retryAt, observedAt: new Date().toISOString(), confidence: "provider_confirmed" },
    };
    mocks.getProviderConnections.mockResolvedValue([linked]);
    mocks.getImageQuotaState.mockResolvedValue(new Map([[linked.id, {
      identity: rejection.identity,
      generation: 2,
      manualPolicy: null,
      blockingRows: [],
      expiredRows: [],
      probeInProgressRows: [],
    }]]));

    await expect(getProviderCredentials("codex", null, "gpt-image-3", {
      capability: "image_generation",
      requestQuotaRejections: [rejection],
      quotaRequestId: "request-model-scope",
      requestState: {},
    })).resolves.toMatchObject({ connectionId: linked.id });
  });

  it.each([false, true])("returns pending recovery without promising dispatch expiry (dispatched=%s)", async (dispatched) => {
    const probing = { id: "probing", provider: "codex", isActive: true, providerSpecificData: {} };
    const leaseExpiresAt = new Date(Date.now() + 120_000).toISOString();
    mocks.getProviderConnections.mockResolvedValue([probing]);
    mocks.getImageQuotaState.mockResolvedValue(new Map([[probing.id, {
      manualPolicy: null,
      blockingRows: [],
      expiredRows: [{ quotaGroupId: "codex.image_generation", constraintId: "usage_limit", retryAt: new Date(Date.now() - 60_000).toISOString() }],
      probeInProgressRows: [{ quotaGroupId: "codex.image_generation", constraintId: "usage_limit", probeLeaseExpiresAt: leaseExpiresAt, probeDispatchedAt: dispatched ? new Date().toISOString() : null }],
    }]]));

    await expect(getProviderCredentials("codex", null, "gpt-image-2", {
      capability: "image_generation",
      quotaRequestId: "request-waiting",
      requestState: {},
    })).resolves.toMatchObject({
      imageQuotaProbeInProgress: true,
      imageQuotaAvailability: {
        state: "probe_in_progress",
        retryAt: dispatched ? null : leaseExpiresAt,
        confidence: dispatched ? "unknown" : "estimated",
        retryScope: dispatched ? "none" : "new_request_after_check",
      },
    });
  });
});
