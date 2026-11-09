// Verify schema migration chain runs correctly across versions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mig-"));
  process.env.DATA_DIR = tempDir;
  // Reset global singleton so each test gets fresh adapter pointed at tempDir
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  // Close adapter to release file handles before rm
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Schema migrations", () => {
  it("fresh DB → applies migrations & stamps schemaVersion", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const { SCHEMA_VERSION } = await import("@/lib/db/schema.js");
    expect(SCHEMA_VERSION).toBe(latestVersion());
    const db = await getAdapter();
    const row = db.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const tables = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map(t => t.name);
    expect(tables).toEqual(expect.arrayContaining([
      "_meta", "settings", "providerConnections", "providerNodes",
      "proxyPools", "apiKeys", "combos", "kv", "usageHistory", "usageDaily", "requestDetails",
    ]));
  });

  it("existing DB at older schemaVersion → re-applies pending migrations on restart", async () => {
    // 1st boot
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, ['{"foo":"bar"}']);
    db.run(`UPDATE _meta SET value = '0' WHERE key = 'schemaVersion'`);
    db.close?.();

    // 2nd boot: full reset to simulate process restart
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db2 = await getAdapter2();
    const row = db2.get(`SELECT value FROM _meta WHERE key='schemaVersion'`);
    expect(parseInt(row.value, 10)).toBe(latestVersion());

    const settings = db2.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "bar" });
  });

  it("reapplies supplier exposure migration without clearing quota locks or open exposure", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const timestamp = "2030-01-01T00:00:00.000Z";
    db.run(
      `INSERT INTO imageQuotaConstraints
        (provider, supplierIdentity, identityGeneration, capability, quotaGroupId, constraintId,
         observedModel, appliesToModels, state, confidence, observedAt, retryAt, source, revision, updatedAt)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'quota_blocked', 'confirmed', ?, ?, 'provider_rejection', 1, ?)`,
      ["gemini", "project-a", "image_generation", "five-hour", "hourly", "gemini-image-model", '["gemini-image-model"]', timestamp, timestamp, timestamp],
    );
    db.run(
      `INSERT INTO imageQuotaPolicies
        (provider, supplierIdentity, identityGeneration, capability, quotaGroupId, policyState, revision, updatedBy, updatedAt)
       VALUES (?, ?, 1, ?, ?, 'paused', 1, 'test', ?)`,
      ["gemini", "project-a", "image_generation", "five-hour", timestamp],
    );
    db.run(
      `INSERT INTO imageSupplierBudgets
        (id, scopeType, scopeKey, currency, scale, enabled, revision, pricingPolicyVersion,
         dailyLimitMicrousd, monthlyLimitMicrousd, pilotLimitMicrousd, maxSubmissionMicrousd,
         pilotId, pilotStartsAt, pilotEndsAt, createdAt, updatedAt)
       VALUES (?, 'billing_project', ?, 'USD', 6, 1, 1, ?, 1000000, 10000000, 1000000, 100000, ?, ?, ?, ?, ?)`,
      ["budget-a", "project-a", "pricing-v1", "pilot-a", timestamp, "2030-01-08T00:00:00.000Z", timestamp, timestamp],
    );
    db.run(
      `INSERT INTO imageSupplierExposureAllocations
        (submissionId, budgetId, pilotId, pricingVersion, pricingDigest, priceShapeJson, currency, scale,
         reservedMaxMicrousd, state, dispatchDay, dispatchMonth, reservedAt, revision, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, 'USD', 6, 75000, 'open', '2030-01-01', '2030-01', ?, 1, ?)`,
      ["submission-unknown", "budget-a", "pilot-a", "pricing-v1", "digest", '{"model":"gemini-image-model"}', timestamp, timestamp],
    );
    db.run(`UPDATE _meta SET value = '10' WHERE key = 'schemaVersion'`);
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const { latestVersion } = await import("@/lib/db/migrations/index.js");
    const db2 = await getAdapter2();

    expect(Number(db2.get(`SELECT value FROM _meta WHERE key = 'schemaVersion'`).value)).toBe(latestVersion());
    expect(db2.get(`SELECT state, retryAt FROM imageQuotaConstraints WHERE constraintId = 'hourly'`))
      .toEqual({ state: "quota_blocked", retryAt: timestamp });
    expect(db2.get(`SELECT policyState FROM imageQuotaPolicies WHERE quotaGroupId = 'five-hour'`))
      .toEqual({ policyState: "paused" });
    expect(db2.get(`SELECT enabled FROM imageSupplierBudgets WHERE id = 'budget-a'`))
      .toEqual({ enabled: 1 });
    expect(db2.get(`SELECT state, reservedMaxMicrousd FROM imageSupplierExposureAllocations WHERE submissionId = 'submission-unknown'`))
      .toEqual({ state: "open", reservedMaxMicrousd: 75000 });
  });

  it("fresh DB + legacy db.json → imports data automatically", async () => {
    // Simulate user upgrading: place legacy JSON in DATA_DIR before first boot
    const legacy = {
      settings: { foo: "legacy-value" },
      apiKeys: [{ id: "k1", key: "abc", name: "test", createdAt: new Date().toISOString() }],
      modelAliases: { "gpt-4": "gpt-4-turbo" },
    };
    fs.writeFileSync(path.join(tempDir, "db.json"), JSON.stringify(legacy));

    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();

    const settings = db.get(`SELECT data FROM settings WHERE id=1`);
    expect(JSON.parse(settings.data)).toEqual({ foo: "legacy-value" });

    const keys = db.all(`SELECT * FROM apiKeys`);
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toBe("abc");

    const aliases = db.all(`SELECT * FROM kv WHERE scope='modelAliases'`);
    expect(aliases).toHaveLength(1);
  });

  it("auto-sync re-creates missing index when DB lacks it", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.exec(`DROP INDEX IF EXISTS idx_pn_type`);
    expect(db.all(`PRAGMA index_list(providerNodes)`).map(i => i.name)).not.toContain("idx_pn_type");
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapter2 } = await import("@/lib/db/driver.js");
    const db2 = await getAdapter2();
    const idx = db2.all(`PRAGMA index_list(providerNodes)`).map(i => i.name);
    expect(idx).toContain("idx_pn_type");
  });
});
