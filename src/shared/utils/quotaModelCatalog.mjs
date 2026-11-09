export const QUOTA_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,255}$/;
export const QUOTA_MODEL_CATEGORIES = [
  { value: 'all', label: 'All categories', icon: 'apps' },
  { value: 'text', label: 'All text', group: '💬 Text generation', emoji: '💬' },
  { value: 'text-reasoning', label: 'Reasoning', group: '💬 Text generation', emoji: '🧠' },
  { value: 'text-vision', label: 'Vision input', group: '💬 Text generation', emoji: '👁' },
  { value: 'image', label: 'All images', group: '🖼 Image generation', emoji: '🖼' },
  { value: 'generation', label: 'Generate', group: '🖼 Image generation', emoji: '✨' },
  { value: 'editing', label: 'Edit', group: '🖼 Image generation', emoji: '🖌' },
  { value: 'both', label: 'Generate + edit', group: '🖼 Image generation', emoji: '🎨' },
];
export function quotaModelMatchesCategory(model, category = 'all') {
  if (category === 'all') return true;
  if (category === 'text') return model.kind === 'llm';
  if (category === 'text-reasoning') return model.kind === 'llm' && model.reasoning === true;
  if (category === 'text-vision') return model.kind === 'llm' && model.vision === true;
  if (model.kind !== 'image') return false;
  if (category === 'image') return true;
  if (category === 'generation') return model.capabilities?.generation === true;
  if (category === 'editing') return model.capabilities?.editing === true;
  if (category === 'both') return model.capabilities?.generation === true && model.capabilities?.editing === true;
  return false;
}
export function normalizeQuotaModel(provider, raw, editing = false) {
  const kind = raw.kind || raw.type || (raw.imageGen === true ? 'image' : 'llm');
  if (!QUOTA_MODEL_ID.test(raw.id || '') || !['llm','image'].includes(kind)) return null;
  const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  return { provider, id: raw.id, name: raw.name || raw.id, kind, upstreamModelId: raw.upstreamModelId || null,
    reasoning: raw.isReasoning === true || raw.reasoning === true || raw.caps?.reasoning === true || Array.isArray(raw.thinkingLevels) && raw.thinkingLevels.length > 0,
    vision: raw.isVL === true || raw.vision === true || raw.caps?.vision === true || capabilities.includes('vision') || raw.modalities?.input?.includes?.('image') === true,
    ...(kind === 'image' ? { capabilities: { generation: raw.capabilities?.generation !== false, editing: editing || raw.capabilities?.editing === true || capabilities.some(value => ['edit','imageToImage'].includes(value)) } } : {}),
  };
}
// Configured support is distinct from current quota, manual pauses and confirmed upstream access.
export function accountMatchesQuotaModel(connection, model) {
  if (connection.provider !== model.provider) return false;
  const allowed = connection.providerSpecificData?.enabledModels;
  // This legacy allowlist governs text models and Codex image access, not other image providers.
  if ((model.kind === 'llm' || model.provider === 'codex') && Array.isArray(allowed) && allowed.length
    && !allowed.includes(model.id) && !(model.kind === 'llm' && allowed.includes(model.upstreamModelId))) return false;
  if (model.kind === 'image' && connection.provider === 'codex' && String(connection.providerSpecificData?.chatgptPlanType || '').toLowerCase() === 'free') return false;
  return true;
}
export function filterQuotaConnections(connections, models, { model = '', modelProvider = '', category = 'all' } = {}) {
  if (!model && category === 'all') return connections;
  const relevant = models.filter(item => (!model || item.id === model) && (!modelProvider || item.provider === modelProvider) && quotaModelMatchesCategory(item, category));
  return connections.filter(connection => relevant.some(item => accountMatchesQuotaModel(connection, item)));
}
export function quotaCatalogCounts(connections, models, category = 'all') {
  const byId = new Map();
  for (const model of models) {
    if (!quotaModelMatchesCategory(model, category)) continue;
    let entry = byId.get(model.id);
    if (!entry) { entry = { id: model.id, name: model.name, kind: model.kind, reasoning: model.reasoning, vision: model.vision, capabilities: model.capabilities, providers: [], accounts: new Set() }; byId.set(model.id, entry); }
    const accounts = connections.filter(connection => accountMatchesQuotaModel(connection, model));
    entry.providers.push({ provider: model.provider, accountCount: accounts.length });
    for (const account of accounts) entry.accounts.add(account.id);
  }
  return [...byId.values()].map(({ accounts, ...entry }) => ({ ...entry, accountCount: accounts.size, providerCount: entry.providers.filter(provider => provider.accountCount > 0).length }))
    .sort((a,b) => b.accountCount-a.accountCount || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
