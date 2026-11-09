import {normalizeRotationUsage,scopeMatches,SNAPSHOT_MAX_AGE_MS} from './rotationSequence.mjs';

// Use the routing adapter's scope map; never substitute another model family's pool.
export function modelQuotaWindows(provider, model, usage, now = Date.now()) {
  if (!usage?.quotas) return [];
  const snapshot=normalizeRotationUsage(provider,usage,now);
  return snapshot.quotas.filter(quota=>scopeMatches(provider,quota.scope,model)).map(quota=>({...quota,
    stale:now-snapshot.observedAt>SNAPSHOT_MAX_AGE_MS || now<snapshot.observedAt,
    expired:quota.resetAt!==null&&quota.resetAt<=now,
  }));
}
