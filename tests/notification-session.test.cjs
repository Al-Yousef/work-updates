'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { EventEmitter } = require('node:events');
const { Queue } = require('../src/queue.cjs');
const { Devices } = require('../src/devices.cjs');
const { StatePublisher } = require('../src/state-order.cjs');
const { NotificationSession } = require('../src/notification-session.cjs');
const localId = '11111111-1111-4111-8111-111111111111';
const remoteId = '22222222-2222-4222-8222-222222222222';
const sender = { channel: 'synthetic', senderId: 'demo-owner' };
const policy = {
  coalesceMs: 0,
  maxSnoozeReminders: 1,
  quietHours: null,
  calls: {
    enabled: true,
    urgency: 'manual',
    unansweredMs: 1000,
    minIntervalMs: 0,
    maxPerTask: 1,
    maxPer24Hours: 2,
  },
};
const code =
  'wu1:' +
  Buffer.from(
    JSON.stringify({ host: '127.0.0.1', port: 12009, pin: 'a'.repeat(64), token: 'b'.repeat(64) }),
  ).toString('base64url');
function feed(queue, revision = 'v1', extra = {}) {
  queue.setFeed({
    device: { kind: 'pc', label: 'PC' },
    monitoredCount: 1,
    collectedAt: 1,
    threads: [
      {
        id: 'same-chat',
        title: 'Synthetic source chat',
        taskTitle: 'Synthetic current task',
        body: 'Waiting on you to choose the next step.',
        summary: 'Choose the next step.',
        status: 'needs',
        fingerprint: revision,
        updatedAt: 1,
        readyForReview: true,
        contextLoaded: true,
        ...extra,
      },
    ],
  });
}
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-notification-session-'));
  const local = new Queue(path.join(dir, 'local')),
    remote = new Queue(path.join(dir, 'remote'));
  feed(local);
  feed(remote);
  const calls = [],
    peers = [];
  const publisher = new StatePublisher();
  let time = Date.now(),
    sequence = 0;
  const devices = new Devices({
    directory: dir,
    identity: { id: localId, name: 'Sample PC', kind: 'pc' },
    state: () => local.snapshot(),
    command: async (method, input) => {
      calls.push({ owner: 'local', method, input });
      if (method === 'action') return local.action(input.id, input.action, input.taskKey);
      return {};
    },
    encrypt: (s) => Buffer.from(s),
    decrypt: (b) => b.toString(),
    makePeer: () => {
      const peer = new EventEmitter();
      peer.connected = false;
      peer.generation = 1;
      peer.publish = () => {
        const state = publisher.stamp({
          ...remote.snapshot(),
          host: { id: remoteId, name: 'Sample Mac', kind: 'mac' },
        });
        peer.emit('state', state);
        return state;
      };
      peer.connect = async () => {
        peer.connected = true;
        peer.publish();
      };
      peer.command = async (method, input) => {
        calls.push({ owner: 'remote', method, input });
        if (method === 'action') remote.action(input.id, input.action, input.taskKey);
        return peer.publish();
      };
      peer.close = () => {
        peer.connected = false;
      };
      peers.push(peer);
      return peer;
    },
  });
  const session = new NotificationSession(devices, {
    localQueue: local,
    policy,
    trustedSender: sender,
    clock: () => time,
    id: () => 'synthetic-' + ++sequence,
  });
  t.after(() => {
    session.close();
    devices.close();
    const resolved = path.resolve(dir),
      base = path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(base + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const accept = (item) => {
    session.flow.beginDelivery(item.id);
    session.flow.settleDelivery(item.id, { state: 'accepted' });
  };
  const incoming = (item, extra = {}) => ({
    ...sender,
    eventId: item.id,
    notificationId: item.id,
    action: 'reviewed',
    ...extra,
  });
  return {
    local,
    remote,
    devices,
    peers,
    calls,
    session,
    accept,
    incoming,
    advance: (ms) => {
      time += ms;
    },
  };
}
test('real Queue change events feed the opt-in flow; Reviewed and Snooze route through Devices to the original owner', async (t) => {
  const f = setup(t);
  assert.equal(f.session.flow.tick().length, 0);
  const pairing = await f.devices.add(code);
  feed(f.local, 'v2');
  feed(f.remote, 'v2');
  f.peers[0].publish();
  const items = f.session.flow.tick();
  assert.equal(items.length, 2);
  const local = items.find((i) => i.refs[0].ownerId === localId),
    remote = items.find((i) => i.refs[0].ownerId === pairing.id);
  f.accept(local);
  f.accept(remote);
  assert.equal((await f.session.flow.receive(f.incoming(local))).codexAccepted, true);
  assert.equal(
    (await f.session.flow.receive(f.incoming(remote, { action: 'snooze' }))).codexAccepted,
    true,
  );
  assert.equal(f.local.cards()[0].reviewed, true);
  assert.equal(f.remote.cards()[0].snoozed, true);
  assert.deepEqual(
    f.calls.map((c) => [c.owner, c.input.id, c.input.taskKey]),
    [
      ['local', 'same-chat', f.local.cards()[0].taskKey],
      ['remote', 'same-chat', f.remote.cards()[0].taskKey],
    ],
  );
});
test('older per-computer snapshots are rejected before the notification flow and reconnecting does not repeat a message', async (t) => {
  const f = setup(t);
  await f.devices.add(code);
  const peer = f.peers[0],
    old = peer.publish();
  feed(f.remote, 'v2');
  peer.publish();
  const item = f.session.flow.tick()[0];
  f.accept(item);
  peer.emit('state', old);
  assert.equal(f.session.flow.tick().length, 0);
  peer.generation++;
  peer.connected = true;
  peer.publish();
  assert.equal(f.session.flow.tick().length, 0);
});
test('forgetting and pairing the same host again revokes old message identities', async (t) => {
  const f = setup(t),
    pair = await f.devices.add(code);
  const item = f.session.flow.tick()[0];
  f.accept(item);
  f.devices.remove(pair.id);
  const next = await f.devices.add(code);
  assert.notEqual(pair.id, next.id);
  await assert.rejects(
    f.session.flow.receive(f.incoming(item, { action: 'reply', text: 'Synthetic response' })),
    /changed|unavailable/,
  );
  assert.equal(f.calls.length, 0);
});
test('a stale reply acknowledgment after forget or reconnect cannot claim Codex accepted it', async (t) => {
  for (const mode of ['forget', 'reconnect']) {
    const f = setup(t);
    const pair = await f.devices.add(code);
    const item = f.session.flow.tick()[0];
    f.accept(item);
    let resolve;
    f.peers[0].command = () =>
      new Promise((r) => {
        resolve = r;
      });
    const pending = f.session.flow.receive(
      f.incoming(item, { action: 'reply', text: 'Synthetic response' }),
    );
    assert.ok(resolve);
    if (mode === 'forget') f.devices.remove(pair.id);
    else {
      f.peers[0].generation++;
      f.peers[0].publish();
    }
    resolve({ accepted: true });
    const result = await pending;
    assert.equal(result.state, 'uncertain');
    assert.equal(result.codexAccepted, false);
    await f.session.flow.receive(f.incoming(item, { action: 'reply', text: 'Synthetic response' }));
  }
});
test('a cancelled, never-dispatched message can be queued once its computer returns online', async (t) => {
  const f = setup(t);
  await f.devices.add(code);
  const item = f.session.flow.tick()[0];
  f.peers[0].connected = false;
  f.peers[0].emit('connection', false);
  assert.equal(f.session.flow.outbox.get(item.id).state, 'cancelled');
  f.peers[0].connected = true;
  f.peers[0].emit('connection', true);
  const replacement = f.session.flow.tick();
  assert.equal(replacement.length, 1);
  assert.notEqual(replacement[0].id, item.id);
  f.accept(replacement[0]);
  assert.equal(f.session.flow.tick().length, 0);
});
test('closing the opt-in session removes only its listeners and leaves both queues available', async (t) => {
  const f = setup(t);
  await f.devices.add(code);
  f.session.close();
  const before = f.session.flow.export();
  feed(f.local, 'v3');
  f.peers[0].publish();
  assert.deepEqual(f.session.flow.export(), before);
  assert.equal(f.devices.snapshot().cards.length, 2);
});
