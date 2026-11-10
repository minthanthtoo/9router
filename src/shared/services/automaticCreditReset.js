import { getSettings, getProviderConnectionById, updateProviderConnection } from '@/lib/localDb';
import { readRotationSnapshots, readCreditResetHolds, completeCreditResetRecovery } from '@/lib/db/repos/providerRotationRepo.js';
import { applicableRotationQuotas, resetCreditPriority } from '@/shared/utils/rotationSequence.mjs';

// Only real text dispatch invokes this; previews and background quota reads never spend credits.
export async function prepareAutomaticCreditReset(connections, policy, model, { reset, readUsage, readCredits } = {}) {
  async function refreshConfirmed(connection, attemptId) {
    readUsage ||= (await import('@/app/api/usage/[connectionId]/route.js')).GET;
    readCredits ||= (await import('@/app/api/usage/[connectionId]/codex-reset-credits/route.js')).GET;
    const context = { params: Promise.resolve({ connectionId: connection.id }) };
    const usage = await readUsage(new Request('http://localhost/internal-quota-read'), context);
    if (!usage.ok) return false;
    await readCredits(new Request('http://localhost/internal-credit-read'), context);
    const refreshed = await getProviderConnectionById(connection.id);
    if (!refreshed || refreshed.isActive === false) return false;
    const fresh = (await readRotationSnapshots([refreshed]))[connection.id];
    const after = applicableRotationQuotas(fresh, 'codex', model, Date.now());
    if (!after.length || after.some(q => q.remaining === 0) || !after.some(q => q.window === 'session' && q.remaining > 0)) return false;
    if (Number(refreshed.errorCode) === 429 && refreshed[`modelLock_${model}`]) {
      await updateProviderConnection(connection.id, { [`modelLock_${model}`]: null });
      refreshed[`modelLock_${model}`] = null;
    }
    Object.assign(connection, refreshed);
    await completeCreditResetRecovery(attemptId);
    return true;
  }
  const holds = await readCreditResetHolds(connections);
  const held = new Set(holds.map(h => h.connectionId));
  for (const hold of holds.filter(h => h.state === 'confirmed')) {
    const connection = connections.find(c => c.id === hold.connectionId);
    try { if (await refreshConfirmed(connection, hold.id)) held.delete(connection.id); } catch {}
  }
  if (!policy?.enabled || !policy.resetPriority?.enabled || policy.resetPriority.autoReset !== true) return { blocked: [...held] };
  const snapshots = await readRotationSnapshots(connections), now = Date.now();
  const matches = connections.filter(c => !held.has(c.id) && c.isActive !== false && resetCreditPriority(c, snapshots[c.id], policy, { provider: 'codex', model, now }))
    .sort((a, b) => snapshots[a.id].credits.expiresAt - snapshots[b.id].credits.expiresAt);
  const blocked = [...held];
  for (const connection of matches) {
    const snapshot = snapshots[connection.id];
    const quotas = applicableRotationQuotas(snapshot, 'codex', model, now);
    // Positive allowance needs no redemption. Unknown allowance never justifies spending.
    if (!quotas.some(q => q.remaining === 0)) return { blocked };
    const latest = await getProviderConnectionById(connection.id);
    const current = (await getSettings()).providerStrategies?.codex?.rotationSequence;
    if (!latest?.isActive || JSON.stringify(current) !== JSON.stringify(policy)) return { blocked };
    const cycle = JSON.stringify([snapshot.credits.expiresAt, snapshot.credits.availableCount,
      quotas.filter(q => q.remaining === 0).map(q => [q.id, q.window, q.resetAt]).sort()]);
    const context = { params: Promise.resolve({ connectionId: connection.id }), automaticCycle: cycle, automaticPolicy: policy };
    try {
      reset ||= (await import('@/app/api/usage/[connectionId]/codex-reset-credits/route.js')).POST;
      const response = await reset(new Request('http://localhost/internal-credit-reset', { method: 'POST' }), context);
      const result = await response.json();
      if (!response.ok || !result.reset) { blocked.push(connection.id); continue; }
      if (await refreshConfirmed(connection, result.redeemRequestId)) return { blocked, readyId: connection.id };
      blocked.push(connection.id);
    } catch { blocked.push(connection.id); }
  }
  return { blocked };
}
