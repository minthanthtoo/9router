import { getModelsByProviderId, PROVIDER_ID_TO_ALIAS } from '../../../open-sse/config/providerModels.js';

// Strip only this provider's prefix: organization/model is a valid model identity.
export function canonicalTextModel(provider, value = '') {
  const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
  let model = String(value || '').replace(/\([^()]+\)\s*$/, '').trim();
  for (const prefix of new Set([provider, alias])) if (model.startsWith(prefix + '/')) { model = model.slice(prefix.length + 1); break; }
  if (provider === 'kiro') model = model.replace(/(\d)-(\d)/g, '$1.$2');
  return model;
}

export function textModelPermissionReason(connection, model, policy) {
  const canonical = canonicalTextModel(connection.provider, model);
  if (connection.isActive === false) return 'Turned off';
  const enabled = connection.providerSpecificData?.enabledModels;
  if (connection.provider === 'codex' && canonical && Array.isArray(enabled) && enabled.length
    && !enabled.some(id => canonicalTextModel(connection.provider, id) === canonical)) return 'Model disabled';
  if (canonical && policy?.disabledModels?.includes(canonical)) return 'Text model off';
  return null;
}

export function isConfiguredTextModel(provider, model) {
  const canonical = canonicalTextModel(provider, model);
  const entry = getModelsByProviderId(provider).find(item => item.id === canonical);
  return entry ? (entry.kind || entry.type || (entry.imageGen ? 'image' : 'llm')) === 'llm' : null;
}
