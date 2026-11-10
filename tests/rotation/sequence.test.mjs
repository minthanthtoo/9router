import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyRotation, validateRotation, rotationMetrics, normalizeRotationUsage, evaluateRotation, rotationValue, applicableRotationQuotas, partitionRotationRows, SNAPSHOT_MAX_AGE_MS } from '../../src/shared/utils/rotationSequence.mjs';
const now = Date.parse('2026-11-06T00:00:00Z');
const quota = (remaining, seconds = 1000) => ({ used: 100 - remaining, total: 100, resetAt: new Date(now + seconds * 1000).toISOString() });
const usage = remaining => ({ quotas: { session: quota(remaining), weekly: quota(remaining) } });
const policy = sorts => ({ ...emptyRotation(), enabled: true, sorts: sorts.map(sort => ({ direction: 'asc', division: 'half', ...sort })) });
const connections = Array.from({ length: 8 }, (_, index) => ({ id: String(index), provider: 'codex' }));
const snapshot = (left, provider = 'codex') => normalizeRotationUsage(provider, usage(left), now);
const evaluate = (rows, snapshots, config) => evaluateRotation(rows, snapshots, config, { provider: 'codex', model: 'gpt-6.1', now });
test('capabilities and strict server validation reject unsupported/duplicate criteria and reset rules', () => {
  assert.deepEqual(rotationMetrics('deepseek'), []);
  assert.ok(rotationMetrics('ollama').every(metric => metric.kind !== 'reset'));
  assert.ok(rotationMetrics('github').every(metric => metric.window === 'cycle'));
  assert.throws(() => validateRotation({ ...emptyRotation(), resetPriority: { enabled: true, days: 3, weeklyBelow: null } }, 'claude'));
  assert.throws(() => validateRotation(policy([{ key: 'monthly-reset' }]), 'codex'));
  assert.throws(() => validateRotation(policy([{ key: 'weekly-reset' }, { key: 'weekly-reset' }]), 'codex'));
  for (const value of [NaN, Infinity, -1, 101, '30']) assert.throws(() => validateRotation({ ...emptyRotation(), resetPriority: { enabled: true, days: 3, weeklyBelow: value } }, 'codex'));
});
test('each later sort partitions only its parent; four sorts create eight segments with original values', () => {
  const snapshots = Object.fromEntries(connections.map((row, i) => [row.id, snapshot(1 + i * 10)]));
  const result = evaluate(connections, snapshots, policy([{ key: 'weekly-remaining' }, { key: 'session-remaining', direction: 'desc' }, { key: 'weekly-reset' }, { key: 'session-reset' }]));
  assert.equal(result.segments.length, 8); assert.equal(result.ranked.length, 8);
  assert.deepEqual(new Set(result.ranked.map(row => row.connection.id)), new Set(connections.map(row => row.id)));
});
test('P50 and gap preserve ties and keep missing data separate', () => {
  const rows = [1, 1, 2, 50, 50, null].map(value => ({ values: [value] }));
  const median = partitionRotationRows(rows, 0, 'asc', 'median');
  assert.equal(median[0].detail.threshold, 2); assert.equal(median.at(-1).rows[0].values[0], null);
  const gap = partitionRotationRows(rows, 0, 'asc', 'gap'); assert.equal(gap[0].detail.gap.size, 48);
  assert.deepEqual(gap.map(group => group.rows.length), [3, 2, 1]);
});
test('unknown parent criterion does not divide a pool arbitrarily; completely unknown is fallback', () => {
  const result = evaluate(connections, {}, policy([{ key: 'weekly-remaining' }, { key: 'session-remaining' }]));
  assert.equal(result.segments.length, 1); assert.equal(result.candidates.length, 8); assert.equal(result.hasEvidence, false);
});
test('Codex priority requires known unexpired available credit and honors optional weekly AND cutoff', () => {
  const a = snapshot(20), b = snapshot(80);
  const credit = { availableCount: 1, expiresAt: now + 86400000, observedAt: now };
  a.credits = credit; b.credits = credit;
  const config = { ...emptyRotation(), enabled: true, resetPriority: { enabled: true, days: 3, weeklyBelow: 30 } };
  let result = evaluate(connections.slice(0, 2), { 0: a, 1: b }, config);
  assert.deepEqual(result.candidates.map(row => row.id), ['0']);
  result = evaluate(connections.slice(0, 2), { 0: a, 1: b }, { ...config, resetPriority: { ...config.resetPriority, weeklyBelow: null } });
  assert.equal(result.candidates.length, 2);
  for (const bad of [{ ...credit, availableCount: 0 }, { ...credit, expiresAt: now }, { ...credit, observedAt: now - SNAPSHOT_MAX_AGE_MS - 1 }, { ...credit, expiresAt: null }]) {
    assert.equal(evaluate(connections.slice(0, 1), { 0: { ...a, credits: bad } }, config).ranked[0].urgent, false);
  }
});
test('credit expiry is separate from quota reset; spent/expired/unknown credits are not candidates', () => {
  const details = { availableCount: 3, credits: [{ status: 'spent', expiresAt: new Date(now + 1).toISOString() }, { status: 'available', expiresAt: new Date(now - 1).toISOString() }, { status: 'available', expiresAt: new Date(now + 1000).toISOString() }] };
  assert.equal(normalizeRotationUsage('codex', usage(50), now, details).credits.expiresAt, now + 1000);
  assert.equal(normalizeRotationUsage('codex', usage(50), now).credits, null);
});
test('Codex main, Spark, review and image usage stay independent', () => {
  const data = normalizeRotationUsage('codex', { quotas: { session: quota(70), weekly: quota(60), spark_weekly: quota(0), review_weekly: quota(0), image_gen_primary: { ...quota(0), quotaKind: 'image_generation' } } }, now);
  const metric = { window: 'weekly', kind: 'remaining' };
  assert.equal(rotationValue(data, metric, 'codex', 'gpt-6.1', now), 60);
  assert.equal(rotationValue(data, metric, 'codex', 'gpt-5.3-codex-spark', now), 0);
  assert.equal(rotationValue(data, metric, 'codex', 'code-review', now), 0);
});
test('model-scoped Claude and Antigravity buckets do not leak across requested models', () => {
  const claude = normalizeRotationUsage('claude', { quotas: { 'weekly (7d)': quota(90), 'weekly opus (7d)': quota(0), 'weekly sonnet (7d)': quota(50) } }, now);
  assert.equal(rotationValue(claude, { window: 'weekly', kind: 'remaining' }, 'claude', 'claude-sonnet-4-6', now), 50);
  const ag = normalizeRotationUsage('antigravity', { quotas: { gemini_weekly: quota(70), claude_gpt_weekly: quota(0), 'gemini-3.1-flash-image': quota(0) } }, now);
  assert.equal(rotationValue(ag, { window: 'weekly', kind: 'remaining' }, 'antigravity', 'gemini-3.8-flash-high', now), 70);
});
test('bonus expiry, trial expiry and inferred Ollama reset cannot masquerade as refill', () => {
  const codebuddy = normalizeRotationUsage('codebuddy-cn', { quotas: { Monthly: { ...quota(50), recurring: true }, 'Bonus Pack 1': { ...quota(0), recurring: false } } }, now);
  assert.equal(codebuddy.quotas.length, 1); assert.equal(codebuddy.quotas[0].window, 'cycle');
  assert.equal(normalizeRotationUsage('kiro', { quotas: { FreeTrial: quota(0) } }, now).quotas.length, 0);
  assert.equal(normalizeRotationUsage('ollama', { quotas: { Monthly: quota(50) } }, now).quotas[0].resetAt, null);
});
test('stale/future observations, passed resets and unknown quota values never gain ranking authority', () => {
  const metric = { window: 'weekly', kind: 'remaining' };
  assert.equal(rotationValue({ ...snapshot(0), observedAt: now - SNAPSHOT_MAX_AGE_MS - 1 }, metric, 'codex', 'gpt-6.1', now), null);
  assert.equal(rotationValue({ ...snapshot(0), observedAt: now + 1 }, metric, 'codex', 'gpt-6.1', now), null);
  assert.equal(rotationValue(normalizeRotationUsage('codex', { quotas: { weekly: quota(0, -1) } }, now), metric, 'codex', 'gpt-6.1', now), null);
  assert.equal(rotationValue(normalizeRotationUsage('codex', { quotas: { weekly: { ...quota(100), quotaStatus: 'unknown' } } }, now), metric, 'codex', 'gpt-6.1', now), null);
});
test('sorting does not mutate caller accounts, policy or snapshot evidence', () => {
  const config = policy([{ key: 'weekly-remaining' }]), data = { 0: snapshot(0), 1: snapshot(50) };
  const before = JSON.stringify([connections, config, data]); evaluate(connections, data, config); assert.equal(JSON.stringify([connections, config, data]), before);
});

test('model scopes preserve organization namespaces and strip only the actual provider prefix',()=>{
 const now=Date.now();const s=normalizeRotationUsage('gemini-cli',{quotas:{'google/gemini-pro':{remainingPercentage:0}}},now);
 for(const model of ['google/gemini-pro','gemini-cli/google/gemini-pro'])assert.equal(applicableRotationQuotas(s,'gemini-cli',model,now).length,1);
 assert.equal(applicableRotationQuotas(s,'gemini-cli','other/gemini-pro',now).length,0);
});

test('card sorting never lifts ordinary accounts above the reset-priority group', async () => {
  const {segmentVisibleConnections} = await import('../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js');
  const accounts=[{id:'ordinary',provider:'claude'},{id:'reset',provider:'codex',rotationHint:{expiresAt:now+86400000}}];
  const quotas={ordinary:{quotas:[{quotaType:'weekly',remainingPercentage:100}]},reset:{quotas:[{quotaType:'weekly',remainingPercentage:5}]}};
  for(const sorts of [[],[{key:'weekly-remaining',direction:'desc',division:'half'}]]) {
    const groups=segmentVisibleConnections(accounts,quotas,sorts,now);
    assert.equal(groups[0].connections[0].id,'reset');
    assert.equal(groups[0].rotationName,'Expiring credit');
    assert.equal(groups.flatMap(group=>group.connections).length,2);
  }
});

test('the quota-page 7d reset sort uses live quota data and stays in simple-sort mode', async () => {
  const {segmentVisibleConnections, updateQuotaRotationPreview} = await import('../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js');
  const accounts = ['late', 'early', 'unknown', 'expired'].map(id => ({id, provider: 'codex'}));
  const quotaData = {
    late: {quotas: [{quotaType: 'weekly', resetAt: new Date(now + 7200000).toISOString()}]},
    early: {quotas: [{quotaType: 'weekly', resetAt: new Date(now + 3600000).toISOString()}]},
    unknown: {quotas: [{quotaType: 'weekly', resetAt: null}]},
    expired: {quotas: [{quotaType: 'weekly', resetAt: new Date(now - 1).toISOString()}]},
  };
  const segments = segmentVisibleConnections(accounts, quotaData, [{key: 'weekly-reset', direction: 'asc'}], now);
  assert.deepEqual(segments.flatMap(segment => segment.connections.map(connection => connection.id)), ['early', 'late', 'unknown', 'expired']);
  assert.equal(updateQuotaRotationPreview(null, 'codex', 'gpt-6.1', [{key: 'weekly-reset', direction: 'asc'}], {enabled: false}), null);
});

test('weekly reset sorting recognizes provider snake_case window names without using short resets', async () => {
  const {parseQuotaData, segmentVisibleConnections} = await import('../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js');
  const accounts = ['late', 'early', 'short-only', 'unknown'].map(id => ({id, provider: 'claude'}));
  const quotaData = {
    late: {quotas: parseQuotaData('claude', {quotas: {
      seven_day: {resetAt: new Date(now + 7200000).toISOString()},
      seven_day_sonnet: {resetAt: new Date(now + 10800000).toISOString()},
    }})},
    early: {quotas: parseQuotaData('claude', {quotas: {seven_day: {resetAt: new Date(now + 3600000).toISOString()}}})},
    'short-only': {quotas: parseQuotaData('claude', {quotas: {five_hour: {resetAt: new Date(now + 60000).toISOString()}}})},
    unknown: {quotas: parseQuotaData('claude', {quotas: {seven_day: {resetAt: null}}})},
  };
  const segments = segmentVisibleConnections(accounts, quotaData, [{key: 'weekly-reset', direction: 'asc'}], now);
  assert.deepEqual(segments.flatMap(segment => segment.connections.map(connection => connection.id)), ['early', 'late', 'short-only', 'unknown']);
});


test('Codex summaries and simple sorting honor declared weekly primary windows', async () => {
  const {parseQuotaData, segmentVisibleConnections, getConnectionQuotaRemaining} = await import('../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js');
  const now=Date.now(), accounts=[{id:'late',provider:'codex'},{id:'early',provider:'codex'},{id:'short',provider:'codex'}];
  const data=Object.fromEntries(accounts.map((account,index)=>[account.id,{quotas:parseQuotaData('codex',{quotas:{session:{used:20,total:100,remaining:80,quotaStatus:'reported',windowSeconds:index===2?18000:604800,resetAt:new Date(now+(index===0?7200000:index===1?3600000:60000)).toISOString()}}})}]));
  assert.equal(data.early.quotas[0].name,'Weekly');
  assert.equal(data.short.quotas[0].name,'5h');
  assert.equal(getConnectionQuotaRemaining(accounts[1],data,'weekly'),80);
  assert.equal(getConnectionQuotaRemaining(accounts[1],data,'session'),null);
  assert.deepEqual(segmentVisibleConnections(accounts,data,[{key:'weekly-reset',direction:'asc'}],now).flatMap(group=>group.connections.map(account=>account.id)),['early','late','short']);
  const longWait=parseQuotaData('codex',{quotas:{session:{used:100,total:100,windowSeconds:18000,resetAt:new Date(now+7*86400000).toISOString()}}});
  assert.equal(longWait[0].name,'5h','countdown length alone must not rename a window');
  const unknown={unknown:{quotas:parseQuotaData('codex',{quotas:{session:{used:0,total:100,quotaStatus:'unknown',windowSeconds:604800}}})}};
  assert.equal(getConnectionQuotaRemaining({id:'unknown'},unknown,'weekly'),null);
});

test('matching 0% accounts lead only with explicit automatic reset consent', () => {
  const rows = [{id:'empty'}, {id:'ready'}, {id:'spent'}];
  const data = {empty:snapshot(0), ready:snapshot(70), spent:snapshot(0)};
  data.empty.credits = {availableCount:1, observedAt:now, expiresAt:now+86400000};
  data.spent.credits = {availableCount:0, observedAt:now, expiresAt:now+3600000};
  const config = {...policy([{key:'weekly-remaining',direction:'desc'}]),resetPriority:{enabled:true,days:3,weeklyBelow:30,autoReset:true}};
  assert.deepEqual(evaluate(rows,data,config).candidates.map(c=>c.id),['empty']);
  assert.deepEqual(evaluate(rows,data,config).waiting.map(r=>r.connection.id),['spent']);
  config.resetPriority.autoReset=false;
  assert.deepEqual(evaluate(rows,data,config).candidates.map(c=>c.id),['ready']);
  assert.throws(()=>validateRotation({...config,resetPriority:{...config.resetPriority,autoReset:'yes'}},'codex'));
});
