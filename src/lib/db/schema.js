// ⚠️ AGENT/DEV: Bump this by +1 EVERY TIME you change the schema below
// (add/remove/alter a table, column, or index in TABLES). It drives the
// pre-change safety backup in migrate.js: when the stored version is lower,
// one lightweight DB backup is taken before applying schema changes. Forgetting
// to bump only skips that backup — it does NOT break the additive auto-sync.
export const SCHEMA_VERSION = 19;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      // Per-key access control. Additive columns, picked up by
      // syncSchemaFromTables() on boot; existing rows read as unrestricted (0).
      accessRestricted: "INTEGER DEFAULT 0",
      accessAllow: "TEXT",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)"],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
    ],
  },
  imageQuotaConstraints: {
    columns: {
      provider: "TEXT NOT NULL",
      supplierIdentity: "TEXT NOT NULL",
      identityGeneration: "INTEGER NOT NULL DEFAULT 1",
      capability: "TEXT NOT NULL",
      quotaGroupId: "TEXT NOT NULL",
      constraintId: "TEXT NOT NULL",
      observedModel: "TEXT",
      appliesToModels: "TEXT NOT NULL",
      state: "TEXT NOT NULL",
      confidence: "TEXT NOT NULL",
      observedAt: "TEXT NOT NULL",
      retryAt: "TEXT",
      source: "TEXT NOT NULL",
      revision: "INTEGER NOT NULL DEFAULT 1",
      updatedAt: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (provider, supplierIdentity, identityGeneration, quotaGroupId, constraintId)",
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_iqc_provider_capability ON imageQuotaConstraints(provider, capability)",
      "CREATE INDEX IF NOT EXISTS idx_iqc_retry_at ON imageQuotaConstraints(state, retryAt)",
    ],
  },
  imageQuotaProbeLeases: {
    columns: {
      provider: "TEXT NOT NULL",
      supplierIdentity: "TEXT NOT NULL",
      identityGeneration: "INTEGER NOT NULL DEFAULT 1",
      quotaGroupId: "TEXT NOT NULL",
      constraintId: "TEXT NOT NULL",
      leaseOwner: "TEXT NOT NULL",
      leaseExpiresAt: "TEXT NOT NULL",
      dispatchedAt: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (provider, supplierIdentity, identityGeneration, quotaGroupId, constraintId)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_iqpl_expiry ON imageQuotaProbeLeases(leaseExpiresAt)"],
  },
  imageQuotaPolicies: {
    columns: {
      provider: "TEXT NOT NULL",
      supplierIdentity: "TEXT NOT NULL",
      identityGeneration: "INTEGER NOT NULL DEFAULT 1",
      capability: "TEXT NOT NULL",
      quotaGroupId: "TEXT NOT NULL",
      policyState: "TEXT NOT NULL",
      revision: "INTEGER NOT NULL DEFAULT 1",
      reason: "TEXT",
      updatedBy: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (provider, supplierIdentity, identityGeneration, capability, quotaGroupId)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_iqp_provider_state ON imageQuotaPolicies(provider, capability, policyState)"],
  },
  imageQuotaPolicyAudit: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      supplierIdentity: "TEXT NOT NULL",
      identityGeneration: "INTEGER NOT NULL DEFAULT 1",
      capability: "TEXT NOT NULL",
      quotaGroupId: "TEXT NOT NULL",
      action: "TEXT NOT NULL",
      previousState: "TEXT NOT NULL",
      nextState: "TEXT NOT NULL",
      revision: "INTEGER NOT NULL",
      reason: "TEXT",
      actor: "TEXT NOT NULL",
      idempotencyKey: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_iqpa_scope_time ON imageQuotaPolicyAudit(provider, capability, quotaGroupId, createdAt)"],
  },
  imageQuotaIdempotency: {
    columns: {
      principal: "TEXT NOT NULL",
      idempotencyKey: "TEXT NOT NULL",
      requestHash: "TEXT NOT NULL",
      receipt: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (principal, idempotencyKey)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_iqi_created_at ON imageQuotaIdempotency(createdAt)"],
  },
  imageQuotaAdmissionState: {
    columns: {
      id: "INTEGER NOT NULL",
      revision: "INTEGER NOT NULL DEFAULT 0",
      quotaObservations: "TEXT NOT NULL DEFAULT '[]'",
    },
    primaryKey: "PRIMARY KEY (id)",
  },
  imageQuotaRequestAttempts: {
    columns: {
      id: "TEXT PRIMARY KEY",
      routerRequestId: "TEXT NOT NULL",
      clientOperationId: "TEXT",
      attemptNumber: "INTEGER NOT NULL",
      provider: "TEXT NOT NULL",
      model: "TEXT NOT NULL",
      connectionId: "TEXT NOT NULL",
      supplierIdentity: "TEXT",
      identityGeneration: "INTEGER",
      quotaObservations: "TEXT",
      quotaLockResolvedAt: "TEXT",
      outcome: "TEXT NOT NULL",
      httpStatus: "INTEGER",
      failureClass: "TEXT",
      quotaGroupId: "TEXT",
      constraintId: "TEXT",
      retryAt: "TEXT",
      confidence: "TEXT",
      fallbackAction: "TEXT NOT NULL",
      startedAt: "TEXT NOT NULL",
      completedAt: "TEXT",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_iqra_request_attempt ON imageQuotaRequestAttempts(routerRequestId, attemptNumber)",
      "CREATE INDEX IF NOT EXISTS idx_iqra_client_operation ON imageQuotaRequestAttempts(clientOperationId, startedAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_iqra_started_at ON imageQuotaRequestAttempts(startedAt)",
      "CREATE INDEX IF NOT EXISTS idx_iqra_unresolved_quota ON imageQuotaRequestAttempts(provider, supplierIdentity, identityGeneration) WHERE outcome = 'quota_rejected' AND quotaLockResolvedAt IS NULL",
    ],
  },
  imageQuotaRequestSubmissions: {
    columns: {
      id: "TEXT PRIMARY KEY",
      routerRequestId: "TEXT NOT NULL",
      clientOperationId: "TEXT",
      attemptNumber: "INTEGER NOT NULL",
      submissionNumber: "INTEGER NOT NULL",
      provider: "TEXT NOT NULL",
      requestedModel: "TEXT NOT NULL",
      model: "TEXT NOT NULL",
      connectionId: "TEXT NOT NULL",
      supplierIdentity: "TEXT",
      identityGeneration: "INTEGER",
      entryPoint: "TEXT NOT NULL",
      operation: "TEXT NOT NULL",
      outcome: "TEXT NOT NULL",
      httpStatus: "INTEGER",
      failureClass: "TEXT",
      quotaGroupId: "TEXT",
      constraintId: "TEXT",
      retryAt: "TEXT",
      confidence: "TEXT",
      quotaObservations: "TEXT",
      quotaLockResolvedAt: "TEXT",
      providerRequestId: "TEXT",
      outputCount: "INTEGER",
      usageJson: "TEXT",
      traceScrubbedAt: "TEXT",
      dispatchedAt: "TEXT NOT NULL",
      completedAt: "TEXT",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_iqrs_request_submission ON imageQuotaRequestSubmissions(routerRequestId, submissionNumber)",
      "CREATE INDEX IF NOT EXISTS idx_iqrs_operation ON imageQuotaRequestSubmissions(clientOperationId, dispatchedAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_iqrs_account_model_history ON imageQuotaRequestSubmissions(provider, connectionId, model, dispatchedAt DESC)",
      "CREATE INDEX IF NOT EXISTS idx_iqrs_account_window ON imageQuotaRequestSubmissions(provider, connectionId, dispatchedAt)",
      "CREATE INDEX IF NOT EXISTS idx_iqrs_unresolved_quota ON imageQuotaRequestSubmissions(provider, supplierIdentity, identityGeneration) WHERE outcome = 'quota_rejected' AND quotaLockResolvedAt IS NULL",
    ],
  },
  imageSupplierBudgets: {
    columns: {
      id: "TEXT PRIMARY KEY",
      scopeType: "TEXT NOT NULL CHECK (scopeType IN ('installation', 'billing_project'))",
      scopeKey: "TEXT NOT NULL CHECK (length(scopeKey) BETWEEN 1 AND 160)",
      currency: "TEXT NOT NULL CHECK (currency = 'USD')",
      scale: "INTEGER NOT NULL CHECK (scale = 6)",
      enabled: "INTEGER NOT NULL CHECK (enabled IN (0, 1))",
      revision: "INTEGER NOT NULL CHECK (revision > 0)",
      pricingPolicyVersion: "TEXT NOT NULL",
      dailyLimitMicrousd: "INTEGER NOT NULL CHECK (dailyLimitMicrousd >= 0)",
      monthlyLimitMicrousd: "INTEGER NOT NULL CHECK (monthlyLimitMicrousd >= 0)",
      pilotLimitMicrousd: "INTEGER NOT NULL CHECK (pilotLimitMicrousd >= 0)",
      maxSubmissionMicrousd: "INTEGER NOT NULL CHECK (maxSubmissionMicrousd >= 0)",
      pilotId: "TEXT NOT NULL",
      pilotStartsAt: "TEXT NOT NULL",
      pilotEndsAt: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE UNIQUE INDEX IF NOT EXISTS idx_isb_scope ON imageSupplierBudgets(scopeType, scopeKey)"],
  },
  imageSupplierExposureAllocations: {
    columns: {
      submissionId: "TEXT NOT NULL",
      budgetId: "TEXT NOT NULL",
      pilotId: "TEXT NOT NULL",
      pricingVersion: "TEXT NOT NULL",
      pricingDigest: "TEXT NOT NULL",
      priceShapeJson: "TEXT NOT NULL",
      currency: "TEXT NOT NULL CHECK (currency = 'USD')",
      scale: "INTEGER NOT NULL CHECK (scale = 6)",
      reservedMaxMicrousd: "INTEGER NOT NULL CHECK (reservedMaxMicrousd >= 0)",
      state: "TEXT NOT NULL CHECK (state IN ('open', 'provisional', 'confirmed', 'released'))",
      calculatedMicrousd: "INTEGER CHECK (calculatedMicrousd IS NULL OR calculatedMicrousd >= 0)",
      billedMicrousd: "INTEGER CHECK (billedMicrousd IS NULL OR billedMicrousd >= 0)",
      dispatchDay: "TEXT NOT NULL",
      dispatchMonth: "TEXT NOT NULL",
      reservedAt: "TEXT NOT NULL",
      revision: "INTEGER NOT NULL CHECK (revision > 0)",
      updatedAt: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (submissionId, budgetId)",
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_isea_budget_day ON imageSupplierExposureAllocations(budgetId, state, dispatchDay)",
      "CREATE INDEX IF NOT EXISTS idx_isea_budget_month ON imageSupplierExposureAllocations(budgetId, state, dispatchMonth)",
    ],
  },
  imageSupplierExposureAdjustments: {
    columns: {
      id: "TEXT PRIMARY KEY",
      submissionId: "TEXT NOT NULL",
      budgetId: "TEXT NOT NULL",
      allocationRevision: "INTEGER NOT NULL CHECK (allocationRevision > 0)",
      evidenceSource: "TEXT NOT NULL",
      evidenceReference: "TEXT NOT NULL",
      evidenceDigest: "TEXT",
      observedAt: "TEXT NOT NULL",
      principal: "TEXT",
      previousState: "TEXT NOT NULL",
      nextState: "TEXT NOT NULL",
      previousCalculatedMicrousd: "INTEGER",
      nextCalculatedMicrousd: "INTEGER",
      previousBilledMicrousd: "INTEGER",
      nextBilledMicrousd: "INTEGER",
      reason: "TEXT",
      createdAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_iseadj_evidence ON imageSupplierExposureAdjustments(budgetId, evidenceSource, evidenceReference, submissionId)",
      "CREATE INDEX IF NOT EXISTS idx_iseadj_submission ON imageSupplierExposureAdjustments(submissionId, budgetId, allocationRevision)",
    ],
  },
  imageQuotaLearningPredictions: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      identityHash: "TEXT NOT NULL CHECK (length(identityHash) = 64)",
      identityGeneration: "INTEGER NOT NULL CHECK (identityGeneration > 0)",
      model: "TEXT NOT NULL",
      estimatorVersion: "TEXT NOT NULL",
      evidenceThroughAt: "TEXT NOT NULL",
      predictedWindowSeconds: "INTEGER NOT NULL CHECK (predictedWindowSeconds > 0)",
      predictedCallLimit: "INTEGER NOT NULL CHECK (predictedCallLimit > 0)",
      predictedNextCheckAt: "TEXT NOT NULL",
      confidence: "TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high'))",
      sampleCount: "INTEGER NOT NULL CHECK (sampleCount >= 0)",
      outcome: "TEXT NOT NULL CHECK (outcome IN ('open', 'validated_success', 'validated_rejected', 'superseded'))",
      createdAt: "TEXT NOT NULL",
      resolvedAt: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_iqlp_scope ON imageQuotaLearningPredictions(provider, identityHash, identityGeneration, model, createdAt DESC)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_iqlp_one_open_scope ON imageQuotaLearningPredictions(provider, identityHash, identityGeneration, model, estimatorVersion) WHERE outcome = 'open'",
    ],
  },
  providerRotationSnapshots: { columns: { connectionId: "TEXT PRIMARY KEY", fingerprint: "TEXT NOT NULL", data: "TEXT NOT NULL" }, indexes: [] },
  providerRotationCursors: { columns: { scope: "TEXT PRIMARY KEY", connectionId: "TEXT NOT NULL", useCount: "INTEGER NOT NULL" }, indexes: [] },
  aurixImageRoutingCursors: {columns:{scope:"TEXT PRIMARY KEY",connectionId:"TEXT NOT NULL",useCount:"INTEGER NOT NULL",updatedAt:"TEXT NOT NULL"},indexes:[]},

  adminImageTestRuns: {
    columns: { id: "TEXT PRIMARY KEY", commandKey: "TEXT NOT NULL UNIQUE", digest: "TEXT NOT NULL", state: "TEXT NOT NULL", itemsJson: "TEXT NOT NULL", revision: "INTEGER NOT NULL DEFAULT 0", owner: "TEXT", leaseUntil: "INTEGER NOT NULL DEFAULT 0", stopRequested: "INTEGER NOT NULL DEFAULT 0", createdAt: "TEXT NOT NULL", updatedAt: "TEXT NOT NULL" },
    indexes: ["CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_image_test_active ON adminImageTestRuns((1)) WHERE state IN ('queued','running','stopping','waiting_reset','paused','needs_review')"],
  },

};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
