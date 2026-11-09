import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const fixtureDirectory = mkdtempSync(join(tmpdir(), 'rotation-adapter-'));
process.env.DATA_DIR = fixtureDirectory;
process.env.AURIX_ISOLATED_BUILD = '1';
let payload = {}, calls = 0;
globalThis.fetch = async () => { calls++; return Response.json(payload); };
const root = new URL('../../', import.meta.url);
const { getCodexUsage } = await import(new URL('open-sse/services/usage/codex.js', root));
const { getKimiUsage } = await import(new URL('open-sse/services/usage/kimi.js', root));
const { parseGlmQuotaResponse } = await import(new URL('open-sse/services/usage/glm.js', root));
const { parseWeeklyQuotaSummary } = await import(new URL('open-sse/services/usage/antigravity-weekly.js', root));
const { getClaudeUsage } = await import(new URL('open-sse/services/usage/claude.js', root));
const { normalizeRotationUsage } = await import(new URL('src/shared/utils/rotationSequence.mjs', root));
test('Codex missing or out-of-range percentages cannot become full or empty capacity', async () => {
  for (const used of [undefined, null, true, 'bad', -10, 110]) {
    payload = { rate_limit: { primary_window: { used_percent: used } } };
    const usage = await getCodexUsage('fixture');
    assert.equal(usage.quotas.session.quotaStatus, 'unknown');
    assert.equal(normalizeRotationUsage('codex', usage).quotas.length, 0);
  }
  payload = { rate_limit: { primary_window: { used_percent: 25 } } };
  assert.equal(normalizeRotationUsage('codex', await getCodexUsage('fixture')).quotas[0].remaining, 75);
});
test('Kimi total-only and blank usage reports remain unknown', async () => {
  for (const used of [undefined, null, '', true, 'bad']) {
    payload = { usage: { limit: 100, used } };
    assert.equal(normalizeRotationUsage('kimi', await getKimiUsage('fixture')).quotas.length, 0);
  }
  payload = { usage: { limit: 100, used: 20 } };
  assert.equal(normalizeRotationUsage('kimi', await getKimiUsage('fixture')).quotas[0].remaining, 80);
});
test('GLM missing/blank percentage does not fabricate unused quota', () => {
  for (const percentage of [undefined, null, '', 'bad', true, false, -1, 101]) assert.equal(Object.keys(parseGlmQuotaResponse({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, percentage }] } }).quotas).length, 0);
});
test('Antigravity null remaining fraction is absent, not exhausted', () => {
  for (const value of [null, '', false, true, 'bad', -1, 2]) {
    const data = { groups: [{ displayName: 'Gemini', buckets: [{ window: 'weekly', remainingFraction: value }] }] };
    assert.deepEqual(parseWeeklyQuotaSummary(data), {});
  }
});
test('Claude cached usage retains the time of the actual quota read', async () => {
  calls = 0; payload = { five_hour: { utilization: 20 }, seven_day: { utilization: 40 } };
  const first = await getClaudeUsage('fixture-cache'), second = await getClaudeUsage('fixture-cache');
  assert.equal(calls, 1); assert.ok(first.observedAt); assert.equal(first.observedAt, second.observedAt);
});

test('Kiro and Copilot incomplete usage cannot report full subscription allowance', async () => {
  const { getKiroUsage } = await import(new URL('open-sse/services/usage/kiro.js', root));
  const { getGitHubUsage } = await import(new URL('open-sse/services/usage/github.js', root));
  payload = { usageBreakdownList: [{ resourceType: 'CREDIT', usageLimitWithPrecision: 100 }] };
  assert.equal(normalizeRotationUsage('kiro', await getKiroUsage('fixture', {})).quotas.length, 0);
  payload = { monthly_quotas: { chat: 100 }, limited_user_quotas: {} };
  assert.equal(normalizeRotationUsage('github', await getGitHubUsage('fixture', {})).quotas.length, 0);
  payload = { monthly_quotas: { chat: 100 }, limited_user_quotas: { chat: 20 } };
  assert.equal(normalizeRotationUsage('github', await getGitHubUsage('fixture', {})).quotas[0].remaining, 80);
});

test.after(() => { rmSync(fixtureDirectory, { recursive: true, force: true }); });
