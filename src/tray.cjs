'use strict';
const path = require('node:path');

const TRAY_GUID = '59f206ba-45e2-4f30-9349-3a6c418c90d3';

function tooltip(state) {
  const active = (state.cards || []).filter((c) => !c.done && !c.reviewed && !c.snoozed);
  const needs = active.filter((c) => c.status === 'needs' || c.waitingOn?.kind === 'you').length;
  const working = active.filter((c) => ['starting', 'working'].includes(c.status)).length;
  const ready = active.filter((c) => c.readyForReview || c.status === 'ready').length;
  const counts = [
    needs && needs + ' waiting on you',
    working && working + ' working',
    ready && ready + ' ready to review',
  ].filter(Boolean);
  return 'Hyphen\n' + (counts.join(' · ') || 'Monitoring your chats');
}

function createTray({
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  assets,
  platform,
  demo,
  show,
  hide,
  create,
  openLogs,
  quit,
}) {
  function image() {
    const tone =
      platform === 'darwin' || !nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
        ? 'dark'
        : 'light';
    const result = nativeImage.createFromPath(path.join(assets, 'tray-' + tone + '.png'));
    for (const factor of [2, 3])
      result.addRepresentation({
        scaleFactor: factor,
        buffer: require('node:fs').readFileSync(
          path.join(assets, 'tray-' + tone + '@' + factor + 'x.png'),
        ),
      });
    if (platform === 'darwin') result.setTemplateImage(true);
    return result;
  }
  const tray = platform === 'win32' && !demo ? new Tray(image(), TRAY_GUID) : new Tray(image());
  // Opening is idempotent. Windows can emit click, double-click, click for one
  // double click; toggling would immediately conceal what was just opened.
  if (platform !== 'darwin') {
    tray.on('click', show);
    tray.on('double-click', show);
  }
  const updateImage = () => {
    if (!tray.isDestroyed()) tray.setImage(image());
  };
  nativeTheme.on('updated', updateImage);
  let previous;
  return {
    update(state) {
      if (tray.isDestroyed()) return;
      const visible = state.windowMode !== 'hidden';
      const text = tooltip(state);
      const key = JSON.stringify([visible, text]);
      if (previous === key) return;
      previous = key;
      tray.setToolTip(text);
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Open queue', click: show },
          { label: 'Hide queue', enabled: visible, click: hide },
          { label: 'New task', click: create },
          { type: 'separator' },
          ...(openLogs ? [{ label: 'Open diagnostic logs', click: openLogs }] : []),
          { label: 'Quit Hyphen', click: quit },
        ]),
      );
    },
    status() {
      return { registered: !tray.isDestroyed(), bounds: tray.getBounds(), guid: tray.getGUID() };
    },
    destroy() {
      nativeTheme.removeListener('updated', updateImage);
      tray.destroy();
    },
  };
}

module.exports = { createTray, tooltip, TRAY_GUID };
