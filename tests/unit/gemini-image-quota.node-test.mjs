import test from "node:test";
import assert from "node:assert/strict";
import { classifyImageQuotaError } from "../../open-sse/handlers/imageProviders/quotaErrors.js";
import {
  imageQuotaIdentity,
  imageQuotaIdentityGeneration,
  imageQuotaIdentityType,
} from "../../src/lib/db/repos/imageQuotaIdentity.js";
import { isValidGeminiProjectId, normalizeGeminiProjectId } from "../../src/lib/geminiProjectId.js";

const MODEL = "gemini-3.1-flash-image";
const NOW = Date.parse("2026-10-16T16:00:00.000Z");

function violation(quotaId, quotaMetric, model = MODEL) {
  return {
    quotaId,
    quotaMetric,
    quotaDimensions: { model, location: "global" },
    quotaValue: "10",
  };
}

function quotaFailureBody(violations, retryDelay = "30s") {
  return JSON.stringify({ error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    details: [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
    ],
  } });
}

test("Gemini quota classifier retains simultaneous model-scoped constraints and reset times", () => {
  const observation = classifyImageQuotaError({
    provider: "gemini",
    status: 429,
    model: MODEL,
    now: NOW,
    bodyText: quotaFailureBody([
      violation("GenerateRequestsPerMinutePerProjectPerModel-Standard", "generativelanguage.googleapis.com/generate_content_paid_tier_requests"),
      violation("GenerateRequestsPerDayPerProjectPerModel-Standard", "generativelanguage.googleapis.com/generate_content_paid_tier_requests"),
      violation("GenerateContentInputTokensPerModelPerMinute-Standard", "generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count", "gemini-3-pro-image"),
    ]),
  });

  assert.equal(observation.quotaGroupId, "gemini_api.image_generation");
  assert.equal(observation.constraints.length, 2);
  assert.equal(new Set(observation.constraints.map((row) => row.constraintId)).size, 2);
  assert.ok(observation.constraints.every((row) => row.appliesToModels[0] === MODEL));
  assert.ok(observation.constraints.every((row) => row.confidence === "provider_confirmed"));
  assert.ok(observation.constraints.some((row) => row.retryAt === new Date(NOW + 30_000).toISOString()));
  assert.ok(observation.constraints.some((row) => row.retryAt === "2026-10-17T07:00:00.000Z"));
  assert.equal(observation.retryAt, "2026-10-17T07:00:00.000Z");
  assert.deepEqual(observation.appliesToModels, [MODEL]);
});

test("Gemini generic 429, unrelated metrics, and model-mismatched details do not create quota locks", () => {
  assert.equal(classifyImageQuotaError({
    provider: "gemini",
    status: 429,
    model: MODEL,
    now: NOW,
    bodyText: JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "retry later" } }),
  }), null);

  const unrelated = classifyImageQuotaError({
    provider: "gemini",
    status: 429,
    model: MODEL,
    now: NOW,
    bodyText: quotaFailureBody([
      violation("SomeRequestsPerMinutePerProject", "other.googleapis.com/requests"),
      violation("GenerateRequestsPerMinutePerProjectPerModel-Standard", "generativelanguage.googleapis.com/generate_content_paid_tier_requests", "gemini-3-pro-image"),
    ]),
  });
  assert.equal(unrelated, null);
});

test("Gemini quota windows without provider retry timing remain explicitly estimated", () => {
  const observation = classifyImageQuotaError({
    provider: "gemini",
    status: 429,
    model: MODEL,
    now: NOW,
    bodyText: JSON.stringify({ error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      details: [{
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [violation("GenerateRequestsPerMinutePerProjectPerModel-Standard", "generativelanguage.googleapis.com/generate_content_paid_tier_requests")],
      }],
    } }),
  });
  assert.equal(observation.constraints[0].confidence, "estimated");
  assert.equal(observation.constraints[0].source, "gemini_quota_window_estimate");
  assert.equal(observation.constraints[0].retryAt, new Date(NOW + 60_000).toISOString());
});

test("Gemini API keys in the same project share one stable quota identity", () => {
  const first = {
    id: "key-one",
    provider: "gemini",
    providerSpecificData: { googleCloudProjectId: "hualugo-images-prod", imageQuotaIdentityGeneration: 1 },
  };
  const second = {
    id: "key-two",
    provider: "gemini",
    providerSpecificData: { googleCloudProjectId: "hualugo-images-prod", imageQuotaIdentityGeneration: 9 },
  };
  const otherProject = {
    id: "key-three",
    provider: "gemini",
    providerSpecificData: { googleCloudProjectId: "hualugo-images-backup" },
  };

  assert.equal(imageQuotaIdentity(first), imageQuotaIdentity(second));
  assert.equal(imageQuotaIdentity(second), imageQuotaIdentity({
    id: "key-four",
    provider: "gemini",
    providerSpecificData: { googleCloudProjectId: "HUALUGO-IMAGES-PROD" },
  }));
  assert.equal(imageQuotaIdentityGeneration(second), 1);
  assert.notEqual(imageQuotaIdentity(first), imageQuotaIdentity(otherProject));
  assert.equal(imageQuotaIdentityType(first), "operator_configured");
  assert.notEqual(imageQuotaIdentity({ id: "key-one", provider: "gemini" }), imageQuotaIdentity({ id: "key-two", provider: "gemini" }));
  assert.equal(imageQuotaIdentityType({
    id: "key-five",
    provider: "gemini",
    providerSpecificData: { verifiedQuotaIdentity: { verified: true, namespace: "custom", value: "shared" } },
  }), "connection_local");
});

test("Gemini project identity accepts canonical IDs or numbers and rejects malformed input", () => {
  assert.equal(normalizeGeminiProjectId(" HUALUGO-IMAGES-PROD "), "hualugo-images-prod");
  assert.equal(normalizeGeminiProjectId("123456789012"), "123456789012");
  assert.equal(isValidGeminiProjectId("short"), false);
  assert.equal(isValidGeminiProjectId("-invalid-project"), false);
  assert.equal(isValidGeminiProjectId("invalid-project-"), false);
  assert.equal(isValidGeminiProjectId("project id with spaces"), false);
});

test("Gemini daily reset calculation follows Pacific daylight time changes", () => {
  const nowBeforeFallback = Date.parse("2026-11-01T07:30:00.000Z");
  const observation = classifyImageQuotaError({
    provider: "gemini",
    status: 429,
    model: MODEL,
    now: nowBeforeFallback,
    bodyText: quotaFailureBody([
      violation("GenerateRequestsPerDayPerProjectPerModel-Standard", "generativelanguage.googleapis.com/generate_content_paid_tier_requests"),
    ]),
  });
  assert.equal(observation.constraints[0].retryAt, "2026-11-02T08:00:00.000Z");
});

test("Gemini quota without explicit model scope applies conservatively to the project group", () => {
  const observation = classifyImageQuotaError({
    provider: "gemini",
    status: 429,
    model: MODEL,
    now: NOW,
    bodyText: JSON.stringify({ error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      details: [{
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [{
          quotaId: "RequestsPer10MinutesPerProject-Standard",
          quotaMetric: "generativelanguage.googleapis.com/generate_content_paid_tier_requests",
          quotaDimensions: { location: "global" },
        }],
      }],
    } }),
  });
  assert.deepEqual(observation.constraints[0].appliesToModels, ["*"]);
  assert.deepEqual(observation.appliesToModels, ["*"]);
  assert.equal(observation.constraints[0].retryAt, new Date(NOW + 10 * 60_000).toISOString());
});
