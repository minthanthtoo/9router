import test from "node:test";
import assert from "node:assert/strict";
import gemini from "../../open-sse/handlers/imageProviders/gemini.js";
import { PROVIDER_MODELS } from "../../open-sse/providers/index.js";

const IMAGE_A = "data:image/png;base64,aGVsbG8=";
const IMAGE_B = "data:image/jpeg;base64,d29ybGQ=";

test("Gemini image catalog exposes the stable Developer API image model", () => {
  const imageModels = (PROVIDER_MODELS.gemini || []).filter((model) => model.kind === "image");
  assert.ok(imageModels.some((model) => model.id === "gemini-3.1-flash-image"));
  assert.ok(!imageModels.some((model) => model.id === "gemini-3.1-flash-image-preview"));
});

test("Gemini image API key is sent in a header, never in the request URL", () => {
  const url = gemini.buildUrl("models/gemini-3.1-flash-image");
  const headers = gemini.buildHeaders({ apiKey: "test-key-value" });

  assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent");
  assert.equal(new URL(url).search, "");
  assert.equal(headers["x-goog-api-key"], "test-key-value");
  assert.equal(headers.Authorization, undefined);
  assert.throws(() => gemini.buildHeaders({ accessToken: "oauth-token" }), /API key is required/);
});

test("Gemini image request maps Hualogu generate and edit inputs to inlineData", () => {
  const body = gemini.buildBody("gemini-3.1-flash-image", {
    prompt: "Change the background",
    size: "1024x1024",
    image: IMAGE_A,
    images: [IMAGE_B],
  });

  assert.deepEqual(body.contents[0].parts, [
    { text: "Change the background" },
    { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
    { inlineData: { mimeType: "image/jpeg", data: "d29ybGQ=" } },
  ]);
  assert.deepEqual(body.generationConfig, {
    responseModalities: ["TEXT", "IMAGE"],
    imageConfig: { aspectRatio: "1:1", imageSize: "1K" },
  });
});

test("Gemini image requests preserve explicit aspect ratio and resolution", () => {
  const body = gemini.buildBody("gemini-3.1-flash-image", {
    prompt: "A wide landscape",
    aspect_ratio: "21:9",
    image_size: "2K",
  });
  assert.deepEqual(body.generationConfig.imageConfig, { aspectRatio: "21:9", imageSize: "2K" });
  assert.throws(() => gemini.buildBody("gemini-3.1-flash-image", {
    prompt: "A landscape", aspect_ratio: "7:3",
  }), /aspect ratio/);
  assert.throws(() => gemini.buildBody("gemini-3.1-flash-image", {
    prompt: "A landscape", image_size: "8K",
  }), /image_size/);
});

test("Gemini image adapter rejects non-inline edit references rather than silently dropping them", () => {
  assert.throws(() => gemini.buildBody("gemini-3.1-flash-image", {
    prompt: "Edit this", image: "https://example.test/image.png",
  }), /base64/);
  assert.throws(() => gemini.buildBody("gemini-3.1-flash-image", {
    prompt: "Edit this", image: "data:image/gif;base64,aGVsbG8=",
  }), /base64/);
});

test("Gemini response preserves validated image output and reports provider usage", async () => {
  let recordedUsage = null;
  const responseBody = {
    candidates: [{ content: { parts: [{ text: "Done" }, { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] } }],
    usageMetadata: {
      promptTokenCount: 20,
      candidatesTokenCount: 1300,
      totalTokenCount: 1330,
      thoughtsTokenCount: 10,
      candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
    },
  };

  const parsed = await gemini.parseResponse(new Response(JSON.stringify(responseBody)), {
    onUsage: (usage) => { recordedUsage = usage; },
  });
  assert.deepEqual(parsed, responseBody);
  assert.deepEqual(recordedUsage, {
    prompt_tokens: 20,
    completion_tokens: 1300,
    total_tokens: 1330,
    reasoning_tokens: 10,
    completion_tokens_details: [{ modality: "IMAGE", tokenCount: 1120 }],
  });
  assert.deepEqual(gemini.normalize(parsed).data, [{ b64_json: "aGVsbG8=" }]);
  assert.deepEqual(gemini.normalize({ candidates: [{ content: { parts: [{ text: "No image" }] } }] }).data, []);
});

test("Gemini usage callback failure does not discard a provider response", async () => {
  const responseBody = {
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
  };
  const parsed = await gemini.parseResponse(new Response(JSON.stringify(responseBody)), {
    onUsage: () => { throw new Error("storage unavailable"); },
  });
  assert.deepEqual(parsed, responseBody);
});
