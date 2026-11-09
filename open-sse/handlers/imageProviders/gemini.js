// Google Gemini Developer API image adapter (Nano Banana models)
import { nowSec, sizeToAspectRatio } from "./_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

const BASE_URL = PROVIDER_MEDIA["gemini"]?.imageConfig?.baseUrl;
const SUPPORTED_ASPECT_RATIOS = new Set([
  "1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4",
  "8:1", "9:16", "16:9", "21:9",
]);
const SUPPORTED_IMAGE_SIZES = new Set(["512", "1K", "2K", "4K"]);

function parseImageInput(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Gemini image references must be base64 image data.");
  }

  const value = input.trim();
  const dataUri = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/\s_-]+={0,2})$/i);
  const mimeType = dataUri?.[1]?.toLowerCase() || "image/png";
  const raw = dataUri ? dataUri[2] : value;
  const data = raw.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(data) || data.length % 4 === 1) {
    throw new Error("Gemini image references must contain valid base64 image data.");
  }

  return { inlineData: { mimeType, data } };
}

function imageConfig(body) {
  const aspectRatio = body.aspect_ratio || body.aspectRatio || sizeToAspectRatio(body.size);
  if (!SUPPORTED_ASPECT_RATIOS.has(aspectRatio)) {
    throw new Error("Unsupported Gemini image aspect ratio.");
  }

  const explicitSize = body.image_size || body.imageSize;
  const imageSize = explicitSize == null ? "1K" : String(explicitSize).toUpperCase();
  if (!SUPPORTED_IMAGE_SIZES.has(imageSize)) {
    throw new Error("Gemini image_size must be one of 512, 1K, 2K, or 4K.");
  }
  return { aspectRatio, imageSize };
}

function normalizeUsage(usageMetadata) {
  if (!usageMetadata || typeof usageMetadata !== "object") return null;
  const promptTokens = usageMetadata.promptTokenCount;
  const completionTokens = usageMetadata.candidatesTokenCount;
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 0 ||
      !Number.isSafeInteger(completionTokens) || completionTokens < 0) return null;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    ...(Number.isSafeInteger(usageMetadata.totalTokenCount) && usageMetadata.totalTokenCount >= 0
      ? { total_tokens: usageMetadata.totalTokenCount }
      : {}),
    ...(Number.isSafeInteger(usageMetadata.thoughtsTokenCount) && usageMetadata.thoughtsTokenCount >= 0
      ? { reasoning_tokens: usageMetadata.thoughtsTokenCount }
      : {}),
    ...(Array.isArray(usageMetadata.promptTokensDetails)
      ? { prompt_tokens_details: usageMetadata.promptTokensDetails }
      : {}),
    ...(Array.isArray(usageMetadata.candidatesTokensDetails)
      ? { completion_tokens_details: usageMetadata.candidatesTokensDetails }
      : {}),
  };
}


export default {
  buildUrl: (model) => {
    const modelId = String(model || "").replace(/^models\//, "");
    if (!BASE_URL || !modelId) throw new Error("Gemini image model is not configured.");
    return `${BASE_URL.replace(/\/$/, "")}/${encodeURIComponent(modelId)}:generateContent`;
  },
  buildHeaders: (creds) => {
    const apiKey = typeof creds?.apiKey === "string" ? creds.apiKey.trim() : "";
    if (!apiKey) throw new Error("A Gemini Developer API key is required for image generation.");
    return { "Content-Type": "application/json", "x-goog-api-key": apiKey };
  },
  buildBody: (_model, body) => {
    const images = Array.isArray(body.images) ? body.images.filter(Boolean) : [];
    if (body.image) images.unshift(body.image);
    const parts = [{ text: body.prompt }];
    for (const image of images) parts.push(parseImageInput(image));

    return {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: imageConfig(body),
        ...(Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0
          ? { maxOutputTokens: body.max_output_tokens } : {}),
      },
    };
  },
  async parseResponse(response, { onUsage } = {}) {
    const body = await response.json();
    const usage = normalizeUsage(body?.usageMetadata);
    if (usage && onUsage) {
      try { await onUsage(usage); } catch {
        // Usage persistence is best-effort after the provider response is received.
      }
    }
    return body;
  },
  normalize: (responseBody) => {
    const parts = responseBody.candidates?.[0]?.content?.parts || [];
    const images = parts.filter((p) => p.inlineData?.data).map((p) => ({ b64_json: p.inlineData.data }));
    return {
      created: nowSec(),
      data: images.length > 0 ? images : [],
    };
  },
};
