'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const { Queue } = require('../src/queue.cjs'),
  { Messages } = require('../src/messages.cjs'),
  { Controller } = require('../src/controller.cjs'),
  { Codex } = require('../src/codex.cjs'),
  { CodexDesktop } = require('../src/codex-desktop.cjs'),
  { feed } = require('../src/demo.cjs');
const { EventEmitter } = require('node:events');
test('expiry after writer preparation is definitely unsent, cancels its queued identity and leaves other work intact', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-deadline-fixture-')),
    queue = new Queue(directory);
  queue.setFeed(feed());
  let calls = 0;
  const expiresAt = Date.now() + 60000,
    client = new EventEmitter();
  client.prepare = async () => {
    t.mock.method(Date, 'now', () => expiresAt + 1);
  };
  client.send = async () => {
    calls++;
    return { turnId: 'turn' };
  };
  const controller = new Controller(queue, client),
    messages = new Messages(queue, controller, { auto: false });
  t.after(() => {
    messages.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('hyphen-deadline-fixture-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const card = queue.cards()[0],
    input = {
      id: card.id,
      taskKey: card.taskKey,
      sourceId: card.primarySourceId,
      messageId: crypto.randomUUID(),
      text: 'One explicitly scheduled task',
      expiresAt,
    };
  await assert.rejects(
    messages.send(input),
    (error) => error.code === 'SCHEDULE_EXPIRED' && error.delivery === 'not-sent',
  );
  assert.equal(calls, 0);
  assert.equal(messages.state.entries[0].status, 'cancelled');
  assert.equal(queue.busy.size, 0);
});
test('Codex client and desktop owner recheck expiry after their own asynchronous preparation', async (t) => {
  const expiry = Date.now() + 60000,
    client = new Codex();
  let calls = 0;
  client.prepare = async () => {
    t.mock.method(Date, 'now', () => expiry + 1);
  };
  client.call = () => {
    calls++;
  };
  await assert.rejects(client.send('source', 'Request', [], { expiresAt: expiry }), /expired/);
  assert.equal(calls, 0);
  const desktop = new CodexDesktop();
  desktop.connect = async () => {};
  desktop.request = () => {
    calls++;
  };
  await assert.rejects(
    desktop.send('source', 'Request', { owner: 'owner', expiresAt: expiry }),
    /expired/,
  );
  assert.equal(calls, 0);
});
test('pause and cancellation arriving during owner discovery refuse the actual mutation with distinct outcomes', async (t) => {
  const expiry = Date.now() + 60000,
    client = new Codex();
  client.prepare = async () => {};
  let calls = 0;
  client.call = () => {
    calls++;
  };
  await assert.rejects(
    client.send('source', 'Request', [], { expiresAt: expiry, beforeDispatch: () => 'wait' }),
    (error) => error.code === 'SCHEDULE_PAUSED' && error.delivery === 'not-sent',
  );
  await assert.rejects(
    client.send('source', 'Request', [], { expiresAt: expiry, beforeDispatch: () => 'deny' }),
    (error) => error.code === 'SCHEDULE_CANCELLED' && error.delivery === 'not-sent',
  );
  assert.equal(calls, 0);
});
