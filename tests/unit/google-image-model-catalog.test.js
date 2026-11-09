import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { MODEL_PRICING } from "../../open-sse/providers/pricing.js";

describe("Google Gemini image model catalog lifecycle", () => {
  const imageModelIds = (PROVIDER_MODELS.gemini || [])
    .filter((model) => model.kind === "image")
    .map((model) => model.id);

  it("does not advertise Gemini image preview models shut down by Google", () => {
    for (const modelId of ["gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview"]) {
      expect(imageModelIds).not.toContain(modelId);
      expect(MODEL_PRICING[`google/${modelId}`]).toBeUndefined();
    }
  });

  it("keeps the still-supported Gemini 2.5 Flash Image model listed", () => {
    expect(imageModelIds).toContain("gemini-2.5-flash-image");
  });
});
