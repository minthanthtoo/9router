import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let runs;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-admin-image-runs-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  runs = await import("@/lib/db/repos/adminImageTestRuns.js");
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("admin image test run recovery", () => {
  it("releases the run on close but keeps only the uncertain account/model held", async () => {
    const targetA = { connectionId: "account-a", provider: "codex", model: "image-a", quotaKey: "shared-a" };
    const targetB = { connectionId: "account-b", provider: "codex", model: "image-b", quotaKey: "shared-b" };
    const run = await runs.createAdminImageRun("operator", "close-held-run-0001", [targetA, targetB]);
    const claim = await runs.claimAdminImageItem("worker-a");
    expect(claim?.runId).toBe(run.id);

    const held = await runs.finishAdminImageItem(run.id, claim.item.operationId, "worker-a", {
      ok: false,
      outcomeUnknown: true,
      message: "Provider accepted the request but the result was not recorded.",
    });
    expect(held.state).toBe("needs_review");

    const closed = await runs.controlAdminImageRun(run.id, "close", held.revision);
    expect(closed.state).toBe("cancelled");
    expect(await runs.readUnresolvedImageTargets()).toMatchObject([
      { connectionId: targetA.connectionId, model: targetA.model, runId: run.id },
    ]);
    await expect(runs.assertImageTargetResolved(targetA.connectionId, targetA.model))
      .rejects.toMatchObject({ code: "target_outcome_unconfirmed" });
    await expect(runs.assertImageTargetResolved(targetB.connectionId, targetB.model)).resolves.toBeUndefined();
    await expect(runs.createAdminImageRun("operator", "new-eligible-run-0001", [targetB]))
      .resolves.toMatchObject({ state: "queued" });
  });
});
