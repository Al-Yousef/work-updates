'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  net = require('node:net');
const { EventEmitter, once } = require('node:events'),
  { PassThrough } = require('node:stream');
const { DiagnosticLog, recovery, connectionHealth } = require('../src/diagnostics.cjs');
const { Messages } = require('../src/messages.cjs');
const { Codex } = require('../src/codex.cjs');
const { NativeControl } = require('../src/native-control.cjs');
const { seed } = require('./fixtures/diagnostic-timeline.cjs');
const { exportDiagnosticReport } = require('../src/diagnostic-export.cjs');
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-diagnostics-')),
    profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    profile,
    log: new DiagnosticLog(path.join(profile, 'logs'), { protectedDirectory: profile, ...options }),
  };
}
function records(log) {
  return fs.readFileSync(log.file, 'utf8').trim().split('\n').map(JSON.parse);
}

test('typed diagnostic metadata excludes free text, paths and credentials and bounds a single huge entry', (t) => {
  const { log } = fixture(t, { maxBytes: 512 });
  log.write('rpc.error', {
    sourceId: 'fixture-source',
    messageId: 'fixture-intent',
    message: 'Bearer SECRET_CREDENTIAL',
    draft: 'PRIVATE_DRAFT',
    answer: 'PRIVATE_ANSWER',
    path: 'C:\\private\\file',
    params: { text: 'PRIVATE_PROMPT' },
    status: 'PRIVATE_STATUS',
    backendHash: 'PRIVATE_HASH',
    method: '/private/path',
    count: Infinity,
  });
  let text = fs.readFileSync(log.file, 'utf8');
  assert.ok(!/SECRET_|PRIVATE_|C:\\|private\/path/.test(text));
  assert.equal(records(log)[0].sourceId, 'fixture-source');
  log.write(
    'test',
    Object.fromEntries(
      Array.from({ length: 10000 }, (_, i) => ['unknown' + i, 'PRIVATE_DRAFT'.repeat(100)]),
    ),
  );
  for (let i = 0; i < 30; i++) log.write('test', { id: i, message: 'PRIVATE_DRAFT'.repeat(10000) });
  for (const file of fs.readdirSync(log.directory))
    assert.ok(fs.statSync(path.join(log.directory, file)).size <= 512);
  assert.ok(fs.readdirSync(log.directory).length <= 3);
});

test('a previewed immutable export sanitizes legacy logs and cannot overwrite private stores', (t) => {
  const { root, profile, log } = fixture(t);
  log.write('message.sent', {
    messageId: 'fixture-intent',
    sourceId: 'fixture-source',
    threadId: 'fixture-source',
    turnId: 'fixture-turn',
    route: 'app-server',
  });
  fs.appendFileSync(
    log.file,
    JSON.stringify({
      at: new Date().toISOString(),
      event: 'rpc.error',
      message: 'PRIVATE_LEGACY_ANSWER',
      password: 'SECRET_PASSWORD',
      sourceId: 'fixture-source',
      phase: 'awaiting-receipt',
      delivery: 'uncertain',
    }) + '\ninvalid line\n',
  );
  const preview = log.preview(),
    destination = path.join(root, 'report.json');
  assert.equal(fs.existsSync(destination), false);
  assert.equal(preview.automaticUpload, false);
  assert.equal(preview.files[0].omittedRecords, 1);
  assert.throws(() => log.export('wrong', destination), /expired/);
  assert.throws(
    () => log.export(preview.previewId, path.join(profile, 'messages.json')),
    /private storage/,
  );
  log.write('test', { id: 99 });
  const result = log.export(preview.previewId, destination),
    text = fs.readFileSync(destination, 'utf8'),
    bundle = JSON.parse(text);
  assert.equal(result.exported, true);
  assert.equal(Buffer.byteLength(text), preview.bytes);
  assert.ok(!/PRIVATE_|SECRET_|fixture-source|fixture-intent|fixture-turn/.test(text));
  const rows = bundle.files[0].records;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sourceId, rows[0].threadId);
  assert.equal(rows[0].sourceId, rows[1].sourceId);
  assert.equal(rows[0].id, undefined);
  assert.throws(() => log.export(preview.previewId, destination), /expired/);
});

test('export rejects linked and oversized log inputs and expired previews', (t) => {
  const { root, log } = fixture(t);
  log.write('test');
  log.preview();
  log.prepared.expiresAt = 0;
  assert.throws(
    () => log.export(log.prepared.previewId, path.join(root, 'report.json')),
    /expired/,
  );
  fs.writeFileSync(log.file, 'x'.repeat(log.maxBytes + 1));
  assert.throws(() => log.preview(), /bound/);
  fs.rmSync(log.file);
  const target = path.join(root, 'private.txt');
  fs.writeFileSync(target, 'PRIVATE_CONTENT');
  try {
    fs.symlinkSync(target, log.file);
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) {
      t.diagnostic('File symlink creation unavailable; oversized/expiry guards verified.');
      return;
    }
    throw error;
  }
  assert.throws(() => log.preview(), /regular log/);
});
test('the user-facing preview requires opt-in and a chosen save destination before any export', async (t) => {
  const { root, log } = fixture(t);
  log.write('test', { id: 1 });
  let saves = 0;
  const declined = await exportDiagnosticReport(log, {
    showMessageBox: async (options) => {
      assert.match(options.detail, /app\.log: 1 metadata records/);
      assert.equal(options.defaultId, 0);
      return { response: 0 };
    },
    showSaveDialog: async () => {
      saves++;
    },
  });
  assert.deepEqual(declined, { cancelled: true });
  assert.equal(saves, 0);
  assert.equal(log.prepared, null);
  const destination = path.join(root, 'approved-report.json');
  const accepted = await exportDiagnosticReport(log, {
    showMessageBox: async () => ({ response: 1 }),
    showSaveDialog: async () => ({ filePath: destination, canceled: false }),
  });
  assert.equal(accepted.exported, true);
  assert.equal(JSON.parse(fs.readFileSync(destination)).schema, 1);
});

test('seeded real queue/controller failures distinguish preparation, writer ownership and lost acceptance', async (t) => {
  const { profile } = fixture(t),
    { log, intents } = await seed(profile),
    rows = records(log);
  for (const { scenario, messageId } of intents) {
    const failure = rows.find((r) =>
      r.event === 'message.failed' || r.event === 'message.uncertain'
        ? r.messageId === messageId
        : false,
    );
    assert.ok(failure, scenario);
    assert.equal(failure.sourceId, '10000000-0000-4000-8000-000000000001');
    assert.equal(failure.deviceId, 'fixture-device');
    assert.ok(rows.some((r) => r.event === 'dispatch.bound' && r.messageId === messageId));
    if (scenario === 'resume-timeout') {
      assert.equal(failure.phase, 'preparing-chat');
      assert.equal(failure.delivery, 'not-sent');
      assert.equal(failure.category, 'preparation-timeout');
    }
    if (scenario === 'writer-lock')
      assert.ok(
        rows.some(
          (r) =>
            r.event === 'dispatch.failed' &&
            r.messageId === messageId &&
            r.category === 'writer-unavailable',
        ),
      );
    if (scenario === 'lost-receipt') {
      assert.equal(failure.category, 'receipt-unknown');
      assert.equal(failure.noResend, true);
    }
  }
  assert.ok(!/PRIVATE_FIXTURE/.test(fs.readFileSync(log.file, 'utf8')));
});

test('restart retains exact intent correlation across distinct backend sessions without redispatch', async (t) => {
  const { root, profile } = fixture(t),
    { log, queue, intents } = await seed(profile),
    id = intents.at(-1).messageId;
  const file = path.join(profile, 'messages.json'),
    saved = JSON.parse(fs.readFileSync(file));
  saved.entries.find((e) => e.id === id).status = 'sending';
  fs.writeFileSync(file, JSON.stringify(saved));
  const next = new DiagnosticLog(log.directory, { protectedDirectory: profile });
  let dispatches = 0;
  const messages = new Messages(queue, { send: () => dispatches++ }, { auto: false, log: next });
  t.after(() => messages.close());
  assert.equal(dispatches, 0);
  assert.equal(messages.state.entries.find((e) => e.id === id).status, 'uncertain');
  const rows = records(next),
    first = rows.find((r) => r.messageId === id),
    recovered = rows.find((r) => r.event === 'message.recovered');
  assert.equal(recovered.messageId, id);
  assert.notEqual(first.backendSessionId, recovered.backendSessionId);
  const preview = next.preview(),
    destination = path.join(root, 'restart-report.json');
  next.export(preview.previewId, destination);
  const exported = JSON.parse(fs.readFileSync(destination)).files.flatMap((f) => f.records),
    prior = exported.find((r) => r.event === 'message.uncertain'),
    restored = exported.find((r) => r.event === 'message.recovered');
  assert.equal(prior.messageId, restored.messageId);
  assert.equal(prior.sourceId, restored.sourceId);
});

test('out-of-order actual RPC replies keep each originating intent rather than the first connection scope', async (t) => {
  const { log } = fixture(t),
    proc = new EventEmitter();
  proc.pid = 100;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = () => {};
  const requests = [];
  proc.stdin.on('data', (data) => {
    const m = JSON.parse(data);
    requests.push(m);
    if (m.method === 'initialize')
      queueMicrotask(() => proc.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n'));
  });
  const client = new Codex({ log, spawn: () => proc, requestTimeoutMs: 1000 });
  t.after(() => client.close());
  await log.scope({ messageId: 'first-connection-intent' }, () => client.connect());
  const first = log.scope({ messageId: 'intent-a' }, () =>
    client.call('turn/start', {
      threadId: 'source-a',
      input: [{ type: 'text', text: 'PRIVATE_INPUT_A' }],
    }),
  );
  const second = log.scope({ messageId: 'intent-b' }, () =>
    client.call('turn/start', {
      threadId: 'source-b',
      input: [{ type: 'text', text: 'PRIVATE_INPUT_B' }],
    }),
  );
  const [a, b] = requests.slice(-2);
  proc.stdout.write(
    JSON.stringify({ id: b.id, result: { turn: { id: 'turn-b' }, text: 'PRIVATE_RESPONSE' } }) +
      '\n',
  );
  proc.stdout.write(JSON.stringify({ id: a.id, result: { turn: { id: 'turn-a' } } }) + '\n');
  await Promise.all([first, second]);
  const rows = records(log).filter(
    (r) => r.event === 'codex.rpc.completed' && r.method === 'turn/start',
  );
  assert.equal(rows[0].messageId, 'intent-b');
  assert.equal(rows[0].sourceId, 'source-b');
  assert.equal(rows[1].messageId, 'intent-a');
  assert.ok(!/PRIVATE_/.test(fs.readFileSync(log.file, 'utf8')));
});

test('authenticated native commands correlate pipe sessions and return phase-specific recovery without logging input', async (t) => {
  const { profile, log } = fixture(t);
  const control = await new NativeControl({
    directory: profile,
    log,
    changed: () => {},
    status: () => ({ activeWriters: 0 }),
    quit: () => {},
    command: async () => {
      throw Object.assign(new Error('PRIVATE_ERROR_DETAIL'), {
        code: 'CODEX_TIMEOUT',
        phase: 'awaiting-receipt',
        delivery: 'uncertain',
      });
    },
  }).start();
  t.after(() => control.close());
  const socket = net.createConnection(control.pipe);
  socket.on('error', () => {});
  await once(socket, 'connect');
  const received = once(socket, 'data');
  socket.write(
    JSON.stringify({
      method: 'command',
      command: 'send',
      token: control.token,
      input: {
        messageId: 'fixture-intent',
        sourceId: 'fixture-source',
        text: 'PRIVATE_NATIVE_PROMPT',
      },
    }) + '\n',
  );
  const response = JSON.parse(String((await received)[0]));
  socket.destroy();
  assert.equal(response.category, 'receipt-unknown');
  assert.match(response.recovery, /before sending again/);
  const rows = records(log),
    start = rows.find((r) => r.event === 'native.command.started'),
    failure = rows.find((r) => r.event === 'native.command.failed');
  assert.equal(start.nativeSessionId, failure.nativeSessionId);
  assert.equal(failure.messageId, 'fixture-intent');
  assert.equal(failure.noResend, true);
  assert.ok(!fs.readFileSync(log.file, 'utf8').includes('PRIVATE_'));
});

test('health distinguishes stale collection from a connected writer, live pipe and offline execution device', () => {
  const health = connectionHealth({
    collectedAt: 900,
    now: 1000,
    collector: { ok: true },
    helper: { connected: true },
    desktopConnected: true,
    pipeListening: true,
    nativeClients: 2,
    devices: [{ kind: 'mac', online: false }],
  });
  assert.equal(health.collector.state, 'stale');
  assert.equal(health.helper.state, 'connected');
  assert.equal(health.desktop.state, 'connected');
  assert.equal(health.pipe.state, 'listening');
  assert.deepEqual(health.executionDevices, [{ kind: 'mac', online: false }]);
  assert.equal(
    connectionHealth({ collectedAt: 1006, now: 1000, collector: { ok: true } }).collector.state,
    'stale',
  );
  assert.equal(
    recovery({ code: 'CODEX_TIMEOUT', phase: 'preparing-chat', delivery: 'not-sent' }).category,
    'preparation-timeout',
  );
  assert.equal(
    recovery({ code: 'CODEX_TIMEOUT', phase: 'awaiting-receipt', delivery: 'uncertain' }).noResend,
    true,
  );
  assert.equal(
    recovery({ code: 'DESKTOP_TIMEOUT', phase: 'ownership-discovery', delivery: 'not-sent' })
      .category,
    'ownership-timeout',
  );
  assert.equal(
    recovery({ code: 'DESKTOP_RECEIPT', phase: 'ownership-discovery', delivery: 'not-sent' })
      .noResend,
    false,
  );
});
