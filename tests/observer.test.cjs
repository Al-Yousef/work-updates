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
  t.after(async () => {
    await watcher?.closeAndWait();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Watcher did not report the unavailable store.')),
      20000,
    );
    watcher = startObserver(
      path.join(dir, 'observer'),
      {
        codexHome: home,
        python: process.env.WORK_UPDATES_PYTHON || 'python',
        helper: path.join(dir, 'do-not-launch.exe'),
        helperScript: path.resolve(__dirname, '../bridge/collector.py'),
      },
      (feed, health) => {
        if (!health.ok && health.at) {
          clearTimeout(timer);
          resolve({ feed, health });
        } else if (!health.ok && /could not start|stopped/.test(health.message)) {
          clearTimeout(timer);
          reject(new Error(health.message));
        }
      },
    );
  });
  assert.equal(result.feed, null);
  assert.match(result.health.message, /OperationalError/);
  watcher.ignore(['11111111-1111-4111-8111-111111111111']);
  const saved=JSON.parse(fs.readFileSync(path.join(dir,'observer/config.json'),'utf8'));
  assert.equal(saved.codexHome,home);
  assert.deepEqual(saved.ignoredThreadIds,['11111111-1111-4111-8111-111111111111']);
});

test('owned collector consumes only its exact stop receipt and exits zero without a signal', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-collector-stop-'));
  fs.mkdirSync(path.join(dir, 'missing-store'));
  const events = [];
  const watcher = startObserver(path.join(dir, 'observer'), {
    codexHome: path.join(dir, 'missing-store'), python: process.env.WORK_UPDATES_PYTHON || 'python',
    log: { write: (type, value) => events.push({ type, ...value }) },
  }, () => {});
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pid = watcher.pid;
  const first = watcher.closeAndWait(), second = watcher.close();
  assert.equal(first, second);
  await first;
  const exit = events.find(e => e.type === 'observer.exited' && e.pid === pid);
  assert.equal(exit.exitCode, 0);
  assert.equal(exit.signal, null);
  assert.equal(exit.intentional, true);
  assert.equal(fs.existsSync(path.join(dir, 'observer', 'data', 'stop.flag')), false);
});

test('a nonzero original collector exit cannot be accepted as privacy shutdown', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-collector-failure-'));
  const script = path.join(dir, 'owned-failure.py');
  fs.writeFileSync(script, 'import sys\nsys.exit(7)\n');
  let exited;
  const ended = new Promise(resolve => { exited = resolve; });
  const watcher = startObserver(path.join(dir, 'observer'), {
    codexHome: path.join(dir, 'missing-store'), helperScript: script,
    python: process.env.WORK_UPDATES_PYTHON || 'python', retryMs: 10000,
    log: { write: (type, value) => { if (type === 'observer.exited') exited(value); } },
  }, () => {});
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal((await ended).exitCode, 7);
  await assert.rejects(watcher.closeAndWait(), /did not exit normally/);
});
