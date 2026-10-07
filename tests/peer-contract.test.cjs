'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { capabilities, negotiate, admission } = require('../src/peer-contract.cjs');
const { HostPeer, RemotePeer } = require('../src/peer.cjs');
const { StatePublisher } = require('../src/state-order.cjs');
test('legacy peer coverage stays explicit and cannot claim assistant, attachments or queued-message parity', () => {
  const legacy = negotiate({});
  assert.equal(legacy.version, 1);
  assert.equal(legacy.receiptVersion, 0);
  for (const method of [
    'queueMessage',
    'cancelMessage',
    'clearMessages',
    'assistantAsk',
    'attachImages',
  ])
    assert.ok(!legacy.commands.includes(method));
  assert.throws(() => admission({}, 'queueMessage'), /does not support/);
  assert.throws(() => admission({ peerContract: capabilities() }, 'queueMessage'), /negotiate/);
});
test('future, malformed and widened peer capability claims fail closed', () => {
  for (const patch of [
    { version: 3 },
    { receiptVersion: 2 },
    { assistant: true },
    { attachments: true },
    { commands: ['shell'] },
    { commands: ['send', 'send'] },
    { orderedSnapshots: false },
  ])
    assert.throws(
      () => negotiate({ peerContract: { ...capabilities(), ...patch } }),
      /unsupported/,
    );
});
test('a paired mutation binds its host epoch and exact source task and message identity', () => {
  const state = new StatePublisher().stamp({
    peerContract: capabilities(),
    cards: [
      { id: 'card', taskKey: 'task', contextRevision: 'current', sources: [{ id: 'source' }] },
    ],
    done: [],
  });
  const request = {
    peerProtocolVersion: 2,
    hostEpoch: state.stateVersion.epoch,
    input: {
      id: 'card',
      taskKey: 'task',
      sourceId: 'source',
      contextRevision: 'current',
      messageId: crypto.randomUUID(),
    },
  };
  assert.equal(admission(state, 'send', request).version, 2);
  assert.throws(
    () => admission(state, 'send', { ...request, hostEpoch: crypto.randomUUID() }),
    /restarted/,
  );
  for (const patch of [
    { sourceId: 'another' },
    { taskKey: 'changed' },
    { contextRevision: 'old' },
    { messageId: 'missing' },
  ])
    assert.throws(
      () => admission(state, 'send', { ...request, input: { ...request.input, ...patch } }),
      /exact paired/,
    );
});
test('actual pinned TLS rejects unsupported commands and an old host session before dispatch', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-peer-contract-'));
  let publisher = new StatePublisher();
  const calls = [];
  const host = new HostPeer({
    directory,
    commands: ['create', 'details', 'refresh'],
    encrypt: (v) => Buffer.from(v),
    decrypt: (v) => v.toString(),
    state: () => publisher.stamp({ cards: [], done: [], settings: {}, approvals: [] }),
    command: async (method, input) => {
      calls.push({ method, input });
      return { id: 'created' };
    },
  });
  const code = await host.start('127.0.0.1'),
    remote = new RemotePeer(code);
  t.after(() => {
    remote.close();
    host.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await remote.connect();
  assert.equal(negotiate(remote.state).version, 2);
  await assert.rejects(remote.command('send', {}), /does not support/);
  assert.equal(calls.length, 0);
  const oldEpoch = remote.state.stateVersion.epoch;
  publisher = new StatePublisher();
  await assert.rejects(
    remote.command('create', { title: 'synthetic' }),
    (error) => error.code === 'PEER_EPOCH' && error.delivery === 'not-sent',
  );
  assert.equal(calls.length, 0);
  const current = await remote.json('/state');
  remote.state = current;
  assert.notEqual(current.stateVersion.epoch, oldEpoch);
  assert.deepEqual(await remote.command('create', { title: 'synthetic' }), { id: 'created' });
  assert.equal(calls.length, 1);
});
