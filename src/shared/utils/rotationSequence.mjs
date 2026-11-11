import { CODEX_REVIEW_SUFFIX } from "../../../open-sse/providers/models/helpers.js";
import { canonicalTextModel } from './textModelPermission.mjs';
// Shared by the account inspector and request routing; never performs provider actions.
export const ROTATION_VERSION = 1;
export const SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;
export const DIVISIONS = ['half', 'median', 'gap'];
export const RESET_GROUPS = [
  {key:'reset',label:'Reset · Matches'},
  {key:'reset-other',label:'Reset · Outside criteria'},
  {key:'regular',label:'No reset credits'},
];
const WINDOWS = {
  codex: ['session', 'weekly'], claude: ['session', 'weekly'], antigravity: ['session', 'weekly', 'model'],
  'gemini-cli': ['model'], minimax: ['session', 'weekly'], 'minimax-cn': ['session', 'weekly'],
  'minimax-code': ['session', 'weekly'], 'minimax-code-global': ['session', 'weekly'],
  glm: ['session', 'weekly'], 'glm-cn': ['session', 'weekly'], kimi: ['weekly', 'rolling'],
  'opencode-go': ['rolling', 'weekly', 'monthly'], 'opencode-zen': ['rolling', 'weekly', 'monthly'],
  github: ['cycle'], kiro: ['cycle'], ollama: ['session', 'weekly', 'monthly'],
  'xiaomi-mimo': ['weekly'], commandcode: ['session', 'weekly'], 'codebuddy-cn': ['cycle'],
  'codebuddy-intl': ['cycle'],
};
const LABELS = { session: 'Short window', weekly: 'Weekly', monthly: 'Monthly', daily: 'Daily', cycle: 'Plan period', rolling: 'Rolling', model: 'Model quota' };
export function rotationMetrics(provider) {
  return (WINDOWS[provider] || []).flatMap(window => ['remaining', 'reset'].map(kind => ({
    key: `${window}-${kind}`, window, kind, label: `${LABELS[window]} ${kind === 'remaining' ? 'left %' : 'reset'}`,
    icon: kind === 'remaining' ? 'percent' : 'hourglass_empty',
  }))).filter(metric => !(provider === 'ollama' && metric.kind === 'reset'));
}
export function emptyRotation() { return { version: ROTATION_VERSION, enabled: false, sorts: [], resetPriority: { enabled: false, days: 3, weeklyBelow: null } }; }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysOnly = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
export function validateRotation(value, provider) {
  if (!keysOnly(value, ['version', 'enabled', 'sorts', 'resetPriority', 'groupAvailability']) || value.version !== ROTATION_VERSION || typeof value.enabled !== 'boolean' || !Array.isArray(value.sorts) || value.sorts.length > rotationMetrics(provider).length) throw new TypeError('Invalid rotation sequence');
  if (value.groupAvailability !== undefined && typeof value.groupAvailability !== 'boolean') throw new TypeError('Invalid availability grouping');
  const allowed = new Set(rotationMetrics(provider).map(metric => metric.key)), seen = new Set();
  const sorts = value.sorts.map(sort => {
    if (!keysOnly(sort, ['key', 'direction', 'division']) || !allowed.has(sort.key) || seen.has(sort.key) || !['asc', 'desc'].includes(sort.direction) || !DIVISIONS.includes(sort.division)) throw new TypeError('Unsupported or duplicate sort');
    seen.add(sort.key); return { key: sort.key, direction: sort.direction, division: sort.division };
  });
  const priority = value.resetPriority;
  if (!keysOnly(priority, ['enabled', 'days', 'weeklyBelow', 'autoReset']) || typeof priority.enabled !== 'boolean' || !Number.isInteger(priority.days) || priority.days < 1 || priority.days > 30 || !(priority.weeklyBelow === null || typeof priority.weeklyBelow === 'number' && Number.isFinite(priority.weeklyBelow) && priority.weeklyBelow >= 0 && priority.weeklyBelow <= 100) || priority.autoReset !== undefined && typeof priority.autoReset !== 'boolean' || priority.enabled && provider !== 'codex') throw new TypeError('Invalid reset-credit priority');
  if (value.enabled && !sorts.length && !priority.enabled) throw new TypeError('Choose a sort or reset priority');
  return { version: ROTATION_VERSION, enabled: value.enabled, sorts, resetPriority: { ...priority }, ...(value.groupAvailability === undefined ? {} : { groupAvailability: value.groupAvailability }) };
}
export function availabilityGrouping(policy) { return policy.groupAvailability ?? policy.sorts.length > 1; }
export function updateRotationSorts(policy, sorts) {
  return { ...policy, sorts, ...(policy.sorts.length < 2 && sorts.length > 1 ? { groupAvailability: true } : {}) };
}
export function cycleRotationSort(sorts, key) {
  const active = sorts.find(sort => sort.key === key);
  return !active ? [...sorts, { key, direction: 'asc', division: 'half' }] : active.direction === 'asc' ? sorts.map(sort => sort.key === key ? { ...sort, direction: 'desc' } : sort) : sorts.filter(sort => sort.key !== key);
}
// Shared partition semantics with the existing visual sequence.
export function partitionRotationRows(ordered, valueIndex, direction, mode = 'half') {
  const known = ordered.filter(row => row.values[valueIndex] !== null), missing = ordered.filter(row => row.values[valueIndex] === null);
  const values = known.map(row => row.values[valueIndex]).sort((a, b) => a - b);
  let threshold = null, gap = null, groups;
  if (mode === 'half') { const middle = Math.ceil(ordered.length / 2); groups = [ordered.slice(0, middle), ordered.slice(middle)]; }
  else {
    if (mode === 'gap') {
      for (let index = 1; index < values.length; index++) {
        const size = values[index] - values[index - 1];
        if (size > (gap?.size || 0)) { gap = { from: values[index - 1], to: values[index], size }; threshold = values[index - 1]; }
      }
    } else if (values.length) { const middle = Math.floor(values.length / 2); threshold = values.length % 2 ? values[middle] : values[middle - 1] + (values[middle] - values[middle - 1]) / 2; }
    groups = threshold === null ? [known] : [known.filter(row => row.values[valueIndex] <= threshold), known.filter(row => row.values[valueIndex] > threshold)];
    if (direction === 'desc') groups.reverse(); groups.push(missing);
  }
  let rank = 0;
  return groups.filter(rows => rows.length).map(rows => {
    const startRank = rank + 1; rank += rows.length;
    const present = rows.map(row => row.values[valueIndex]).filter(value => value !== null);
    return { rows, detail: { mode, threshold, gap, parentCount: ordered.length, startRank, endRank: rank, min: present.length ? Math.min(...present) : null, max: present.length ? Math.max(...present) : null, missing: rows.length - present.length } };
  });
}
const number = value => (typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null;
const timestamp = value => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export function normalizeRotationUsage(provider, usage, observedAt = Date.now(), creditDetails = null) {
  const quotas = [];
  for (const [id, quota] of Object.entries(usage?.quotas || {})) {
    if (!object(quota) || quota.unlimited || quota.quotaStatus === 'unknown' || quota.quotaConfidence === 'unknown') continue;
    const lower = id.toLowerCase(); let window = null, scope = '*';
    if (provider === 'codex') {
      const image = quota.quotaKind==='image_generation' && ['image_gen','imagegen_premium'].includes(quota.limitId);
      if(image){
        if(quota.windowSeconds===604800) window='weekly';
        else if(quota.windowSeconds>0&&quota.windowSeconds<=86400) window='session';
        else continue;
        scope='codex:image';
      } else {
      if (!/^(?:(?:spark|review)_)?(?:session|weekly)$/.test(id)) continue;
      window = id.endsWith('weekly') ? 'weekly' : 'session';
      if (quota.windowSeconds > 0) { if (quota.windowSeconds === 604800) window = 'weekly'; else if (quota.windowSeconds <= 86400) window = 'session'; else continue; }
      scope = id.startsWith('spark_') ? 'codex:spark' : id.startsWith('review_') ? 'codex:review' : 'codex:main';
      }
    } else if (provider === 'antigravity') {
      if (/^(?:gemini|claude_gpt)_(?:session|weekly)$/.test(id)) { window = id.endsWith('weekly') ? 'weekly' : 'session'; scope = id.startsWith('gemini') ? 'ag:gemini' : 'ag:claude-gpt'; }
      else { window = 'model'; scope = `model:${id}`; }
    } else if (provider === 'gemini-cli') { window = 'model'; scope = `model:${id}`; }
    else if (provider === 'github') { window = 'cycle'; scope = id === 'chat' && !usage.quotas.premium_interactions ? '*' : `bucket:${id}`; }
    else if (provider.startsWith('codebuddy-')) { if (quota.recurring !== true) continue; window = 'cycle'; }
    else if (provider === 'kiro') { if (/trial|bonus|overage/i.test(id)) continue; window = 'cycle'; }
    else {
      window = /weekly|7d|7 days/.test(lower) ? 'weekly' : /monthly/.test(lower) ? 'monthly' : /daily/.test(lower) ? 'daily' : /rolling|ratelimit/.test(lower) ? 'rolling' : /session|\bhour|\b\d+h\b/.test(lower) ? 'session' : null;
      if (provider === 'claude') { const match = lower.match(/^weekly (.+) \(7d\)$/); if (match) scope = `family:${match[1]}`; }
      if (['minimax', 'minimax-cn', 'minimax-code', 'minimax-code-global'].includes(provider)) {
        const family = id.replace(/\s*(?:\((?:5h|7d)\)|·.*$)/gi, '').trim().toLowerCase();
        if (family && !/^(general|weekly|session|5h|7 days|\d+ hours)$/.test(family)) scope = `family:${family}`;
      }
    }
    if (!window || !(WINDOWS[provider] || []).includes(window)) continue;
    const total = number(quota.total), used = number(quota.used), left = number(quota.remaining), percentage = number(quota.remainingPercentage);
    let remaining = percentage !== null ? percentage : total > 0 && left !== null ? left / total * 100 : total > 0 && used !== null ? (total - used) / total * 100 : null;
    if (remaining !== null && (remaining < 0 || remaining > 100)) remaining = null;
    const resetAt = provider === 'ollama' || /bonus|trial/i.test(id) ? null : timestamp(quota.resetAt);
    quotas.push({ id, window, scope, remaining, resetAt, windowSeconds: number(quota.windowSeconds) });
  }
  const credits = creditDetails && Array.isArray(creditDetails.credits) ? {
    availableCount: number(creditDetails.availableCount),
    expiresAt: creditDetails.credits.filter(credit => credit.status === 'available').map(credit => timestamp(credit.expiresAt)).filter(time => time !== null && time > observedAt).sort((a, b) => a - b)[0] ?? null,
  } : null;
  return { provider, observedAt: timestamp(usage?.observedAt) ?? observedAt, quotas, credits };
}
export function scopeMatches(provider, scope, model) {
  const lower = canonicalTextModel(provider, model).toLowerCase();
  if (scope === '*') return true;
  if (scope === 'codex:main') return !lower.endsWith(CODEX_REVIEW_SUFFIX) && !/(?:^|[-_])spark(?:$|[-_])|image/.test(lower);
  if (scope === 'codex:image') return /image/.test(lower);
  if (scope === 'codex:spark') return lower.includes('spark');
  if (scope === 'codex:review') return lower.endsWith(CODEX_REVIEW_SUFFIX);
  if (!lower) return false;
  if (scope === 'ag:gemini') return lower.startsWith('gemini');
  if (scope === 'ag:claude-gpt') return /^(claude|gpt)/.test(lower);
  if (scope.startsWith('model:')) return lower === scope.slice(6).toLowerCase();
  if (scope.startsWith('family:')) return lower.replace(/[^a-z0-9]/g, '').includes(scope.slice(7).replace(/[^a-z0-9]/g, ''));
  // Copilot premium interactions are relevant to routed chat; other buckets are not interchangeable.
  return provider === 'github' && scope === 'bucket:premium_interactions';
}
export function applicableRotationQuotas(snapshot, provider, model, now = Date.now()) {
  if (!snapshot || snapshot.provider !== provider || !Number.isFinite(snapshot.observedAt) || now < snapshot.observedAt || now - snapshot.observedAt > SNAPSHOT_MAX_AGE_MS) return [];
  return snapshot.quotas.filter(quota => scopeMatches(provider, quota.scope, model) && (quota.resetAt === null || quota.resetAt > now));
}
export function rotationValue(snapshot, metric, provider, model, now) {
  const values = applicableRotationQuotas(snapshot, provider, model, now).filter(quota => quota.window === metric.window).map(quota => metric.kind === 'remaining' ? quota.remaining : quota.resetAt).filter(value => value !== null);
  return values.length ? Math.min(...values) : null;
}
export function resetCreditPriority(connection, snapshot, policy, { provider, model = '', now = Date.now() }) {
  if (!policy?.enabled || !policy.resetPriority?.enabled || !scopeMatches(provider, 'codex:main', model)) return false;
  const credits = snapshot?.credits;
  const fresh = snapshot?.provider === provider && Number.isFinite(snapshot.observedAt) && now >= snapshot.observedAt && now - snapshot.observedAt <= SNAPSHOT_MAX_AGE_MS;
  const weekly = rotationValue(snapshot, { window: 'weekly', kind: 'remaining' }, provider, model, now);
  return Boolean(fresh && credits?.availableCount > 0 && Number.isFinite(credits.observedAt) && now >= credits.observedAt && now - credits.observedAt <= SNAPSHOT_MAX_AGE_MS && credits.expiresAt > now && credits.expiresAt <= now + policy.resetPriority.days * 86400000 && (policy.resetPriority.weeklyBelow === null || weekly !== null && weekly <= policy.resetPriority.weeklyBelow));
}

export function evaluateRotation(connections, snapshots, policy, { provider, model = '', now = Date.now(), onStep, includeExhausted = false }) {
  policy = validateRotation(policy, provider);
  const metrics = rotationMetrics(provider), rules = policy.sorts.map(sort => ({ ...metrics.find(metric => metric.key === sort.key), ...sort }));
  const rows = connections.map(connection => {
    const snapshot = snapshots[connection.id];
    const fresh = snapshot?.provider === provider && Number.isFinite(snapshot.observedAt) && now >= snapshot.observedAt && now - snapshot.observedAt <= SNAPSHOT_MAX_AGE_MS;
    const expiry = fresh && snapshot.credits?.availableCount > 0 && snapshot.credits.expiresAt > now && Number.isFinite(snapshot.credits.observedAt) && now >= snapshot.credits.observedAt && now - snapshot.credits.observedAt <= SNAPSHOT_MAX_AGE_MS ? snapshot.credits.expiresAt : null;
    const urgent = resetCreditPriority(connection, snapshot, policy, { provider, model, now });
    const resetGroup = policy.enabled && policy.resetPriority.enabled && provider === 'codex' && scopeMatches(provider,'codex:main',model) ? urgent ? 'reset' : expiry ? 'reset-other' : 'regular' : null;
    return { connection, values: rules.map(rule => rotationValue(snapshot, rule, provider, model, now)), urgent, expiry, fresh, resetGroup };
  });
  const segments = [], waiting = [];
  const urgent = rows.filter(row => row.urgent).sort((a,b)=>a.expiry-b.expiry);
  const regular = rows.filter(row => !row.urgent);
  const creditGroups = RESET_GROUPS.map(({key,label})=>({
    path:key,
    note:label,
    rows:rows.filter(row=>row.resetGroup===key).sort((a,b)=>(a.expiry??Infinity)-(b.expiry??Infinity)),
    boundaries:[],
  })).filter(group=>group.rows.length);
  onStep?.({ initial: true, rows, urgent, regular, creditGroups });
  const descend = (group, depth, path, boundaries) => {
    const rule = rules[depth];
    const skipped = !rule || group.every(row => row.values[depth] === null);
    const ordered = skipped ? group : [...group].sort((a, b) => a.values[depth] === b.values[depth] ? 0 : a.values[depth] === null ? 1 : b.values[depth] === null ? -1 : (a.values[depth] - b.values[depth]) * (rule.direction === 'asc' ? 1 : -1));
    // Demote after the first ordering, before a split can let exhausted rows change its boundary.
    const waitingRows = !includeExhausted && depth === 0 ? ordered.filter(row => !(row.urgent && policy.resetPriority.autoReset) && rotationValue(snapshots[row.connection.id], { window: 'session', kind: 'remaining' }, provider, model, now) === 0) : [];
    waiting.push(...waitingRows.map(row => ({ ...row, reason: 'Short window exhausted' })));
    const ready = waitingRows.length ? ordered.filter(row => !waitingRows.includes(row)) : ordered;
    const children = rule && !skipped && depth + 1 < rules.length && ready.length > 1 ? partitionRotationRows(ready, depth, rule.direction, rules[depth + 1].division).map(({ rows, detail }, index) => ({ rows, path: `${path}.${index + 1}`, boundaries: [...boundaries, { ...detail, label: rule.label, kind: rule.kind, key: rule.key, direction: rule.direction }] })) : null;
    onStep?.({ depth, path, rows: ordered, ready, waiting: waitingRows, boundaries, children, skipped });
    if (children) children.forEach(child => descend(child.rows, depth + 1, child.path, child.boundaries));
    else if (rule && depth + 1 < rules.length) descend(ready, depth + 1, path, boundaries);
    else if (ready.length) segments.push({ key: path, rows: ready, boundaries, resetGroup:ready[0].resetGroup });
  };
  if (!policy.enabled) { if (rows.length) segments.push({ key: 'regular', rows, boundaries: [] }); }
  else {
    if (creditGroups.length) creditGroups.forEach(group=>descend(group.rows,0,group.path,group.boundaries));
    else descend(rows, 0, 'regular', []);
  }
  const hasEvidence = rows.some(row => row.urgent || row.values.some(value => value !== null));
  return { hasEvidence, segments, waiting, ranked: segments.flatMap(segment => segment.rows), candidates: segments[0]?.rows.map(row => row.connection) || [], staleCount: rows.filter(row => !row.fresh).length };
}

export function legacyRotationNext(connections, strategy, stickyRequests) {
  if (!connections.length) return null;
  if (strategy !== 'round-robin') return connections[0];
  const priority = (a, b) => (a.priority || 999) - (b.priority || 999);
  const recent = [...connections].sort((a, b) => !a.lastUsedAt && !b.lastUsedAt ? priority(a, b) : !a.lastUsedAt ? 1 : !b.lastUsedAt ? -1 : Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))[0];
  if (recent.lastUsedAt && (recent.consecutiveUseCount || 0) < stickyRequests) return recent;
  return [...connections].sort((a, b) => !a.lastUsedAt && !b.lastUsedAt ? priority(a, b) : !a.lastUsedAt ? -1 : !b.lastUsedAt ? 1 : Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt))[0];
}
