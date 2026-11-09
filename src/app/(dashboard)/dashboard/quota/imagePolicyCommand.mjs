export function preparePolicyDraft(draft, row) {
  if (draft.payload) return draft;
  return { ...draft, payload: {
    connectionId: row.connectionId,
    action: draft.action,
    reason: draft.reason.trim(),
    expectedRevision: row.manualPolicy?.revision || 0,
  } };
}

export function editPolicyDraft(draft, reason, idempotencyKey) {
  if (!draft || draft.outcomeUnknown) return draft;
  return { ...draft, reason, idempotencyKey, payload: null };
}

export function rebasePolicyDraft(draft, idempotencyKey) {
  return { ...draft, idempotencyKey, payload: null, outcomeUnknown: false };
}

export function imagePolicyKey(connectionId, model = null) {
  return JSON.stringify([connectionId, model]);
}

export function imageManualPolicy(row, model = null) {
  if (!model) return row.manualPolicy || { state: "enabled", revision: 0 };
  const policies = (row.modelPolicies || []).filter(policy => policy.model === model);
  return { state: policies.some(policy => policy.state === "paused") ? "paused" : "enabled",
    revision: policies.reduce((max, policy) => Math.max(max, policy.revision || 0), 0) };
}

export function imagePolicyReceiptMatches(receipt, row, model, payload) {
  return receipt?.connectionId === row.connectionId && receipt.provider === row.provider
    && receipt.quotaGroupId === (model ? `${row.quotaGroupId}:model:${model}` : row.quotaGroupId)
    && receipt.policyState === (payload.action === "pause" ? "paused" : "enabled")
    && receipt.revision === payload.expectedRevision + 1;
}
