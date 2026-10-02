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
  const bundled = path.join(
    os.homedir(),
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'python',
    process.platform === 'win32' ? 'python.exe' : 'bin/python3',
  );
  const python = options.python || (fs.existsSync(bundled) ? bundled : null);
  const source = options.helperScript && fs.existsSync(options.helperScript) && python;
  if (options.helper && !source) {
    binary = options.helper;
    args = ['--root', root, '--parent-pid', String(process.pid)];
  } else {
    binary = python || (process.platform === 'win32' ? 'python' : 'python3');
    args = [
      '-X',
      'utf8',
      source ? options.helperScript : path.join(__dirname, '..', 'bridge', 'collector.py'),
      '--root',
      root,
      '--parent-pid',
      String(process.pid),
    ];
  }
  const child = spawn(binary, args, { windowsHide: true, stdio: 'ignore' });
  options.log?.write('observer.started', { pid: child.pid, binary });
  let stopped = false,
    last = -1,
    lastHealth = -1;
  child.on('error', (error) => {
    options.log?.write('observer.error', {
      pid: child.pid,
      code: error.code,
      message: error.message,
    });
    onFeed(null, {
      ok: false,
      message: 'The chat watcher could not start. Check Codex and your Python runtime.',
    });
  });
  child.on('exit', (code, signal) => {
    options.log?.write('observer.exited', {
      pid: child.pid,
      exitCode: code,
      signal,
      intentional: stopped,
    });
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
