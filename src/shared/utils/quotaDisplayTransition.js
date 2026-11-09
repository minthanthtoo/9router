import {flushSync} from 'react-dom';

// Animate only explicit display edits; polling and routing never capture the page.
export function quotaDisplayTransition(update) {
  if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return;
  }
  document.documentElement.classList.add('quota-display-transition');
  const transition = document.startViewTransition(() => flushSync(update));
  transition.finished.catch(() => {}).finally(() => document.documentElement.classList.remove('quota-display-transition'));
}
