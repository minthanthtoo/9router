import { describe, expect, it } from "vitest";
import { preparePolicyDraft, editPolicyDraft, rebasePolicyDraft } from "../../src/app/(dashboard)/dashboard/quota/imagePolicyCommand.mjs";

describe("image policy command retry identity", () => {
  const draft = { action: "pause", reason: " Review account ", idempotencyKey: "command-1" };
  const row = { connectionId: "account-a", manualPolicy: { revision: 7 } };
  it("replays the exact payload and key when a refresh advances the revision after a lost reply", () => {
    const sent = preparePolicyDraft(draft, row);
    const unknown = { ...sent, outcomeUnknown: true };
    const retried = preparePolicyDraft(unknown, { ...row, manualPolicy: { revision: 8 } });
    expect(retried.idempotencyKey).toBe("command-1");
    expect(retried.payload).toBe(sent.payload);
    expect(retried.payload).toEqual({ connectionId: "account-a", action: "pause", reason: "Review account", expectedRevision: 7 });
    expect(editPolicyDraft(unknown, "New reason", "command-2")).toBe(unknown);
  });
  it("allows a deliberate new command after a definitive conflict and fresh review", () => {
    const sent = preparePolicyDraft(draft, row);
    const rebased = rebasePolicyDraft({ ...sent, outcomeUnknown: true }, "command-2");
    const reviewed = preparePolicyDraft(rebased, { ...row, manualPolicy: { revision: 8 } });
    expect(reviewed.idempotencyKey).toBe("command-2");
    expect(reviewed.payload.expectedRevision).toBe(8);
    expect(reviewed.outcomeUnknown).toBe(false);
    const edited = editPolicyDraft(reviewed, "Edited reason", "command-3");
    expect(edited.payload).toBeNull();
    expect(edited.reason).toBe("Edited reason");
    expect(edited.idempotencyKey).toBe("command-3");
  });
});
