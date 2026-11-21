export function getAccountReadPresentation({ failed, scopePending, count, pageSummary, page, totalPages }) {
  const pagePosition = `Page ${page} / ${totalPages}`;
  if (scopePending && failed) return { cards: 'Account count unavailable', page: 'Account counts unavailable', pagination: 'Page unavailable', showCards: false };
  if (scopePending) return { cards: 'Loading account count…', page: 'Loading account counts…', pagination: 'Loading page…', showCards: false };
  if (!failed) return { cards: `${count} cards on this page`, page: pageSummary, pagination: pagePosition, showCards: true };
  return { cards: `${count} last-loaded cards`, page: `${pageSummary} · last loaded`, pagination: `${pagePosition} · last loaded`, showCards: true };
}

export function accountReadErrorMessage(error) {
  const status = Number(error?.status);
  if (status === 401) return 'Sign-in expired. Sign in again, then retry.';
  if (status === 403) return 'You do not have access to this account list (HTTP 403).';
  if (status >= 500) return `The server could not load account data (HTTP ${status}). Check the server log, then retry.`;
  if (status >= 400) return `The account request failed (HTTP ${status}). Retry.`;
  if (error instanceof SyntaxError) return 'The server returned invalid account data. Retry.';
  return 'Could not reach 9Router. Check the connection, then retry.';
}
