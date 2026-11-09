import { describe, expect, it } from "vitest";
import {
  getConnectionsEmptyMessage,
  areAllReportedQuotasDepleted,
  filterQuotasByVisibility,
  hasReportedQuotaAvailable,
  getHiddenQuotaRows,
  parseQuotaData,
  getRemainingPercentage,
  trimHiddenQuotaKeys,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("provider quota visibility", () => {
  it("does not describe missing OAuth quota accounts as no connected providers", () => {
    const message = getConnectionsEmptyMessage({ eligibleConnections: 0 }, "all", "all");
    expect(message.title).toBe("No Supported OAuth Quota Accounts");
    expect(message.description).toContain("API-key image routing status is shown separately above");
  });

  const data = {
    quotas: {
      "gemini-pro-agent": {
        displayName: "Gemini 3.1 Pro (High)",
        used: 200,
        total: 1000,
        resetAt: "2026-07-04T00:00:00Z",
        remainingPercentage: 80,
      },
      "claude-opus-4-6-thinking": {
        displayName: "Claude Opus 4.6 (Thinking)",
        used: 100,
        total: 1000,
        resetAt: "2026-07-04T00:00:00Z",
        remainingPercentage: 90,
      },
    },
  };

  it("groups Antigravity model quotas into Gemini and Claude families", () => {
    const quotas = parseQuotaData("antigravity", data);
    expect(quotas.map((q) => q.modelKey)).toEqual([
      "gemini",
      "claude",
    ]);
    expect(quotas[0].name).toBe("Gemini (Flash / Pro)");
    expect(quotas[1].name).toBe("Claude (Sonnet / Opus)");
  });

  it("preserves normalized display units on the standalone Gemini image row", () => {
    const quotas = parseQuotaData("antigravity", {
      quotas: {
        "gemini-3.1-flash-image": {
          displayName: "Gemini 3.1 Flash Image",
          used: 580,
          total: 1000,
          remainingPercentage: 42,
          displayUnit: "normalized_percentage",
        },
      },
    });

    expect(quotas).toMatchObject([{
      name: "Gemini 3.1 Flash Image",
      displayUnit: "normalized_percentage",
    }]);
  });

  it("converts provider-reported used percentages to remaining headroom", () => {
    const [usedPercentage] = parseQuotaData("quota-test", {
      quotas: { request: { percentage: 83, percentageIsUsed: true } },
    });
    const [remainingPercentage] = parseQuotaData("quota-test", {
      quotas: { request: { percentage: 83 } },
    });

    expect(getRemainingPercentage(usedPercentage)).toBe(17);
    expect(getRemainingPercentage(remainingPercentage)).toBe(83);
    expect(getRemainingPercentage({ quotaStatus: "unknown", percentage: 83 })).toBeNull();
  });

  it("shows all quotas by default and hides configured provider rows", () => {
    const quotas = parseQuotaData("antigravity", data);
    expect(filterQuotasByVisibility("antigravity", quotas, {})).toHaveLength(2);

    const visibility = {
      antigravity: { hidden: ["claude"] },
    };
    const visible = filterQuotasByVisibility("antigravity", quotas, visibility);
    const hidden = getHiddenQuotaRows("antigravity", quotas, visibility);

    expect(visible.map((q) => q.modelKey)).toEqual(["gemini"]);
    expect(hidden.map((q) => q.modelKey)).toEqual(["claude"]);
  });

  it("trims stale or obsolete model keys", () => {
    const quotas = parseQuotaData("antigravity", data);
    const trimmed = trimHiddenQuotaKeys(["claude", "stale-model-xyz", "gemini-3.8-flash-low"], quotas);
    expect(trimmed).toEqual(["claude"]);

    const visibility = {
      antigravity: { hidden: ["claude", "stale-model-xyz"] },
    };
    const visible = filterQuotasByVisibility("antigravity", quotas, visibility);
    const hidden = getHiddenQuotaRows("antigravity", quotas, visibility);

    expect(visible.map((q) => q.modelKey)).toEqual(["gemini"]);
    expect(hidden.map((q) => q.modelKey)).toEqual(["claude"]);
  });

  it("does not apply one provider hidden list to another provider", () => {
    const quotas = parseQuotaData("antigravity", data);
    const visibility = {
      codex: { hidden: ["gemini"] },
    };
    expect(filterQuotasByVisibility("antigravity", quotas, visibility)).toHaveLength(2);
  });

  it("does not globally disable a connection while any reported capability has quota", () => {
    const quotas = [
      { name: "Gemini text", used: 100, total: 100 },
      { name: "Gemini image", used: 0, total: 100 },
    ];

    expect(areAllReportedQuotasDepleted(quotas)).toBe(false);
    expect(hasReportedQuotaAvailable(quotas)).toBe(true);
  });

  it("disables only when all quota rows are known and depleted", () => {
    expect(areAllReportedQuotasDepleted([
      { name: "Gemini text", used: 100, total: 100 },
      { name: "Gemini image", used: 98, total: 100 },
    ])).toBe(true);
    expect(areAllReportedQuotasDepleted([
      { name: "Gemini text", used: 100, total: 100 },
      { name: "Gemini image", used: 0, total: 0 },
    ])).toBe(false);
    expect(areAllReportedQuotasDepleted([])).toBe(false);
  });
});
