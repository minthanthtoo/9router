import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const { getAdapterMock, getExecutorMock, getImageAdapterMock } = vi.hoisted(() => ({
  getAdapterMock: vi.fn(), getExecutorMock: vi.fn(), getImageAdapterMock: vi.fn(),
}));
vi.mock("uuid", () => ({ v4: () => "test-connection-id" }));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: getAdapterMock }));
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: getExecutorMock }));
vi.mock("../../open-sse/handlers/imageProviders/index.js", () => ({ getImageAdapter: getImageAdapterMock }));

import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import geminiImageAdapter from "../../open-sse/handlers/imageProviders/gemini.js";
import antigravityImageAdapter from "../../open-sse/handlers/imageProviders/antigravity.js";

import {
  admitImageQuotaRequest,
  acquireImageQuotaProbeLeases,
  beginImageRequestAttempt,
  beginImageRequestSubmission,
  configureImageSupplierBudget,
  hasImageSupplierBudgets,
  finishImageRequestAttempt,
  finishImageRequestSubmission,
  finishImageQuotaProbe,
  getImageRequestTrace,
  getImageRequestUsageSummary,
  getImageLearningHistory,
  getImageLearningSummaries,
  getImageQuotaState,
  getLocalImageCapacity,
  getImageSupplierBudgetOverview,
  getImageSupplierLoads,
  imageQuotaIdentity,
  recordImageQuotaObservation,
  reconcileImageSupplierExposure,
  writeImageQuotaPolicy,
} from "../../src/lib/db/repos/imageQuotaRepo.js";
import { prepareQuotaIdentityPatch } from "../../src/lib/db/repos/connectionsRepo.js";
import imageQuotaMigration from "../../src/lib/db/migrations/002-image-quota-state.js";
import imageQuotaManagementMigration from "../../src/lib/db/migrations/003-image-quota-management.js";
import imageQuotaDispatchMigration from "../../src/lib/db/migrations/004-image-quota-dispatch.js";
import imageRequestAttemptsMigration from "../../src/lib/db/migrations/005-image-request-attempts.js";
import imageRequestSubmissionsMigration from "../../src/lib/db/migrations/006-image-request-submissions.js";
import imageQuotaTraceFallbackMigration from "../../src/lib/db/migrations/007-image-quota-trace-fallback.js";
import imageSubmissionQuotaFallbackMigration from "../../src/lib/db/migrations/008-image-submission-quota-fallback.js";
import imageQuotaAdmissionFallbackMigration from "../../src/lib/db/migrations/009-image-quota-admission-fallback.js";
import imageSupplierExposureMigration from "../../src/lib/db/migrations/010-image-supplier-exposure.js";
import imageLearningMigration from "../../src/lib/db/migrations/012-image-quota-learning.js";
import imageLearningPredictionMigration from "../../src/lib/db/migrations/013-image-quota-learning-predictions.js";
import imageQuotaIdentityHistoryIndexMigration from "../../src/lib/db/migrations/014-image-quota-identity-history-index.js";
import { TABLES, buildCreateTableSql } from "../../src/lib/db/schema.js";

let sqlite;
let adapter;
let temporaryDatabase;

function makeAdapter(db) {
  return {
    driver: "node:sqlite",
    run: (sql, params = []) => db.prepare(sql).run(...params),
    get: (sql, params = []) => db.prepare(sql).get(...params),
    all: (sql, params = []) => db.prepare(sql).all(...params),
    exec: (sql) => db.exec(sql),
    transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = fn();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function observation(retryAt) {
  return {
    capability: "image_generation",
    quotaGroupId: "codex.image_generation",
    constraintId: "usage_limit",
    model: "gpt-image-2",
    appliesToModels: ["*"],
    observedAt: "2026-10-15T00:00:00.000Z",
    retryAt,
    confidence: "provider_confirmed",
    source: "provider_image_error",
  };
}

const accountA = {
  id: "connection-a",
  provider: "codex",
  providerSpecificData: { chatgptAccountId: "account-1", workspaceId: "workspace-a" },
};

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  adapter = makeAdapter(sqlite);
  imageQuotaMigration.up(adapter);
  imageQuotaManagementMigration.up(adapter);
  imageQuotaDispatchMigration.up(adapter);
  imageRequestAttemptsMigration.up(adapter);
  imageRequestSubmissionsMigration.up(adapter);
  imageQuotaTraceFallbackMigration.up(adapter);
  imageSubmissionQuotaFallbackMigration.up(adapter);
  imageQuotaAdmissionFallbackMigration.up(adapter);
  imageSupplierExposureMigration.up(adapter);
  imageLearningMigration.up(adapter);
  imageLearningPredictionMigration.up(adapter);
  imageQuotaIdentityHistoryIndexMigration.up(adapter);
  sqlite.exec("CREATE TABLE providerConnections(id TEXT PRIMARY KEY, provider TEXT, isActive INTEGER, data TEXT)");
  getAdapterMock.mockResolvedValue(adapter);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  getAdapterMock.mockReset();
  sqlite?.close();
  if (temporaryDatabase) rmSync(temporaryDatabase, { recursive: true, force: true });
  temporaryDatabase = null;
});

describe("image quota repository", () => {
  it("frees concurrency on definite completion while keeping every rolling window", async () => {
    vi.stubEnv("IMAGE_QUOTA_LOCAL_LIMITS_JSON", JSON.stringify([{ provider: "codex", model: "*", maxConcurrent: 1,
      windows: [{ seconds: 60, requests: 1 }, { seconds: 3600, requests: 1 }] }]));
    const input = { routerRequestId: "75111111-1111-4111-8111-111111111111", attemptNumber: 1, submissionNumber: 1,
      provider: "codex", requestedModel: "cx/gpt-image-2", model: "gpt-image-2", connectionId: accountA.id, connection: accountA };
    await beginImageRequestSubmission(input);
    await expect(beginImageRequestSubmission(input)).rejects.toThrow("reconcile before redispatch");
    await finishImageRequestSubmission({ routerRequestId: input.routerRequestId, submissionNumber: 1, outcome: "succeeded", outputCount: 1 });
    adapter.run("UPDATE imageQuotaRequestSubmissions SET dispatchedAt = ?", [new Date(Date.now() - 61000).toISOString()]);
    const next = { ...input, routerRequestId: "75222222-2222-4222-8222-222222222222", model: "other-image" };
    await expect(beginImageRequestSubmission(next)).rejects.toMatchObject({ code: "IMAGE_LOCAL_CAPACITY" });
    adapter.run("UPDATE imageQuotaRequestSubmissions SET dispatchedAt = ?", [new Date(Date.now() - 3601000).toISOString()]);
    await expect(beginImageRequestSubmission(next)).resolves.toMatchObject({ routerRequestId: next.routerRequestId });
  });

  it("fails closed on invalid policy before creating a dispatch reservation", async () => {
    vi.stubEnv("IMAGE_QUOTA_LOCAL_LIMITS_JSON", "{bad-json");
    await expect(beginImageRequestSubmission({ routerRequestId: "76111111-1111-4111-8111-111111111111", attemptNumber: 1,
      submissionNumber: 1, provider: "codex", requestedModel: "cx/gpt-image-2", model: "gpt-image-2", connectionId: accountA.id, connection: accountA }))
      .rejects.toThrow("Invalid image local capacity policy");
    expect(adapter.get("SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions").n).toBe(0);
  });

  it("atomically reserves configured supplier concurrency and retains unknown occupancy", async () => {
    vi.stubEnv("IMAGE_QUOTA_LOCAL_LIMITS_JSON", JSON.stringify([{ provider: "codex", model: "gpt-image-2", maxConcurrent: 1 }]));
    const input = { routerRequestId: "71111111-1111-4111-8111-111111111111", attemptNumber: 1, submissionNumber: 1,
      provider: "codex", requestedModel: "cx/gpt-image-2", model: "gpt-image-2", connectionId: accountA.id, connection: accountA };
    const second = { ...input, routerRequestId: "72222222-2222-4222-8222-222222222222" };
    const results = await Promise.allSettled([beginImageRequestSubmission(input), beginImageRequestSubmission(second)]);
    const readsBefore = adapter.get("SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions").n;
    const linked = { ...accountA, id: "linked-credential" };
    const loads = await getImageSupplierLoads([accountA, linked, { ...accountA, id: "other", providerSpecificData: {} }], "codex");
    expect(loads.get(accountA.id)).toBe(1);
    expect(loads.get(linked.id)).toBe(1);
    expect(loads.get("other")).toBe(0);

    expect(await getLocalImageCapacity(accountA, "gpt-image-2")).toMatchObject({ source: "local_policy", retryAt: null });
    expect(await getLocalImageCapacity(accountA, "other-model")).toBeNull();
    expect(adapter.get("SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions").n).toBe(readsBefore);

    expect(results.map((row) => row.status).sort()).toEqual(["fulfilled", "rejected"]);
    await finishImageRequestSubmission({ routerRequestId: input.routerRequestId, submissionNumber: 1, outcome: "outcome_unknown" });
    await expect(beginImageRequestSubmission(second)).rejects.toMatchObject({ code: "IMAGE_LOCAL_CAPACITY", availability: { retryAt: null, source: "local_policy" } });
    expect(adapter.get("SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions").n).toBe(1);
  });

  it("enforces rolling request windows across linked credentials without claiming upstream quota", async () => {
    vi.stubEnv("IMAGE_QUOTA_LOCAL_LIMITS_JSON", JSON.stringify([{ provider: "gemini", model: "image", windows: [{ seconds: 60, requests: 1 }] }]));
    const connection = { id: "key-a", provider: "gemini", projectId: "project-one" };
    const input = { routerRequestId: "73111111-1111-4111-8111-111111111111", attemptNumber: 1, submissionNumber: 1,
      provider: "gemini", requestedModel: "gemini/image", model: "image", connectionId: connection.id, connection };
    await beginImageRequestSubmission(input);
    await finishImageRequestSubmission({ routerRequestId: input.routerRequestId, submissionNumber: 1, outcome: "succeeded", outputCount: 1 });
    const linked = { ...connection, id: "key-b" };
    const next = { ...input, routerRequestId: "73222222-2222-4222-8222-222222222222", connectionId: linked.id, connection: linked };
    await expect(beginImageRequestSubmission(next)).rejects.toMatchObject({ code: "IMAGE_LOCAL_CAPACITY", availability: { confidence: "estimated", source: "local_policy" } });
    adapter.run("UPDATE imageQuotaRequestSubmissions SET dispatchedAt = ?", [new Date(Date.now() - 61_000).toISOString()]);
    await expect(beginImageRequestSubmission(next)).resolves.toMatchObject({ routerRequestId: next.routerRequestId });
  });

  it.each(["in_flight", "outcome_unknown", "quota_rejected", "succeeded", "provider_rejected"])("applies retention safely to old %s evidence", async (outcome) => {
    const routerRequestId = "70111111-1111-4111-8111-111111111111";
    const clientOperationId = "70222222-2222-4222-8222-222222222222";
    const identity = { routerRequestId, clientOperationId, attemptNumber: 1, provider: "codex",
      model: "gpt-image-2", connectionId: accountA.id, connection: accountA, quotaGroupId: "codex.image_generation" };
    await beginImageRequestAttempt(identity);
    await beginImageRequestSubmission({ ...identity, submissionNumber: 1, requestedModel: "cx/gpt-image-2" });
    const old = new Date(Date.now() - 9 * 86400_000).toISOString();
    adapter.run("UPDATE imageQuotaRequestAttempts SET outcome = ?, startedAt = ? WHERE routerRequestId = ?", [outcome, old, routerRequestId]);
    adapter.run("UPDATE imageQuotaRequestSubmissions SET outcome = ?, dispatchedAt = ?, providerRequestId = ?, usageJson = ? WHERE routerRequestId = ?", [outcome, old, "private-id", '{"total_tokens":7}', routerRequestId]);
    const oldTrace = await getImageRequestTrace({ clientOperationId });
    const retained = ["in_flight", "outcome_unknown", "quota_rejected"].includes(outcome);
    expect(oldTrace.status).toBe(retained ? "found" : "not_found");
    if (retained) {
      expect(oldTrace.requests[0].attempts).toHaveLength(1);
      expect(oldTrace.requests[0].submissions).toHaveLength(1);
    }
    const next = { ...identity, routerRequestId: "70333333-3333-4333-8333-333333333333" };
    await beginImageRequestAttempt(next);
    await beginImageRequestSubmission({ ...next, submissionNumber: 1, requestedModel: "cx/gpt-image-2" });
    expect(adapter.get("SELECT COUNT(*) AS n FROM imageQuotaRequestAttempts WHERE routerRequestId = ?", [routerRequestId]).n).toBe(retained ? 1 : 0);
    expect(adapter.get("SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions WHERE routerRequestId = ?", [routerRequestId]).n).toBe(1);
    const compact = adapter.get("SELECT providerRequestId, usageJson, traceScrubbedAt FROM imageQuotaRequestSubmissions WHERE routerRequestId = ?", [routerRequestId]);
    expect(compact.providerRequestId).toBe(retained ? "private-id" : null);
    expect(compact.usageJson).toBe(retained ? '{"total_tokens":7}' : null);
    expect(Boolean(compact.traceScrubbedAt)).toBe(!retained);
    if (!retained) await expect(beginImageRequestSubmission({ ...identity, submissionNumber: 1, requestedModel: "cx/gpt-image-2" })).rejects.toThrow("reconcile before redispatch");
    expect((await getImageRequestTrace({ routerRequestId })).status).toBe(retained ? "found" : "not_found");
  });

  it("counts all recorded history while bounding and sanitizing model timelines", async () => {
    for (let i = 0; i < 205; i++) {
      adapter.run(`INSERT INTO imageQuotaRequestSubmissions
        (id, routerRequestId, attemptNumber, submissionNumber, provider, requestedModel, model,
         connectionId, entryPoint, operation, outcome, outputCount, dispatchedAt, updatedAt, providerRequestId, usageJson)
        VALUES (?, ?, 1, 1, 'codex', 'gpt-image-2', 'gpt-image-2', ?, 'images_generations', 'generate', 'succeeded', 2, ?, ?, 'private-provider-id', '{"total_tokens":42}')`,
        [`row-${i}`, `request-${i}`, accountA.id, "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
    }
    const nowMs = Date.parse("2026-11-01T12:00:00.000Z");
    const result = await getImageLearningHistory(accountA, { nowMs });
    expect(result.coverage).toEqual({ recordedSince: "2026-11-01T00:00:00.000Z", priorHistoryComplete: false });
    expect(result.models[0]).toMatchObject({ model: "gpt-image-2", counts: { callsTotal: 205, calls24h: 205, successfulCalls: 205, images: 410 }, historyTruncated: true });
    expect(result.models[0].history).toHaveLength(200);
    expect(JSON.stringify(result)).not.toContain("private-provider-id");
    expect(result.models[0].history[0]).not.toHaveProperty("usageJson");
    const summaries = await getImageLearningSummaries([accountA], "codex", nowMs);
    expect(summaries.get(accountA.id).counts).toEqual({ calls24h: 205, callsTotal: 205 });
    expect(summaries.get(accountA.id).models[0]).not.toHaveProperty("history");
    expect((await getImageLearningHistory(accountA, { nowMs, model: "absent" })).models).toEqual([]);
    adapter.run(`INSERT INTO imageQuotaRequestSubmissions
      (id, routerRequestId, attemptNumber, submissionNumber, provider, requestedModel, model, connectionId, entryPoint, operation, outcome, retryAt, confidence, dispatchedAt, updatedAt)
      SELECT 'old-rejection', 'old-rejection', 1, 1, provider, requestedModel, model, connectionId, entryPoint, operation, 'quota_rejected', '2026-10-01T01:00:00.000Z', 'provider_confirmed', '2026-10-01T00:00:00.000Z', updatedAt
      FROM imageQuotaRequestSubmissions LIMIT 1`);
    const withOldRejection = await getImageLearningHistory(accountA, { nowMs });
    expect(withOldRejection.models[0].history).toHaveLength(200);
    expect(withOldRejection.models[0].last429).toMatchObject({ at: "2026-10-01T00:00:00.000Z", confidence: "provider_confirmed" });
    expect(withOldRejection.models[0].counts).toMatchObject({ callsTotal: 206, calls24h: 205, quotaRejections: 1 });
    expect(withOldRejection.models[0].nextCheck).toBeNull();
    adapter.run("UPDATE imageQuotaRequestSubmissions SET dispatchedAt = '2026-11-01T01:00:00.000Z', confidence = 'estimated' WHERE id = 'old-rejection'");
    const withBackoff = await getImageLearningHistory(accountA, { nowMs });
    expect(withBackoff.models[0].nextCheck).toMatchObject({ confidence: "estimated", source: "router_backoff" });
  });

  it("learns from recent warm observations after more than 200 recorded dispatches", async () => {
    const epoch = Date.parse("2026-11-01T00:00:00.000Z");
    let offset = 0;
    const add = (at, outcome) => {
      const timestamp = new Date(epoch + at * 1000).toISOString();
      const id = `bounded-${at}-${outcome}`;
      adapter.run(`INSERT INTO imageQuotaRequestSubmissions
        (id, routerRequestId, attemptNumber, submissionNumber, provider, requestedModel, model, connectionId, entryPoint, operation, outcome, quotaObservations, dispatchedAt, updatedAt)
        VALUES (?, ?, 1, 1, 'codex', 'image', 'image', ?, 'images_generations', 'generate', ?, '[{"constraintId":"image_gen"}]', ?, ?)`,
        [id, id, accountA.id, outcome, timestamp, timestamp]);
    };
    for (let i = 0; i < 64; i++) {
      offset += [61, 90, 400, 65, 1100, 77, 180][i % 7];
      add(offset, "succeeded"); add(offset + 1, "succeeded"); add(offset + 2, "succeeded"); add(offset + 3, "quota_rejected");
    }
    add(offset + 61, "succeeded");
    const result = await getImageLearningHistory(accountA, { nowMs: epoch + (offset + 62) * 1000 });
    expect(result.models[0].counts.callsTotal).toBe(257);
    expect(result.models[0].history).toHaveLength(200);
    expect(result.models[0].historyTruncated).toBe(true);
    expect(result.models[0].estimate).toMatchObject({ state: "estimated", windowSeconds: 60, callLimit: 3, confidence: "low", sampleCount: 200 });
    expect(result.models[0].estimate.reason).toContain("Partial coverage");
  });

  it("upgrades populated compact history without losing records and can replay migration", () => {
    const legacyDb = new DatabaseSync(":memory:");
    const legacy = makeAdapter(legacyDb);
    const table = { ...TABLES.imageQuotaRequestSubmissions,
      columns: Object.fromEntries(Object.entries(TABLES.imageQuotaRequestSubmissions.columns).filter(([key]) => key !== "traceScrubbedAt")) };
    legacy.exec(buildCreateTableSql("imageQuotaRequestSubmissions", table));
    legacy.run(`INSERT INTO imageQuotaRequestSubmissions
      (id, routerRequestId, attemptNumber, submissionNumber, provider, requestedModel, model, connectionId, entryPoint, operation, outcome, dispatchedAt, updatedAt)
      VALUES ('old-id', 'old-request', 1, 1, 'codex', 'image', 'image', 'account', 'images_generations', 'generate', 'outcome_unknown', '2026-10-01', '2026-10-01')`);
    const before = legacy.get("SELECT * FROM imageQuotaRequestSubmissions");
    imageLearningMigration.up(legacy);
    imageLearningMigration.up(legacy);
    expect(legacy.get("SELECT * FROM imageQuotaRequestSubmissions")).toEqual({ ...before, traceScrubbedAt: null });
    expect(legacy.all("PRAGMA index_list(imageQuotaRequestSubmissions)").map((row) => row.name)).toContain("idx_iqrs_account_model_history");
    legacyDb.close();
  });

  it("adds quota fallback columns to an existing request-attempt table", () => {
    const legacyDb = new DatabaseSync(":memory:");
    const legacyAdapter = makeAdapter(legacyDb);
    const legacyTable = {
      ...TABLES.imageQuotaRequestAttempts,
      columns: Object.fromEntries(Object.entries(TABLES.imageQuotaRequestAttempts.columns)
        .filter(([name]) => !["supplierIdentity", "identityGeneration", "quotaObservations", "quotaLockResolvedAt"].includes(name))),
    };
    legacyDb.exec(buildCreateTableSql("imageQuotaRequestAttempts", legacyTable));
    imageQuotaTraceFallbackMigration.up(legacyAdapter);
    expect(legacyAdapter.all("PRAGMA table_info(imageQuotaRequestAttempts)").map((column) => column.name))
      .toContain("quotaObservations");
    expect(legacyAdapter.all("PRAGMA index_list(imageQuotaRequestAttempts)").map((index) => index.name))
      .toContain("idx_iqra_unresolved_quota");
    legacyDb.close();
  });

  it("adds quota fallback fields to an existing image submission table", () => {
    const legacyDb = new DatabaseSync(":memory:");
    const legacyAdapter = makeAdapter(legacyDb);
    const legacyTable = {
      ...TABLES.imageQuotaRequestSubmissions,
      columns: Object.fromEntries(Object.entries(TABLES.imageQuotaRequestSubmissions.columns)
        .filter(([name]) => !["supplierIdentity", "identityGeneration", "quotaObservations", "quotaLockResolvedAt"].includes(name))),
    };
    legacyDb.exec(buildCreateTableSql("imageQuotaRequestSubmissions", legacyTable));
    imageSubmissionQuotaFallbackMigration.up(legacyAdapter);
    const columns = legacyAdapter.all("PRAGMA table_info(imageQuotaRequestSubmissions)").map((column) => column.name);
    expect(columns).toContain("supplierIdentity");
    expect(columns).toContain("quotaObservations");
    expect(legacyAdapter.all("PRAGMA index_list(imageQuotaRequestSubmissions)").map((index) => index.name))
      .toContain("idx_iqrs_unresolved_quota");
    legacyDb.close();
  });

  it("adds the admission fallback column to a legacy singleton without replacing its revision", () => {
    const legacyDb = new DatabaseSync(":memory:");
    const legacyAdapter = makeAdapter(legacyDb);
    const legacyTable = {
      ...TABLES.imageQuotaAdmissionState,
      columns: Object.fromEntries(Object.entries(TABLES.imageQuotaAdmissionState.columns)
        .filter(([name]) => name !== "quotaObservations")),
    };
    legacyDb.exec(buildCreateTableSql("imageQuotaAdmissionState", legacyTable));
    legacyDb.exec("INSERT INTO imageQuotaAdmissionState(id, revision) VALUES(1, 27)");
    imageQuotaAdmissionFallbackMigration.up(legacyAdapter);
    expect(legacyAdapter.get("SELECT revision, quotaObservations FROM imageQuotaAdmissionState WHERE id = 1"))
      .toEqual({ revision: 27, quotaObservations: "[]" });
    imageQuotaAdmissionFallbackMigration.up(legacyAdapter);
    expect(legacyAdapter.all("PRAGMA table_info(imageQuotaAdmissionState)").filter((column) => column.name === "quotaObservations"))
      .toHaveLength(1);
    legacyDb.close();
  });

  it.each([
    ["gemini", { projectId: "quota-project" }],
    ["codex", { providerSpecificData: { chatgptAccountId: "known-account" } }],
    ["antigravity", { providerSpecificData: { googleAccountSub: "known-account" } }],
  ])("rechecks a connection-local %s lock after its supplier identity becomes known", async (provider, identityPatch) => {
    const local = { id: "local-connection", provider, providerSpecificData: {} };
    await recordImageQuotaObservation(local, { ...observation(new Date(Date.now() + 86_400_000).toISOString()), quotaGroupId: `${provider}.image_generation` }, "local-limit");
    const known = { ...local, ...prepareQuotaIdentityPatch(local, identityPatch) };
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, 1, ?)")
      .run(known.id, known.provider, JSON.stringify({ projectId: known.projectId, providerSpecificData: known.providerSpecificData }));

    const state = (await getImageQuotaState([known], provider, "image_generation", "gpt-image-2")).get(known.id);
    expect(state.blockingRows).toHaveLength(1);
    expect(await admitImageQuotaRequest(known, "image_generation", "gpt-image-2"))
      .toMatchObject({ allowed: false, reason: "quota_blocked" });
  });

  it("does not let a newer enabled alias hide an operator pause", async () => {
    for (const [identity, policyState, revision] of [[`connection:${accountA.id}`, "paused", 1], [imageQuotaIdentity(accountA), "enabled", 2]]) {
      sqlite.prepare(`INSERT INTO imageQuotaPolicies
        (provider, supplierIdentity, identityGeneration, capability, quotaGroupId, policyState, revision, updatedBy, updatedAt)
        VALUES ('codex', ?, 1, 'image_generation', 'codex.image_generation', ?, ?, 'operator', ?)`)
        .run(identity, policyState, revision, new Date().toISOString());
    }
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, 1, ?)")
      .run(accountA.id, accountA.provider, JSON.stringify({ providerSpecificData: accountA.providerSpecificData }));
    const state = (await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2")).get(accountA.id);
    expect(state.manualPolicy).toMatchObject({ policyState: "paused" });
    expect(state.policyRevision).toBe(2);
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2"))
      .toMatchObject({ allowed: false, reason: "manual_paused" });
  });

  it("resumes an inherited alias pause at its exposed revision without clearing automatic quota", async () => {
    const local = { ...accountA, providerSpecificData: {} };
    const known = { ...local, ...prepareQuotaIdentityPatch(local, { providerSpecificData: accountA.providerSpecificData }) };
    const command = { capability: "image_generation", quotaGroupId: "codex.image_generation", principal: "operator", reason: "reviewed supplier" };
    await writeImageQuotaPolicy({ ...command, connection: local, action: "pause", expectedRevision: 0, idempotencyKey: "local-pause", requestHash: "pause" });
    await recordImageQuotaObservation(local, observation(new Date(Date.now() + 86_400_000).toISOString()), "local-quota");
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, 1, ?)")
      .run(known.id, known.provider, JSON.stringify({ providerSpecificData: known.providerSpecificData }));
    const receipt = await writeImageQuotaPolicy({ ...command, connection: known, action: "resume", expectedRevision: 1, idempotencyKey: "canonical-resume", requestHash: "resume" });
    expect(receipt).toMatchObject({ revision: 2, policyState: "enabled" });
    const state = (await getImageQuotaState([known], "codex", "image_generation", "gpt-image-2")).get(known.id);
    expect(state.manualPolicy).toBeNull();
    expect(state.blockingRows).toHaveLength(1);
    expect(await admitImageQuotaRequest(known, "image_generation", "gpt-image-2"))
      .toMatchObject({ allowed: false, reason: "quota_blocked" });
  });

  it("leases every identity/group constraint and dispatches only one recovery owner", async () => {
    const now = Date.now();
    const local = { ...accountA, providerSpecificData: {} };
    const known = { ...local, ...prepareQuotaIdentityPatch(local, { providerSpecificData: accountA.providerSpecificData }) };
    const expired = new Date(now - 1_000).toISOString();
    await recordImageQuotaObservation(local, observation(expired), "local-expired");
    await recordImageQuotaObservation(known, observation(expired), "canonical-expired");
    await recordImageQuotaObservation(known, { ...observation(expired), quotaGroupId: "codex.other_image_limit" }, "other-group-expired");
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, 1, ?)")
      .run(known.id, known.provider, JSON.stringify({ providerSpecificData: known.providerSpecificData }));
    const rows = (await getImageQuotaState([known], "codex", "image_generation", "gpt-image-2")).get(known.id).expiredRows;
    expect(rows).toHaveLength(3);
    const results = await Promise.all([
      acquireImageQuotaProbeLeases(known, rows, "owner-a", 120_000, now),
      acquireImageQuotaProbeLeases(known, rows, "owner-b", 120_000, now),
    ]);
    expect(results.map((result) => result.acquired)).toEqual([true, false]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaProbeLeases").get().n).toBe(3);
    expect(await admitImageQuotaRequest(known, "image_generation", "gpt-image-2", "owner-b"))
      .toMatchObject({ allowed: false, reason: "probe_not_owned" });
    expect(await admitImageQuotaRequest(known, "image_generation", "gpt-image-2", "owner-a"))
      .toMatchObject({ allowed: true });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaProbeLeases WHERE dispatchedAt IS NOT NULL").get().n).toBe(3);
    await finishImageQuotaProbe(known, rows, "owner-a", { success: true });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaConstraints").get().n).toBe(0);
  });

  it("does not clear a quota constraint on success before the recovery was dispatched", async () => {
    const now = Date.now();
    await recordImageQuotaObservation(accountA, observation(new Date(now - 1_000).toISOString()), "expired");
    const rows = (await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2")).get(accountA.id).expiredRows;
    await acquireImageQuotaProbeLeases(accountA, rows, "reserved-only", 120_000, now);
    await finishImageQuotaProbe(accountA, rows, "reserved-only", { success: true, nowMs: now });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaConstraints").get().n).toBe(1);
  });

  it("keeps a dispatched local probe fenced after supplier identity enrichment", async () => {
    const local = { ...accountA, providerSpecificData: {} };
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, 1, ?)")
      .run(local.id, local.provider, JSON.stringify({ providerSpecificData: local.providerSpecificData }));
    await recordImageQuotaObservation(local, observation(new Date(Date.now() - 1_000).toISOString()), "local-expired");
    const rows = (await getImageQuotaState([local], "codex", "image_generation", "gpt-image-2")).get(local.id).expiredRows;
    await acquireImageQuotaProbeLeases(local, rows, "dispatched-owner", 120_000);
    expect(await admitImageQuotaRequest(local, "image_generation", "gpt-image-2", "dispatched-owner"))
      .toMatchObject({ allowed: true });
    const known = { ...local, ...prepareQuotaIdentityPatch(local, { providerSpecificData: accountA.providerSpecificData }) };
    sqlite.prepare("UPDATE providerConnections SET data = ? WHERE id = ?")
      .run(JSON.stringify({ providerSpecificData: known.providerSpecificData }), known.id);
    const later = Date.now() + 600_000;
    const state = (await getImageQuotaState([known], "codex", "image_generation", "gpt-image-2", later)).get(known.id);
    expect(state.probeInProgressRows).toMatchObject([{ identityGeneration: 1, probeDispatchedAt: expect.any(String) }]);
    expect(await acquireImageQuotaProbeLeases(known, state.expiredRows, "replacement-owner", 120_000, later))
      .toMatchObject({ acquired: false });
    expect(await admitImageQuotaRequest(known, "image_generation", "gpt-image-2", "replacement-owner"))
      .toMatchObject({ allowed: false, reason: "probe_not_owned" });
  });

  it("reserves the last local concurrency slot across independent SQLite workers", async () => {
    vi.stubEnv("IMAGE_QUOTA_LOCAL_LIMITS_JSON", JSON.stringify([{ provider: "codex", model: "gpt-image-2", maxConcurrent: 1 }]));
    temporaryDatabase = mkdtempSync(join(tmpdir(), "image-capacity-workers-"));
    const databasePath = join(temporaryDatabase, "quota.sqlite");
    sqlite.close();
    sqlite = new DatabaseSync(databasePath);
    sqlite.exec("PRAGMA journal_mode = WAL");
    adapter = makeAdapter(sqlite);
    imageQuotaMigration.up(adapter);
    imageQuotaManagementMigration.up(adapter);
    imageQuotaDispatchMigration.up(adapter);
    imageRequestAttemptsMigration.up(adapter);
    imageRequestSubmissionsMigration.up(adapter);
    imageQuotaTraceFallbackMigration.up(adapter);
    imageSubmissionQuotaFallbackMigration.up(adapter);
    imageQuotaAdmissionFallbackMigration.up(adapter);
    imageSupplierExposureMigration.up(adapter);
    const workers = ["74111111-1111-4111-8111-111111111111", "74222222-2222-4222-8222-222222222222"].map((routerRequestId) => new Worker(
      new URL("../fixtures/image-quota-recovery-worker.mjs", import.meta.url), { workerData: {
        databasePath,
        submission: { routerRequestId, attemptNumber: 1, submissionNumber: 1, provider: "codex", model: "gpt-image-2",
          requestedModel: "cx/gpt-image-2", connectionId: accountA.id, connection: accountA },
        adapterUrl: new URL("../../src/lib/db/adapters/nodeSqliteAdapter.js", import.meta.url).href,
        repositoryUrl: new URL("../../src/lib/db/repos/imageQuotaRepo.js", import.meta.url).href,
      } },
    ));
    try {
      expect(await Promise.all(workers.map((worker) => once(worker, "message")))).toEqual([[{ ready: true }], [{ ready: true }]]);
      const pending = workers.map((worker) => once(worker, "message"));
      workers.forEach((worker) => worker.postMessage("dispatch"));
      const results = (await Promise.all(pending)).flat();
      expect(results.filter((row) => row.ticket)).toHaveLength(1);
      expect(results.filter((row) => row.code === "IMAGE_LOCAL_CAPACITY")).toHaveLength(1);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions").get().n).toBe(1);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  }, 10000);

  it("admits one affordable contender across separate native SQLite processes and never dispatches the denied one", async () => {
    temporaryDatabase = mkdtempSync(join(tmpdir(), "image-supplier-budget-processes-"));
    const databasePath = join(temporaryDatabase, "quota.sqlite");
    sqlite.close();
    sqlite = new DatabaseSync(databasePath);
    sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    adapter = makeAdapter(sqlite);
    imageQuotaMigration.up(adapter);
    imageQuotaManagementMigration.up(adapter);
    imageQuotaDispatchMigration.up(adapter);
    imageRequestAttemptsMigration.up(adapter);
    imageRequestSubmissionsMigration.up(adapter);
    imageQuotaTraceFallbackMigration.up(adapter);
    imageSubmissionQuotaFallbackMigration.up(adapter);
    imageQuotaAdmissionFallbackMigration.up(adapter);
    imageSupplierExposureMigration.up(adapter);
    sqlite.exec("CREATE TABLE providerConnections(id TEXT PRIMARY KEY, provider TEXT, isActive INTEGER, data TEXT)");
    getAdapterMock.mockResolvedValue(adapter);

    const now = Date.now();
    const budgetParams = {
      currency: "USD", scale: 6, enabled: true, dailyLimitMicrousd: 100, monthlyLimitMicrousd: 100,
      pilotLimitMicrousd: 100, maxSubmissionMicrousd: 100, pricingPolicyVersion: "synthetic-v1",
      pilotId: "synthetic-pilot", pilotStartsAt: new Date(now - 60_000).toISOString(),
      pilotEndsAt: new Date(now + 86_400_000).toISOString(),
    };
    await configureImageSupplierBudget({ ...budgetParams, id: "installation-budget", scopeType: "installation", scopeKey: "router-installation" });
    await configureImageSupplierBudget({ ...budgetParams, id: "project-budget", scopeType: "billing_project", scopeKey: imageQuotaIdentity(accountA) });
    const budgetScope = { installationBudgetId: "installation-budget", projectBudgetId: "project-budget" };
    const common = {
      provider: "codex", requestedModel: "codex/gpt-image-2", model: "gpt-image-2", connectionId: accountA.id,
      connection: accountA, entryPoint: "images_generations", operation: "generate", budgetScope,
      pricingVersion: "synthetic-v1", pricingDigest: "a".repeat(64),
      priceShape: { model: "gpt-image-2", operation: "generate", outputCount: 1, resolution: "1024" },
    };
    const seed = await beginImageRequestSubmission({
      ...common, routerRequestId: "78111111-1111-4111-8111-111111111111", attemptNumber: 1,
      submissionNumber: 1, estimatedMaxMicrousd: 40,
    });
    await finishImageRequestSubmission({ ...seed, outcome: "succeeded", outputCount: 1 });

    const routerRequestIds = ["78222222-2222-4222-8222-222222222222", "78333333-3333-4333-8333-333333333333"];
    const contenderCost = 35;
    expect(40 + contenderCost).toBeLessThanOrEqual(100); // Each contender fits alone after the seed.
    const childScript = fileURLToPath(new URL("../fixtures/image-supplier-budget-process.mjs", import.meta.url));
    const repositoryUrl = new URL("../../src/lib/db/repos/imageQuotaRepo.js", import.meta.url).href;
    const adapterUrl = new URL("../../src/lib/db/adapters/nodeSqliteAdapter.js", import.meta.url).href;
    const children = routerRequestIds.map((routerRequestId) => fork(childScript, [], {
      execPath: process.execPath,
      env: {
        ...process.env, IMAGE_QUOTA_LOCAL_LIMITS_JSON: "[]",
        IMAGE_SUPPLIER_TEST_INPUT: JSON.stringify({ databasePath, repositoryUrl, adapterUrl, submission: {
          ...common, routerRequestId, attemptNumber: 1, submissionNumber: 1, estimatedMaxMicrousd: contenderCost,
          pricingDigest: "b".repeat(64),
        } }),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    }));
    try {
      const ready = await Promise.all(children.map(async (child) => (await once(child, "message"))[0]));
      expect(ready).toEqual([{ ready: true }, { ready: true }]);
      const outcomesPromise = Promise.all(children.map(async (child) => (await once(child, "message"))[0]));
      const startAt = Date.now() + 250;
      children.forEach((child) => child.send({ command: "admit", startAt }));
      const outcomes = await outcomesPromise;
      expect(new Set(outcomes.map((outcome) => outcome.pid)).size).toBe(2);
      expect(outcomes.map((outcome) => Boolean(outcome.ticket)).sort()).toEqual([false, true]);
      expect(outcomes.filter((outcome) => outcome.code === "IMAGE_SUPPLIER_BUDGET_EXHAUSTED")).toHaveLength(1);
      expect(outcomes.reduce((sum, outcome) => sum + outcome.providerDispatches, 0)).toBe(1);

      const admitted = outcomes.find((outcome) => outcome.ticket);
      const rejected = outcomes.find((outcome) => !outcome.ticket);
      const rejectedRequestId = routerRequestIds[outcomes.indexOf(rejected)];
      expect(admitted.providerDispatches).toBe(1);
      expect(rejected.providerDispatches).toBe(0);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions WHERE routerRequestId IN (?, ?)")
        .get(...routerRequestIds).n).toBe(1);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions WHERE routerRequestId = ?")
        .get(rejectedRequestId).n).toBe(0);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageSupplierExposureAllocations WHERE submissionId = ?")
        .get(admitted.ticket.submissionId).n).toBe(2);
      expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM imageSupplierExposureAllocations a
        JOIN imageQuotaRequestSubmissions s ON s.id = a.submissionId WHERE s.routerRequestId IN (?, ?)`)
        .get(...routerRequestIds).n).toBe(2);
      const obligations = sqlite.prepare(`SELECT b.id, SUM(CASE
        WHEN a.state = 'open' THEN a.reservedMaxMicrousd
        WHEN a.state = 'provisional' THEN MAX(a.reservedMaxMicrousd, COALESCE(a.calculatedMicrousd, 0))
        WHEN a.state = 'confirmed' THEN a.billedMicrousd ELSE 0 END) AS amount
        FROM imageSupplierBudgets b JOIN imageSupplierExposureAllocations a ON a.budgetId = b.id GROUP BY b.id`).all();
      expect(obligations).toHaveLength(2);
      expect(obligations.every((row) => Number(row.amount) <= 100)).toBe(true);
    } finally {
      await Promise.all(children.map(async (child) => {
        if (child.exitCode == null && child.signalCode == null) {
          child.kill();
          await once(child, "exit");
        }
      }));
    }
  }, 20_000);

  it.each(["reserved", "accepted"])("retains exposure after SIGKILL at %s and refuses redispatch from fresh processes", async (holdAt) => {
    temporaryDatabase = mkdtempSync(join(tmpdir(), "image-supplier-crash-"));
    const databasePath = join(temporaryDatabase, "quota.sqlite");
    const providerLog = join(temporaryDatabase, "provider-accepted.jsonl");
    sqlite.close();
    sqlite = new DatabaseSync(databasePath);
    sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    adapter = makeAdapter(sqlite);
    for (const migration of [imageQuotaMigration, imageQuotaManagementMigration, imageQuotaDispatchMigration,
      imageRequestAttemptsMigration, imageRequestSubmissionsMigration, imageQuotaTraceFallbackMigration,
      imageSubmissionQuotaFallbackMigration, imageQuotaAdmissionFallbackMigration, imageSupplierExposureMigration]) migration.up(adapter);
    getAdapterMock.mockResolvedValue(adapter);
    const now = Date.now();
    const base = { currency: "USD", scale: 6, enabled: true,
      dailyLimitMicrousd: holdAt === "reserved" ? 100 : 1000, monthlyLimitMicrousd: holdAt === "accepted" ? 100 : 1000,
      pilotLimitMicrousd: 1000, maxSubmissionMicrousd: 100, pricingPolicyVersion: "synthetic-v1",
      pilotId: "crash-pilot", pilotStartsAt: new Date(now - 45 * 86_400_000).toISOString(),
      pilotEndsAt: new Date(now + 86_400_000).toISOString() };
    await configureImageSupplierBudget({ ...base, id: "installation-budget", scopeType: "installation", scopeKey: "router" });
    await configureImageSupplierBudget({ ...base, id: "project-budget", scopeType: "billing_project", scopeKey: imageQuotaIdentity(accountA) });
    const submission = {
      routerRequestId: "79000000-0000-4000-8000-000000000000", attemptNumber: 1, submissionNumber: 1,
      provider: "codex", requestedModel: "codex/gpt-image-2", model: "gpt-image-2", connectionId: accountA.id,
      connection: accountA, entryPoint: "images_generations", operation: "generate",
      budgetScope: { installationBudgetId: "installation-budget", projectBudgetId: "project-budget" },
      estimatedMaxMicrousd: 70, pricingVersion: "synthetic-v1", pricingDigest: "a".repeat(64),
      priceShape: { model: "gpt-image-2", operation: "generate", outputCount: 1 },
    };
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        appendFileSync(providerLog, JSON.stringify(JSON.parse(body)) + "\n", { flush: true });
        response.end("accepted");
      });
    });
    const children = [];
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const providerUrl = `http://127.0.0.1:${server.address().port}/fixture`;
      const start = async (candidate, crashAt) => {
        const child = fork(fileURLToPath(new URL("../fixtures/image-supplier-budget-process.mjs", import.meta.url)), [], {
          execPath: process.execPath, stdio: ["ignore", "ignore", "pipe", "ipc"],
          env: { ...process.env, IMAGE_QUOTA_LOCAL_LIMITS_JSON: "[]", IMAGE_SUPPLIER_TEST_INPUT: JSON.stringify({
            databasePath, repositoryUrl: new URL("../../src/lib/db/repos/imageQuotaRepo.js", import.meta.url).href,
            adapterUrl: new URL("../../src/lib/db/adapters/nodeSqliteAdapter.js", import.meta.url).href,
            submission: candidate, providerUrl, holdAt: crashAt,
          }) },
        });
        children.push(child);
        expect((await once(child, "message"))[0]).toEqual({ ready: true });
        const result = once(child, "message");
        child.send({ command: "admit", startAt: Date.now() });
        return { child, result: (await result)[0] };
      };
      const original = await start(submission, holdAt);
      expect(original.result).toMatchObject({ phase: holdAt, providerDispatches: holdAt === "accepted" ? 1 : 0 });
      const exited = once(original.child, "exit");
      original.child.kill("SIGKILL");
      expect((await exited)[1]).toBe("SIGKILL");
      // Model a period rollover on the durable fixture; an open obligation is not freed by age.
      const priorPeriod = new Date(now);
      priorPeriod.setUTCDate(0);
      const oldTimestamp = priorPeriod.toISOString();
      sqlite.prepare("UPDATE imageSupplierExposureAllocations SET dispatchDay = ?, dispatchMonth = ?, reservedAt = ?")
        .run(oldTimestamp.slice(0, 10), oldTimestamp.slice(0, 7), oldTimestamp);
      sqlite.prepare("UPDATE imageQuotaRequestSubmissions SET dispatchedAt = ?").run(oldTimestamp);
      const replay = await start(submission);
      expect(replay.result.ticket).toBeUndefined();
      expect(replay.result.providerDispatches).toBe(0);
      // Rotate the credential but retain its supplier identity and unresolved money.
      const next = await start({ ...submission, routerRequestId: "79111111-1111-4111-8111-111111111111",
        connectionId: "refreshed-key", connection: { ...accountA, id: "refreshed-key" }, estimatedMaxMicrousd: 35 });
      expect(next.result).toMatchObject({ code: "IMAGE_SUPPLIER_BUDGET_EXHAUSTED", providerDispatches: 0 });
      expect(next.result.details.limitType).toBe(holdAt === "reserved" ? "daily" : "monthly");
      expect(new Set([original.result.pid, replay.result.pid, next.result.pid]).size).toBe(3);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions WHERE outcome = 'in_flight'").get().n).toBe(1);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageSupplierExposureAllocations WHERE state = 'open' AND reservedMaxMicrousd = 70").get().n).toBe(2);
      if (holdAt === "accepted") {
        const lines = readFileSync(providerLog, "utf8").trim().split("\n");
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]).submissionId).toBe(original.result.ticket.submissionId);
      } else {
        expect(() => readFileSync(providerLog)).toThrow();
      }
    } finally {
      await Promise.all(children.map(async (child) => {
        if (child.exitCode == null && child.signalCode == null) {
          const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
        }
      }));
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    }
  }, 20_000);

  it.each([true, false])("refuses an unmapped submission after an installation budget is configured (enabled=%s)", async (enabled) => {
    const now = Date.now();
    expect(await hasImageSupplierBudgets()).toBe(false);
    await configureImageSupplierBudget({
      id: "installation-budget", scopeType: "installation", scopeKey: "router-installation",
      currency: "USD", scale: 6, enabled, dailyLimitMicrousd: 100, monthlyLimitMicrousd: 100,
      pilotLimitMicrousd: 100, maxSubmissionMicrousd: 100, pricingPolicyVersion: "synthetic-v1",
      pilotId: "synthetic-pilot", pilotStartsAt: new Date(now - 60_000).toISOString(),
      pilotEndsAt: new Date(now + 86_400_000).toISOString(),
    });
    expect(await hasImageSupplierBudgets()).toBe(true);
    await expect(beginImageRequestSubmission({
      routerRequestId: "78666666-6666-4666-8666-666666666666", attemptNumber: 1, submissionNumber: 1,
      provider: "codex", requestedModel: "codex/gpt-image-2", model: "gpt-image-2", connectionId: accountA.id,
      connection: accountA, entryPoint: "images_generations", operation: "generate",
    })).rejects.toMatchObject({ code: "IMAGE_SUPPLIER_BUDGET_UNAVAILABLE" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions").get().n).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageSupplierExposureAllocations").get().n).toBe(0);
    const fetchMock = vi.fn(() => { throw new Error("must never send inference"); });
    vi.stubGlobal("fetch", fetchMock);
    const success = vi.fn();
    for (const provider of ["gemini", "antigravity"]) {
      const executor = new BaseExecutor(provider, {});
      executor.buildUrl = () => "https://provider.invalid/images";
      executor.transformRequest = (_model, body) => body;
      executor.buildHeaders = () => ({ "content-type": "application/json" });
      getExecutorMock.mockReturnValue(executor);
      getImageAdapterMock.mockReturnValue(provider === "gemini" ? geminiImageAdapter : antigravityImageAdapter);
      const result = await handleImageGenerationCore({
        body: { prompt: "synthetic fixture" }, modelInfo: { provider, model: "gemini-image" },
        credentials: { apiKey: "synthetic", accessToken: "synthetic" }, onRequestSuccess: success,
        onImageSubmissionStart: async () => {
          try {
            return await beginImageRequestSubmission({
              routerRequestId: "78888888-8888-4888-8888-888888888888", attemptNumber: 1, submissionNumber: 1,
              provider, requestedModel: `${provider}/gemini-image`, model: "gemini-image", connectionId: "synthetic",
              entryPoint: "images_generations", operation: "generate",
            });
          } catch (error) {
            expect(error.code).toBe("IMAGE_SUPPLIER_BUDGET_UNAVAILABLE");
            return "accounting_unavailable";
          }
        },
      });
      expect(result).toMatchObject({ success: false, status: 503, dispatchBlocked: "accounting_unavailable",
        acceptance: "rejected_before_acceptance" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions").get().n).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageSupplierExposureAllocations").get().n).toBe(0);
  });

  it.each([
    { estimatedMaxMicrousd: 20 },
    { pricingVersion: "synthetic-v1" },
    { pricingDigest: "a".repeat(64) },
    { priceShape: { model: "gpt-image-2", operation: "generate", outputCount: 1 } },
  ])("rejects pricing without budget scope instead of silently dropping it: %j", async (pricing) => {
    await expect(beginImageRequestSubmission({
      routerRequestId: "78777777-7777-4777-8777-777777777777", attemptNumber: 1, submissionNumber: 1,
      provider: "codex", requestedModel: "codex/gpt-image-2", model: "gpt-image-2", connectionId: accountA.id,
      connection: accountA, entryPoint: "images_generations", operation: "generate", ...pricing,
    })).rejects.toMatchObject({ code: "IMAGE_SUPPLIER_BUDGET_UNAVAILABLE" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions").get().n).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageSupplierExposureAllocations").get().n).toBe(0);
  });

  it.each([
    { model: "different-model", operation: "generate", outputCount: 1 },
    { model: "gpt-image-2", operation: "edit", outputCount: 1 },
  ])("refuses financial shapes inconsistent with the physical submission: %j", async (priceShape) => {
    const now = Date.now();
    const base = { currency: "USD", scale: 6, enabled: true, dailyLimitMicrousd: 100, monthlyLimitMicrousd: 100,
      pilotLimitMicrousd: 100, maxSubmissionMicrousd: 100, pricingPolicyVersion: "synthetic-v1",
      pilotId: "synthetic-pilot", pilotStartsAt: new Date(now - 60_000).toISOString(),
      pilotEndsAt: new Date(now + 86_400_000).toISOString() };
    await configureImageSupplierBudget({ ...base, id: "installation-budget", scopeType: "installation", scopeKey: "router-installation" });
    await configureImageSupplierBudget({ ...base, id: "project-budget", scopeType: "billing_project", scopeKey: imageQuotaIdentity(accountA) });
    await expect(beginImageRequestSubmission({
      routerRequestId: "78999999-9999-4999-8999-999999999999", attemptNumber: 1, submissionNumber: 1,
      provider: "codex", requestedModel: "codex/gpt-image-2", model: "gpt-image-2", connectionId: accountA.id,
      connection: accountA, entryPoint: "images_generations", operation: "generate",
      budgetScope: { installationBudgetId: "installation-budget", projectBudgetId: "project-budget" },
      estimatedMaxMicrousd: 20, pricingVersion: "synthetic-v1", pricingDigest: "a".repeat(64), priceShape,
    })).rejects.toMatchObject({ code: "IMAGE_SUPPLIER_BUDGET_UNAVAILABLE" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions").get().n).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageSupplierExposureAllocations").get().n).toBe(0);
  });

  it("reports local supplier obligations, settlement states and remaining headroom", async () => {
    const now = Date.now();
    const base = {
      currency: "USD", scale: 6, enabled: true, dailyLimitMicrousd: 1000, monthlyLimitMicrousd: 1000,
      pilotLimitMicrousd: 1000, maxSubmissionMicrousd: 100, pricingPolicyVersion: "synthetic-v1",
      pilotId: "status-pilot", pilotStartsAt: new Date(now - 60_000).toISOString(),
      pilotEndsAt: new Date(now + 86_400_000).toISOString(),
    };
    await configureImageSupplierBudget({ ...base, id: "status-installation", scopeType: "installation", scopeKey: "router" });
    await configureImageSupplierBudget({ ...base, id: "status-project", scopeType: "billing_project", scopeKey: imageQuotaIdentity(accountA) });
    const common = {
      provider: "codex", requestedModel: "synthetic-image", model: "synthetic-image", connectionId: accountA.id,
      connection: accountA, entryPoint: "images_generations", operation: "generate",
      budgetScope: { installationBudgetId: "status-installation", projectBudgetId: "status-project" },
      pricingVersion: "synthetic-v1", pricingDigest: "a".repeat(64),
      priceShape: { model: "synthetic-image", operation: "generate", outputCount: 1, resolution: "1K" },
    };
    const settled = await beginImageRequestSubmission({ ...common,
      routerRequestId: "78444444-4444-4444-8444-444444444401", attemptNumber: 1, submissionNumber: 1,
      estimatedMaxMicrousd: 20,
    });
    await finishImageRequestSubmission({ ...settled, outcome: "succeeded", outputCount: 1 });
    await reconcileImageSupplierExposure({
      submissionId: settled.submissionId, budgetId: "status-installation",
      evidence: { expectedRevision: 2, evidenceSource: "provider_billing", evidenceReference: "local-test",
        evidenceDigest: "b".repeat(64), observedAt: new Date().toISOString(), principal: "offline-test",
        nextState: "confirmed", billedMicrousd: 19 },
    });
    await beginImageRequestSubmission({ ...common,
      routerRequestId: "78444444-4444-4444-8444-444444444402", attemptNumber: 1, submissionNumber: 1,
      estimatedMaxMicrousd: 30,
    });

    const overview = await getImageSupplierBudgetOverview(Date.now());
    expect(overview).toMatchObject([
      { id: "status-project", status: "active", obligationMicrousd: { daily: 50, monthly: 50, pilot: 50 },
        remainingMicrousd: { daily: 950, monthly: 950, pilot: 950 }, openMicrousd: 30, provisionalMicrousd: 20, confirmedBilledMicrousd: 0 },
      { id: "status-installation", status: "active", obligationMicrousd: { daily: 49, monthly: 49, pilot: 49 },
        remainingMicrousd: { daily: 951, monthly: 951, pilot: 951 }, openMicrousd: 30, provisionalMicrousd: 0, confirmedBilledMicrousd: 19 },
    ]);
  });

  it("settles a successful reservation once and disables every linked budget on billed overrun", async () => {
    const now = Date.now();
    const base = {
      currency: "USD", scale: 6, enabled: true, dailyLimitMicrousd: 100, monthlyLimitMicrousd: 100,
      pilotLimitMicrousd: 100, maxSubmissionMicrousd: 100, pricingPolicyVersion: "synthetic-v1",
      pilotId: "synthetic-pilot", pilotStartsAt: new Date(now - 60_000).toISOString(),
      pilotEndsAt: new Date(now + 86_400_000).toISOString(),
    };
    await configureImageSupplierBudget({ ...base, id: "installation-budget", scopeType: "installation", scopeKey: "router-installation" });
    await configureImageSupplierBudget({ ...base, id: "project-budget", scopeType: "billing_project", scopeKey: imageQuotaIdentity(accountA) });
    const ticket = await beginImageRequestSubmission({
      routerRequestId: "78444444-4444-4444-8444-444444444444", attemptNumber: 1, submissionNumber: 1,
      provider: "codex", requestedModel: "codex/gpt-image-2", model: "gpt-image-2", connectionId: accountA.id,
      connection: accountA, entryPoint: "images_generations", operation: "generate",
      budgetScope: { installationBudgetId: "installation-budget", projectBudgetId: "project-budget" },
      estimatedMaxMicrousd: 20, pricingVersion: "synthetic-v1", pricingDigest: "c".repeat(64),
      priceShape: { model: "gpt-image-2", operation: "generate", outputCount: 1, resolution: "1024" },
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageSupplierExposureAllocations WHERE submissionId = ? AND state = 'open'")
      .get(ticket.submissionId).n).toBe(2);
    expect(await finishImageRequestSubmission({ ...ticket, outcome: "succeeded", outputCount: 1 })).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageSupplierExposureAllocations WHERE submissionId = ? AND state = 'provisional'")
      .get(ticket.submissionId).n).toBe(2);
    expect(await finishImageRequestSubmission({ ...ticket, outcome: "succeeded", outputCount: 1 })).toBe(false);

    const evidence = {
      expectedRevision: 2, evidenceSource: "provider_billing", evidenceReference: "invoice-line-1",
      evidenceDigest: "d".repeat(64), observedAt: new Date().toISOString(), principal: "offline-test",
      nextState: "confirmed", billedMicrousd: 21,
    };
    const reconciled = await reconcileImageSupplierExposure({
      submissionId: ticket.submissionId, budgetId: "installation-budget", evidence,
    });
    expect(reconciled).toMatchObject({ state: "confirmed", billedMicrousd: 21, revision: 3 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageSupplierBudgets WHERE enabled = 0").get().n).toBe(2);
    const replayed = await reconcileImageSupplierExposure({
      submissionId: ticket.submissionId, budgetId: "installation-budget", evidence,
    });
    expect(replayed).toMatchObject({ state: "confirmed", replayed: true });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageSupplierExposureAdjustments WHERE submissionId = ?")
      .get(ticket.submissionId).n).toBe(3);
    await expect(beginImageRequestSubmission({
      routerRequestId: "78555555-5555-4555-8555-555555555555", attemptNumber: 1, submissionNumber: 1,
      provider: "codex", requestedModel: "codex/gpt-image-2", model: "gpt-image-2", connectionId: accountA.id,
      connection: accountA, entryPoint: "images_generations", operation: "generate",
      budgetScope: { installationBudgetId: "installation-budget", projectBudgetId: "project-budget" },
      estimatedMaxMicrousd: 1, pricingVersion: "synthetic-v1", pricingDigest: "e".repeat(64),
      priceShape: { model: "gpt-image-2", operation: "generate", outputCount: 1, resolution: "1024" },
    })).rejects.toMatchObject({ code: "IMAGE_SUPPLIER_BUDGET_UNAVAILABLE" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions WHERE routerRequestId = ?")
      .get("78555555-5555-4555-8555-555555555555").n).toBe(0);
  });

  it("admits exactly one recovery across independent native SQLite workers", async () => {
    temporaryDatabase = mkdtempSync(join(tmpdir(), "image-quota-workers-"));
    const databasePath = join(temporaryDatabase, "quota.sqlite");
    sqlite.close();
    sqlite = new DatabaseSync(databasePath);
    sqlite.exec("PRAGMA journal_mode = WAL");
    adapter = makeAdapter(sqlite);
    imageQuotaMigration.up(adapter);
    imageQuotaManagementMigration.up(adapter);
    imageQuotaDispatchMigration.up(adapter);
    imageRequestAttemptsMigration.up(adapter);
    imageRequestSubmissionsMigration.up(adapter);
    imageQuotaTraceFallbackMigration.up(adapter);
    imageSubmissionQuotaFallbackMigration.up(adapter);
    sqlite.exec("CREATE TABLE providerConnections(id TEXT PRIMARY KEY, provider TEXT, isActive INTEGER, data TEXT)");
    getAdapterMock.mockResolvedValue(adapter);
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, 1, ?)")
      .run(accountA.id, accountA.provider, JSON.stringify({ providerSpecificData: accountA.providerSpecificData }));
    await recordImageQuotaObservation(accountA, observation(new Date(Date.now() - 1_000).toISOString()), "expired");
    const rows = (await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2")).get(accountA.id).expiredRows;
    const workers = ["native-worker-a", "native-worker-b"].map((owner) => new Worker(
      new URL("../fixtures/image-quota-recovery-worker.mjs", import.meta.url),
      { workerData: {
        owner, databasePath, rows, connection: accountA,
        adapterUrl: new URL("../../src/lib/db/adapters/nodeSqliteAdapter.js", import.meta.url).href,
        repositoryUrl: new URL("../../src/lib/db/repos/imageQuotaRepo.js", import.meta.url).href,
      } },
    ));
    try {
      const ready = await Promise.all(workers.map((worker) => once(worker, "message")));
      expect(ready).toEqual([[{ ready: true }], [{ ready: true }]]);
      const completed = workers.map((worker) => once(worker, "message"));
      workers.forEach((worker) => worker.postMessage("dispatch"));
      const results = (await Promise.all(completed)).flat();
      expect(results.every((result) => !result.error)).toBe(true);
      expect(results.filter((result) => result.lease.acquired)).toHaveLength(1);
      expect(results.filter((result) => result.admission?.allowed)).toHaveLength(1);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaProbeLeases WHERE dispatchedAt IS NOT NULL").get().n).toBe(1);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  }, 10_000);

  it("refuses to reserve recovery from a stale constraint snapshot", async () => {
    const now = Date.now();
    await recordImageQuotaObservation(accountA, observation(new Date(now - 1_000).toISOString()), "expired");
    const rows = (await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2")).get(accountA.id).expiredRows;
    await recordImageQuotaObservation(accountA, observation(new Date(now + 86_400_000).toISOString()), "new-limit");
    expect(await acquireImageQuotaProbeLeases(accountA, rows, "stale-selector", 120_000, now)).toMatchObject({ acquired: false });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaProbeLeases").get().n).toBe(0);
  });

  it("refuses probe rows belonging to another supplier without modifying state", async () => {
    await recordImageQuotaObservation(accountA, observation(new Date(Date.now() - 1_000).toISOString()), "expired");
    const rows = (await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2")).get(accountA.id).expiredRows;
    const other = { ...accountA, providerSpecificData: { chatgptAccountId: "different-account" } };
    await expect(acquireImageQuotaProbeLeases(other, rows, "wrong-supplier", 120_000)).rejects.toThrow("probe scope");
    await expect(finishImageQuotaProbe(other, rows, "wrong-supplier", { success: true })).rejects.toThrow("probe scope");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaConstraints").get().n).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaProbeLeases").get().n).toBe(0);
  });

  it.each(["estimated", "provider_confirmed"])("preserves a longer reset and its provenance after a shorter %s reset", async (confidence) => {
    const weekly = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await recordImageQuotaObservation(accountA, observation(weekly), "weekly");
    await recordImageQuotaObservation(accountA, { ...observation(new Date(Date.now() + 3_600_000).toISOString()), confidence, source: "later-rejection" }, "shorter");
    const rows = (await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2")).get(accountA.id).blockingRows;
    expect(rows).toMatchObject([{ retryAt: weekly, confidence: "provider_confirmed", source: "provider_image_error", revision: 2 }]);
  });

  it("does not replace an unknown reset with an estimated deadline", async () => {
    await recordImageQuotaObservation(accountA, { ...observation(null), confidence: "unknown" }, "unknown-reset");
    await recordImageQuotaObservation(accountA, { ...observation(new Date(Date.now() + 3_600_000).toISOString()), confidence: "estimated" }, "estimated-reset");
    const rows = (await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2")).get(accountA.id).blockingRows;
    expect(rows).toMatchObject([{ retryAt: null }]);
  });

  it("accepts a provider-confirmed reset after an unknown deadline", async () => {
    await recordImageQuotaObservation(accountA, { ...observation(null), confidence: "unknown" }, "unknown-reset");
    const confirmed = new Date(Date.now() + 3_600_000).toISOString();
    await recordImageQuotaObservation(accountA, observation(confirmed), "confirmed-reset");
    const rows = (await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2")).get(accountA.id).blockingRows;
    expect(rows).toMatchObject([{ retryAt: confirmed, confidence: "provider_confirmed" }]);
  });

  it("records each dispatched submission and reports observed calls without claiming provider quota use", async () => {
    const routerRequestId = "7c928d8e-f790-42ec-8bdf-2ee049c06f1e";
    const clientOperationId = "84d28c94-ef09-48f9-9c3b-31f2a4c13eac";
    const ticket = await beginImageRequestSubmission({
      routerRequestId,
      clientOperationId,
      attemptNumber: 1,
      submissionNumber: 1,
      provider: "codex",
      requestedModel: "codex/gpt-image-2",
      model: "gpt-image-2",
      connectionId: "private-account-identifier",
      connection: { ...accountA, id: "private-account-identifier" },
      entryPoint: "images_generations",
      operation: "generate",
      quotaGroupId: "codex.image_generation",
    });

    expect(await finishImageRequestSubmission({
      ...ticket,
      outcome: "quota_rejected",
      httpStatus: 429,
      failureClass: "image_quota",
      quotaGroupId: "codex.image_generation",
      constraintId: "usage_limit",
      retryAt: "2026-10-22T00:00:00.000Z",
      confidence: "provider_confirmed",
      providerRequestId: "req_123",
      usage: { prompt_tokens: 10, completion_tokens: 2, prompt: "must not persist" },
    })).toBe(true);
    expect(await finishImageRequestSubmission({ ...ticket, outcome: "succeeded", outputCount: 1 })).toBe(false);

    const trace = await getImageRequestTrace({ clientOperationId });
    expect(trace).toMatchObject({
      schema_version: "9router.image_request_trace.v2",
      status: "found",
      requests: [{
        router_request_id: routerRequestId,
        submissions: [{
          sequence: 1,
          attempt_sequence: 1,
          provider: "codex",
          requested_model: "codex/gpt-image-2",
          model: "gpt-image-2",
          account_ref: expect.stringMatching(/^acct_[0-9a-f]{24}$/),
          outcome: "quota_rejected",
          http_status: 429,
          retry_at: "2026-10-22T00:00:00.000Z",
          provider_usage: { status: "reported", counters: { prompt_tokens: 10, completion_tokens: 2 } },
        }],
      }],
    });
    expect(JSON.stringify(trace)).not.toContain("private-account-identifier");
    expect(JSON.stringify(trace)).not.toContain("must not persist");

    const summary = await getImageRequestUsageSummary([{ id: "private-account-identifier" }], "codex");
    expect(summary.get("private-account-identifier")).toMatchObject({
      dispatchedRequests: 1,
      validatedImages: 0,
      quotaRejections: 1,
      unknownOutcomes: 0,
    });
  });

  it("stores a sanitized per-account attempt trace under router and client operation IDs", async () => {
    const routerRequestId = "7c928d8e-f790-42ec-8bdf-2ee049c06f1e";
    const clientOperationId = "84d28c94-ef09-48f9-9c3b-31f2a4c13eac";
    await beginImageRequestAttempt({
      routerRequestId,
      clientOperationId,
      attemptNumber: 1,
      provider: "codex",
      model: "gpt-image-2",
      connectionId: "private-connection-identifier",
      quotaGroupId: "codex.image_generation",
    });

    expect(await finishImageRequestAttempt({
      routerRequestId,
      attemptNumber: 1,
      outcome: "quota_rejected",
      httpStatus: 429,
      failureClass: "image_quota",
      quotaGroupId: "codex.image_generation",
      constraintId: "usage_limit",
      retryAt: "2026-10-22T00:00:00.000Z",
      confidence: "provider_confirmed",
      fallbackAction: "try_next_account",
    })).toBe(true);
    expect(await finishImageRequestAttempt({
      routerRequestId,
      attemptNumber: 1,
      outcome: "succeeded",
      httpStatus: 200,
      fallbackAction: "success",
    })).toBe(false);

    const trace = await getImageRequestTrace({ clientOperationId });
    expect(trace).toMatchObject({
      schema_version: "9router.image_request_trace.v2",
      status: "found",
      requests: [{
        router_request_id: routerRequestId,
        client_operation_id: clientOperationId,
        attempts: [{
          sequence: 1,
          provider: "codex",
          model: "gpt-image-2",
          account_ref: expect.stringMatching(/^acct_[0-9a-f]{24}$/),
          outcome: "quota_rejected",
          http_status: 429,
          failure_class: "image_quota",
          retry_at: "2026-10-22T00:00:00.000Z",
          fallback_action: "try_next_account",
        }],
      }],
    });
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain("private-connection-identifier");
    expect(trace.requests[0].attempts[0]).not.toHaveProperty("connection_id");
    expect(serialized).not.toContain("prompt");
    expect((await getImageRequestTrace({ routerRequestId })).requests).toHaveLength(1);
  });

  it("uses a completed image attempt as a durable quota lock when constraint persistence fails, then probes once after all scoped resets", async () => {
    const accountB = {
      id: "connection-b",
      provider: "codex",
      providerSpecificData: { chatgptAccountId: "account-2", workspaceId: "workspace-b" },
    };
    for (const connection of [accountA, accountB]) {
      sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, 1, ?)")
        .run(connection.id, connection.provider, JSON.stringify({ providerSpecificData: connection.providerSpecificData }));
    }

    const routerRequestId = "bba9bb55-626f-43af-9600-726e8dfaaee7";
    const startedAt = Date.now();
    const quotaObservations = [
      { ...observation(new Date(startedAt + 500).toISOString()), constraintId: "hourly_limit", appliesToModels: ["gpt-image-2"] },
      { ...observation(new Date(startedAt + 1400).toISOString()), constraintId: "weekly_limit", appliesToModels: ["gpt-image-2"] },
    ];
    await beginImageRequestAttempt({
      routerRequestId,
      attemptNumber: 1,
      provider: accountA.provider,
      model: "gpt-image-2",
      connectionId: accountA.id,
      connection: accountA,
      quotaGroupId: "codex.image_generation",
    });
    await finishImageRequestAttempt({
      routerRequestId,
      attemptNumber: 1,
      outcome: "quota_rejected",
      httpStatus: 429,
      failureClass: "image_quota",
      quotaGroupId: quotaObservations[0].quotaGroupId,
      constraintId: quotaObservations[0].constraintId,
      retryAt: quotaObservations[0].retryAt,
      confidence: "provider_confirmed",
      quotaObservations,
      fallbackAction: "try_next_account",
    });
    sqlite.exec(`CREATE TRIGGER fail_image_quota_constraint_insert
      BEFORE INSERT ON imageQuotaConstraints BEGIN SELECT RAISE(ABORT, 'injected constraint write failure'); END`);
    await expect(recordImageQuotaObservation(accountA, { ...quotaObservations[0], constraints: quotaObservations }, routerRequestId, 1))
      .resolves.toMatchObject({ constraintId: "hourly_limit" });

    const locked = (await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2")).get(accountA.id);
    expect(locked.blockingRows.map((row) => row.constraintId)).toEqual(["hourly_limit", "weekly_limit"]);
    expect(locked.blockingRows.every((row) => row.source === "quota_attempt_trace_fallback")).toBe(true);
    const trace = JSON.stringify(await getImageRequestTrace({ routerRequestId }));
    expect(trace).not.toContain("account-1");
    expect(trace).not.toContain("workspace-a");
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2"))
      .toMatchObject({ allowed: false, reason: "quota_blocked" });
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-3"))
      .toMatchObject({ allowed: true });
    expect(await admitImageQuotaRequest(accountB, "image_generation", "gpt-image-2"))
      .toMatchObject({ allowed: true });

    sqlite.exec("DROP TRIGGER fail_image_quota_constraint_insert");
    await new Promise((resolve) => setTimeout(resolve, 650));
    const afterHourlyReset = (await getImageQuotaState(
      [accountA], "codex", "image_generation", "gpt-image-2",
    )).get(accountA.id);
    expect(afterHourlyReset.blockingRows.map((row) => row.constraintId)).toEqual(["weekly_limit"]);
    expect(afterHourlyReset.expiredRows.map((row) => row.constraintId)).toEqual(["hourly_limit"]);

    await new Promise((resolve) => setTimeout(resolve, 800));
    const expired = (await getImageQuotaState(
      [accountA], "codex", "image_generation", "gpt-image-2",
    )).get(accountA.id).expiredRows;
    const [leaseA, leaseB] = await Promise.all([
      acquireImageQuotaProbeLeases(accountA, expired, "fallback-probe-a", 120_000),
      acquireImageQuotaProbeLeases(accountA, expired, "fallback-probe-b", 120_000),
    ]);
    const owner = leaseA.acquired ? "fallback-probe-a" : "fallback-probe-b";
    expect(Number(leaseA.acquired) + Number(leaseB.acquired)).toBe(1);
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2", owner))
      .toMatchObject({ allowed: true });
    await finishImageQuotaProbe(accountA, expired, owner, { success: true });
    expect((await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2")).get(accountA.id))
      .toMatchObject({ blockingRows: [], expiredRows: [] });
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2"))
      .toMatchObject({ allowed: true });
  });

  it("uses the durable submission record when quota attempt finalization and constraint writes fail", async () => {
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, 1, ?)")
      .run(accountA.id, accountA.provider, JSON.stringify({ providerSpecificData: accountA.providerSpecificData }));
    const routerRequestId = "9d596ad5-2502-408d-8f4e-3a921d0f5520";
    const startedAt = Date.now();
    const quotaObservations = [
      { ...observation(new Date(startedAt + 500).toISOString()), constraintId: "hourly_limit", appliesToModels: ["gpt-image-2"] },
      { ...observation(new Date(startedAt + 1400).toISOString()), constraintId: "weekly_limit", appliesToModels: ["gpt-image-2"] },
    ];
    await beginImageRequestAttempt({
      routerRequestId,
      attemptNumber: 1,
      provider: accountA.provider,
      model: "gpt-image-2",
      connectionId: accountA.id,
      connection: accountA,
      quotaGroupId: "codex.image_generation",
    });
    const ticket = await beginImageRequestSubmission({
      routerRequestId,
      attemptNumber: 1,
      submissionNumber: 1,
      provider: accountA.provider,
      requestedModel: "codex/gpt-image-2",
      model: "gpt-image-2",
      connectionId: accountA.id,
      connection: accountA,
      entryPoint: "images_generations",
      operation: "generate",
      quotaGroupId: "codex.image_generation",
    });
    await finishImageRequestSubmission({
      ...ticket,
      outcome: "quota_rejected",
      httpStatus: 429,
      failureClass: "image_quota",
      ...quotaObservations[0],
      quotaObservations,
    });

    sqlite.exec(`CREATE TRIGGER fail_image_quota_attempt_update
      BEFORE UPDATE ON imageQuotaRequestAttempts BEGIN SELECT RAISE(ABORT, 'injected attempt update failure'); END`);
    sqlite.exec(`CREATE TRIGGER fail_image_quota_constraint_insert
      BEFORE INSERT ON imageQuotaConstraints BEGIN SELECT RAISE(ABORT, 'injected constraint write failure'); END`);
    await expect(finishImageRequestAttempt({
      routerRequestId,
      attemptNumber: 1,
      outcome: "quota_rejected",
      httpStatus: 429,
      failureClass: "image_quota",
      quotaGroupId: quotaObservations[0].quotaGroupId,
      constraintId: quotaObservations[0].constraintId,
      retryAt: quotaObservations[0].retryAt,
      confidence: "provider_confirmed",
      quotaObservations,
      fallbackAction: "try_next_account",
    })).rejects.toThrow("injected attempt update failure");
    await expect(recordImageQuotaObservation(accountA, { ...quotaObservations[0], constraints: quotaObservations }, routerRequestId, 1))
      .resolves.toMatchObject({ constraintId: "hourly_limit" });

    const locked = (await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2")).get(accountA.id);
    expect(locked.blockingRows.map((row) => row.constraintId)).toEqual(["hourly_limit", "weekly_limit"]);
    expect(locked.blockingRows.every((row) => row.source === "quota_submission_fallback")).toBe(true);
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2"))
      .toMatchObject({ allowed: false, reason: "quota_blocked" });
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-3"))
      .toMatchObject({ allowed: true });

    sqlite.exec("DROP TRIGGER fail_image_quota_attempt_update");
    sqlite.exec("DROP TRIGGER fail_image_quota_constraint_insert");
    await new Promise((resolve) => setTimeout(resolve, 650));
    const afterHourlyReset = (await getImageQuotaState(
      [accountA], "codex", "image_generation", "gpt-image-2",
    )).get(accountA.id);
    expect(afterHourlyReset.blockingRows.map((row) => row.constraintId)).toEqual(["weekly_limit"]);
    expect(afterHourlyReset.expiredRows.map((row) => row.constraintId)).toEqual(["hourly_limit"]);

    await new Promise((resolve) => setTimeout(resolve, 800));
    const expired = (await getImageQuotaState(
      [accountA], "codex", "image_generation", "gpt-image-2",
    )).get(accountA.id).expiredRows;
    const lease = await acquireImageQuotaProbeLeases(accountA, expired, "submission-fallback-probe", 120_000);
    expect(lease.acquired).toBe(true);
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2", "submission-fallback-probe"))
      .toMatchObject({ allowed: true });
    await finishImageQuotaProbe(accountA, expired, "submission-fallback-probe", { success: true });
    expect((await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2")).get(accountA.id))
      .toMatchObject({ blockingRows: [], expiredRows: [] });
    expect(sqlite.prepare("SELECT quotaLockResolvedAt FROM imageQuotaRequestSubmissions WHERE routerRequestId = ?")
      .get(routerRequestId).quotaLockResolvedAt).not.toBeNull();
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2"))
      .toMatchObject({ allowed: true });
  });

  it.each(["{", "null", "{}", "[null]", "[{}]"])(
    "fails closed without erasing malformed admission quota state %s", async (stored) => {
      sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, 1, ?)")
        .run(accountA.id, accountA.provider, JSON.stringify({ providerSpecificData: accountA.providerSpecificData }));
      sqlite.prepare("UPDATE imageQuotaAdmissionState SET quotaObservations = ? WHERE id = 1").run(stored);
      const unavailable = { code: "IMAGE_QUOTA_STORE_UNAVAILABLE" };
      await expect(getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2"))
        .rejects.toMatchObject(unavailable);
      await expect(admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2"))
        .rejects.toMatchObject(unavailable);
      await expect(recordImageQuotaObservation(accountA, observation("2026-10-24T00:00:00Z"), "corrupt-store"))
        .rejects.toMatchObject(unavailable);
      expect(sqlite.prepare("SELECT quotaObservations FROM imageQuotaAdmissionState WHERE id = 1").get().quotaObservations)
        .toBe(stored);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaConstraints").get().n).toBe(0);
    },
  );

  it("fails closed when the admission-state singleton is missing", async () => {
    sqlite.exec("DELETE FROM imageQuotaAdmissionState WHERE id = 1");
    await expect(getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2"))
      .rejects.toMatchObject({ code: "IMAGE_QUOTA_STORE_UNAVAILABLE" });
  });

  it("retains model-scoped quota locks in admission state when attempt, submission, and constraint writes fail", async () => {
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, 1, ?)")
      .run(accountA.id, accountA.provider, JSON.stringify({ providerSpecificData: accountA.providerSpecificData }));
    const routerRequestId = "f5595c57-c193-4286-83fd-62a482488f7a";
    const startedAt = Date.now();
    const quotaObservations = [
      { ...observation(new Date(startedAt + 3_600_000).toISOString()), constraintId: "hourly_limit", appliesToModels: ["gpt-image-2"] },
      { ...observation(new Date(startedAt + 7 * 24 * 3_600_000).toISOString()), constraintId: "weekly_limit", appliesToModels: ["gpt-image-2"] },
    ];
    await beginImageRequestAttempt({
      routerRequestId,
      attemptNumber: 1,
      provider: accountA.provider,
      model: "gpt-image-2",
      connectionId: accountA.id,
      connection: accountA,
      quotaGroupId: quotaObservations[0].quotaGroupId,
    });
    const ticket = await beginImageRequestSubmission({
      routerRequestId,
      attemptNumber: 1,
      submissionNumber: 1,
      provider: accountA.provider,
      requestedModel: "codex/gpt-image-2",
      model: "gpt-image-2",
      connectionId: accountA.id,
      connection: accountA,
      entryPoint: "images_generations",
      operation: "generate",
      quotaGroupId: quotaObservations[0].quotaGroupId,
    });
    sqlite.exec(`CREATE TRIGGER fail_quota_attempt_update
      BEFORE UPDATE ON imageQuotaRequestAttempts BEGIN SELECT RAISE(ABORT, 'injected attempt write failure'); END`);
    sqlite.exec(`CREATE TRIGGER fail_quota_submission_update
      BEFORE UPDATE ON imageQuotaRequestSubmissions BEGIN SELECT RAISE(ABORT, 'injected submission write failure'); END`);
    sqlite.exec(`CREATE TRIGGER fail_quota_constraint_insert
      BEFORE INSERT ON imageQuotaConstraints BEGIN SELECT RAISE(ABORT, 'injected constraint write failure'); END`);

    await expect(finishImageRequestAttempt({
      routerRequestId,
      attemptNumber: 1,
      outcome: "quota_rejected",
      httpStatus: 429,
      failureClass: "image_quota",
      quotaGroupId: quotaObservations[0].quotaGroupId,
      constraintId: quotaObservations[0].constraintId,
      retryAt: quotaObservations[0].retryAt,
      confidence: "provider_confirmed",
      quotaObservations,
      fallbackAction: "try_next_account",
    })).rejects.toThrow("injected attempt write failure");
    await expect(finishImageRequestSubmission({
      ...ticket,
      outcome: "quota_rejected",
      httpStatus: 429,
      failureClass: "image_quota",
      ...quotaObservations[0],
      quotaObservations,
    })).rejects.toThrow("injected submission write failure");
    await expect(recordImageQuotaObservation(accountA, {
      ...quotaObservations[0], constraints: quotaObservations,
    }, routerRequestId, 1)).resolves.toMatchObject({
      provider: "codex",
      constraintId: "hourly_limit",
    });

    const stored = JSON.parse(sqlite.prepare("SELECT quotaObservations FROM imageQuotaAdmissionState WHERE id = 1").get().quotaObservations);
    expect(stored.map((row) => row.constraintId)).toEqual(["hourly_limit", "weekly_limit"]);
    const locked = (await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2")).get(accountA.id);
    expect(locked.blockingRows.map((row) => row.constraintId)).toEqual(["hourly_limit", "weekly_limit"]);
    expect(locked.blockingRows.every((row) => row.source === "quota_admission_state_fallback")).toBe(true);
    expect(locked.blockingRows.every((row) => row.appliesToModels === JSON.stringify(["gpt-image-2"]))).toBe(true);
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2"))
      .toMatchObject({ allowed: false, reason: "quota_blocked" });
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-3"))
      .toMatchObject({ allowed: true });

    sqlite.exec("DROP TRIGGER fail_quota_attempt_update");
    sqlite.exec("DROP TRIGGER fail_quota_submission_update");
    sqlite.exec("DROP TRIGGER fail_quota_constraint_insert");
    const afterHourlyReset = (await getImageQuotaState(
      [accountA], "codex", "image_generation", "gpt-image-2", startedAt + 2 * 3_600_000,
    )).get(accountA.id);
    expect(afterHourlyReset.blockingRows.map((row) => row.constraintId)).toEqual(["weekly_limit"]);
    expect(afterHourlyReset.expiredRows.map((row) => row.constraintId)).toEqual(["hourly_limit"]);

    const expiredReset = new Date(Date.now() - 1_000).toISOString();
    const fallbackState = JSON.parse(sqlite.prepare("SELECT quotaObservations FROM imageQuotaAdmissionState WHERE id = 1").get().quotaObservations)
      .map((row) => ({ ...row, retryAt: expiredReset }));
    sqlite.prepare("UPDATE imageQuotaAdmissionState SET quotaObservations = ? WHERE id = 1")
      .run(JSON.stringify(fallbackState));
    const expired = (await getImageQuotaState(
      [accountA], "codex", "image_generation", "gpt-image-2",
    )).get(accountA.id).expiredRows;
    const [leaseA, leaseB] = await Promise.all([
      acquireImageQuotaProbeLeases(accountA, expired, "admission-probe-a", 120_000),
      acquireImageQuotaProbeLeases(accountA, expired, "admission-probe-b", 120_000),
    ]);
    const owner = leaseA.acquired ? "admission-probe-a" : "admission-probe-b";
    expect(Number(leaseA.acquired) + Number(leaseB.acquired)).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaConstraints WHERE state = 'blocked'").get().n).toBe(2);
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2", owner))
      .toMatchObject({ allowed: true });
    await finishImageQuotaProbe(accountA, expired, owner, { success: true });
    expect(JSON.parse(sqlite.prepare("SELECT quotaObservations FROM imageQuotaAdmissionState WHERE id = 1").get().quotaObservations))
      .toEqual([]);
    expect((await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2")).get(accountA.id))
      .toMatchObject({ blockingRows: [], expiredRows: [] });
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2"))
      .toMatchObject({ allowed: true });
  });

  it("keeps a newer fallback rejection after an older expiry probe succeeds", async () => {
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, 1, ?)")
      .run(accountA.id, accountA.provider, JSON.stringify({ providerSpecificData: accountA.providerSpecificData }));
    sqlite.exec(`CREATE TRIGGER fail_quota_constraint_insert
      BEFORE INSERT ON imageQuotaConstraints BEGIN SELECT RAISE(ABORT, 'injected constraint write failure'); END`);
    const oldObservation = {
      ...observation(new Date(Date.now() - 1_000).toISOString()),
      appliesToModels: ["gpt-image-2"],
    };
    await recordImageQuotaObservation(accountA, oldObservation, "older-quota");
    const expired = (await getImageQuotaState(
      [accountA], "codex", "image_generation", "gpt-image-2",
    )).get(accountA.id).expiredRows;
    sqlite.exec("DROP TRIGGER fail_quota_constraint_insert");

    const lease = await acquireImageQuotaProbeLeases(accountA, expired, "older-probe", 120_000);
    expect(lease.acquired).toBe(true);
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2", "older-probe"))
      .toMatchObject({ allowed: true });

    sqlite.exec(`CREATE TRIGGER fail_quota_constraint_insert
      BEFORE INSERT ON imageQuotaConstraints BEGIN SELECT RAISE(ABORT, 'injected constraint write failure'); END`);
    const newerReset = new Date(Date.now() + 86_400_000).toISOString();
    await recordImageQuotaObservation(accountA, {
      ...observation(newerReset), appliesToModels: ["gpt-image-2"],
    }, "newer-quota");
    sqlite.exec("DROP TRIGGER fail_quota_constraint_insert");

    await finishImageQuotaProbe(accountA, expired, "older-probe", { success: true });
    const state = (await getImageQuotaState(
      [accountA], "codex", "image_generation", "gpt-image-2",
    )).get(accountA.id);
    expect(state.blockingRows).toMatchObject([{
      constraintId: "usage_limit",
      source: "quota_admission_state_fallback",
      retryAt: newerReset,
    }]);
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2"))
      .toMatchObject({ allowed: false, reason: "quota_blocked" });
  });

  it("resolves the trace fallback when the canonical quota constraint write succeeds", async () => {
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, 1, ?)")
      .run(accountA.id, accountA.provider, JSON.stringify({ providerSpecificData: accountA.providerSpecificData }));
    const routerRequestId = "86bdce12-289e-49c7-bb05-d85b27dfcaa2";
    const quota = observation(new Date(Date.now() + 60_000).toISOString());
    await beginImageRequestAttempt({
      routerRequestId,
      attemptNumber: 1,
      provider: accountA.provider,
      model: "gpt-image-2",
      connectionId: accountA.id,
      connection: accountA,
      quotaGroupId: quota.quotaGroupId,
    });
    await finishImageRequestAttempt({
      routerRequestId,
      attemptNumber: 1,
      outcome: "quota_rejected",
      failureClass: "image_quota",
      quotaGroupId: quota.quotaGroupId,
      constraintId: quota.constraintId,
      retryAt: quota.retryAt,
      confidence: quota.confidence,
      quotaObservations: [quota],
      fallbackAction: "try_next_account",
    });
    await recordImageQuotaObservation(accountA, quota, routerRequestId, 1);

    const trace = sqlite.prepare("SELECT quotaLockResolvedAt FROM imageQuotaRequestAttempts WHERE routerRequestId = ?")
      .get(routerRequestId);
    const state = (await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2")).get(accountA.id);
    expect(trace.quotaLockResolvedAt).not.toBeNull();
    expect(state.blockingRows).toMatchObject([{ constraintId: quota.constraintId, fallbackAttemptIds: [] }]);
  });

  it("uses a newer provider-confirmed reset instead of an older unknown reset in admission", async () => {
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, 1, ?)")
      .run(accountA.id, accountA.provider, JSON.stringify({ providerSpecificData: accountA.providerSpecificData }));
    sqlite.exec(`CREATE TRIGGER fail_image_quota_constraint_insert
      BEFORE INSERT ON imageQuotaConstraints BEGIN SELECT RAISE(ABORT, 'injected constraint write failure'); END`);
    const routerRequestId = "984220b8-f6b6-4e88-982f-9be1020e9755";
    const unknown = { ...observation(null), confidence: "unknown", retryAt: null };
    const confirmed = observation(new Date(Date.now() + 300).toISOString());
    for (const [attemptNumber, quota] of [[1, unknown], [2, confirmed]]) {
      await beginImageRequestAttempt({
        routerRequestId,
        attemptNumber,
        provider: accountA.provider,
        model: "gpt-image-2",
        connectionId: accountA.id,
        connection: accountA,
        quotaGroupId: quota.quotaGroupId,
      });
      await finishImageRequestAttempt({
        routerRequestId,
        attemptNumber,
        outcome: "quota_rejected",
        failureClass: "image_quota",
        quotaGroupId: quota.quotaGroupId,
        constraintId: quota.constraintId,
        retryAt: quota.retryAt,
        confidence: quota.confidence,
        quotaObservations: [quota],
        fallbackAction: "try_next_account",
      });
      await expect(recordImageQuotaObservation(accountA, quota, routerRequestId, attemptNumber))
        .resolves.toMatchObject({ constraintId: "usage_limit" });
      if (attemptNumber === 1) await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const state = (await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2")).get(accountA.id);
    expect(state.blockingRows).toMatchObject([{ retryAt: confirmed.retryAt, confidence: "provider_confirmed" }]);
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2"))
      .toMatchObject({ allowed: false, reason: "quota_blocked" });
  });

  it("keeps multiple router calls for one Hualogu operation distinct", async () => {
    const clientOperationId = "84d28c94-ef09-48f9-9c3b-31f2a4c13eac";
    for (const [routerRequestId, model] of [
      ["7c928d8e-f790-42ec-8bdf-2ee049c06f1e", "gemini-3.1-flash-image"],
      ["113b2f43-1b2b-4f6b-a65c-816868d248ae", "gemini-3.1-flash-image"],
    ]) {
      await beginImageRequestAttempt({
        routerRequestId,
        clientOperationId,
        attemptNumber: 1,
        provider: "antigravity",
        model,
        connectionId: `account-${routerRequestId.slice(0, 8)}`,
        quotaGroupId: "antigravity.image_generation",
      });
    }
    const trace = await getImageRequestTrace({ clientOperationId });
    expect(trace.requests).toHaveLength(2);
    expect(trace.requests.every((request) => request.attempts.length === 1)).toBe(true);
    expect(trace.requests.map((request) => request.router_request_id)).toContain("7c928d8e-f790-42ec-8bdf-2ee049c06f1e");
    expect(trace.requests.map((request) => request.router_request_id)).toContain("113b2f43-1b2b-4f6b-a65c-816868d248ae");
  });

  it("preserves dispatched ownership across a file database reopen", async () => {
    temporaryDatabase = mkdtempSync(join(tmpdir(), "image-quota-restart-"));
    const filename = join(temporaryDatabase, "quota.sqlite");
    sqlite.close();
    sqlite = new DatabaseSync(filename);
    adapter = makeAdapter(sqlite);
    imageQuotaMigration.up(adapter);
    imageQuotaManagementMigration.up(adapter);
    imageQuotaDispatchMigration.up(adapter);
    imageRequestAttemptsMigration.up(adapter);
    imageRequestSubmissionsMigration.up(adapter);
    imageQuotaTraceFallbackMigration.up(adapter);
    imageSubmissionQuotaFallbackMigration.up(adapter);
    sqlite.exec("CREATE TABLE providerConnections(id TEXT PRIMARY KEY, provider TEXT, isActive INTEGER, data TEXT)");
    getAdapterMock.mockResolvedValue(adapter);
    const now = Date.now();
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, ?, ?)")
      .run(accountA.id, accountA.provider, 1, JSON.stringify({ providerSpecificData: accountA.providerSpecificData }));
    await recordImageQuotaObservation(accountA, observation(new Date(now - 1_000).toISOString()), "expired-quota");
    const rows = (await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2", now)).get(accountA.id).expiredRows;
    await acquireImageQuotaProbeLeases(accountA, rows, "worker-before-restart", 120_000, now);
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2", "worker-before-restart")).toMatchObject({ allowed: true });
    sqlite.close();
    sqlite = new DatabaseSync(filename);
    adapter = makeAdapter(sqlite);
    getAdapterMock.mockResolvedValue(adapter);
    expect(await acquireImageQuotaProbeLeases(accountA, rows, "worker-after-restart", 120_000, now + 600_000))
      .toMatchObject({ acquired: false });
    const state = (await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2", now + 600_000)).get(accountA.id);
    expect(state.probeInProgressRows[0].probeDispatchedAt).toBeTruthy();
  });

  it("migrates existing reservations without dropping quota locks and is repeatable", async () => {
    sqlite.exec("ALTER TABLE imageQuotaProbeLeases DROP COLUMN dispatchedAt");
    sqlite.prepare(`INSERT INTO imageQuotaProbeLeases
      (provider, supplierIdentity, identityGeneration, quotaGroupId, constraintId, leaseOwner, leaseExpiresAt, createdAt)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?)`).run(
      "codex", imageQuotaIdentity(accountA), "codex.image_generation", "usage_limit", "legacy-worker",
      "2026-10-15T00:02:00.000Z", "2026-10-15T00:00:00.000Z",
    );
    await recordImageQuotaObservation(accountA, observation("2026-10-22T00:00:00.000Z"), "existing-quota");
    imageQuotaDispatchMigration.up(adapter);
    imageQuotaDispatchMigration.up(adapter);
    expect(sqlite.prepare("PRAGMA table_info(imageQuotaProbeLeases)").all().filter((row) => row.name === "dispatchedAt")).toHaveLength(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaConstraints").get().n).toBe(1);
    expect(sqlite.prepare("SELECT dispatchedAt FROM imageQuotaProbeLeases").get().dispatchedAt).toBe("2026-10-15T00:00:00.000Z");
  });

  it("does not admit or take over a dispatched probe after its reservation expires", async () => {
    const now = Date.now();
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, ?, ?)")
      .run(accountA.id, accountA.provider, 1, JSON.stringify({ providerSpecificData: accountA.providerSpecificData }));
    await recordImageQuotaObservation(accountA, observation(new Date(now - 1_000).toISOString()), "expired-quota");
    const rows = (await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2", now)).get(accountA.id).expiredRows;
    await acquireImageQuotaProbeLeases(accountA, rows, "worker-a", 120_000, now);

    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2", "worker-b"))
      .toMatchObject({ allowed: false, reason: "probe_not_owned" });
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2", "worker-a"))
      .toMatchObject({ allowed: true });
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2", "worker-a"))
      .toMatchObject({ allowed: false, reason: "probe_not_owned" });

    const later = now + 600_000;
    expect(await acquireImageQuotaProbeLeases(accountA, rows, "worker-b", 120_000, later))
      .toMatchObject({ acquired: false });
    const pending = (await getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2", later)).get(accountA.id);
    expect(pending.probeInProgressRows).toHaveLength(1);
    expect(pending.probeInProgressRows[0].probeDispatchedAt).toBeTruthy();
    await finishImageQuotaProbe(accountA, rows, "worker-b", { success: true, nowMs: later });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaConstraints").get().n).toBe(1);
    await finishImageQuotaProbe(accountA, rows, "worker-a", { success: true, nowMs: later });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaConstraints").get().n).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaProbeLeases").get().n).toBe(0);
  });

  it("shares constraints only across verified provider account and workspace identity", async () => {
    const sameAccount = {
      id: "connection-b",
      provider: "codex",
      providerSpecificData: { chatgptAccountId: "account-1", workspaceId: "workspace-a" },
    };
    const otherWorkspace = {
      id: "connection-c",
      provider: "codex",
      providerSpecificData: { chatgptAccountId: "account-1", workspaceId: "workspace-b" },
    };
    await recordImageQuotaObservation(accountA, observation("2026-10-17T00:00:00.000Z"), "request-1");

    const state = await getImageQuotaState(
      [accountA, sameAccount, otherWorkspace],
      "codex",
      "image_generation",
      "gpt-image-2",
      Date.parse("2026-10-15T01:00:00.000Z"),
    );

    expect(state.get("connection-a").blockingRows).toHaveLength(1);
    expect(state.get("connection-b").blockingRows).toHaveLength(1);
    expect(state.get("connection-c").blockingRows).toHaveLength(0);
    expect(imageQuotaIdentity(accountA)).toBe("codex:account-1:workspace-a");
  });

  it("returns every model constraint when the status projection has no model filter", async () => {
    await recordImageQuotaObservation({ ...accountA, provider: "antigravity" }, {
      ...observation("2026-10-17T00:00:00.000Z"),
      quotaGroupId: "antigravity.image_generation",
      constraintId: "provider_image_quota",
      model: "gemini-image-model-a",
      appliesToModels: ["gemini-image-model-a"],
    }, "request-image-a");

    const state = await getImageQuotaState(
      [{ ...accountA, provider: "antigravity" }],
      "antigravity",
      "image_generation",
      null,
      Date.parse("2026-10-15T01:00:00.000Z"),
    );

    expect(state.get(accountA.id).blockingRows).toHaveLength(1);
    expect(state.get(accountA.id).blockingRows[0].appliesToModels).toBe('["gemini-image-model-a"]');
  });

  it("keeps a weekly block after a shorter reset and a token-only credential refresh", async () => {
    const hourly = {
      ...observation("2026-10-15T01:00:00.000Z"),
      constraintId: "hourly_image_limit",
      appliesToModels: ["gpt-image-2"],
    };
    const weekly = {
      ...observation("2026-10-22T00:00:00.000Z"),
      constraintId: "weekly_image_limit",
      appliesToModels: ["gpt-image-2"],
    };
    await recordImageQuotaObservation(accountA, hourly, "request-hourly");
    await recordImageQuotaObservation(accountA, weekly, "request-weekly");

    const refreshPatch = prepareQuotaIdentityPatch(accountA, {
      accessToken: "rotated-token",
      providerSpecificData: { accessTokenExpiresAt: "2026-10-15T02:00:00Z" },
    });
    const refreshedAccount = {
      ...accountA,
      ...refreshPatch,
      providerSpecificData: refreshPatch.providerSpecificData,
    };
    const state = (await getImageQuotaState(
      [refreshedAccount],
      "codex",
      "image_generation",
      "gpt-image-2",
      Date.parse("2026-10-15T02:00:00.000Z"),
    )).get(accountA.id);

    expect(state.blockingRows.map((row) => row.constraintId)).toEqual(["weekly_image_limit"]);
    expect(state.expiredRows.map((row) => row.constraintId)).toEqual(["hourly_image_limit"]);
    expect(refreshPatch.providerSpecificData).toMatchObject({
      chatgptAccountId: "account-1",
      workspaceId: "workspace-a",
      imageQuotaIdentityGeneration: 1,
    });
  });

  it("leases one expired reset check and keeps a newer quota observation after a stale success", async () => {
    const now = Date.parse("2026-10-15T01:00:00.000Z");
    const first = await recordImageQuotaObservation(accountA, observation("2026-10-14T23:00:00.000Z"), "request-old");
    const expired = (await getImageQuotaState(
      [accountA], "codex", "image_generation", "gpt-image-2", now,
    )).get(accountA.id).expiredRows;

    const attempts = await Promise.all([
      acquireImageQuotaProbeLeases(accountA, expired, "request-probe", 120_000, now),
      acquireImageQuotaProbeLeases(accountA, expired, "request-other", 120_000, now),
    ]);
    const winnerIndex = attempts.findIndex((attempt) => attempt.acquired);
    const lease = attempts[winnerIndex];
    const competingLease = attempts[1 - winnerIndex];
    const winningOwner = winnerIndex === 0 ? "request-probe" : "request-other";
    expect(lease.acquired).toBe(true);
    expect(competingLease).toMatchObject({ acquired: false, leaseExpiresAt: lease.leaseExpiresAt });

    const newer = await recordImageQuotaObservation(accountA, observation("2026-10-18T00:00:00.000Z"), "request-new");
    await finishImageQuotaProbe(accountA, expired, winningOwner, { success: true, nowMs: now });

    const current = (await getImageQuotaState(
      [accountA], "codex", "image_generation", "gpt-image-2", now,
    )).get(accountA.id).blockingRows;
    expect(first.revision).toBe(1);
    expect(newer.revision).toBe(2);
    expect(current).toHaveLength(1);
    expect(current[0].revision).toBe(2);
  });

  it("does not let a worker clear quota after its expired lease was taken over", async () => {
    const now = Date.now() - 2_000;
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, 1, ?)")
      .run(accountA.id, accountA.provider, JSON.stringify({ providerSpecificData: accountA.providerSpecificData }));
    await recordImageQuotaObservation(accountA, observation("2026-10-14T23:00:00.000Z"), "request-old");
    const expired = (await getImageQuotaState(
      [accountA], "codex", "image_generation", "gpt-image-2", now,
    )).get(accountA.id).expiredRows;

    const firstLease = await acquireImageQuotaProbeLeases(accountA, expired, "worker-a", 1_000, now);
    const takeover = await acquireImageQuotaProbeLeases(accountA, expired, "worker-b", 120_000, now + 1_001);
    expect(firstLease.acquired).toBe(true);
    expect(takeover.acquired).toBe(true);

    await finishImageQuotaProbe(accountA, expired, "worker-a", { success: true, nowMs: now + 1_001 });
    const afterStaleWorker = (await getImageQuotaState(
      [accountA], "codex", "image_generation", "gpt-image-2", now + 1_001,
    )).get(accountA.id);
    expect(afterStaleWorker.expiredRows).toHaveLength(1);
    expect(afterStaleWorker.probeInProgressRows).toMatchObject([
      { constraintId: "usage_limit", probeLeaseExpiresAt: takeover.leaseExpiresAt },
    ]);

    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2", "worker-b"))
      .toMatchObject({ allowed: true });
    await finishImageQuotaProbe(accountA, expired, "worker-b", { success: true, nowMs: now + 1_001 });
    const afterOwnerSuccess = (await getImageQuotaState(
      [accountA], "codex", "image_generation", "gpt-image-2", now + 1_001,
    )).get(accountA.id);
    expect(afterOwnerSuccess.expiredRows).toHaveLength(0);
  });

  it("does not let the lease owner clear quota after its own lease has expired", async () => {
    const now = Date.parse("2026-10-15T01:00:00.000Z");
    await recordImageQuotaObservation(accountA, observation("2026-10-14T23:00:00.000Z"), "request-old");
    const expired = (await getImageQuotaState(
      [accountA], "codex", "image_generation", "gpt-image-2", now,
    )).get(accountA.id).expiredRows;
    const lease = await acquireImageQuotaProbeLeases(accountA, expired, "worker-a", 1_000, now);

    await finishImageQuotaProbe(accountA, expired, "worker-a", { success: true, nowMs: now + 1_001 });
    const state = (await getImageQuotaState(
      [accountA], "codex", "image_generation", "gpt-image-2", now + 1_001,
    )).get(accountA.id);
    expect(lease.acquired).toBe(true);
    expect(state.expiredRows).toHaveLength(1);
    expect(state.probeInProgressRows).toHaveLength(0);
  });

  it("projects an active persisted recovery lease as probe in progress", async () => {
    const now = Date.parse("2026-10-15T01:00:00.000Z");
    await recordImageQuotaObservation(accountA, observation("2026-10-14T23:00:00.000Z"), "request-old");
    const expired = (await getImageQuotaState(
      [accountA], "codex", "image_generation", "gpt-image-2", now,
    )).get(accountA.id).expiredRows;
    const lease = await acquireImageQuotaProbeLeases(accountA, expired, "request-probe", 120_000, now);

    const state = (await getImageQuotaState(
      [accountA], "codex", "image_generation", "gpt-image-2", now,
    )).get(accountA.id);

    expect(lease.acquired).toBe(true);
    expect(state.probeInProgressRows).toMatchObject([
      { constraintId: "usage_limit", probeLeaseExpiresAt: lease.leaseExpiresAt },
    ]);
  });

  it("refuses quota persistence on a non-durable sql.js adapter", async () => {
    getAdapterMock.mockResolvedValue({ ...adapter, driver: "sql.js" });
    await expect(getImageQuotaState([accountA], "codex", "image_generation", "gpt-image-2"))
      .rejects.toMatchObject({ code: "IMAGE_QUOTA_STORE_UNAVAILABLE" });
  });

  it("commits scoped pause/resume with audit and idempotency, then admits only the resumed account", async () => {
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, ?, ?)")
      .run(accountA.id, accountA.provider, 1, JSON.stringify({ providerSpecificData: accountA.providerSpecificData }));

    const pause = await writeImageQuotaPolicy({
      connection: accountA,
      capability: "image_generation",
      quotaGroupId: "codex.image_generation",
      action: "pause",
      reason: "Temporarily hold this image pool",
      principal: "dashboard:operator",
      idempotencyKey: "pause-key",
      requestHash: "pause-hash",
      expectedRevision: 0,
    });
    expect(pause).toMatchObject({ policyState: "paused", revision: 1, replayed: false });
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2"))
      .toMatchObject({ allowed: false, reason: "manual_paused" });

    const replay = await writeImageQuotaPolicy({
      connection: accountA,
      capability: "image_generation",
      quotaGroupId: "codex.image_generation",
      action: "pause",
      reason: "Temporarily hold this image pool",
      principal: "dashboard:operator",
      idempotencyKey: "pause-key",
      requestHash: "pause-hash",
      expectedRevision: 0,
    });
    expect(replay).toMatchObject({ policyState: "paused", revision: 1, replayed: true });

    await expect(writeImageQuotaPolicy({
      connection: accountA,
      capability: "image_generation",
      quotaGroupId: "codex.image_generation",
      action: "resume",
      principal: "dashboard:operator",
      idempotencyKey: "pause-key",
      requestHash: "different-body",
      expectedRevision: 1,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    const resume = await writeImageQuotaPolicy({
      connection: accountA,
      capability: "image_generation",
      quotaGroupId: "codex.image_generation",
      action: "resume",
      reason: "Upstream support confirmed the image route",
      principal: "dashboard:operator",
      idempotencyKey: "resume-key",
      requestHash: "resume-hash",
      expectedRevision: 1,
    });
    expect(resume).toMatchObject({ policyState: "enabled", revision: 2, replayed: false });
    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2"))
      .toMatchObject({ allowed: true, reason: null });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaPolicyAudit").get().n).toBe(2);
  });

  it("keeps an automatic quota block when an operator resumes the account", async () => {
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, ?, ?)")
      .run(accountA.id, accountA.provider, 1, JSON.stringify({ providerSpecificData: accountA.providerSpecificData }));
    await recordImageQuotaObservation(accountA, observation(new Date(Date.now() + 86_400_000).toISOString()), "request-quota");

    await writeImageQuotaPolicy({
      connection: accountA,
      capability: "image_generation",
      quotaGroupId: "codex.image_generation",
      action: "pause",
      reason: "Operator review in progress",
      principal: "dashboard:operator",
      idempotencyKey: "quota-pause-key",
      requestHash: "quota-pause-hash",
      expectedRevision: 0,
    });
    await writeImageQuotaPolicy({
      connection: accountA,
      capability: "image_generation",
      quotaGroupId: "codex.image_generation",
      action: "resume",
      reason: "Resume manual hold only",
      principal: "dashboard:operator",
      idempotencyKey: "quota-resume-key",
      requestHash: "quota-resume-hash",
      expectedRevision: 1,
    });

    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2"))
      .toMatchObject({ allowed: false, reason: "quota_blocked" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM imageQuotaConstraints WHERE state = 'blocked'").get().n).toBe(1);
  });

  it("does not admit a selected credential after its connection identity changes", async () => {
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, ?, ?)")
      .run(accountA.id, accountA.provider, 1, JSON.stringify({
        providerSpecificData: { chatgptAccountId: "replacement-account" },
      }));

    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2"))
      .toMatchObject({ allowed: false, reason: "connection_changed" });
  });

  it("rechecks the selected model against the latest connection configuration", async () => {
    sqlite.prepare("INSERT INTO providerConnections(id, provider, isActive, data) VALUES (?, ?, ?, ?)")
      .run(accountA.id, accountA.provider, 1, JSON.stringify({
        providerSpecificData: {
          ...accountA.providerSpecificData,
          enabledModels: ["gpt-5.5"],
        },
      }));

    expect(await admitImageQuotaRequest(accountA, "image_generation", "gpt-image-2"))
      .toMatchObject({ allowed: false, reason: "model_not_enabled" });
  });
});
