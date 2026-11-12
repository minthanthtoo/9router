import { applicableRotationQuotas, evaluateRotation, resetCreditPriority } from '../../shared/utils/rotationSequence.mjs';
import {effectiveImageQuotaEligibility} from './imageQuotaEligibility.js';
import { isModelLockActive } from 'open-sse/services/accountFallback.js';
import { getAntigravityQuotaBlockForConnection, getAntigravityQuotaCache } from './antigravityQuota.js';
import { textModelPermissionReason, isConfiguredTextModel, accountModelAccess } from '../../shared/utils/textModelPermission.mjs';

export function rotationPool(connections, snapshots, policy, { provider, model = '', lockModel = model, now = Date.now(), onStep, imageStates, quotaAdmission = false, textPolicies, resetHolds = [] }) {
  // Resettable exhausted accounts enter selection only after the ordinary pool is empty.
  if (provider === 'codex' && !quotaAdmission && policy.resetPriority?.autoReset) {
    const ordinary = { ...policy, resetPriority: { ...policy.resetPriority, autoReset: false } };
    if (rotationPool(connections, snapshots, ordinary, { provider, model, lockModel, now, imageStates, textPolicies, resetHolds }).ranked.length) policy = ordinary;
  }
  const blocked = [], eligible = [];
  const admission = quotaAdmission ? [
    { id: 'account', label: 'Enabled accounts', ready: 0 },
    { id: 'subscription', label: 'Subscription allowance', ready: 0, unreported: 0 },
    { id: 'model', label: 'Image quota & holds', ready: 0 },
  ] : null;
  for (const connection of connections) {
    let reason = null, gate = 'account';
    const textReason = !quotaAdmission && isConfiguredTextModel(provider, model) !== false
      ? textModelPermissionReason(connection, model, textPolicies?.get(connection.id), snapshots[connection.id]?.modelAccess, now) : null;
    if (connection.isActive === false) reason = 'Turned off';
    else if (resetHolds.some(row => row.connectionId === connection.id)) reason = 'Reset pending verification';
    else if (!quotaAdmission && isModelLockActive(connection, lockModel) && !(Number(connection.errorCode) === 429 && policy.resetPriority?.autoReset && resetCreditPriority(connection, snapshots[connection.id], policy, { provider, model, now }))) reason = 'Cooling down';
    else if (textReason) reason = textReason;
    else if (accountModelAccess(connection,model,quotaAdmission?undefined:snapshots[connection.id]?.modelAccess,now).reason) reason=accountModelAccess(connection,model,quotaAdmission?undefined:snapshots[connection.id]?.modelAccess,now).reason;
    if (!reason && quotaAdmission) {
      admission[0].ready++;
      gate = 'subscription';
      const quotas = applicableRotationQuotas(snapshots[connection.id], provider, model, now);
      const subscription = quotas.filter(quota => quota.window !== 'model');
      if (!subscription.some(quota => Number.isFinite(quota.remaining))) admission[1].unreported++;
      if (subscription.some(quota => quota.remaining === 0)) reason = 'Quota exhausted';
      else {
        admission[1].ready++;
        gate = 'model';
        const providerBlock = provider === 'antigravity' && model
          ? getAntigravityQuotaBlockForConnection(connection.id, model, getAntigravityQuotaCache()) : null;
        const status = effectiveImageQuotaEligibility(connection, imageStates?.get(connection.id), { model: lockModel, nowMs: now, antigravityQuotaBlock: providerBlock });
        if (quotas.some(quota => quota.window === 'model' && quota.remaining === 0)) reason = 'Image quota wait';
        else if (isModelLockActive(connection, lockModel)) reason = 'Cooling down';
        else if (!status.eligible) reason = ({ manual_paused: 'Images paused', probe_in_progress: 'Outcome pending', quota_blocked: 'Image quota wait', provider_usage_blocked: 'Image quota wait' })[status.state] || 'Image hold or quota wait';
        else admission[2].ready++;
      }
    } else if (!reason) {
      if (provider === 'antigravity' && model && getAntigravityQuotaBlockForConnection(connection.id, model, getAntigravityQuotaCache())) reason = 'Quota wait';
      else if (imageStates && !effectiveImageQuotaEligibility(connection,imageStates.get(connection.id),{model,nowMs:now}).eligible) reason = 'Image hold or quota wait';
      else if (!(policy.resetPriority?.autoReset && resetCreditPriority(connection, snapshots[connection.id], policy, { provider, model, now })) && applicableRotationQuotas(snapshots[connection.id], provider, model, now).some(quota => (quota.window !== 'session' || !policy.enabled) && quota.remaining === 0)) reason = 'Quota exhausted';
    }
    if (reason) blocked.push({ connection, reason, ...(quotaAdmission ? { gate } : {}) }); else eligible.push(connection);
  }
  const evaluation = evaluateRotation(eligible, snapshots, policy, { provider, model, now, onStep });
  return { ...evaluation, blocked, ...(admission ? { admission } : {}) };
}

export function rotationWaitingIds(pool) {
  const temporary = new Set(['Cooling down', 'Quota exhausted', 'Quota wait', 'Image quota wait', 'Outcome pending', 'Reset pending verification', 'Image hold or quota wait']);
  return new Set([...pool.waiting, ...pool.blocked.filter(row => temporary.has(row.reason))].map(row => row.connection.id));
}
