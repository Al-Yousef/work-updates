'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { atomic, read } = require('./queue.cjs');
function startObserver(root, options, onFeed) {
  const home = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  fs.mkdirSync(root, { recursive: true });
  atomic(path.join(root, 'config.json'), { codexHome: home, pollSeconds: 3, ignoredThreadIds: [] });
  let binary, args;
  if (options.helper) {
    binary = options.helper;
    args = ['--root', root, '--parent-pid', String(process.pid)];
  } else {
    const bundled = path.join(
      os.homedir(),
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'python',
      process.platform === 'win32' ? 'python.exe' : 'bin/python3',
    );
    binary =
      options.python ||
      (fs.existsSync(bundled) ? bundled : process.platform === 'win32' ? 'python' : 'python3');
    args = [
      '-X',
      'utf8',
      path.join(__dirname, '..', 'bridge', 'collector.py'),
      '--root',
      root,
      '--parent-pid',
      String(process.pid),
    ];
  }
  const child = spawn(binary, args, { windowsHide: true, stdio: 'ignore' });
  let stopped = false,
    last = -1,
    lastHealth = -1;
  child.on('error', () =>
    onFeed(null, {
      ok: false,
      message: 'The chat watcher could not start. Check Codex and your Python runtime.',
    }),
  );
  child.on('exit', () => {
    if (!stopped)
      onFeed(null, {
        ok: false,
        message: 'The chat watcher stopped. Restart Work Updates to reconnect.',
      });
  });
  const poll = () => {
    const file = path.join(root, 'data', 'feed.json'),
      healthFile = path.join(root, 'data', 'health.json');
    let stamp = -1,
      healthStamp = -1;
    try {
      stamp = fs.statSync(file).mtimeMs;
    } catch {}
    try {
      healthStamp = fs.statSync(healthFile).mtimeMs;
    } catch {}
    if (stamp !== last || healthStamp !== lastHealth) {
      const changed = stamp !== last;
      last = stamp;
      lastHealth = healthStamp;
      onFeed(
        changed ? read(file, null) : null,
        read(healthFile, { ok: stamp !== -1, message: 'Waiting for Codex chat storage.' }),
      );
    }
  };
  const timer = setInterval(poll, 700);
  poll();
  return {
    pid: child.pid,
    request(ids) {
      atomic(path.join(root, 'data', 'details-request.json'), { threadIds: ids });
      fs.writeFileSync(path.join(root, 'data', 'refresh.flag'), 'context');
    },
    close() {
      stopped = true;
      clearInterval(timer);
      child.kill();
    },
  };
}
module.exports = { startObserver };
