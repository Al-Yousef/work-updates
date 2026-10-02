'use strict';
const { execFileSync } = require('node:child_process');

function parseLayout(text) {
  const value = (name) => {
    const match = text.match(new RegExp('\\b' + name + '\\s+REG_DWORD\\s+(0x[0-9a-f]+)', 'i'));
    return match ? Number(match[1]) : null;
  };
  // Windows defaults to centered icons when no alignment preference is stored.
  const alignment = value('TaskbarAl');
  return { centered: alignment === null || alignment === 1, widgets: value('TaskbarDa') === 1 };
}

function readLayout() {
  try {
    return parseLayout(
      execFileSync(
        'reg.exe',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'],
        { encoding: 'utf8', windowsHide: true, timeout: 1200, stdio: ['ignore', 'pipe', 'ignore'] },
      ),
    );
  } catch {
    return { centered: false, widgets: false };
  }
}

function weatherTarget(display, layout) {
  const unavailable = (message) => ({ target: 'weather', bounds: null, message });
  if (!layout.widgets) return unavailable('Enable Windows Widgets to use the weather area.');
  if (!layout.centered)
    return unavailable(
      'The weather shortcut needs centered taskbar icons to keep Start accessible.',
    );
  const { bounds: b, workArea: a } = display;
  const height = b.y + b.height - (a.y + a.height);
  if (
    a.x !== b.x ||
    a.y !== b.y ||
    a.width !== b.width ||
    height < 28 ||
    height > 96 ||
    b.width < 640
  )
    return unavailable('The weather shortcut needs a visible bottom taskbar with auto-hide off.');
  // A bounded input region over the left weather area, not a rebinding of Explorer's tile.
  return {
    target: 'weather',
    bounds: { x: b.x, y: a.y + a.height, width: 144, height },
    message: 'Weather shortcut active. Turn it off to restore Widgets clicks here.',
  };
}

module.exports = { parseLayout, readLayout, weatherTarget };
