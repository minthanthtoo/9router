import { getProviderConnections, getSettings } from '@/lib/localDb';
import { readRotationSnapshots } from '@/lib/db/repos/providerRotationRepo.js';
import {validateImageRouting} from '@/shared/utils/imageRouting.mjs';
import { SNAPSHOT_MAX_AGE_MS, validateRotation } from '@/shared/utils/rotationSequence.mjs';

const state = (globalThis.__rotationSnapshotRefresh ??= { jobs: new Map(), timer: null, tick: false, lastAttemptAt: null, lastSuccessAt: null, lastError: null, heartbeatAt: null, nextDueAt: null });
export async function refreshRotationSnapshots(provider, includeCredits = false) {
  if (state.jobs.has(provider)) return state.jobs.get(provider);
  const job = (async () => {
    const { GET: readUsage } = await import('@/app/api/usage/[connectionId]/route.js');
    const { GET: readCredits } = await import('@/app/api/usage/[connectionId]/codex-reset-credits/route.js');
    const connections = await getProviderConnections({ provider, isActive: true });
    const existing = await readRotationSnapshots(connections), now = Date.now();
    const errors = [];
    for (const connection of connections) {
      const cached = existing[connection.id];
      const fresh = cached && now >= cached.observedAt && now - cached.observedAt < SNAPSHOT_MAX_AGE_MS / 2;
      const creditFresh = cached?.credits && now >= cached.credits.observedAt && now - cached.credits.observedAt < SNAPSHOT_MAX_AGE_MS / 2;
      try {
        if (!fresh) {
          const response = await readUsage(new Request('http://localhost/api/usage/' + connection.id), { params: Promise.resolve({ connectionId: connection.id }) });
          if (!response.ok) { errors.push({ id: connection.id, message: 'Quota read failed' }); continue; }
          const usage = await response.json();
          if (!usage.quotas) { errors.push({ id: connection.id, message: 'Quota unavailable' }); continue; }
        }
      } catch { errors.push({ id: connection.id, message: 'Quota read failed' }); continue; }
      if (provider === 'codex' && includeCredits && !creditFresh) {
        try {
          const response = await readCredits(new Request('http://localhost/api/usage/' + connection.id + '/codex-reset-credits'), { params: Promise.resolve({ connectionId: connection.id }) });
          if (!response.ok) errors.push({ id: connection.id, message: 'Credit expiry unavailable' });
        } catch { errors.push({ id: connection.id, message: 'Credit expiry unavailable' }); }
      }
    }
    return { errors };
  })();
  state.lastAttemptAt = Date.now();
  state.jobs.set(provider, job);
  try { const result = await job; state.lastError = result.errors.length ? `${result.errors.length} account reads unavailable` : null; if (!result.errors.length) state.lastSuccessAt = Date.now(); return result; } catch (error) { state.lastError = 'Quota read failed'; throw error; } finally { state.jobs.delete(provider); }
}
function monitoringPolicies(settings) {
 const policies=new Map(Object.entries(settings.providerStrategies||{}).filter(([,value])=>value.rotationSequence?.enabled).map(([provider,value])=>[provider,value.rotationSequence]));
 for(const rule of validateImageRouting(settings.aurixImageRouting).rules) if(rule.accountPreference?.mode==='custom'&&rule.accountPreference.sequence.enabled) {
  const prior=policies.get(rule.provider),sequence=rule.accountPreference.sequence;
  policies.set(rule.provider,prior?.resetPriority.enabled?prior:sequence);
 }
 return policies;
}
export function startRotationSnapshotRefresh() {
  if (state.timer || process.env.DISABLE_ROTATION_SNAPSHOT_REFRESH === '1' || process.env.NEXT_PHASE === 'phase-production-build') return;
  const tick = async () => {
    if (state.tick) return;
    state.tick = true; state.heartbeatAt = Date.now(); state.nextDueAt = Date.now() + 60000;
    try {
      const settings = await getSettings();
      const policies=monitoringPolicies(settings);
      if (!policies.size) { clearInterval(state.timer); state.timer = null; return; }
      const failures = [];
      for (const [provider, sequence] of policies) {
        try {
          validateRotation(sequence, provider);
          const result = await refreshRotationSnapshots(provider, sequence.resetPriority?.enabled);
          if (result.errors.length) failures.push(provider);
        } catch { failures.push(provider); }
      }
      state.lastError = failures.length ? `${failures.length} provider refreshes unavailable` : null;
    } catch { state.lastError = 'Quota monitor unavailable'; console.warn('[Rotation snapshots] Refresh unavailable'); }
    finally { state.tick = false; if (!state.timer) state.nextDueAt = null; }
  };
  state.timer = setInterval(tick, 60000); state.timer.unref?.();
  void tick();
}

export function rotationAutomationStatus(settings) {
 const providers=[...monitoringPolicies(settings).keys()];
 return {scope:'process',quotaReads:{checkedAt:Date.now(),disabled:process.env.DISABLE_ROTATION_SNAPSHOT_REFRESH==='1',configured:providers.length>0,running:Boolean(state.timer),inProgress:state.tick||state.jobs.size>0,providers,cadenceMs:60000,lastAttemptAt:state.lastAttemptAt||null,lastSuccessAt:state.lastSuccessAt||null,lastError:state.lastError||null,nextDueAt:state.timer?state.nextDueAt||null:null,heartbeatAt:state.heartbeatAt||null},passiveLearning:{mode:'recorded_traffic'},imageRecovery:{mode:'manual',scheduled:false}};
}
