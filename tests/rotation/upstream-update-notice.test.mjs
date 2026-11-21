import test from 'node:test';
import assert from 'node:assert/strict';

async function loadNotice() {
  return import('../../src/shared/utils/upstreamUpdateNotice.mjs').catch(() => ({}));
}

test('upstream release notice requires compatibility review and links to release notes', async () => {
  const { getUpstreamUpdateNotice } = await loadNotice();
  assert.equal(typeof getUpstreamUpdateNotice, 'function');
  assert.deepEqual(getUpstreamUpdateNotice('0.5.119'), {
    title: 'Upstream package v0.5.119 available',
    message: 'Compatibility with this patched fork has not been verified. Review before updating.',
    href: 'https://github.com/decolua/9router/releases',
  });
  assert.doesNotMatch(JSON.stringify(getUpstreamUpdateNotice('0.5.119')), /npm i -g|install command|update now/i);
});

test('upstream update notice rejects non-release version strings', async () => {
  const { getUpstreamUpdateNotice } = await loadNotice();
  assert.equal(typeof getUpstreamUpdateNotice, 'function');
  assert.equal(getUpstreamUpdateNotice('0.5.119;rm -rf'), null);
  assert.equal(getUpstreamUpdateNotice(null), null);
});
