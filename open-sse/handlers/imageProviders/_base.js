// Shared helpers for image provider adapters

export const POLL_INTERVAL_MS = 1500;
export const POLL_TIMEOUT_MS = 120000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map OpenAI size to provider-specific aspect ratio
export function sizeToAspectRatio(size) {
  if (!size || typeof size !== "string") return "1:1";
  const map = {
    "1024x1024": "1:1",
    "1024x1792": "9:16",
    "1792x1024": "16:9",
    "1024x1536": "2:3",
    "1536x1024": "3:2",
  };
  return map[size] || "1:1";
}

// Fetch URL → base64 (for providers returning image URLs)
export async function urlToBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function isUsableBase64Image(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().replace(/\s/g, "");
  if (!normalized || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    return false;
  }
  try {
    return Buffer.from(normalized, "base64").length > 0;
  } catch {
    return false;
  }
}

export function hasUsableImagePayload(result) {
  if (!Array.isArray(result?.data)) return false;
  return result.data.some((item) => {
    if (isUsableBase64Image(item?.b64_json)) return true;
    if (typeof item?.url !== "string") return false;
    try {
      const url = new URL(item.url);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  });
}
