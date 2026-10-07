'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { EventEmitter } = require('node:events'),
  { PassThrough } = require('node:stream');
const { ExecutorBindings } = require('../src/executor-bindings.cjs');
const { Codex } = require('../src/codex.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-executor-')),
    cwd = path.join(directory, 'workspace');
  fs.mkdirSync(cwd);
  const logs = [],
    requests = [],
    clients = [];
  let version = '0.160.1',
    account = {
      account: { type: 'chatgpt', email: 'synthetic-account-one', planType: 'plus' },
      requiresOpenaiAuth: true,
    },
    returnedCwd = cwd;
  const registry = () =>
    new ExecutorBindings({ directory, deviceId: 'local-device', actorId: 'human:local-device' });
  const connect = (executors = registry()) => {
    const client = new Codex({
      executors,
      requestTimeoutMs: 1000,
      log: { write: (event, details) => logs.push({ event, details }) },
      spawn: () => {
        const proc = new EventEmitter();
        proc.pid = 12345;
        proc.stdin = new PassThrough();
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.kill = () => {};
        proc.stdin.on('data', (bytes) => {
          const m = JSON.parse(bytes.toString());
          requests.push(m);
          if (m.id === undefined) return;
          const output = {
            initialize: {
              userAgent: 'codex_cli_rs/' + version,
              codexHome: path.join(directory, 'codex-profile'),
              platformOs:
                process.platform === 'win32'
                  ? 'windows'
                  : process.platform === 'darwin'
                    ? 'macos'
                    : 'linux',
            },
            'account/read': account,
            'thread/start': {
              thread: { id: 'synthetic-thread', cwd: returnedCwd },
              cwd: returnedCwd,
            },
            'thread/resume': {
              thread: { id: m.params.threadId, cwd: returnedCwd },
              cwd: returnedCwd,
            },
            'thread/read': { thread: { id: m.params.threadId, cwd: returnedCwd } },
            'thread/name/set': {},
            'turn/start': { turn: { id: 'synthetic-turn' } },
            'turn/steer': { turnId: 'synthetic-turn' },
          }[m.method];
          queueMicrotask(() =>
            proc.stdout.write(JSON.stringify({ id: m.id, result: output }) + '\n'),
          );
        });
        return proc;
      },
    });
    clients.push(client);
    return client;
  };
  t.after(() => {
    for (const c of clients) c.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    cwd,
    requests,
    logs,
    registry,
    connect,
    task: { id: 'task', title: 'Synthetic task', prompt: 'Synthetic instruction' },
    set account(v) {
      account = v;
    },
    set version(v) {
      version = v;
    },
    set returnedCwd(v) {
      returnedCwd = v;
    },
  };
}
test('actual Codex creation binds the local task before inference and stores no raw account identity', async (t) => {
  const f = fixture(t),
    registry = f.registry(),
    client = f.connect(registry),
    result = await client.start(f.task, f.cwd);
  assert.equal(result.threadId, 'synthetic-thread');
  const entry = registry.thread(result.threadId);
  assert.equal(entry.workspace, fs.realpathSync.native(f.cwd));
  assert.equal(entry.access, 'active');
  assert.equal(entry.serverVersion, '0.160.1');
  assert.equal(f.requests.filter((r) => r.method === 'account/read').length, 2);
  const saved = fs.readFileSync(registry.file, 'utf8');
  assert.ok(!saved.includes('synthetic-account-one'));
  assert.ok(!saved.includes('codex-profile'));
  assert.ok(!JSON.stringify(f.logs).includes('synthetic-account-one'));
});
test('changed account blocks a loaded-task send before a new turn or steer mutation', async (t) => {
  const f = fixture(t),
    client = f.connect();
  await client.start(f.task, f.cwd);
  const start = f.requests.length;
  f.account = {
    account: { type: 'chatgpt', email: 'synthetic-account-two' },
    requiresOpenaiAuth: true,
  };
  await assert.rejects(client.send('synthetic-thread', 'Changed owner'), {
    code: 'EXECUTOR_BINDING_HELD',
    delivery: 'not-sent',
  });
  assert.ok(!f.requests.slice(start).some((r) => ['turn/start', 'turn/steer'].includes(r.method)));
});
test('restart keeps the exact original task and a version change refuses resume before reading its history', async (t) => {
  const f = fixture(t),
    first = f.connect();
  await first.start(f.task, f.cwd);
  first.close();
  const saved = f.registry(),
    id = saved.thread('synthetic-thread').id;
  f.version = '0.161.0';
  const changed = f.connect(saved),
    at = f.requests.length;
  await assert.rejects(changed.send('synthetic-thread', 'No migration'), {
    code: 'EXECUTOR_BINDING_HELD',
  });
  assert.ok(
    !f.requests
      .slice(at)
      .some((r) => ['thread/resume', 'turn/start', 'turn/steer'].includes(r.method)),
  );
  assert.equal(f.registry().thread('synthetic-thread').id, id);
});
test('existing task continuation verifies the exact workspace and does not create a replacement chat', async (t) => {
  const f = fixture(t),
    client = f.connect();
  const result = await client.start({ ...f.task, threadId: 'existing-thread' }, f.cwd);
  assert.equal(result.threadId, 'existing-thread');
  assert.ok(f.requests.some((r) => r.method === 'thread/read'));
  assert.ok(!f.requests.some((r) => r.method === 'thread/start'));
  assert.equal(client.options.executors.thread('existing-thread').taskId, 'task');
  const other = path.join(f.directory, 'another-workspace');
  fs.mkdirSync(other);
  const at = f.requests.length;
  await assert.rejects(client.start({ ...f.task, threadId: 'existing-thread' }, other), {
    code: 'EXECUTOR_BINDING_HELD',
  });
  assert.ok(!f.requests.slice(at).some((r) => r.method === 'turn/start'));
});
test('an unexpected returned workspace never receives the first model turn', async (t) => {
  const f = fixture(t),
    other = path.join(f.directory, 'other');
  fs.mkdirSync(other);
  f.returnedCwd = other;
  await assert.rejects(f.connect().start(f.task, f.cwd), { code: 'EXECUTOR_BINDING_HELD' });
  assert.ok(f.requests.some((r) => r.method === 'thread/start'));
  assert.ok(!f.requests.some((r) => r.method === 'turn/start'));
});
test('revoked access remains distinct from offline transport and cannot be restored by another start', async (t) => {
  const f = fixture(t),
    registry = f.registry(),
    client = f.connect(registry);
  await client.start(f.task, f.cwd);
  const bound = registry.thread('synthetic-thread');
  assert.throws(() => registry.revoke(bound.id, 'source-text'), { code: 'EXECUTOR_BINDING_HELD' });
  registry.revoke(bound.id, 'human:local-device');
  client.close();
  const at = f.requests.length;
  await assert.rejects(
    f.connect(f.registry()).start({ ...f.task, threadId: 'synthetic-thread' }, f.cwd),
    { code: 'EXECUTOR_BINDING_HELD' },
  );
  assert.ok(!f.requests.slice(at).some((r) => ['thread/resume', 'turn/start'].includes(r.method)));
  assert.equal(f.registry().inspect()[0].access, 'revoked');
  assert.equal(f.registry().inspect()[0].online, 'unknown_until_next_handshake');
});
test('unsupported account identities cannot be claimed from provider kind or a model catalog', async (t) => {
  for (const account of [
    { type: 'apiKey' },
    { type: 'amazonBedrock', usesCodexManagedCredentials: true },
    { type: 'chatgpt', email: null },
  ]) {
    const f = fixture(t);
    f.account = { account, requiresOpenaiAuth: true };
    await assert.rejects(f.connect().start(f.task, f.cwd), { code: 'EXECUTOR_BINDING_HELD' });
    assert.ok(!f.requests.some((r) => ['thread/start', 'turn/start'].includes(r.method)));
    assert.equal(f.registry().inspect().length, 0);
  }
});
test('future and externally replaced binding journals preserve their bytes and hold dispatch', async (t) => {
  const f = fixture(t),
    client = f.connect();
  await client.start(f.task, f.cwd);
  const file = client.options.executors.file,
    future = JSON.stringify({ version: 99, entries: [] });
  fs.writeFileSync(file, future);
  await assert.rejects(client.send('synthetic-thread', 'Held'), { code: 'EXECUTOR_BINDING_HELD' });
  assert.throws(() => f.registry(), { code: 'PRIVATE_STORE_RECOVERY' });
  assert.equal(fs.readFileSync(file, 'utf8'), future);
});
