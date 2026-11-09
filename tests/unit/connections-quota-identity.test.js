import { describe, expect, it, vi } from "vitest";

vi.mock("uuid", () => ({ v4: () => "test-connection-id" }));
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: vi.fn() }));

import { prepareQuotaIdentityPatch } from "../../src/lib/db/repos/connectionsRepo.js";

describe("connection image quota identity lifecycle", () => {
  it("keeps verified account and generation metadata across token-only refresh patches", () => {
    const existing = {
      id: "connection-a",
      provider: "codex",
      providerSpecificData: {
        chatgptAccountId: "account-1",
        workspaceId: "workspace-a",
        imageQuotaIdentityGeneration: 4,
        enabledModels: ["gpt-image-2"],
      },
    };

    const patch = prepareQuotaIdentityPatch(existing, {
      accessToken: "refreshed-token",
      providerSpecificData: { accessTokenExpiresAt: "2026-10-15T02:00:00Z" },
    });

    expect(patch.providerSpecificData).toMatchObject({
      chatgptAccountId: "account-1",
      workspaceId: "workspace-a",
      imageQuotaIdentityGeneration: 4,
    });
  });

  it("increments the generation when the verified account or workspace changes", () => {
    const existing = {
      id: "connection-a",
      provider: "codex",
      providerSpecificData: {
        chatgptAccountId: "account-1",
        workspaceId: "workspace-a",
        imageQuotaIdentityGeneration: 4,
      },
    };

    const patch = prepareQuotaIdentityPatch(existing, {
      providerSpecificData: { chatgptAccountId: "account-2", workspaceId: "workspace-b" },
    });

    expect(patch.providerSpecificData.imageQuotaIdentityGeneration).toBe(5);
  });

  it("increments when an account identity becomes known after connection-local state", () => {
    const existing = { id: "connection-a", provider: "antigravity", providerSpecificData: {} };
    const patch = prepareQuotaIdentityPatch(existing, {
      providerSpecificData: { googleAccountSub: "google-sub-1" },
    });

    expect(patch.providerSpecificData.imageQuotaIdentityGeneration).toBe(2);
  });
});
