import { HTTP_STATUS } from "../config/runtimeConfig.js";

export function requestsImageOutput(body) {
  const includesImage = (modalities) => Array.isArray(modalities)
    && modalities.some((value) => typeof value === "string" && value.toUpperCase() === "IMAGE");
  return (Array.isArray(body?.tools) && body.tools.some((tool) => tool?.type === "image_generation"))
    || body?.tool_choice?.type === "image_generation"
    || includesImage(body?.modalities)
    || includesImage(body?.generationConfig?.responseModalities);
}

export function imageGenerationRequiresManagedRouteResponse() {
  return new Response(JSON.stringify({
    error: {
      message: "Image generation requires a managed Images route. Use /v1/images/generations for new images or /v1/images/edits with source images; Chat and Responses image tools are not routed.",
      type: "invalid_request_error",
      code: "image_generation_requires_managed_route",
    },
  }), {
    status: HTTP_STATUS.BAD_REQUEST,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
