'use strict';
const target = document.getElementById('corner-toggle');
target.addEventListener('click', async () => {
  if (target.disabled) return;
  target.disabled = true;
  try {
    await window.workUpdates.window({ action: 'corner' });
  } finally {
    target.disabled = false;
  }
});
window.workUpdates.subscribe((state) =>
  target.setAttribute(
    'aria-label',
    state.windowMode === 'peek'
      ? 'Keep Work Updates open'
      : state.windowMode === 'pinned'
        ? 'Hide Work Updates queue'
        : 'Show Work Updates queue',
  ),
);
