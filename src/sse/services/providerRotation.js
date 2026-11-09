import { applicableRotationQuotas, evaluateRotation } from '../../shared/utils/rotationSequence.mjs';
import {effectiveImageQuotaEligibility} from './imageQuotaEligibility.js';
import { isModelLockActive } from 'open-sse/services/accountFallback.js';
import { getAntigravityQuotaBlockForConnection, getAntigravityQuotaCache } from './antigravityQuota.js';
import { textModelPermissionReason, isConfiguredTextModel } from '../../shared/utils/textModelPermission.mjs';

export function rotationPool(connections, snapshots, policy, { provider, model = '', lockModel = model, now = Date.now(), onStep, imageStates, quotaAdmission = false, textPolicies }) {
  const blocked = [], eligible = [];
  for (const connection of connections) {
    let reason = null;
    const enabled = connection.providerSpecificData?.enabledModels;
    const textReason = !quotaAdmission && isConfiguredTextModel(provider, model) !== false
      ? textModelPermissionReason(connection, model, textPolicies?.get(connection.id)) : null;
    if (connection.isActive === false) reason = 'Turned off';
    else if (isModelLockActive(connection, lockModel)) reason = 'Cooling down';
    else if (textReason) reason = textReason;
    else if (provider === 'codex' && Array.isArray(enabled) && enabled.length && model && !enabled.includes(model.replace(/^[^/]+\//, ''))) reason = 'Model disabled';
    else if (provider === 'antigravity' && model && getAntigravityQuotaBlockForConnection(connection.id, model, getAntigravityQuotaCache())) reason = 'Quota wait';
    else if (imageStates && !effectiveImageQuotaEligibility(connection,imageStates.get(connection.id),{model,nowMs:now}).eligible) reason = 'Image hold or quota wait';
    else if ((policy.enabled || quotaAdmission) && applicableRotationQuotas(snapshots[connection.id], provider, model, now).some(quota => (quota.window !== 'session' || !policy.enabled) && quota.remaining === 0)) reason = 'Quota exhausted';
    if (reason) blocked.push({ connection, reason }); else eligible.push(connection);
  }
  const evaluation = evaluateRotation(eligible, snapshots, policy, { provider, model, now, onStep });
  return { ...evaluation, blocked };
}
