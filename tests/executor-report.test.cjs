'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { ExecutorBindings } = require('../src/executor-bindings.cjs'),
  { projection, validate } = require('../src/executor-report.cjs'),
  { Devices, prefix } = require('../src/devices.cjs');
const { HostPeer } = require('../src/peer.cjs'),
  { negotiate } = require('../src/peer-contract.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-executor-report-')),
    cwd = path.join(directory, 'workspace'),
    deviceId = crypto.randomUUID();
  fs.mkdirSync(cwd);
  const registry = new ExecutorBindings({ directory, deviceId, actorId: 'human:' + deviceId });
  const runtime = registry.runtime(
    {
      userAgent: 'codex_cli_rs/0.160.1',
      codexHome: path.join(directory, 'private-profile'),
      platformOs: 'windows',
    },
    { account: { type: 'chatgpt', email: 'private-synthetic-account' } },
  );
  const grant = registry.grant('task', runtime, cwd);
  registry.attach('task', 'source', runtime, cwd);
  const card = {
    id: 'task',
    taskKey: 'task-key',
    kind: 'task',
    status: 'ready',
    label: 'Ready',
    title: 'Owned synthetic task',
    sources: [{ id: 'source' }],
    primarySourceId: 'source',
  };
  const state = () => ({
    cards: [card],
    done: [],
    approvals: [],
    settings: { projects: [] },
    health: { ok: true },
    collectedAt: Date.now() / 1000,
  });
  t.after(() =>
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  );
  return { directory, cwd, deviceId, registry, runtime, grant, card, state };
}
test('recorded executor identity is bounded and redacted; transport, revocation and storage holds remain distinct', (t) => {
  const f = fixture(t),
    offline = f.registry.report('disconnected'),
    encoded = JSON.stringify(offline);
  for (const secret of [
    f.cwd,
    'private-profile',
    'private-synthetic-account',
    f.registry.state.salt,
  ])
    assert.equal(encoded.includes(secret), false);
  assert.equal(offline.liveExecutorVerified, false);
  assert.equal(offline.cloud, false);
  assert.equal(offline.grants[0].access, 'active');
  const active = projection(offline, f.deviceId).task(f.card);
  assert.equal(active.id, f.grant.id);
  assert.equal(active.binding, 'recorded_grant');
  assert.equal(
    projection(offline, f.deviceId).task({ ...f.card, sources: [{ id: 'another-source' }] })
      .binding,
    'unreported',
  );
  const restart = new ExecutorBindings({
    directory: f.directory,
    deviceId: f.deviceId,
    actorId: 'human:' + f.deviceId,
  });
  assert.equal(restart.report().grants[0].workspaceRef, offline.grants[0].workspaceRef);
  restart.revoke(f.grant.id, restart.actorId);
  assert.equal(restart.report('connected').grants[0].access, 'revoked');
  fs.writeFileSync(restart.file, '{"version":999}');
  const bytes = fs.readFileSync(restart.file);
  assert.equal(restart.report('connected').coverage, 'storage_held');
  assert.deepEqual(restart.report().grants, []);
  assert.throws(() => restart.inspect(), { code: 'EXECUTOR_BINDING_HELD' });
  assert.deepEqual(fs.readFileSync(restart.file), bytes);
});
test('capability reports cannot be widened into live verification or cloud/task authority', (t) => {
  const f = fixture(t),
    report = f.registry.report();
  for (const change of [
    { schema: 2 },
    { deviceId: crypto.randomUUID() },
    { cloud: true },
    { liveExecutorVerified: true },
    { grants: [{ ...report.grants[0], capabilities: ['shell'] }] },
    { grants: [{ ...report.grants[0], accountRef: 'raw-account' }] },
    { coverage: 'storage_held' },
  ])
    assert.throws(() => validate({ ...report, ...change }, f.deviceId));
  const legacy = projection(null, f.deviceId);
  assert.equal(legacy.summary.supported, false);
  assert.equal(legacy.task({ ...f.card, executor: report.grants[0] }).binding, 'unreported');
  assert.throws(
    () =>
      negotiate({
        peerContract: { ...require('../src/peer-contract.cjs').capabilities(), executorReports: 2 },
      }),
    /unsupported/,
  );
});
test('a whole-device snapshot reads its registry once and keeps duplicate task identities with their original owner', (t) => {
  const f = fixture(t);
  let reads = 0;
  const devices = new Devices({
    directory: f.directory,
    identity: { id: f.deviceId, name: 'Original', kind: 'pc' },
    state: f.state,
    executorReport: () => {
      reads++;
      return f.registry.report();
    },
  });
  const snapshot = devices.snapshot();
  assert.equal(reads, 1);
  assert.equal(snapshot.cards[0].executor.deviceId, f.deviceId);
  assert.equal(devices.localState().peerContract.executorReports, 1);
  const otherId = crypto.randomUUID(),
    report = structuredClone(f.registry.report());
  report.deviceId = otherId;
  const entry = {
    id: 'paired',
    state: {
      ...f.state(),
      host: { id: otherId, name: 'Other' },
      peerContract: { ...require('../src/peer-contract.cjs').capabilities(), executorReports: 1 },
      executorReport: report,
    },
    peer: { connected: false },
  };
  devices.peers.set(entry.id, entry);
  const combined = devices.snapshot();
  assert.equal(combined.cards.length, 2);
  const remote = combined.cards.find((c) => !c.owner.local);
  assert.equal(remote.id, prefix(entry.id) + 'task');
  assert.equal(remote.executor.taskId, remote.id);
  assert.equal(remote.executor.threadId, prefix(entry.id) + 'source');
  assert.equal(remote.executor.deviceId, otherId);
  assert.equal(remote.executor.access, 'active');
  assert.equal(remote.owner.online, false);
  report.grants[0].access = 'revoked';
  assert.equal(devices.snapshot().cards.find((c) => !c.owner.local).executor.access, 'revoked');
  devices.peers.clear();
  assert.equal(devices.snapshot().cards.length, 1);
});
test('actual paired TLS carries the same negotiated grant in HTTP and ordered events without migrating or reenabling revoked work', async (t) => {
  const f = fixture(t),
    producer = new Devices({
      directory: f.directory,
      identity: { id: f.deviceId, name: 'Original', kind: 'pc' },
      state: f.state,
      executorReport: () => f.registry.report('connected'),
    });
  const host = new HostPeer({
    directory: f.directory,
    encrypt: (v) => Buffer.from(v),
    decrypt: (v) => v.toString(),
    commands: ['details'],
    state: () => producer.localState(),
    command: () => {
      f.registry.assertThread('source', f.runtime, f.cwd);
      return f.card;
    },
  });
  const receiverDirectory = path.join(f.directory, 'receiver');
  fs.mkdirSync(receiverDirectory);
  const receiver = new Devices({
    directory: receiverDirectory,
    identity: { id: crypto.randomUUID(), name: 'Viewer', kind: 'mac' },
    state: () => ({ ...f.state(), cards: [] }),
    encrypt: (v) => Buffer.from(v),
    decrypt: (v) => v.toString(),
  });
  t.after(() => {
    receiver.close();
    host.close();
  });
  const pair = await receiver.add(await host.start('127.0.0.1'));
  assert.equal(receiver.snapshot().cards[0].executor.id, f.grant.id);
  assert.equal(receiver.snapshot().cards[0].owner.capabilities.executorReports, 1);
  f.registry.revoke(f.grant.id, f.registry.actorId);
  host.broadcast(producer.localState());
  for (let i = 0; i < 40 && receiver.snapshot().cards[0].executor.access !== 'revoked'; i++)
    await new Promise((r) => setTimeout(r, 20));
  const revoked = receiver.snapshot().cards[0];
  assert.equal(revoked.executor.access, 'revoked');
  assert.equal(revoked.owner.capabilities.executorReports, 1);
  await assert.rejects(
    receiver.command('details', { id: revoked.id, taskKey: revoked.taskKey }),
    /original executor/,
  );
  const entry = receiver.peers.get(pair.id);
  entry.peer.connected = false;
  const offline = receiver.snapshot().cards[0];
  assert.equal(offline.owner.online, false);
  assert.equal(offline.executor.access, 'revoked');
  await assert.rejects(
    receiver.command('start', { id: offline.id, taskKey: offline.taskKey }),
    /offline|support/,
  );
});
