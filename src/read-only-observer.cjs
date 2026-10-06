'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

function sourceIdentity(home) {
  const canonical = fs.realpathSync(home);
  return crypto
    .createHash('sha256')
    .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
    .digest('hex');
}

// A receipt proves a successful read, independently of any chat's updatedAt.
// Generation and source are fixed by the parent before accepting pipe data.
class CollectionReceipt {
  constructor(
    sourceId,
    { staleMs = 30000, wall = Date.now, clock = () => performance.now() } = {},
  ) {
    this.sourceId = sourceId;
    this.staleMs = staleMs;
    this.wall = wall;
    this.clock = clock;
    this.session = null;
    this.sequence = 0;
    this.completedAt = 0;
    this.received = null;
    this.activityReceived = null;
    this.feed = null;
    this.connected = false;
    this.error = '';
  }
  begin(session) {
    this.session = session;
    this.sequence = 0;
    this.connected = true;
    this.received = null;
    this.activityReceived = null;
    this.error = '';
  }
  accept(value) {
    if (
      !this.connected ||
      value?.session !== this.session ||
      value.sourceId !== this.sourceId ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence <= this.sequence ||
      !Number.isFinite(value.completedAt)
    )
      return false;
    const age = this.wall() - value.completedAt * 1000;
    if (age < -5000 || age > this.staleMs || value.completedAt < this.completedAt) return false;
    if (value.ok !== true && value.ok !== false) return false;
    if (
      value.ok &&
      (!Array.isArray(value.feed?.threads) ||
        !Number.isFinite(value.feed.collectedAt) ||
        Math.abs(value.feed.collectedAt - value.completedAt) > 2)
    )
      return false;
    this.sequence = value.sequence;
    this.activityReceived = this.clock();
    if (!value.ok) {
      this.error = 'Local Codex could not be read. Cached context is shown.';
      return true;
    }
    this.feed = value.feed;
    this.completedAt = value.completedAt;
    this.received = this.clock();
    this.error = '';
    return true;
  }
  disconnect(message = 'Collector stopped. Cached context is shown.') {
    this.connected = false;
    this.error = message;
  }
  health() {
    const ageMs = this.received === null ? null : Math.max(0, this.clock() - this.received);
    const ok = this.connected && !this.error && ageMs !== null && ageMs < this.staleMs;
    const status = ok
      ? 'current'
      : !this.connected
        ? 'disconnected'
        : this.error
          ? 'error'
          : this.received === null
            ? 'connecting'
            : 'stale';
    return {
      ok,
      status,
      at: this.completedAt,
      ageMs,
      session: this.session,
      sequence: this.sequence,
      sourceId: this.sourceId,
      message: ok
        ? ''
        : this.error ||
          (status === 'connecting'
            ? 'Reading local Codex. Cached context is shown until a new read completes.'
            : 'Collector heartbeat expired. Cached context is shown.'),
    };
  }
}

function startReadOnlyObserver(options, onFeed = () => {}) {
  const home = fs.realpathSync(options.codexHome);
  const receipt = new CollectionReceipt(sourceIdentity(home), options);
  const python =
    options.python ||
    path.join(
      os.homedir(),
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'python',
      process.platform === 'win32' ? 'python.exe' : 'bin/python3',
    );
  const create = options.spawn || spawn;
  let child,
    timer,
    retry,
    paused = false,
    closed = false,
    generation = 0,
    restarts = 0,
    failures = 0,
    launched = 0,
    lastStatus = '';
  const health = () => ({ ...receipt.health(), generation, restarts });
  const publish = (feed = null) => {
    const value = health();
    lastStatus = value.status;
    onFeed(feed, value);
  };
  function launch() {
    if (closed || paused) return;
    generation++;
    const session = crypto.randomUUID();
    receipt.begin(session);
    launched = receipt.clock();
    let buffer = '',
      ended = false;
    child = create(
      python,
      [
        '-X',
        'utf8',
        options.helperScript || path.join(__dirname, '..', 'bridge', 'collector.py'),
        '--stdio',
        '--codex-home',
        home,
        '--session',
        session,
        '--source-id',
        receipt.sourceId,
        '--parent-pid',
        String(process.pid),
        '--poll-seconds',
        String(options.pollSeconds || 3),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const own = child;
    publish();
    const finish = () => {
      if (ended) return;
      ended = true;
      if (child !== own || closed || paused) return;
      receipt.disconnect('Collector stopped. Reconnecting; cached context is shown.');
      publish();
      failures++;
      const delay = Math.min(
        options.retryMaxMs || 10000,
        (options.retryMs || 500) * 2 ** Math.min(failures - 1, 5),
      );
      retry = setTimeout(() => {
        restarts++;
        launch();
      }, delay);
    };
    own.once('error', finish);
    own.once('exit', finish);
    own.stdout?.on('data', (chunk) => {
      if (child !== own || closed || paused || ended) return;
      buffer += chunk.toString('utf8');
      // Bound a corrupt or stalled pipe without writing private payloads to logs.
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) {
        receipt.disconnect('Collector response exceeded the local read limit. Reconnecting.');
        own.kill();
        finish();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (!receipt.accept(value)) continue;
        if (value.ok) failures = 0;
        publish(value.ok ? receipt.feed : null);
      }
    });
  }
  timer = setInterval(() => {
    if (closed || paused) return;
    const state = health();
    if (state.status !== lastStatus) publish();
    const elapsed = receipt.clock() - (receipt.activityReceived ?? launched);
    if (child && receipt.connected && elapsed >= receipt.staleMs) {
      receipt.disconnect('Collector heartbeat expired. Reconnecting; cached context is shown.');
      publish();
      child.kill();
    }
  }, options.checkMs || 250);
  launch();
  return {
    get pid() {
      return child?.pid;
    },
    get feed() {
      return receipt.feed;
    },
    get sourceId() {
      return receipt.sourceId;
    },
    health,
    pause() {
      paused = true;
      clearTimeout(retry);
      receipt.disconnect();
      child?.kill();
      publish();
    },
    resume() {
      if (closed || !paused) return;
      paused = false;
      restarts++;
      launch();
    },
    close() {
      closed = true;
      clearInterval(timer);
      clearTimeout(retry);
      receipt.disconnect();
      child?.kill();
    },
  };
}
module.exports = { CollectionReceipt, sourceIdentity, startReadOnlyObserver };
