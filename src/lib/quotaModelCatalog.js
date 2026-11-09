import { getModelsByProviderId, PROVIDER_ID_TO_ALIAS, supportsImageEdit } from '../../open-sse/config/providerModels.js';
import { normalizeQuotaModel } from '../shared/utils/quotaModelCatalog.mjs';

// Match the host catalog: registered identities win; custom-only models extend it.
export function configuredQuotaModels(providers, custom = []) {
  return providers.flatMap(provider => {
    const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
    const additions = custom.filter(model => [provider, alias].includes(model.providerAlias) || model.provider === provider);
    const models = new Map();
    for (const raw of [...getModelsByProviderId(provider), ...additions]) {
      if (models.has(raw.id)) continue;
      const model = normalizeQuotaModel(provider, raw, supportsImageEdit(provider, raw.id));
      if (model) models.set(model.id, model);
    }
    return [...models.values()];
  });
}
