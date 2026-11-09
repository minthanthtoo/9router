import { describe, it, expect, vi, beforeEach } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute }),
}));
import adapter from "../../open-sse/handlers/imageProviders/antigravity.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

describe("Antigravity image reference transport", () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue({ response: new Response(JSON.stringify({ candidates: [] })) });
  });

  it("forwards target and garment bytes in their original order", async () => {
    await adapter.executeViaExecutor("gemini-3.1-flash-image", {
      prompt: "Change only clothing",
      images: ["data:image/png;base64,dGFyZ2V0", "data:image/jpeg;base64,Z2FybWVudA=="],
    }, {}, null);
    expect(execute.mock.calls[0][0].disableRetries).toBe(true);
    expect(execute.mock.calls[0][0].body.contents[0].parts).toEqual([
      { inlineData: { mimeType: "image/png", data: "dGFyZ2V0" } },
      { inlineData: { mimeType: "image/jpeg", data: "Z2FybWVudA==" } },
      { text: "Change only clothing" },
    ]);
    const transformed = new AntigravityExecutor().transformRequest(
      "gemini-3.1-flash-image", execute.mock.calls[0][0].body, false,
      { projectId: "synthetic-project", connectionId: "synthetic-connection" },
    );
    expect(transformed.request.contents[0].parts).toEqual(execute.mock.calls[0][0].body.contents[0].parts);
  });

  it("retains a single image for ordinary latest-result edits", async () => {
    await adapter.executeViaExecutor("gemini-3.1-flash-image", {
      prompt: "Make it cartoon", image: "data:image/png;base64,dGFyZ2V0",
    }, {}, null);
    expect(execute.mock.calls[0][0].body.contents[0].parts).toHaveLength(2);
    expect(execute.mock.calls[0][0].body.contents[0].parts[0].inlineData.data).toBe("dGFyZ2V0");
  });

  it("rejects an unusable reference before dispatch instead of ignoring it", async () => {
    await expect(adapter.executeViaExecutor("gemini-3.1-flash-image", {
      prompt: "Edit", images: ["data:image/png;base64,dGFyZ2V0", "https://example.test/garment.jpg"],
    }, {}, null)).rejects.toThrow("Invalid Antigravity image reference");
    expect(execute).not.toHaveBeenCalled();
  });
});
