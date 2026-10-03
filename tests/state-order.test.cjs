'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { StatePublisher, StateOrder } = require('../src/state-order.cjs');
const { HostPeer, RemotePeer } = require('../src/peer.cjs');
const { Queue } = require('../src/queue.cjs');
const { feed } = require('../src/demo.cjs');

test('host snapshot order survives equal timestamps, a backward clock and a fresh process', () => {
  let clock = 100000;
  const publisher = new StatePublisher({ clock: () => clock });
  const a = publisher.stamp({ cards: [] }),
    b = publisher.stamp({ cards: [] });
  clock = 1000;
  const c = publisher.stamp({ cards: [] });
  assert.equal(a.servedAt, b.servedAt);
  assert.ok(c.servedAt < a.servedAt);
  assert.deepEqual(
    [a, b, c].map((s) => s.stateVersion.revision),
    [1, 2, 3],
  );
  const order = new StateOrder({ required: true });
  assert.equal(order.accept(c.stateVersion), true);
  assert.equal(order.accept(b.stateVersion), false);
  const restarted = new StatePublisher({ clock: () => clock }).stamp({ cards: [] });
  assert.notEqual(restarted.stateVersion.epoch, c.stateVersion.epoch);
  assert.throws(() => order.accept(restarted.stateVersion), { code: 'STATE_RESTARTED' });
  order.reset();
  assert.equal(order.accept(restarted.stateVersion), true);
  assert.throws(() => order.accept(c.stateVersion), { code: 'STATE_RESTARTED' });
});

test('equal revisions are ignored and ordered peers cannot silently lose their version', () => {
  const publisher = new StatePublisher(),
    order = new StateOrder({ required: true }),
    snapshot = publisher.stamp({});
  assert.equal(order.accept(snapshot.stateVersion), true);
  assert.equal(order.accept(snapshot.stateVersion), false);
  assert.throws(() => order.accept(null), /Update/);
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => new StateOrder().accept({ ...snapshot.stateVersion, revision }), /invalid/);
});

test('private TLS delivers a frozen older HTTP snapshot after a newer Done event without restoring the task', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-order-wire-'));
  const queue = new Queue(directory);
  queue.setFeed(feed(), { ok: true });
  const publisher = new StatePublisher({ clock: () => 100000 });
  const state = () =>
    publisher.stamp({ ...queue.snapshot(), host: { id: '11111111-1111-4111-8111-111111111111' } });
  const host = new HostPeer({
    directory,
    state,
    encrypt: (v) => Buffer.from(v),
    decrypt: (v) => v.toString(),
    command: async () => ({}),
  });
  let peer;
  t.after(() => {
    peer?.close();
    host.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const code = await host.start('127.0.0.1');
  peer = new RemotePeer(code);
  let current;
  const order = new StateOrder({ required: true });
  peer.on('state', (value) => {
    if (order.accept(value.stateVersion)) current = value;
  });
  await peer.connect();
  const task = current.cards.find((c) => c.status === 'ready');
  assert.ok(task);
  let hold = true,
    release,
    capturedResolve;
  const captured = new Promise((resolve) => {
    capturedResolve = resolve;
  });
  const original = host.request.bind(host);
  host.request = (req, res) => {
    if (hold && req.url === '/state' && host.authorized(req)) {
      hold = false;
      const frozen = JSON.parse(JSON.stringify(state()));
      release = () => host.json(res, 200, frozen);
      capturedResolve();
      return;
    }
    return original(req, res);
  };
  const delayed = peer.json('/state');
  await captured;
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Done event timed out')), 5000);
    peer.on('state', (value) => {
      if (value.done.some((c) => c.taskKey === task.taskKey)) {
        clearTimeout(timer);
        resolve(value);
      }
    });
  });
  queue.action(task.id, 'reviewed', task.taskKey);
  queue.action(task.id, 'done', task.taskKey);
  host.broadcast(state());
  const latest = await completed;
  release();
  const stale = await delayed;
  assert.equal(
    stale.servedAt,
    latest.servedAt,
    'Whole-second timestamps cannot distinguish these states',
  );
  assert.equal(
    stale.cards.find((c) => c.taskKey === task.taskKey).reviewed,
    false,
    'This is the actual older wire payload',
  );
  assert.ok(latest.done.some((c) => c.taskKey === task.taskKey));
  assert.equal(order.accept(stale.stateVersion), false);
  assert.ok(
    current.done.some((c) => c.taskKey === task.taskKey),
    'The already-completed task stays completed',
  );
});
