import test from "node:test";
import assert from "node:assert/strict";
import { getImageQuotaConstraintDisplay } from "../../src/app/(dashboard)/dashboard/quota/constraintDisplay.mjs";
import { getQuotaUsageDisplay } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaUsageDisplay.mjs";

test("image quota UI reports effective wildcard scope separately from the triggering model", () => {
  assert.deepEqual(getImageQuotaConstraintDisplay({
    model: "gemini-3.1-flash-image",
    appliesToModels: ["*"],
  }), {
    effectiveScope: "All image models",
    observedModel: "gemini-3.1-flash-image",
  });
});

test("image quota UI preserves a reported model-specific restriction scope", () => {
  assert.deepEqual(getImageQuotaConstraintDisplay({
    model: "gemini-3.1-flash-image",
    appliesToModels: ["gemini-3.1-flash-image"],
  }), {
    effectiveScope: "gemini-3.1-flash-image",
    observedModel: "gemini-3.1-flash-image",
  });
});

test("normalized Antigravity quota counters are not described as request counts", () => {
  const display = getQuotaUsageDisplay({
    used: 150,
    total: 1000,
    displayUnit: "normalized_percentage",
    remainingPercentage: 85,
  });
  assert.match(display.text, /request count unavailable/i);
  assert.match(display.title, /not a provider request count/i);
});

test("missing image quota fraction is displayed as unknown", () => {
  assert.equal(getQuotaUsageDisplay({ quotaStatus: "unknown" }).text, "Quota status unknown");
});
