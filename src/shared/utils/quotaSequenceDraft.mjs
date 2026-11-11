import { emptyRotation, rotationMetrics, validateRotation } from './rotationSequence.mjs';
export const QUOTA_DIVISION_OPTIONS = [
  { key: 'half', label: 'Equal count', short: '½', icon: 'splitscreen', detail: 'Split the preceding order into two balanced card counts; ties may split.' },
  { key: 'median', label: 'P50 value', short: 'P50', icon: 'align_center', detail: 'Split at the preceding values’ median; keep equal values together. Unreported values form a trailing group.' },
  { key: 'gap', label: 'Largest gap', short: 'Gap', icon: 'expand', detail: 'Split at the largest jump in the preceding values; equal values stay together. Unreported values form a trailing group.' },
];
export function quotaSequencePolicy(provider, sorts, resetPriority, groupAvailability) {
  const allowed = new Set(rotationMetrics(provider).map(metric => metric.key));
  if (!allowed.size) throw new TypeError('Quota rotation is unavailable');
  const unsupported = sorts.filter(sort => !allowed.has(sort.key));
  if (unsupported.length) throw new TypeError(`Unsupported: ${unsupported.map(sort => sort.key.replace('-remaining',' remaining').replace('-reset',' reset')).join(', ')}`);
  return validateRotation({ ...emptyRotation(), enabled: true, ...(groupAvailability === undefined ? {} : {groupAvailability}), sorts: sorts.map(sort => ({...sort, division: sort.division || 'half'})), resetPriority: provider === 'codex' ? resetPriority : emptyRotation().resetPriority },provider);
}
export function sameQuotaSequence(a,b) { return JSON.stringify(a) === JSON.stringify(b); }
export function rotationPublishReady(row, now = Date.now()) {
  return Boolean(row?.revision && row.preview?.validUntil > now && !row.error && !row.loading && !['saving','applied','uncertain','conflict'].includes(row.status));
}
