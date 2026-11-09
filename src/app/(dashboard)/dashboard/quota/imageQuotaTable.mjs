import { imageNextCheck, estimateLabel } from "./imageLearningDisplay.mjs";
const sortableKeys = new Set(["account", "state", "next", "calls24h", "total"]);

export const IMAGE_MODEL_CATEGORY_OPTIONS = [
  { value: "all", label: "All categories" },
  { value: "generation", label: "Generation" },
  { value: "editing", label: "Editing" },
  { value: "both", label: "Both" },
  { value: "unreported", label: "Unreported" },
];

export function imageModelMatchesCategory(item, category = "all") {
  const generation = item?.capabilities?.generation === true;
  const editing = item?.capabilities?.editing === true;
  if (category === "generation") return generation;
  if (category === "editing") return editing;
  if (category === "both") return generation && editing;
  if (category === "unreported") return !generation && !editing;
  return true;
}

export function imageAccountModels(account, catalog = []) {
  const models = new Map(catalog.filter(item => item.provider === account?.provider)
    .map(item => [item.id, { model: item.id, capabilities: item.capabilities }]));
  for (const item of account?.learning?.models || []) models.set(item.model, { ...models.get(item.model), ...item });
  return [...models.values()];
}

export function buildImageQuotaRows(projection, model = "", modelProvider = "", catalog = []) {
  return (projection?.rows || []).flatMap((account) => {
    const models = imageAccountModels(account, catalog);
    if (modelProvider && account.provider !== modelProvider) return [];
    const selected = model ? models.filter((item) => item.model === model) : models;
    return (selected.length ? selected : [null]).map((entry) => ({ account, entry, model: entry?.model || model || "—" }));
  });
}

export function imageQuotaRowState({ account, model }) {
  return (account.modelPolicies || []).some(policy => policy.model === model && policy.state === "paused")
    && account.routeState !== "account_disabled" ? "manual_paused" : account.routeState;
}

export function filterImageQuotaRows(rows, { provider = "all", status = "all", accountQuery = "" } = {}) {
  const term = accountQuery.trim().toLocaleLowerCase();
  return rows.filter(row => { const { account } = row; return (provider === "all" || account.provider === provider)
    && (status === "all" || imageQuotaRowState(row) === status)
    && (!term || `${account.accountLabel || ""} ${account.connectionId || ""}`.toLocaleLowerCase().includes(term)); });
}

function valueFor(row, key) {
  const { account, entry, model } = row;
  if (key === "account") return `${account.provider}:${account.accountLabel}:${model}`;
  if (key === "state") return imageQuotaRowState(row) || null;
  if (key === "next") {
    const raw = imageNextCheck(account, entry)?.at;
    const timestamp = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (key === "calls24h") return Number.isSafeInteger(entry?.counts?.calls24h) ? entry.counts.calls24h : null;
  if (key === "total") return Number.isSafeInteger(entry?.counts?.callsTotal) ? entry.counts.callsTotal : null;
  return null;
}

export function sortImageQuotaRows(rows, sort) {
  const key = sortableKeys.has(sort?.key) ? sort.key : "account";
  const direction = sort?.direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const left = valueFor(a, key);
    const right = valueFor(b, key);
    if (left === null || right === null) {
      if (left !== right) return left === null ? 1 : -1;
    } else {
      const result = typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
      if (result) return result * direction;
    }
    return a.account.provider.localeCompare(b.account.provider)
      || a.account.connectionId.localeCompare(b.account.connectionId)
      || a.model.localeCompare(b.model);
  });
}

export function groupImageQuotaRows(rows) {
  const providers = new Map();
  for (const row of rows) {
    const provider = row.account.provider;
    if (!providers.has(provider)) providers.set(provider, { provider, rows: [], accounts: new Map() });
    const group = providers.get(provider);
    const key = JSON.stringify([provider, row.account.connectionId]);
    if (!group.accounts.has(key)) group.accounts.set(key, { key, account: row.account, rows: [] });
    group.rows.push(row);
    group.accounts.get(key).rows.push(row);
  }
  return [...providers.values()].map(group => ({ ...group, accounts: [...group.accounts.values()] }));
}

export function imageCardModelRows(account, catalog = []) {
  return imageAccountModels(account, catalog).map(entry => ({
    ...entry,
    wait: imageNextCheck(account, entry),
    estimateText: estimateLabel(entry.estimate),
    recorded: Number.isSafeInteger(entry.counts?.callsTotal) && entry.counts.callsTotal >= 0,
  }));
}
