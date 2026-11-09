import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyRotation, evaluateRotation, SNAPSHOT_MAX_AGE_MS } from '../../src/shared/utils/rotationSequence.mjs';
import { rotationPreviewInfo, rotationStages } from '../../src/shared/utils/rotationPreview.mjs';
import { rotationPool } from '../../src/sse/services/providerRotation.js';
const now = Date.parse('2026-11-07T00:00:00Z');
const connections = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }));
const policy = { ...emptyRotation(), enabled: true, sorts: [{ key: 'weekly-remaining', direction: 'asc', division: 'half' }, { key: 'session-remaining', direction: 'desc', division: 'half' }] };
const snapshot = (short, weekly = 50, extra = {}) => ({ provider: 'codex', observedAt: now, quotas: [ { window: 'session', scope: 'codex:main', remaining: short, resetAt: now + 5000 }, { window: 'weekly', scope: 'codex:main', remaining: weekly, resetAt: now + 86400000 } ], ...extra });
const ids = rows => rows.map(row => row.connection.id);
const context = { provider: 'codex', model: 'gpt-6.1', now };
function run(snapshots, config = policy, rows = connections, ctx = context) {
  const events = [];
  const pool = rotationPool(rows, snapshots, config, { ...ctx, onStep: event => events.push(event) });
  return { pool, stages: rotationStages(events, config), info: rotationPreviewInfo(pool, snapshots, config, ctx) };
}
test('sort first, demote zero, then split only ready rows and sort inside their parent', () => {
  const snapshots = { a: snapshot(0, 10), b: snapshot(20, 20), c: snapshot(60, 30), d: snapshot(40, 40), e: snapshot(80, 50) };
  const before = JSON.stringify([connections, snapshots, policy]);
  const { pool, stages, info } = run(snapshots);
  assert.deepEqual(stages.map(stage => stage.id), ['eligible', 'sort-0', 'waiting', 'split-1', 'sort-1']);
  assert.deepEqual(stages[1].groups.flatMap(group => group.ids), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(pool.segments.map(segment => ids(segment.rows)), [['c', 'b'], ['e', 'd']]);
  assert.deepEqual(ids(pool.waiting), ['a']);
  assert.deepEqual(pool.candidates.map(row => row.id), ['c', 'b']);
  assert.equal(pool.waiting[0].reason, 'Short window exhausted');
  assert.equal(info.waitingCount, 1);
  assert.equal(info.validUntil, now + 5000);
  assert.deepEqual(stages.at(-1).groups.map(group => group.ids), [['c', 'b'], ['e', 'd'], ['a']]);
  for (const stage of stages) assert.deepEqual(stage.groups.flatMap(group => group.ids).sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(JSON.stringify([connections, snapshots, policy]), before);
});
test('one sort, unknown first sort and priority-only sequences all retain the zero gate', () => {
  const snapshots = { a: snapshot(0), b: snapshot(30) };
  for (const sorts of [policy.sorts.slice(0, 1), [{ key: 'weekly-reset', direction: 'asc', division: 'half' }, policy.sorts[1]], []]) {
    const s = structuredClone(snapshots); for (const value of Object.values(s)) value.quotas[1].resetAt = null;
    const config = { ...policy, sorts, resetPriority: { enabled: true, days: 3, weeklyBelow: null } };
    const { pool, stages } = run(s, config, connections.slice(0, 2));
    assert.deepEqual(ids(pool.waiting), ['a']); assert.deepEqual(ids(pool.ranked), ['b']);
    assert.ok(stages.some(stage => stage.id === 'waiting'));
  }
});
test('all waiting has no dispatch or legacy fallback candidates, even when sorts have no evidence', () => {
  const config = { ...policy, sorts: [{ key: 'weekly-reset', direction: 'asc', division: 'half' }] };
  const s = { a: snapshot(0), b: snapshot(0) }; for (const value of Object.values(s)) value.quotas[1].resetAt = null;
  const { pool, info } = run(s, config, connections.slice(0, 2));
  assert.equal(pool.ranked.length, 0); assert.equal(pool.candidates.length, 0); assert.equal(pool.waiting.length, 2);
  assert.equal(info.selectedCount, 0); assert.equal(pool.blocked.length, 0);
});
test('priority roots retain independent ready partitions and waiting rows go below both roots', () => {
  const s = Object.fromEntries(connections.map((c, i) => [c.id, snapshot(i === 0 ? 0 : 10 * i, 10 * (i + 1))]));
  for (const id of ['a', 'b', 'c']) s[id].credits = { observedAt: now, availableCount: 1, expiresAt: now + 86400000 };
  const { pool, stages } = run(s, { ...policy, resetPriority: { enabled: true, days: 3, weeklyBelow: null } });
  assert.deepEqual(pool.segments.map(segment => segment.key), ['reset.1', 'reset.2', 'regular.1', 'regular.2']);
  assert.deepEqual(ids(pool.ranked), ['b', 'c', 'd', 'e']); assert.deepEqual(ids(pool.waiting), ['a']);
  assert.deepEqual(stages.at(-1).groups.flatMap(group => group.ids), ['b', 'c', 'd', 'e', 'a']);
});
test('fresh scoped zero only; stale, future, unknown, expired and unrelated observations remain unknown', () => {
  const cases = [undefined, snapshot(null), snapshot(0, 50, { observedAt: now - SNAPSHOT_MAX_AGE_MS - 1 }), snapshot(0, 50, { observedAt: now + 1 }), snapshot(0, 50, { provider: 'claude' }), { ...snapshot(0), quotas: [{ ...snapshot(0).quotas[0], resetAt: now }] }];
  for (const data of cases) assert.equal(run({ a: data }, policy, connections.slice(0, 1)).pool.waiting.length, 0);
  for (const model of ['gpt-6-spark', 'code-review', 'gpt-image-1']) assert.equal(run({ a: snapshot(0) }, policy, connections.slice(0, 1), { ...context, model }).pool.waiting.length, 0);
  const ag = { provider: 'antigravity', observedAt: now, quotas: [{ window: 'session', scope: 'ag:gemini', remaining: 0, resetAt: null }] };
  assert.equal(run({ a: ag }, policy, connections.slice(0, 1), { ...context, provider: 'antigravity', model: 'gemini-3-flash' }).pool.waiting.length, 1);
  assert.equal(run({ a: ag }, policy, connections.slice(0, 1), { ...context, provider: 'antigravity', model: 'claude-sonnet' }).pool.waiting.length, 0);
});
test('hard admission and separate holds win over short waiting; disabled policy keeps legacy behavior', () => {
  const s = { a: snapshot(0, 0), b: snapshot(0), c: snapshot(0) };
  const rows = [connections[0], { ...connections[1], isActive: false }, { ...connections[2], 'modelLock_gpt-6.1': new Date(Date.now() + 60000).toISOString() }];
  const { pool } = run(s, policy, rows); assert.equal(pool.waiting.length, 0); assert.equal(pool.blocked.length, 3);
  const disabled = run({ a: snapshot(0) }, { ...policy, enabled: false }, connections.slice(0, 1));
  assert.equal(disabled.pool.waiting.length, 0); assert.deepEqual(ids(disabled.pool.ranked), ['a']);
  const allUnknown = evaluateRotation(connections, {}, policy, context); assert.equal(allUnknown.hasEvidence, false); assert.equal(allUnknown.candidates.length, connections.length);
});

test('three and four sorts preserve every row in the trace without sorting waiting rows again', () => {
  const s = Object.fromEntries(connections.map((c, i) => [c.id, snapshot(i % 2 === 0 ? 0 : 20 * i, 10 * (i + 1))]));
  s.a.credits = { observedAt: now, availableCount: 1, expiresAt: now + 86400000 };
  for (const division of ['half', 'median', 'gap']) for (const count of [3, 4]) {
    const config = { ...policy, resetPriority: { enabled: true, days: 3, weeklyBelow: null }, sorts: [...policy.sorts, { key: 'weekly-reset', direction: 'desc', division }, { key: 'session-reset', direction: 'asc', division }].slice(0, count).map(rule => ({ ...rule, division })) };
    const { pool, stages } = run(s, config);
    assert.deepEqual(ids(pool.waiting), ['a', 'c', 'e']);
    assert.deepEqual(new Set(ids(pool.ranked)), new Set(['b', 'd']));
    for (const stage of stages) assert.deepEqual(stage.groups.flatMap(group => group.ids).sort(), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(stages.at(-1).groups.flatMap(group => group.ids), [...ids(pool.ranked), ...ids(pool.waiting)]);
    assert.ok(stages.slice(stages.findIndex(stage => stage.id === 'waiting')).every(stage => stage.groups.filter(group => group.waiting).flatMap(group => group.ids).join() === 'a,c,e'));
  }
});
