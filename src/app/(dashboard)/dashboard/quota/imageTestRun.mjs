const BLOCKED = new Set(['manual_paused', 'account_disabled', 'identity_required', 'quota_blocked', 'probe_in_progress', 'local_capacity_limited', 'model_not_enabled', 'provider_usage_blocked', 'legacy_cooldown', 'unavailable']);

export function imageTestAllowed(account, model) {
  return Boolean(model && model !== '—' && account?.accountEnabled && !BLOCKED.has(account.routeState) && !(account.modelPolicies || []).some(policy => policy.model === model && policy.state === 'paused'));
}

export function imageTestPlan(rows) {
  const targets = new Map();
  for (const { account, entry, model } of rows) {
    if (!entry?.capabilities?.generation || !imageTestAllowed(account, model)) continue;
    const key = JSON.stringify([account.connectionId, model]);
    targets.set(key, { connectionId: account.connectionId, accountLabel: account.accountLabel, provider: account.provider, model });
  }
  return [...targets.values()];
}

export async function runImageTests(targets, { submit, stopped, report }) {
  const results = [];
  for (const target of targets) {
    if (stopped()) break;
    let result;
    try { result = await submit(target); }
    catch { result = { ok: false, outcomeUnknown: true, message: 'Outcome unconfirmed. Inspect activity before another request.' }; }
    results.push({ ...target, ...result });
    report([...results]);
    if (result.outcomeUnknown || [401, 403, 429].includes(result.status) || result.status >= 500) break;
  }
  return results;
}

export async function submitImageTest({ connectionId, model }) {
  const response = await fetch('/api/models/image-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId, model }) });
  const data = await response.json();
  if (typeof data?.message === 'string' && typeof data.outcomeUnknown === 'boolean') return { ...data, status: data.status || response.status };
  if (response.status >= 400 && response.status < 500) return { ok: false, status: response.status, outcomeUnknown: false, message: response.status === 401 ? 'Sign in to the dashboard before testing.' : 'Test refused before dispatch. Check account and model selection.' };
  throw new Error('Unconfirmed response');
}
