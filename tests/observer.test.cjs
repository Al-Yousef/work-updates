'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { startObserver } = require('../src/observer.cjs');
test('watcher reports health changes even when no new feed can be written', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-observer-'));
  const home = path.join(dir, 'missing-store');
  fs.mkdirSync(home);
  let watcher;
  t.after(() => {
    watcher?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Watcher did not report the unavailable store.')),
      7000,
    );
    watcher = startObserver(
      path.join(dir, 'observer'),
      { codexHome: home, python: process.env.WORK_UPDATES_PYTHON || 'python' },
      (feed, health) => {
        if (!health.ok && health.at) {
          clearTimeout(timer);
          resolve({ feed, health });
        }
      },
    );
  });
  assert.equal(result.feed, null);
  assert.match(result.health.message, /OperationalError/);
});
