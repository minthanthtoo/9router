import { SNAPSHOT_MAX_AGE_MS, applicableRotationQuotas, scopeMatches, rotationValue, rotationMetrics } from './rotationSequence.mjs';

export function rotationPreviewInfo(pool, snapshots, policy, { provider, model, now }) {
  const rows = [...pool.ranked, ...(pool.waiting || [])];
  const deadlines = [now + 60000];
  const quality = { missing: 0, old: 0, unreported: 0 };
  for (const row of rows) {
    const snapshot = snapshots[row.connection.id];
    if (!snapshot) quality.missing++;
    else if (!row.fresh) quality.old++;
    else if (row.values.some(value => value === null)) quality.unreported++;
    if (!row.fresh) continue;
    deadlines.push(snapshot.observedAt + SNAPSHOT_MAX_AGE_MS);
    for (const quota of applicableRotationQuotas(snapshot, provider, model, now)) if (quota.resetAt > now) deadlines.push(quota.resetAt);
    if (policy.resetPriority.enabled && snapshot.credits) {
      if (snapshot.credits.observedAt + SNAPSHOT_MAX_AGE_MS > now) deadlines.push(snapshot.credits.observedAt + SNAPSHOT_MAX_AGE_MS);
      if (snapshot.credits.expiresAt > now) deadlines.push(snapshot.credits.expiresAt);
      const entersWindow = snapshot.credits.expiresAt - policy.resetPriority.days * 86400000;
      if (entersWindow > now) deadlines.push(entersWindow);
    }
  }
  for (const { connection } of pool.blocked || []) {
    const snapshot = snapshots[connection.id];
    if (!snapshot || snapshot.observedAt > now || now - snapshot.observedAt > SNAPSHOT_MAX_AGE_MS) continue;
    deadlines.push(snapshot.observedAt + SNAPSHOT_MAX_AGE_MS);
    for (const quota of applicableRotationQuotas(snapshot, provider, model, now)) if (quota.resetAt > now) deadlines.push(quota.resetAt);
  }
  const sessionDurations = rows.flatMap(row => applicableRotationQuotas(snapshots[row.connection.id], provider, model, now).filter(quota => quota.window === 'session').map(quota => quota.windowSeconds)).filter(value => value > 0);
  const sessionLabel = sessionDurations.length && sessionDurations.every(value => value === sessionDurations[0]) && sessionDurations[0] % 3600 === 0 ? `${sessionDurations[0] / 3600}h` : 'Session';
  const creditApplicable = provider === 'codex' && scopeMatches(provider, 'codex:main', model);
  return {
    validUntil: Math.min(...deadlines), quality, sessionLabel,
    selectedCount: policy.enabled && pool.hasEvidence ? pool.candidates.length : pool.ranked.length,
    waitingCount: pool.waiting?.length || 0,
    groups: [...pool.segments, ...(pool.waiting?.length ? [{ rows: pool.waiting, boundaries: [], waiting: true }] : [])].map((segment, index) => ({ segment: index + 1, count: segment.rows.length, priority: Boolean(segment.rows[0]?.urgent), boundaries: segment.boundaries, waiting: Boolean(segment.waiting) })),
    creditSummary: { applicable: creditApplicable, nextExpiry: rows.filter(row => row.fresh).map(row => snapshots[row.connection.id]?.credits).filter(credits => credits?.availableCount > 0 && credits.observedAt <= now && now - credits.observedAt <= SNAPSHOT_MAX_AGE_MS && credits.expiresAt > now).map(credits => credits.expiresAt).sort((a,b) => a-b)[0] ?? null, matching: rows.filter(row => row.urgent).length, ready: pool.ranked.filter(row => row.urgent).length, waiting: (pool.waiting || []).filter(row => row.urgent).length, unavailable: creditApplicable ? rows.filter(row => {
      const credits = snapshots[row.connection.id]?.credits;
      return !row.fresh || !credits || !(credits.observedAt <= now && now - credits.observedAt <= SNAPSHOT_MAX_AGE_MS) || credits.availableCount === null || credits.availableCount > 0 && (!credits.expiresAt || policy.resetPriority.weeklyBelow !== null && rotationValue(snapshots[row.connection.id], { window: 'weekly', kind: 'remaining' }, provider, model, now) === null);
    }).length : 0 },
  };
}
export function previewIsCurrent(preview, context, previewContext, now) {
  return Boolean(preview && context === previewContext && Number.isFinite(preview.validUntil) && now < preview.validUntil);
}
export function rotationMetricLabel(metric, sessionLabel = 'Session') {
  const label = metric.window === 'session' ? sessionLabel : metric.label.replace(/ (?:left %|reset)$/, '');
  return `${label} ${metric.kind === 'remaining' ? 'remaining' : 'reset'}`;
}
export function rotationDirection(metric, direction) {
  return metric.kind === 'reset' ? direction === 'asc' ? 'Soonest first' : 'Latest first' : direction === 'asc' ? 'Low first' : 'High first';
}

// Replay observations emitted by the real evaluator; never reconstruct the sorting algorithm.
export function rotationStages(events, policy) {
  const initial = events.find(event => event.initial);
  if (!initial) return [];
  const pack = group => ({ key: group.path, ids: group.rows.map(row => row.connection.id), boundaries: group.boundaries || [], note: group.note || null, waiting: Boolean(group.waiting) });
  const stages = [{ id: 'eligible', type: 'eligible', label: 'Eligible', groups: [pack({ path: 'eligible', rows: initial.rows })] }];
  if (!policy.enabled) return stages;
  let groups = [...(initial.creditGroups || [{path:'reset',rows:initial.urgent,boundaries:[]}]), { path: 'regular', rows: initial.regular, boundaries: [] }].filter(group => group.rows.length);
  if (policy.resetPriority.enabled) stages.push({ id: 'credits', type: 'credits', label: '1 Credit expiry', groups: groups.map(pack) });
  const waiting = [];
  const packed = () => [...groups.map(pack), ...waiting.map(pack)];
  const demote = () => {
    groups = groups.map(group => {
      const event = events.find(event => !event.initial && event.depth === 0 && event.path === group.path);
      if (event?.waiting.length) waiting.push({ path: `waiting-${group.path}`, rows: event.waiting, boundaries: [], waiting: true, note: 'Short window exhausted · not dispatchable' });
      return event ? { ...group, rows: event.ready, event } : group;
    }).filter(group => group.rows.length);
    stages.push({ id: 'waiting', type: 'waiting', label: 'Waiting', groups: packed() });
  };
  if (!policy.sorts.length) demote();
  for (let depth = 0; depth < policy.sorts.length; depth++) {
    const rule = policy.sorts[depth];
    groups = groups.map(group => {
      const event = events.find(event => !event.initial && event.depth === depth && event.path === group.path);
      return event ? { ...group, rows: event.rows, note: event.skipped ? 'No ordering: quota not reported' : null, event } : { ...group, note: group.rows.length === 1 ? 'One account: order unchanged' : group.note, event: null };
    });
    stages.push({ id: `sort-${depth}`, type: 'sort', rule, ruleIndex: depth, label: `Rule ${depth + 1 + Number(policy.resetPriority.enabled)}`, groups: packed() });
    if (depth === 0) demote();
    if (depth + 1 < policy.sorts.length) {
      groups = groups.flatMap(group => group.event?.children || [{ ...group, note: group.note || 'No split: one account' }]);
      stages.push({ id: `split-${depth + 1}`, type: 'split', rule, ruleIndex: depth, division: policy.sorts[depth + 1].division, label: `Split before ${depth + 2 + Number(policy.resetPriority.enabled)}`, groups: [...groups.map(group => ({ ...pack(group), note: group.rows.length > 1 && group.boundaries.at(-1)?.min === group.boundaries.at(-1)?.max && policy.sorts[depth + 1].division !== 'half' ? 'No value split: values equal' : group.note || null })), ...waiting.map(pack)] });
    }
  }
  return stages;
}
export function rotationMeasurements(snapshot, provider, model, now) {
  return Object.fromEntries(rotationMetrics(provider).map(metric => [metric.key, rotationValue(snapshot, metric, provider, model, now)]));
}
export function quotaScopeSummary(snapshot, provider, model, now) {
  const scopes = [...new Set(applicableRotationQuotas(snapshot, provider, model, now).map(quota => quota.scope))];
  if (!scopes.length) return 'Quota scope not reported';
  if (scopes.includes('codex:main')) return 'Main Codex allowance · shared across supported main text models';
  if (scopes.includes('codex:image')) return 'Image allowance · separate from text';
  if (scopes.includes('codex:spark')) return 'Spark allowance · separate from main Codex';
  if (scopes.includes('codex:review')) return 'Review allowance · separate from main Codex';
  return scopes.map(scope => scope === '*' ? 'Shared account allowance' : scope.startsWith('model:') ? `Model allowance: ${scope.slice(6)}` : scope.startsWith('family:') ? `Shared model family: ${scope.slice(7)}` : scope.startsWith('ag:') ? `Shared ${scope.slice(3)} allowance` : `Allowance scope: ${scope}`).join(' · ');
}
export function resetAxis(values, now, horizon) {
  const offsets = values.filter(value => Number.isFinite(value) && value > now).map(value => value - now);
  const max = horizon || Math.max(3600000, ...offsets);
  return { horizon: max, ticks: [0, .25, .5, .75, 1].map(fraction => ({ fraction, time: now + max * fraction })), points: values.map(value => value === null || !Number.isFinite(value) ? null : ({ position: Math.min(1, Math.max(0, (value - now) / max)), offScale: value - now > max, due: value <= now })) };
}
