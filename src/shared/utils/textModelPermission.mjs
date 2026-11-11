import { getModelsByProviderId, PROVIDER_ID_TO_ALIAS, getModelUpstreamId } from '../../../open-sse/config/providerModels.js';

// Strip only this provider's prefix: organization/model is a valid model identity.
export function canonicalTextModel(provider, value = '') {
  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  let model = String(value || '').replace(/\([^()]+\)\s*$/, '').trim();
  for (const prefix of new Set([provider, alias])) if (model.startsWith(prefix + '/')) { model = model.slice(prefix.length + 1); break; }
  if (provider === 'kiro') model = model.replace(/(\d)-(\d)/g, '$1.$2');
  return model;
}

export function accountModelAccess(connection, model, evidence, now = Date.now()) {
  const canonical=canonicalTextModel(connection.provider,model);
  const upstream=id=>{
    const raw=String(id).replace(/^(?:codex|cx)\//,'');
    return canonicalTextModel('codex',getModelUpstreamId(PROVIDER_ID_TO_ALIAS.codex,raw)).replace(/-(?:none|minimal|low|medium|high|xhigh)$/, '');
  };
  const enabled=connection.providerSpecificData?.enabledModels;
  if(connection.provider==='codex' && canonical && Array.isArray(enabled) && enabled.length && !enabled.some(id=>canonicalTextModel(connection.provider,id)===canonical || canonicalTextModel(connection.provider,id)===upstream(model))) return {state:'disabled',reason:'Model disabled'};
  if(!canonical || /image/.test(canonical) || isConfiguredTextModel(connection.provider,canonical)===false || connection.provider!=='codex' || !evidence || evidence.source!=='account_models' || !Array.isArray(evidence.models) || !Number.isFinite(evidence.observedAt) || now<evidence.observedAt || now-evidence.observedAt>600000) return {state:'unknown',reason:null};
  const supported=evidence.models.some(id=>upstream(id)===upstream(model));
  return {state:supported?'supported':'unsupported',reason:supported?null:'Model unavailable on this account'};
}

export function textModelPermissionReason(connection, model, policy, evidence, now = Date.now()) {
  const canonical = canonicalTextModel(connection.provider, model);
  if (connection.isActive === false) return 'Turned off';
  const access=accountModelAccess(connection,model,evidence,now);
  if(access.reason) return access.reason;
  if (canonical && policy?.disabledModels?.includes(canonical)) return 'Text model off';
  return null;
}

export function isConfiguredTextModel(provider, model) {
  const canonical = canonicalTextModel(provider, model);
  const entry = getModelsByProviderId(provider).find(item => item.id === canonical);
  return entry ? (entry.kind || entry.type || (entry.imageGen ? 'image' : 'llm')) === 'llm' : null;
}
