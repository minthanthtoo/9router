import test from "node:test";
import assert from "node:assert/strict";
import { calculateCostFromTokens, getPricingForModel, mergePricingOverride } from "../../open-sse/providers/pricing.js";

const MODEL = "gemini-3.1-flash-image";

test("Gemini 3.1 Flash Image uses separate standard image and text output rates", () => {
  const pricing = getPricingForModel("gemini", MODEL);

  assert.equal(pricing.input, 0.5);
  assert.equal(pricing.output, 3);
  assert.equal(pricing.image_output, 60);
  assert.equal(pricing.reasoning, 3);
  assert.equal(pricing.reasoning, 3);
});

test("Gemini image usage prices reported image tokens separately from text tokens", () => {
  const pricing = getPricingForModel("gemini", MODEL);
  const cost = calculateCostFromTokens({
    prompt_tokens: 20,
    completion_tokens: 1300,
    reasoning_tokens: 10,
    completion_tokens_details: [{ modality: "IMAGE", tokenCount: 1120 }],
  }, pricing);

  assert.ok(Math.abs(cost - 0.06778) < 1e-12);
});

test("Gemini image usage falls back to the image rate when modality details are missing", () => {
  const pricing = getPricingForModel("gemini", MODEL);
  const cost = calculateCostFromTokens({
    prompt_tokens: 20,
    completion_tokens: 1300,
    reasoning_tokens: 10,
  }, pricing);

  assert.ok(Math.abs(cost - 0.07804) < 1e-12);
});

test("Gemini image usage falls back conservatively when image-token details are malformed", () => {
  const pricing = getPricingForModel("gemini", MODEL);
  const cost = calculateCostFromTokens({
    prompt_tokens: 20,
    completion_tokens: 1300,
    reasoning_tokens: 10,
    completion_tokens_details: [{ modality: "IMAGE", tokenCount: "1120" }],
  }, pricing);

  assert.ok(Math.abs(cost - 0.07804) < 1e-12);
});

test("Gemini image admin overrides retain default modality rates", () => {
  const defaults = getPricingForModel("gemini", MODEL);
  const pricing = mergePricingOverride(defaults, { input: 0.6, output: 5 });
  const cost = calculateCostFromTokens({
    prompt_tokens: 20,
    completion_tokens: 1300,
    completion_tokens_details: [{ modality: "IMAGE", tokenCount: 1120 }],
  }, pricing);

  assert.equal(pricing.input, 0.6);
  assert.equal(pricing.output, 5);
  assert.equal(pricing.image_output, 60);
  assert.ok(Math.abs(cost - 0.068112) < 1e-12);
});

test("Gemini text model pricing remains on its existing text-token rate", () => {
  const pricing = getPricingForModel("gemini", "gemini-3.5-flash-lite");
  const cost = calculateCostFromTokens({ prompt_tokens: 100, completion_tokens: 10 }, pricing);

  assert.ok(Math.abs(cost - 0.000055) < 1e-15);
});
