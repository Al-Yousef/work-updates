'use strict';
const path = require('node:path');

// Portable installs have a launcher and a private queue beside desktop/. Use
// that queue even when someone starts the inner executable directly.
function dataDirectory({ explicit, platform, packaged, executable, fallback, isFile }) {
  if (explicit) return path.resolve(explicit);
  if (platform === 'win32' && packaged) {
    const root = path.dirname(path.dirname(executable));
    const directory = path.join(root, 'data', 'desktop');
    if (isFile(path.join(root, 'Work Updates.exe')) && isFile(path.join(directory, 'state.json')))
      return directory;
  }
  return fallback;
}

function startsVisible(args, demo = false) {
  return !args.includes('--hidden') && (args.includes('--show') || demo);
}

module.exports = { dataDirectory, startsVisible };
