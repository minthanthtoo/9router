import test from 'node:test';
import assert from 'node:assert/strict';

async function loadStatus() {
  return import('../../src/shared/utils/accountReadStatus.mjs').catch(() => ({}));
}

test('failed initial account read reports unknown counts instead of zero or stale rows', async () => {
  const { getAccountReadPresentation } = await loadStatus();
  assert.equal(typeof getAccountReadPresentation, 'function');
  assert.deepEqual(getAccountReadPresentation({ failed: true, scopePending: true, count: 0, pageSummary: 'Showing 0-0 of 0', page: 1, totalPages: 1 }), {
    cards: 'Account count unavailable',
    page: 'Account counts unavailable',
    pagination: 'Page unavailable',
    showCards: false,
  });
});

test('failed refresh labels retained rows as last loaded', async () => {
  const { getAccountReadPresentation } = await loadStatus();
  assert.equal(typeof getAccountReadPresentation, 'function');
  assert.deepEqual(getAccountReadPresentation({ failed: true, scopePending: false, count: 3, pageSummary: 'Showing 1-3 of 3', page: 2, totalPages: 4 }), {
    cards: '3 last-loaded cards',
    page: 'Showing 1-3 of 3 · last loaded',
    pagination: 'Page 2 / 4 · last loaded',
    showCards: true,
  });
});

test('a new filter scope hides prior rows and counts until its own request completes', async () => {
  const { getAccountReadPresentation } = await loadStatus();
  assert.equal(typeof getAccountReadPresentation, 'function');
  assert.deepEqual(getAccountReadPresentation({ failed: false, scopePending: true, count: 12, pageSummary: 'Showing 1-12 of 20', page: 3, totalPages: 5 }), {
    cards: 'Loading account count…',
    page: 'Loading account counts…',
    pagination: 'Loading page…',
    showCards: false,
  });
});

test('account request errors distinguish server and network failures', async () => {
  const { accountReadErrorMessage } = await loadStatus();
  assert.equal(typeof accountReadErrorMessage, 'function');
  assert.match(accountReadErrorMessage({ status: 500 }), /server.*HTTP 500/i);
  assert.match(accountReadErrorMessage({ status: 401 }), /sign-in/i);
  assert.match(accountReadErrorMessage(new TypeError('Failed to fetch')), /could not reach/i);
});
