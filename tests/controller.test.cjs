'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { EventEmitter } = require('node:events');
const { Queue } = require('../src/queue.cjs');
const { Controller } = require('../src/controller.cjs');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-controller-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const q = new Queue(dir),
    client = new EventEmitter();
  client.reply = (id, value) => {
    client.replyValue = { id, value };
  };
  client.reject = (id) => {
    client.rejected = id;
  };
  return { q, client, c: new Controller(q, client) };
}
test('a failed start keeps its created chat for retry and concurrent clicks create only one chat', async (t) => {
  const { q, client, c } = setup(t);
  let starts = 0;
  client.start = async (task) => {
    starts++;
    if (!task.threadId) client.emit('created', { taskId: task.id, threadId: 'owned-chat' });
    await new Promise((r) => setTimeout(r, 20));
    throw new Error('Temporary failure');
  };
  const task = q.create({ title: 'Verify queue behavior', prompt: 'Run the checks.' });
  const run = c.start(task.id);
  await c.start(task.id);
  await assert.rejects(run);
  assert.equal(starts, 1);
  assert.equal(task.threadId, 'owned-chat');
  client.start = async (task) => {
    assert.equal(task.threadId, 'owned-chat');
    return { threadId: task.threadId, turnId: 'retry' };
  };
  await c.start(task.id);
  assert.equal(task.status, 'working');
});
test('streamed commentary is quiet and actual completion creates a review notification', (t) => {
  const { q, client, c } = setup(t),
    task = q.create({ title: 'Verify queue behavior', prompt: 'Run the checks.' });
  q.patch(task.id, { threadId: 'owned-chat', status: 'working' });
  let attention = 0;
  c.on('attention', () => attention++);
  client.emit('notification', {
    method: 'item/agentMessage/delta',
    params: { threadId: 'owned-chat', itemId: 'msg', delta: 'Checks passed.' },
  });
  assert.equal(attention, 0);
  client.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'owned-chat', turn: { id: 'completed-pass', status: 'completed' } },
  });
  assert.equal(task.status, 'ready');
  assert.equal(task.notificationVersion, 'completed-pass');
  assert.equal(attention, 1);
});
test('approval requests remain pending until a human answers, and unknown requests fail closed', (t) => {
  const { q, client, c } = setup(t),
    task = q.create({ title: 'Verify queue behavior', prompt: 'Run the checks.' });
  q.patch(task.id, { threadId: 'owned-chat' });
  client.emit('request', {
    id: 4,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'owned-chat', command: 'test command' },
  });
  assert.equal(task.status, 'needs');
  assert.equal(client.replyValue, undefined);
  assert.equal(q.snapshot().approvals[0].reply, undefined);
  assert.throws(() => c.respond('4', 'acceptForSession'));
  c.respond('4', 'accept');
  assert.deepEqual(client.replyValue, { id: 4, value: { decision: 'accept' } });
  assert.equal(task.status, 'working');
  assert.equal(q.approvals.size, 0);
  client.emit('request', { id: 5, method: 'unknown/request', params: { threadId: 'owned-chat' } });
  assert.equal(client.rejected, 5);
  assert.equal(task.status, 'blocked');
});
