'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { atomic, read } = require('./queue.cjs');
function startObserver(root, options, onFeed) {
  const home = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  fs.mkdirSync(root, { recursive: true });
  atomic(path.join(root, 'config.json'), {
    codexHome: home,
    pollSeconds: options.pollSeconds || 3,
    ignoredThreadIds: [],
  });
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
  const file = path.join(root, 'data', 'feed.json'),
    healthFile = path.join(root, 'data', 'health.json');
  const stamp = (target) => {
    try {
      return fs.statSync(target).mtimeMs;
    } catch {
      return -1;
    }
  };
  let stopped = false,
    child,
    retry,
    failures = 0,
    connected = false,
    baseline = -1,
    healthBaseline = -1,
    launched = 0,
    last = -1,
    lastHealth = -1,
    lastStatus = '',
    cachedFeed = null,
    cachedHealth = { ok: false, message: 'Waiting for Codex chat storage.' };
  function launch() {
    if (stopped) return;
    baseline = stamp(file);
    healthBaseline = stamp(healthFile);
    launched = Date.now();
    connected = false;
    child = spawn(binary, args, { windowsHide: true, stdio: 'ignore' });
    const own = child;
    let ended = false;
    options.log?.write('observer.started', { pid: own.pid, binary });
    const finish = (code, signal, error) => {
      if (ended) return;
      ended = true;
      options.log?.write(error ? 'observer.error' : 'observer.exited', {
        pid: own.pid,
        exitCode: code,
        signal,
        intentional: stopped,
        ...(error ? { code: error.code, message: error.message } : {}),
      });
      if (stopped || child !== own) return;
      connected = false;
      onFeed(null, {
        ok: false,
        message: 'The chat watcher stopped. Reconnecting; cached context is shown.',
      });
      failures++;
      retry = setTimeout(
        launch,
        Math.min(10000, (options.retryMs || 500) * 2 ** Math.min(failures - 1, 5)),
      );
    };
    own.once('error', (error) => finish(null, null, error));
    own.once('exit', (code, signal) => finish(code, signal));
  }
  const poll = () => {
    const feedStamp = stamp(file),
      healthStamp = stamp(healthFile);
    const feed = feedStamp !== last ? (cachedFeed = read(file, null)) : cachedFeed;
    const health =
      healthStamp !== lastHealth
        ? (cachedHealth = read(healthFile, {
            ok: false,
            message: 'Waiting for Codex chat storage.',
          }))
        : cachedHealth;
    const now = Date.now() / 1000,
      maxAge = (options.staleMs || 30000) / 1000;
    const age = now - Number(feed?.collectedAt || 0),
      healthAge = now - Number(health.at || 0);
    const renewed = feedStamp !== baseline && healthStamp !== healthBaseline;
    const fresh = renewed && age >= -5 && age < maxAge && healthAge >= -5 && healthAge < maxAge;
    // A historical OK file is not a receipt from the currently running helper.
    const ok = !!(child?.exitCode === null && fresh && health.ok);
    if (ok) {
      connected = true;
      failures = 0;
    }
    const status = ok
      ? 'current'
      : healthStamp !== healthBaseline && healthStamp !== -1 && !health.ok
        ? 'error'
        : 'cached';
    if (feedStamp !== last || healthStamp !== lastHealth || status !== lastStatus) {
      options.log?.write('observer.health',{status,connected:ok,elapsedMs:Math.max(0,Math.round(age*1000)),pid:child?.pid,phase:'collector-read'});
      const changed = feedStamp !== last;
      last = feedStamp;
      lastHealth = healthStamp;
      lastStatus = status;
      onFeed(changed ? feed : null, {
        ...health,
        ok,
        status,
        message: ok
          ? ''
          : status === 'error'
            ? health.message
            : 'Local Codex context is cached. Waiting for a current collector read.',
      });
    }
    if (
      child?.exitCode === null &&
      Date.now() - launched >= (options.staleMs || 30000) &&
      (!connected || !fresh) &&
      status !== 'error'
    ) {
      options.log?.write('observer.heartbeat-expired', { pid: child.pid });
      connected = false;
      child.kill();
    }
  };
  launch();
  const timer = setInterval(poll, options.checkMs || 700);
  poll();
  return {
    get pid() {
      return child?.pid;
    },
    request(ids) {
      const file=path.join(root,'data','details-request.json');
      const pending=read(file,{threadIds:[]});
      atomic(file, { threadIds: [...new Set([...ids,...(Array.isArray(pending.threadIds)?pending.threadIds:[])])].slice(0,32) });
      fs.writeFileSync(path.join(root, 'data', 'refresh.flag'), 'context');
    },
    close() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(retry);
      child?.kill();
    },
  };
}
module.exports = { startObserver };
