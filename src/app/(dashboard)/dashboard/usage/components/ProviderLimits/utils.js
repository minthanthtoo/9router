import { partitionRotationRows } from "@/shared/utils/rotationSequence.mjs";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";

// ─── Constants ───────────────────────────────────────────────────────────────
export const QUOTA_CACHE_KEY = "quotaCacheData";
export const REFRESH_INTERVAL_MS = 60000;
// Claude usage/quota endpoint rate-limits; poll it less often than other providers
export const CLAUDE_REFRESH_INTERVAL_MS = 600000;
export const DEPLETED_QUOTA_THRESHOLD = 5;
export const AUTO_REFRESH_STORAGE_KEY = "quotaAutoRefresh";
export const CONNECTIONS_PAGE_SIZE = 20;
export const ACCOUNT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
export const ACCOUNT_PAGE_SIZE_MAX = 500;
export const ACCOUNT_FILTER_OPTIONS = [
  { value: "all", label: "All accounts" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Turned off" },
];
export const QUOTA_SORT_OPTIONS = [
  { key: "session-reset", label: "Session reset", icon: "update", window: "session", kind: "reset", asc: "Earliest first", desc: "Latest first" },
  { key: "weekly-reset", label: "Weekly reset", icon: "event_repeat", window: "weekly", kind: "reset", asc: "Earliest first", desc: "Latest first" },
  { key: "session-remaining", label: "Session left %", icon: "percent", window: "session", kind: "remaining", asc: "Lowest first", desc: "Highest first" },
  { key: "weekly-remaining", label: "Weekly left %", icon: "percent", window: "weekly", kind: "remaining", asc: "Lowest first", desc: "Highest first" },
];

export const QUOTA_DIVISION_OPTIONS = [
  { key: "half", label: "Equal count", short: "½", icon: "splitscreen", detail: "Split the preceding order into two balanced card counts; ties may split." },
  { key: "median", label: "P50 value", short: "P50", icon: "align_center", detail: "Split at the preceding values' median; keep equal values together. Unreported values form a trailing group." },
  { key: "gap", label: "Largest gap", short: "Gap", icon: "expand", detail: "Split at the largest jump in the preceding values; equal values stay together. Unreported values form a trailing group." },
];
export function cycleQuotaDivision(sorts, key) {
  const index = sorts.findIndex(sort => sort.key === key);
  if (index < 1) return sorts;
  return sorts.map((sort, i) => i === index ? { ...sort, division: QUOTA_DIVISION_OPTIONS[(QUOTA_DIVISION_OPTIONS.findIndex(mode => mode.key === (sort.division || "half")) + 1) % QUOTA_DIVISION_OPTIONS.length].key } : sort);
}

function quotaValueRange(rows, index) {
  const values = rows.map(row => row.values[index]).filter(value => value !== null);
  return { min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null, missing: rows.length-values.length };
}

// Boundaries and membership come from the same partition; never recalculate P50 on a child.
export function describeQuotaDivision(ordered, valueIndex, direction, mode = "half") {
  return partitionRotationRows(ordered, valueIndex, direction, mode);
}

export function divideQuotaRows(ordered, valueIndex, direction, mode = "half") {
  return describeQuotaDivision(ordered,valueIndex,direction,mode).map(group=>group.rows);
}

export function formatQuotaSortValue(value, kind) {
  if (value === null || value === undefined) return "Unreported";
  return kind === "reset" ? new Date(value).toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",second:"2-digit"}) : `${Number(value.toFixed(2))}%`;
}
function formatQuotaGap(value, kind) {
  if (kind !== "reset") return `${Number(value.toFixed(2))} pp`;
  const seconds=Math.round(value/1000),days=Math.floor(seconds/86400),hours=Math.floor(seconds%86400/3600),minutes=Math.floor(seconds%3600/60),rest=seconds%60;
  return [days&&`${days}d`,hours&&`${hours}h`,minutes&&`${minutes}m`,rest&&`${rest}s`].filter(Boolean).join(" ") || "<1s";
}
export function quotaSegmentDescription(segment) {
  const rangeText=detail=>{
    const value=n=>formatQuotaSortValue(n,detail.kind);
    const range=detail.min===null?"Unreported":detail.min===detail.max?value(detail.min):`${value(detail.min)}–${value(detail.max)}`;
    return range+(detail.missing&&detail.min!==null?` · ${detail.missing} unreported`:"");
  };
  const details=(segment.boundaries||[]).map(detail=>{
    const value=n=>formatQuotaSortValue(n,detail.kind);
    if(detail.mode==="half")return `${detail.label} · ½ count ${detail.startRank}–${detail.endRank}/${detail.parentCount} · ${rangeText(detail)}`;
    const boundary=detail.mode==="median"?`P50 ${value(detail.threshold)}`:detail.gap?`Gap ${formatQuotaGap(detail.gap.size,detail.kind)} (${value(detail.gap.from)} → ${value(detail.gap.to)})`:"Gap: no distinct values";
    return `${detail.label} · ${boundary} · ${rangeText(detail)}`;
  });
  if(!details.length&&segment.ordering)details.push(`${segment.ordering.label} ${segment.ordering.direction==="asc"?"↑":"↓"} · ${rangeText(segment.ordering)}`);
  return details;
}

export function quotaActiveSegmentIndex(cardTops, edge, listBottom) {
  if(listBottom<=edge)return -1;
  return cardTops.reduce((active,top,index)=>top<=edge+1?index:active,-1);
}

export function quotaSegmentScrollTop({ scrollTop, cardTop, viewportTop, toolbarHeight, segmentHeight, gap }) {
  return Math.max(0,scrollTop+cardTop-viewportTop-toolbarHeight-segmentHeight-gap);
}

export function isQuotaCardCollapsed(state, id) {
  return state.overrides[id] ?? state.all;
}
export function updateQuotaCardCollapse(state, { id, all }) {
  if (typeof all === "boolean") return { all, overrides: {} };
  const collapsed = !isQuotaCardCollapsed(state, id);
  const overrides = { ...state.overrides };
  if (collapsed === state.all) delete overrides[id]; else overrides[id] = collapsed;
  return { ...state, overrides };
}

export function cycleQuotaSort(sorts, key) {
  if (!QUOTA_SORT_OPTIONS.some(option => option.key === key)) return sorts;
  const active = sorts.find(sort => sort.key === key);
  if (!active) return [...sorts, { key, direction: "asc" }];
  if (active.direction === "asc") return sorts.map(sort => sort.key === key ? { ...sort, direction: "desc" } : sort);
  return sorts.filter(sort => sort.key !== key);
}

export function updateQuotaRotationPreview(current, provider, model, sorts, resetPriority) {
  if (current?.provider !== provider) return null;
  return {
    ...current,
    model,
    policy: {
      ...current.policy,
      enabled: sorts.length > 0 || resetPriority.enabled,
      sorts,
      resetPriority,
    },
  };
}

function matchesQuotaWindow(quota, window) {
  if (Number.isSafeInteger(quota.windowSeconds) && quota.windowSeconds > 0) return window === "weekly" ? quota.windowSeconds === 604800 : quota.windowSeconds <= 86400;
  const label = `${quota.quotaType || ""} ${quota.modelKey || ""} ${quota.name || ""}`.replace(/[_-]+/g, " ");
  const weekly = /\b(?:weekly|7d|7\s*days?|seven\s*days?)\b/i.test(label);
  return window === "weekly" ? weekly : !weekly && /\b(?:session|hourly|5h|five\s*hours?|\d+(?:\.\d+)?\s*h|\d+\s*hours?)\b/i.test(label);
}

function finiteQuotaNumber(value) {
  if (value == null || typeof value === "boolean" || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}


// ─── Pure helpers ─────────────────────────────────────────────────────────────
export function withCodexImageQuota(quotas, row, now = Date.now()) {
  if (quotas.some((quota) => /^image(?:_gen|gen_premium)_(?:primary|secondary)$/.test(quota.quotaType || ""))) return quotas;
  const resets = (row?.constraints || [])
    .filter((constraint) => constraint.confidence === "provider_confirmed"
      && ["codex_provider_reset", "codex_usage_window_reset", "provider_retry_after", "provider_image_error"].includes(constraint.source))
    .map((constraint) => Date.parse(constraint.retryAt))
    .filter((time) => Number.isFinite(time) && time > now);
  return [...quotas, {
    name: "Images",
    quotaType: "image_window_unreported",
    used: 0,
    total: 0,
    quotaStatus: "unknown",
    displayUnit: "image_window_unreported",
    resetAt: resets.length ? new Date(Math.max(...resets)).toISOString() : null,
  }];
}

export function getConnectionLabel(connection) {
  return connection.name?.trim()
    || connection.email?.trim()
    || connection.displayName?.trim()
    || null;
}

export function getConnectionQuotaRemaining(connection, quotaData, window = "session") {
  const quotas = quotaData[connection.id]?.quotas || [];
  const primary = quotas.find(quota => quota.quotaType === window && matchesQuotaWindow(quota, window));
  const values = (primary ? [primary] : quotas.filter(quota => matchesQuotaWindow(quota, window)))
    .map(quota => {
      if (quota.quotaStatus === "unknown") return null;
      const percent = finiteQuotaNumber(quota.remainingPercentage);
      if (percent !== null) return Math.max(0, Math.min(100, percent));
      const used = finiteQuotaNumber(quota.used);
      const total = finiteQuotaNumber(quota.total);
      if (used !== null && used >= 0 && total !== null && total > 0) return Math.max(0, Math.min(100, (total - used) / total * 100));
      const remaining = finiteQuotaNumber(quota.remaining);
      return remaining === null ? null : Math.max(0, Math.min(100, remaining));
    }).filter(value => value !== null);
  return values.length ? Math.min(...values) : null;
}

// Stable group-by-provider: first-seen provider order, original order within group.
function groupByProviderStable(connections) {
  const seen = new Map();
  for (const conn of connections) {
    const key = conn.provider || "";
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(conn);
  }
  return Array.from(seen.values()).flat();
}

export function segmentVisibleConnections(connections, quotaData, sorts = [], now = Date.now()) {
  const rules = sorts.map(sort => ({ ...QUOTA_SORT_OPTIONS.find(option => option.key === sort.key), direction: sort.direction, division: sort.division || "half" }))
    .filter(rule => rule.key && ["asc", "desc"].includes(rule.direction));
  const priority = connections.filter(connection => connection.rotationHint);
  const regular = connections.filter(connection => !connection.rotationHint);
  if (!rules.length) return priority.length ? [
    {key:"reset",rotationName:"Expiring credit",connections:priority},
    ...(regular.length ? [{key:"regular",rotationName:"Other accounts",connections:groupByProviderStable(regular)}] : []),
  ] : [{ key: "all", connections: groupByProviderStable(connections) }];
  const rows = connections.map(connection => ({
    connection,
    values: rules.map(rule => {
      if (rule.kind === "remaining") return getConnectionQuotaRemaining(connection, quotaData, rule.window);
      const resets = (quotaData[connection.id]?.quotas || [])
        .filter(quota => matchesQuotaWindow(quota, rule.window) && quota.resetAt)
        .map(quota => new Date(quota.resetAt).getTime())
        .filter(time => Number.isFinite(time) && time > now);
      return resets.length ? Math.min(...resets) : null;
    }),
  }));
  const compare = (index) => (a,b) => {
    const left = a.values[index], right = b.values[index];
    if (left === right) return 0;
    if (left === null || right === null) return left === null ? 1 : -1;
    return (left-right) * (rules[index].direction === "asc" ? 1 : -1);
  };
  const descend = (list, depth, path, boundaries) => {
    if (!list.length) return [];
    const ordered = [...list].sort(compare(depth));
    if (depth + 1 < rules.length && ordered.length > 1) {
      return describeQuotaDivision(ordered, depth, rules[depth].direction, rules[depth+1].division)
        .flatMap(({rows:part,detail},index) => descend(part,depth+1,[...path,index+1],[...boundaries,{...detail,key:rules[depth].key,label:rules[depth].label,kind:rules[depth].kind,direction:rules[depth].direction}]));
    }
    return ordered.length ? [{ key: path.join(".") || "1", connections: ordered.map(row => row.connection), boundaries,
      ordering:{...rules[depth],mode:"half",startRank:1,endRank:ordered.length,parentCount:ordered.length,...quotaValueRange(ordered,depth)} }] : [];
  };
  return priority.length ? [
    ...descend(rows.filter(row => row.connection.rotationHint),0,["reset"],[]).map(segment => ({...segment,rotationName:"Expiring credit"})),
    ...descend(rows.filter(row => !row.connection.rotationHint),0,["regular"],[]).map(segment => ({...segment,rotationName:"Other accounts"})),
  ] : descend(rows,0,[],[]);
}

export function sortVisibleConnections(connections, quotaData, sorts = [], now = Date.now()) {
  return segmentVisibleConnections(connections, quotaData, sorts, now).flatMap(segment => segment.connections);
}

export function buildLoadingState(connections) {
  const nextLoadingState = {};
  connections.forEach((connection) => {
    nextLoadingState[connection.id] = true;
  });
  return nextLoadingState;
}

export function filterQuotaStateByConnections(state, connections) {
  const visibleIds = new Set(connections.map((connection) => connection.id));
  return Object.fromEntries(
    Object.entries(state).filter(([id]) => visibleIds.has(id)),
  );
}

export function getConnectionsPageRange(pagination) {
  if (!pagination.total) {
    return { start: 0, end: 0 };
  }
  const start = (pagination.page - 1) * pagination.pageSize + 1;
  const end = Math.min(pagination.page * pagination.pageSize, pagination.total);
  return { start, end };
}

export function getConnectionsEmptyMessage(totals, providerFilter, accountFilter) {
  if (!totals.eligibleConnections) {
    return {
      icon: "cloud_off",
      title: "No Supported OAuth Quota Accounts",
      description:
        "This section tracks supported OAuth quota accounts. API-key image routing status is shown separately above.",
    };
  }
  if (!totals.providerFilteredConnections) {
    return {
      icon: "filter_alt_off",
      title: "No Accounts Match Current Filters",
      description:
        providerFilter === "all"
          ? "Try changing the account status filter to see more quota trackers."
          : `No ${accountFilter === "inactive" ? "turned off" : accountFilter === "active" ? "active" : "matching"} accounts found for ${providerFilter}.`,
    };
  }
  return {
    icon: "filter_alt_off",
    title: "No Accounts On This Page",
    description:
      "Try moving to another page or refreshing the current filters.",
  };
}

export function sortRequestFromExpiringFirst(expiringFirst) {
  return expiringFirst ? "expiring" : "priority";
}

export function getPageSizeLabel(pageSize, isCustomPageSize) {
  return isCustomPageSize ? `Custom: ${pageSize} / page` : `${pageSize} / page`;
}

export function getConnectionsPaginationSummary(pagination) {
  const { start, end } = getConnectionsPageRange(pagination);
  return `Showing ${start}-${end} of ${pagination.total}`;
}

export function getSafePagination(pagination, fallbackPageSize) {
  return (
    pagination || {
      page: 1,
      pageSize: fallbackPageSize,
      total: 0,
      totalPages: 1,
    }
  );
}

export function getSafeTotals(totals, fallbackTotal = 0) {
  return (
    totals || {
      eligibleConnections: fallbackTotal,
      providerFilteredConnections: fallbackTotal,
    }
  );
}

export function shouldResetPage(previousValue, nextValue) {
  return previousValue !== nextValue;
}

export function getPaginationPageValue(dataPagination, fallbackPage) {
  return dataPagination?.page || fallbackPage;
}

export function getProviderOptions(dataProviderOptions) {
  return dataProviderOptions || [];
}

export async function reconcileConnectionsPage(fetchConnections, targetPage) {
  return await fetchConnections(targetPage);
}

export function getQuotaCache() {
  if (typeof window === "undefined") return {};
  try {
    const cached = window.localStorage.getItem(QUOTA_CACHE_KEY);
    return cached ? JSON.parse(cached) : {};
  } catch (error) {
    console.error("Error reading quota cache:", error);
    return {};
  }
}

export function setQuotaCache(connectionId, quotaEntry) {
  if (typeof window === "undefined") return;
  try {
    const cache = getQuotaCache();
    cache[connectionId] = {
      ...quotaEntry,
      cachedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(QUOTA_CACHE_KEY, JSON.stringify(cache));
  } catch (error) {
    console.error("Error writing quota cache:", error);
  }
}

/**
 * Format ISO date string to countdown format (inspired by vscode-antigravity-cockpit)
 * @param {string|Date} date - ISO date string or Date object
 * @returns {string} Formatted countdown (e.g., "2d 5h 30m", "4h 40m", "15m") or "-"
 */
export function formatResetTime(date) {
  if (!date) return "-";

  try {
    const resetDate = typeof date === "string" ? new Date(date) : date;
    const now = new Date();
    const diffMs = resetDate - now;

    if (diffMs <= 0) return "-";

    const totalMinutes = Math.ceil(diffMs / (1000 * 60));
    
    // < 60 minutes: show only minutes
    if (totalMinutes < 60) {
      return `${totalMinutes}m`;
    }
    
    const totalHours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;
    
    // < 24 hours: show hours and minutes
    if (totalHours < 24) {
      return `${totalHours}h ${remainingMinutes}m`;
    }
    
    // >= 24 hours: show days, hours, and minutes
    const days = Math.floor(totalHours / 24);
    const remainingHours = totalHours % 24;
    return `${days}d ${remainingHours}h ${remainingMinutes}m`;
  } catch (error) {
    return "-";
  }
}

/**
 * Get Tailwind color class based on percentage
 * @param {number} percentage - Remaining percentage (0-100)
 * @returns {string} Color name: "green" | "yellow" | "red"
 */
export function getStatusColor(percentage) {
  if (percentage > 70) return "green";
  if (percentage >= 30) return "yellow";
  return "red"; // 0-29% including 0% (out of quota) - show red
}

/**
 * Get status emoji based on percentage
 * @param {number} percentage - Remaining percentage (0-100)
 * @returns {string} Emoji: "🟢" | "🟡" | "🔴"
 */
export function getStatusEmoji(percentage) {
  if (percentage > 70) return "🟢";
  if (percentage >= 30) return "🟡";
  return "🔴"; // 0-29% including 0% (out of quota) - show red
}

/**
 * Calculate remaining percentage
 * @param {number} used - Used amount
 * @param {number} total - Total amount
 * @returns {number} Remaining percentage (0-100)
 */
export function calculatePercentage(used, total) {
  if (!total || total === 0) return 0;
  if (!used || used < 0) return 100;
  if (used >= total) return 0;

  return Math.round(((total - used) / total) * 100);
}

function hasKnownQuotaUsage(quota) {
  if (!quota || quota.used === null || quota.used === undefined || quota.used === ""
    || quota.total === null || quota.total === undefined || quota.total === "") {
    return false;
  }
  const used = Number(quota.used);
  const total = Number(quota.total);
  return Number.isFinite(used) && used >= 0 && Number.isFinite(total) && total > 0;
}

/** A global connection may be disabled only when every reported quota is empty. */
export function areAllReportedQuotasDepleted(quotas) {
  return Array.isArray(quotas) && quotas.length > 0 && quotas.every((quota) =>
    hasKnownQuotaUsage(quota)
      && calculatePercentage(quota.used, quota.total) <= DEPLETED_QUOTA_THRESHOLD,
  );
}

/** Re-enable only when at least one reported quota explicitly has headroom. */
export function hasReportedQuotaAvailable(quotas) {
  return Array.isArray(quotas) && quotas.some((quota) =>
    hasKnownQuotaUsage(quota)
      && calculatePercentage(quota.used, quota.total) > DEPLETED_QUOTA_THRESHOLD,
  );
}

/**
 * Get remaining percentage from a normalized quota row
 * @param {Object} quota - Normalized quota object
 * @returns {number} Remaining percentage (0-100)
 */
export function getRemainingPercentage(quota) {
  if (quota?.quotaStatus === "unknown") return null;

  if (quota?.remaining !== undefined) {
    return Math.max(0, Math.min(100, Math.round(quota.remaining)));
  }

  if (quota?.remainingPercentage !== undefined) {
    return Math.max(0, Math.min(100, Math.round(quota.remainingPercentage)));
  }

  const percentage = quota?.percentage ?? quota?.colorPercentage;
  if (Number.isFinite(Number(percentage))) {
    const value = Number(percentage);
    return Math.max(0, Math.min(100, Math.round(quota?.percentageIsUsed ? 100 - value : value)));
  }

  return calculatePercentage(quota?.used, quota?.total);
}

export function getQuotaVisibilityKey(quota) {
  if (!quota || typeof quota !== "object") return "";
  return String(quota.modelKey || quota.name || "").trim();
}

/**
 * Trim hidden quota keys to only those matching currently valid quotas.
 * Stale or obsolete model keys are dropped.
 */
export function trimHiddenQuotaKeys(hidden = [], quotas = []) {
  if (!Array.isArray(hidden) || hidden.length === 0) return [];
  const validKeys = new Set(quotas.map(getQuotaVisibilityKey).filter(Boolean));
  return [...new Set(hidden.map((k) => String(k).trim()).filter((k) => validKeys.has(k)))];
}

export function getSharedQuotaVisibilityKey(quota) {
  return getQuotaVisibilityKey(quota).toLowerCase();
}

export function setSharedQuotaVisibility(visibility, quota, visible) {
  const key = getSharedQuotaVisibilityKey(quota);
  if (!key) return visibility;
  return { ...visibility, sharedRows: { ...visibility.sharedRows, [key]: visible } };
}

function isQuotaRowVisible(provider, quota, visibility) {
  const shared = visibility.sharedRows?.[getSharedQuotaVisibilityKey(quota)];
  if (typeof shared === "boolean") return shared;
  return !visibility[provider]?.hidden?.includes(getQuotaVisibilityKey(quota));
}

export function filterQuotasByVisibility(provider, quotas = [], quotaVisibility = {}) {
  if (!Array.isArray(quotas)) return [];
  return quotas.filter(quota => isQuotaRowVisible(provider, quota, quotaVisibility));
}

export function getHiddenQuotaRows(provider, quotas = [], quotaVisibility = {}) {
  if (!Array.isArray(quotas)) return [];
  return quotas.filter(quota => !isQuotaRowVisible(provider, quota, quotaVisibility));
}

/**
 * Parse provider-specific quota structures into normalized array
 * @param {string} provider - Provider name (github, antigravity, codex, kiro, claude)
 * @param {Object} data - Raw quota data from provider
 * @returns {Array<Object>} Normalized quota objects with { name, used, total, resetAt }
 */
export function parseQuotaData(provider, data) {
  if (!data || typeof data !== "object") return [];

  const normalizedQuotas = [];

  try {
    switch (provider.toLowerCase()) {
      case "github":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;

      case "antigravity":
        if (data.quotas) {
          const entries = Object.entries(data.quotas);
          const weeklyKeys = new Set(["gemini_weekly", "claude_gpt_weekly", "gemini_argon_weekly"]);
          const sessionKeys = new Set(["gemini_session", "claude_gpt_session", "gemini_argon_session"]);
          const summaryKeys = new Set([...weeklyKeys, ...sessionKeys]);
          const argonModels = entries.filter(([k]) => k.startsWith("gemini-") && k.includes("argon"));
          const geminiModels = entries.filter(([k]) => k.startsWith("gemini-") && !k.includes("image") && !k.includes("argon"));
          const claudeModels = entries.filter(([k]) => k.startsWith("claude-"));
          const imageModels = entries.filter(([k]) => k.includes("image"));
          const summaryModels = entries.filter(([k]) => summaryKeys.has(k));
          const usageDisplayMetadata = (quota) => ({
            ...(quota.displayUnit ? { displayUnit: quota.displayUnit } : {}),
            ...(quota.quotaStatus ? { quotaStatus: quota.quotaStatus } : {}),
          });
          const otherModels = entries.filter(([k]) => !k.startsWith("gemini-") && !k.startsWith("claude-") && !k.includes("image") && !summaryKeys.has(k));

          // Summary keys from retrieveUserQuotaSummary
          const hasGeminiWeekly = Boolean(data.quotas.gemini_weekly);
          const hasGeminiSession = Boolean(data.quotas.gemini_session);
          const hasArgonWeekly = Boolean(data.quotas.gemini_argon_weekly);
          const hasArgonSession = Boolean(data.quotas.gemini_argon_session);
          const hasClaudeWeekly = Boolean(data.quotas.claude_gpt_weekly);
          const hasClaudeSession = Boolean(data.quotas.claude_gpt_session);

          // 1. Gemini Family (Flash / Pro):
          if (hasGeminiSession) {
            summaryModels.filter(([k]) => k === "gemini_session").forEach(([modelKey, quota]) => {
              normalizedQuotas.push({
                name: quota.displayName || modelKey,
                modelKey,
                used: quota.used || 0,
                total: quota.total || 0,
                resetAt: quota.resetAt || null,
                remainingPercentage: quota.remainingPercentage,
                ...usageDisplayMetadata(quota),
              });
            });
          } else if (geminiModels.length > 0) {
            const rep = geminiModels.reduce((min, cur) =>
              (cur[1].remainingPercentage ?? 100) < (min[1].remainingPercentage ?? 100) ? cur : min
            )[1];
            // Only show synthesized Gemini row if its resetAt differs from weekly (i.e. it represents a separate 5h window)
            const weeklyResetAt = data.quotas.gemini_weekly?.resetAt;
            const isDuplicateOfWeekly = hasGeminiWeekly && rep.resetAt === weeklyResetAt && (rep.remainingPercentage ?? 0) === 0;

            if (!isDuplicateOfWeekly) {
              normalizedQuotas.push({
                name: "Gemini (Flash / Pro)",
                modelKey: "gemini",
                used: rep.used || 0,
                total: rep.total || 0,
                resetAt: rep.resetAt || null,
                remainingPercentage: rep.remainingPercentage,
                ...usageDisplayMetadata(rep),
              });
            }
          }

          // Show Gemini weekly row if present
          if (hasGeminiWeekly) {
            summaryModels.filter(([k]) => k === "gemini_weekly").forEach(([modelKey, quota]) => {
              normalizedQuotas.push({
                name: quota.displayName || modelKey,
                modelKey,
                used: quota.used || 0,
                total: quota.total || 0,
                resetAt: quota.resetAt || null,
                remainingPercentage: quota.remainingPercentage,
                ...usageDisplayMetadata(quota),
              });
            });
          }

          // 1b. Gemini 4 Argon Family (separate quota bucket on Pro plans):
          if (hasArgonSession) {
            summaryModels.filter(([k]) => k === "gemini_argon_session").forEach(([modelKey, quota]) => {
              normalizedQuotas.push({
                name: quota.displayName || modelKey,
                modelKey,
                used: quota.used || 0,
                total: quota.total || 0,
                resetAt: quota.resetAt || null,
                remainingPercentage: quota.remainingPercentage,
              });
            });
          } else if (!hasArgonWeekly && argonModels.length > 0) {
            const rep = argonModels.reduce((min, cur) =>
              (cur[1].remainingPercentage ?? 100) < (min[1].remainingPercentage ?? 100) ? cur : min
            )[1];
            const geminiSessionResetAt = data.quotas.gemini_session?.resetAt;
            const geminiWeeklyResetAt = data.quotas.gemini_weekly?.resetAt;
            const sharesMainGeminiPool =
              (hasGeminiSession && rep.resetAt === geminiSessionResetAt && rep.remainingPercentage === data.quotas.gemini_session?.remainingPercentage) ||
              (hasGeminiWeekly && rep.resetAt === geminiWeeklyResetAt && rep.remainingPercentage === data.quotas.gemini_weekly?.remainingPercentage);

            if (!sharesMainGeminiPool) {
              normalizedQuotas.push({
                name: "Gemini 4 Argon",
                modelKey: "gemini_argon",
                used: rep.used || 0,
                total: rep.total || 0,
                resetAt: rep.resetAt || null,
                remainingPercentage: rep.remainingPercentage,
              });
            }
          }

          if (hasArgonWeekly) {
            summaryModels.filter(([k]) => k === "gemini_argon_weekly").forEach(([modelKey, quota]) => {
              normalizedQuotas.push({
                name: quota.displayName || modelKey,
                modelKey,
                used: quota.used || 0,
                total: quota.total || 0,
                resetAt: quota.resetAt || null,
                remainingPercentage: quota.remainingPercentage,
              });
            });
          }

          // 2. Claude & GPT Family:
          if (hasClaudeSession) {
            summaryModels.filter(([k]) => k === "claude_gpt_session").forEach(([modelKey, quota]) => {
              normalizedQuotas.push({
                name: quota.displayName || modelKey,
                modelKey,
                used: quota.used || 0,
                total: quota.total || 0,
                resetAt: quota.resetAt || null,
                remainingPercentage: quota.remainingPercentage,
                ...usageDisplayMetadata(quota),
              });
            });
          } else if (claudeModels.length > 0) {
            const rep = claudeModels.reduce((min, cur) =>
              (cur[1].remainingPercentage ?? 100) < (min[1].remainingPercentage ?? 100) ? cur : min
            )[1];
            const weeklyResetAt = data.quotas.claude_gpt_weekly?.resetAt;
            const isDuplicateOfWeekly = hasClaudeWeekly && rep.resetAt === weeklyResetAt && (rep.remainingPercentage ?? 0) === 0;

            if (!isDuplicateOfWeekly) {
              normalizedQuotas.push({
                name: "Claude (Sonnet / Opus)",
                modelKey: "claude",
                used: rep.used || 0,
                total: rep.total || 0,
                resetAt: rep.resetAt || null,
                remainingPercentage: rep.remainingPercentage,
                ...usageDisplayMetadata(rep),
              });
            }
          }

          // Show Claude & GPT weekly row if present
          if (hasClaudeWeekly) {
            summaryModels.filter(([k]) => k === "claude_gpt_weekly").forEach(([modelKey, quota]) => {
              normalizedQuotas.push({
                name: quota.displayName || modelKey,
                modelKey,
                used: quota.used || 0,
                total: quota.total || 0,
                resetAt: quota.resetAt || null,
                remainingPercentage: quota.remainingPercentage,
              });
            });
          }

          // 3. Standalone Image Generation Models (unique usage)
          imageModels.forEach(([modelKey, quota]) => {
            normalizedQuotas.push({
              name: quota.displayName || modelKey,
              modelKey,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
              ...usageDisplayMetadata(quota),
            });
          });

          // 4. Other models:
          // In Antigravity, GPT-OSS is explicitly documented by Google as part of the "Claude and GPT models" group:
          // ("Models within this group: Claude Opus, Claude Sonnet, GPT-OSS").
          // When summary quotas (claude_gpt_session / claude_gpt_weekly) are present, GPT-OSS is already represented
          // by the "Claude & GPT" family rows. We only include otherModels if no summary exists for that pool.
          if (!hasClaudeWeekly && !hasClaudeSession) {
            otherModels.forEach(([modelKey, quota]) => {
              normalizedQuotas.push({
                name: quota.displayName || modelKey,
                modelKey,
                used: quota.used || 0,
                total: quota.total || 0,
                resetAt: quota.resetAt || null,
                remainingPercentage: quota.remainingPercentage,
                ...usageDisplayMetadata(quota),
              });
            });
          }
        }
        break;

      case "codex":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([quotaType, quota]) => {
            let displayName = quotaType;
            if (quota.quotaKind === "image_generation" && ["image_gen","imagegen_premium"].includes(quota.limitId)) {
              const seconds=quota.windowSeconds;
              const duration=seconds?seconds%86400===0?`${seconds/86400}d`:seconds%3600===0?`${seconds/3600}h`:seconds%60===0?`${seconds/60}m`:`${seconds}s`:"reported window";
              displayName=`${quota.limitId === "imagegen_premium" ? "Images Premium" : "Images"} (${duration})`;
            }
            else if (Number.isSafeInteger(quota.windowSeconds) && quota.windowSeconds > 0) {
              const seconds = quota.windowSeconds;
              const duration = seconds === 604800 ? "Weekly" : seconds % 86400 === 0 ? `${seconds / 86400}d` : seconds % 3600 === 0 ? `${seconds / 3600}h` : seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
              const family = quotaType.startsWith("spark_") ? "Spark" : quotaType.startsWith("review_") ? "Review" : "";
              displayName = family ? `${family} (${duration})` : duration;
            }
            else if (quotaType === "spark_session") displayName = "Spark (5h)";
            else if (quotaType === "spark_weekly") displayName = "Spark (Weekly)";
            else if (quotaType === "session") displayName = "5h";
            else if (quotaType === "weekly") displayName = "Weekly";
            else if (quotaType === "review_session") displayName = "Review (5h)";
            else if (quotaType === "review_weekly") displayName = "Review (Weekly)";

            normalizedQuotas.push({
              name: displayName,
              quotaType,
              windowSeconds: quota.windowSeconds,
              quotaStatus: quota.quotaStatus,
              ...(quota.quotaKind === "image_generation" ? { displayUnit: "provider_percentage" } : {}),
              used: quota.used || 0,
              total: quota.total || 0,
              remaining: quota.remaining,
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;

      case "kiro":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([quotaType, quota]) => {
            normalizedQuotas.push({
              name: quotaType,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;

      case "qoder":
      case "qoder-cn":
        // Qoder ships a `user` quota, an optional `organization` quota and —
        // when the account has redeemed a free-credit promo — an `addOn`
        // bucket. All share the shape {total, used, remaining, unit, resetAt}.
        // Skip any bucket whose total is 0: `personal_standard` accounts
        // report `user` as 0/0 (their grant lives in `addOn`) and most
        // accounts never have an organization bucket, so rendering "0/0"
        // rows is noise. Buckets holding an actual grant always have
        // total > 0 and are kept.
        // Don't forward Qoder's `remaining` field: it's an absolute credit
        // count, but getRemainingPercentage / QuotaTable interpret
        // `remaining` as a 0-100 percentage and would render 348 credits
        // as "348%". The percentage is computed from used/total instead.
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([quotaType, quota]) => {
            if (!quota || (Number(quota.total) || 0) === 0) {
              return;
            }
            normalizedQuotas.push({
              name:
                quotaType === "user"
                  ? "Personal"
                  : quotaType === "organization"
                    ? "Organization"
                    : quotaType === "addOn"
                      ? "Add-on"
                      : quotaType,
              used: quota.used || 0,
              total: quota.total || 0,
              unit: quota.unit,
              resetAt: quota.resetAt || null,
              // Qoder reports open-ended plans as a 9999 sentinel; the service
              // turns that into neverExpires so the row can read
              // "Never expires" instead of "N/A" or a year-9999 date.
              neverExpires: quota.neverExpires === true,
              // Present on add-on credits: links to Qoder's own usage page.
              detailUrl: quota.detailUrl || null,
            });
          });
        }
        break;

      case "claude":
        if (data.message) {
          // Handle error message case
          normalizedQuotas.push({
            name: "error",
            used: 0,
            total: 0,
            resetAt: null,
            message: data.message,
          });
        } else if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              remaining: quota.remaining !== undefined ? quota.remaining : Math.max(0, (quota.total || 100) - (quota.used || 0)),
              remainingPercentage: quota.remainingPercentage !== undefined ? quota.remainingPercentage : calculatePercentage(quota.used, quota.total),
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;

      case "vercel-ai-gateway":
        // Vercel returns currency credit balance, not request quotas.
        // The 'Remaining (USD)' row needs explicit remainingPercentage because
        // its used/total values would otherwise compute the wrong direction
        // (e.g. used=95.5 / total=100 → 4% instead of 96%).
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
            });
          });
        }
        break;

      case "codebuddy-cn":
      case "codebuddy-intl":
        // CodeBuddy CN/Intl mix recurring refill packs ("Monthly"/"Weekly"/...)
        // with one-shot bonus packs ("Bonus Pack N"). Forward `recurring`
        // so the UI can show "Expires in" for bonus packs (whose resetAt is
        // a hard expiry, not a refresh) instead of "Reset in".
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              recurring: quota.recurring !== false,
            });
          });
        }
        break;

      case "grok-cli":
        // Grok Build credits (on-demand window + prepaid balance).
        // Do NOT forward absolute `remaining` — getRemainingPercentage treats
        // it as a 0–100 percentage (same as Qoder). Use remainingPercentage.
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
            });
          });
        }
        break;

      case "kimi":
        // Weekly / Ratelimit from /v1/usages. Prefer remainingPercentage only.
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
            });
          });
        }
        break;

      case "deepseek":
        // Credit balance — remainingPercentage only (no absolute remaining).
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
              isCreditBalance: quota.isCreditBalance ?? true,
              currency: quota.currency || (name.includes("(") ? name.slice(name.indexOf("(") + 1, name.indexOf(")")) : "USD"),
            });
          });
        }
        break;

      case "cursor":
        // Plan spend is USD (cents from GetCurrentPeriodUsage). Forward
        // remainingPercentage only — do not pass absolute remaining (UI treats it as %).
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
            });
          });
        }
        break;

      case "groq":
        // Requests/Tokens rate-limit windows from response headers — absolute
        // used/total (calculatePercentage derives the bar), like Codex/Kiro.
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;

      case "ollama":
        // Session (5h) / Weekly (7d) / Monthly usage % from ollama.com/api/balance (or /api/usage).
        // remainingPercentage only — no absolute remaining (UI treats remaining as %).
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
              isCreditBalance: quota.isCreditBalance,
              currency: quota.currency,
              unit: quota.unit,
              unlimited: quota.unlimited,
            });
          });
        }
        break;

      case "zed":
        // Edit predictions + optional hosted model_requests; unlimited uses remainingPercentage.
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
              unlimited: quota.unlimited,
            });
          });
        }
        break;

      case "minimax-code":
      case "minimax-code-global":
        // Service already returns dashboard-shaped rows: a credits balance
        // (isCreditBalance → 💰 with the amount as total) plus M Plan rate
        // windows as 0-100 percent rows. Pass through, preserving extras.
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              remaining: quota.remaining,
              remainingPercentage: quota.remainingPercentage,
              resetAt: quota.resetAt || null,
              message: quota.message,
              isCreditBalance: quota.isCreditBalance,
              currency: quota.currency,
            });
          });
        }
        break;

      default:
        // Generic fallback for unknown providers
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name: quota.name || name,
              used: quota.used || 0,
              total: quota.total || 0,
              percentage: quota.percentage,
              colorPercentage: quota.colorPercentage,
              percentageIsUsed: quota.percentageIsUsed === true,
              resetAt: quota.resetAt || null,
              emptyMessage: quota.emptyMessage || null,
            });
          });
        }
    }
  } catch (error) {
    console.error(`Error parsing quota data for ${provider}:`, error);
    return [];
  }

  if (provider?.toLowerCase() === "claude") {
    const CLAUDE_QUOTA_ORDER = {
      "session (5h)": 0,
      "weekly (7d)": 1,
      "weekly fable (7d)": 2,
      "weekly opus (7d)": 3,
      "weekly sonnet (7d)": 4,
    };
    normalizedQuotas.sort((a, b) => (CLAUDE_QUOTA_ORDER[a.name] ?? 99) - (CLAUDE_QUOTA_ORDER[b.name] ?? 99));
    return normalizedQuotas;
  }

  // Sort quotas according to PROVIDER_MODELS order
  const modelOrder = getModelsByProviderId(provider);
  if (modelOrder.length > 0) {
    const orderMap = new Map(modelOrder.map((m, i) => [m.id, i]));
    
    normalizedQuotas.sort((a, b) => {
      // Use modelKey for antigravity (mapped to family anchor), otherwise use name
      let keyA = a.modelKey || a.name;
      let keyB = b.modelKey || b.name;
      if (keyA === "gemini_argon" || keyA === "gemini_argon_session") keyA = "gemini-4-argon-high";
      if (keyA === "gemini" || keyA === "gemini_session") keyA = "gemini-3.8-flash-high";
      if (keyA === "claude" || keyA === "claude_gpt_session") keyA = "claude-sonnet-4-6";
      if (keyB === "gemini_argon" || keyB === "gemini_argon_session") keyB = "gemini-4-argon-high";
      if (keyB === "gemini" || keyB === "gemini_session") keyB = "gemini-3.8-flash-high";
      if (keyB === "claude" || keyB === "claude_gpt_session") keyB = "claude-sonnet-4-6";
      const orderA = orderMap.get(keyA) ?? 999;
      const orderB = orderMap.get(keyB) ?? 999;
      return orderA - orderB;
    });
  }

  return normalizedQuotas;
}
