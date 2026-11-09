import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { transform } from "esbuild";
import { estimateLabel, imageCount, selectImageLearning, hasImage429Evidence } from "../../src/app/(dashboard)/dashboard/quota/imageLearningDisplay.mjs";

const root = new URL("../../src/app/(dashboard)/dashboard/", import.meta.url);
const source = (file) => readFileSync(new URL(file, root), "utf8");

describe("image account model evidence", () => {
  const row = { learning: { counts: { calls24h: 9, callsTotal: 90 }, models: [
    { model: "image-a", counts: { calls24h: 3, callsTotal: 30 }, estimate: { state: "estimated", windowSeconds: 3600, callLimit: 12, confidence: "low" } },
    { model: "image-b", counts: { calls24h: 6, callsTotal: 60 }, estimate: { state: "learning" } },
  ] } };
  it("keeps exact model counts distinct from account totals", () => {
    expect(selectImageLearning(row).counts.callsTotal).toBe(90);
    expect(selectImageLearning(row, "image-a").counts.callsTotal).toBe(30);
    expect(selectImageLearning(row, "image-a").models.map((entry) => entry.model)).toEqual(["image-a"]);
    expect(selectImageLearning(row, "missing").counts).toBeUndefined();
    expect(selectImageLearning(row, "missing").models).toEqual([]);
    expect(selectImageLearning(row).estimate).toBeNull();
  });
  it("labels a next check as 429 only when its timestamp matches rejection evidence", () => {
    const oldRetry = "2026-11-02T10:00:00Z";
    const localDeadline = "2026-11-02T12:00:00Z";
    const models = [{ last429: { retryAt: oldRetry } }];
    expect(hasImage429Evidence(localDeadline, models)).toBe(false);
    expect(hasImage429Evidence(oldRetry, models)).toBe(true);
    expect(hasImage429Evidence("2026-11-02T10:00:00.000Z", models)).toBe(true);
    expect(hasImage429Evidence(null, models)).toBe(false);
    expect(hasImage429Evidence("invalid", [{ last429: { retryAt: "invalid" } }])).toBe(false);
    expect(hasImage429Evidence(localDeadline, [], [{ source: "local_policy", retryAt: localDeadline }])).toBe(false);
    expect(hasImage429Evidence(localDeadline, [], [{ source: "provider_429", retryAt: localDeadline }])).toBe(true);
    expect(hasImage429Evidence(localDeadline, [], [{ httpStatus: 429, retryAt: localDeadline }])).toBe(true);
    expect(hasImage429Evidence(localDeadline, [], [{ source: "provider_429", state: "probe_in_progress", retryAt: localDeadline }])).toBe(false);
  });
  it("does not invent quota or allow an incomplete estimate to look established", () => {
    expect(estimateLabel(row.learning.models[0].estimate)).toBe("Estimated 12 requests / 1h · low confidence");
    for (const estimate of [null, { state: "ambiguous", callLimit: 12, windowSeconds: 3600 }, { state: "estimated", windowSeconds: 3600 }, { state: "learning" }]) {
      expect(estimateLabel(estimate)).toBe("Not enough history");
    }
    expect(imageCount(0)).toBe("0");
    expect(imageCount(undefined)).toBe("—");
    expect(imageCount(-1)).toBe("—");
  });
});

// Mounted controls, revision fencing and lazy activity are covered in rotation/image-controls-ui.test.mjs.
describe("image card entry points", () => {
  it("compiles the shared card and management JSX", async () => {
    for (const file of ["quota/ImageAccountCard.js", "quota/ImageManagementDialog.js", "quota/ImageQuotaPanel.js", "quota/page.js", "usage/components/ProviderLimits/index.js"]) {
      const result = await transform(source(file), { loader: "jsx", jsx: "automatic", sourcefile: file });
      expect(result.code).toBeTruthy();
    }
  });
});
