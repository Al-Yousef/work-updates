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
test('a lost connection blocks only its affected chats and preserves unrelated approvals', (t) => {
  const { q, client } = setup(t);
  const a = q.create({ title: 'First task', prompt: 'Work.' });
  const b = q.create({ title: 'Other task', prompt: 'Work.' });
  q.patch(a.id, { threadId: 'first', status: 'working' });
  q.patch(b.id, { threadId: 'other', status: 'needs' });
  q.approvals.set('one', { taskId: a.id });
  q.approvals.set('two', { taskId: b.id });
  client.emit('disconnected', { threadIds: ['first'], message: 'Specific connection failure' });
  assert.equal(a.status, 'blocked');
  assert.equal(a.error, 'Specific connection failure');
  assert.equal(b.status, 'needs');
  assert.equal(q.approvals.has('one'), false);
  assert.equal(q.approvals.has('two'), true);
});
test('a refused writer lock creates no adopted task or fake user message', async (t) => {
  const { q, client, c } = setup(t);
  q.setFeed({
    threads: [
      {
        id: 'external-chat',
        title: 'Source chat',
        taskTitle: 'Review draft',
        body: 'Draft ready.',
        status: 'ready',
        lifecycle: 'completed',
        fingerprint: 'version',
        contextLoaded: true,
      },
    ],
  });
  const card = q.get('external-chat');
  let sends = 0;
  client.prepare = async () => {
    throw new Error('already has an active writer');
  };
  client.send = async () => {
    sends++;
  };
  await assert.rejects(c.send(card.id, 'A test reply', undefined, card.taskKey), /active writer/);
  assert.equal(q.state.tasks.length, 0);
  assert.equal(q.get(card.id).status, 'ready');
  assert.equal(q.get(card.id).sources[0].body, 'Draft ready.');
  assert.equal(q.busy.size, 0);
  assert.equal(sends, 0);
});
test('a detached old task cannot steer a chat that is working in the desktop', async (t) => {
  const { q, client, c } = setup(t);
  const task = q.create({ title: 'Old task', prompt: 'Old request' });
  q.patch(task.id, { threadId: 'external-chat', status: 'blocked', error: 'Codex disconnected' });
  q.setFeed({
    threads: [
      {
        id: 'external-chat',
        title: 'Source chat',
        taskTitle: 'Current request',
        body: 'Working on the current request.',
        status: 'working',
        lifecycle: 'working',
        fingerprint: 'version',
        contextLoaded: true,
      },
    ],
  });
  client.prepare = async () => {
    throw new Error('Should not resume');
  };
  const card = q.get(task.id);
  await assert.rejects(
    c.send(card.id, 'A test reply', undefined, card.taskKey),
    /working in Codex/,
  );
  assert.equal(task.messages.length, 0);
  assert.equal(q.get(task.id).status, 'working');
});
test('group reply uses the displayed source and concurrent retries cannot adopt it twice', async (t) => {
  const { q, client, c } = setup(t);
  const records = [
    {
      id: 'first-chat',
      title: 'Older chat',
      taskTitle: 'Review release draft',
      body: 'Ready.',
      status: 'ready',
      fingerprint: 'one',
      updatedAt: 2,
    },
    {
      id: 'needs-chat',
      title: 'Decision chat',
      taskTitle: 'Approve release notes',
      body: 'Need your approval.',
      status: 'needs',
      fingerprint: 'two',
      updatedAt: 1,
    },
  ];
  q.setFeed({ threads: records });
  q.group({ title: 'Release', ids: records.map((r) => r.id) });
  const card = q.cards()[0];
  let release,
    sends = 0;
  client.send = async (id) => {
    assert.equal(id, 'needs-chat');
    sends++;
    await new Promise((r) => {
      release = r;
    });
    return {turn:{id:'accepted-turn'}};
  };
  const pending = c.send(card.id, 'Use the verified draft', undefined, card.taskKey);
  await assert.rejects(c.send(card.id, 'Second click', undefined, card.taskKey));
  assert.equal(q.state.tasks.length, 1);
  release();
  await pending;
  assert.equal(sends, 1);
  const task = q.state.tasks[0];
  client.send = async (id) => {
    assert.equal(id, 'needs-chat');
    return {turnId:'accepted-follow-up'};
  };
  await c.send(task.id, 'A later follow-up', 'needs-chat');
  assert.equal(q.state.tasks.length, 1);
});
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
test('an old task turn ID cannot substitute for a missing current RPC receipt',async t=>{
  const {q,client,c}=setup(t);const task=q.create({title:'Test receipt',prompt:'A test'});
  q.patch(task.id,{threadId:'test-source',turnId:'old-turn',status:'ready'});q.ownedThreads.add('test-source');
  client.send=async()=>({});
  await assert.rejects(c.send(task.id,'New test',undefined,task.id),error=>error.code==='DELIVERY_RECEIPT'&&error.delivery==='uncertain');
  assert.equal(q.busy.size,0);
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
test('a delayed completion does not reopen a task the user completed', (t) => {
  const { q, client, c } = setup(t),
    task = q.create({ title: 'Verify a completed task', prompt: 'Check a sample.' });
  q.patch(task.id, { threadId: 'owned-chat', status: 'ready' });
  q.action(task.id, 'done');
  let attention = 0;
  c.on('attention', () => attention++);
  client.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'owned-chat', turn: { id: 'late', status: 'completed' } },
  });
  assert.equal(q.get(task.id).status, 'done');
  assert.equal(attention, 0);
});
test('acceptance binds the current turn before started and old updates cannot clear its request', async (t) => {
  const { q, client, c } = setup(t);
  const task = q.create({ title: 'Current pass', prompt: 'Check the fixture.' });
  q.patch(task.id, { threadId: 'owned-chat', status: 'ready', turnId: 'old-turn' });
  q.ownedThreads.add('owned-chat');
  client.send = async () => ({ turn: { id: 'new-turn' } });
  await c.send(task.id, 'Run the current pass');
  assert.equal(task.turnId, 'new-turn');
  q.approvals.set('current-request', { taskId: task.id });
  q.patch(task.id, { status: 'needs' });
  let attention = 0;
  c.on('attention', () => attention++);
  client.emit('notification', { method: 'turn/started', params: {
    threadId: 'owned-chat', turn: { id: 'unrelated-turn' },
  } });
  client.emit('notification', { method: 'item/agentMessage/delta', params: {
    threadId: 'owned-chat', turnId: 'old-turn', itemId: 'old-answer', delta: 'Obsolete answer.',
  } });
  client.emit('notification', { method: 'item/completed', params: {
    threadId: 'owned-chat', turnId: 'old-turn', item: { id: 'old-answer', type: 'agentMessage', text: 'Obsolete final answer.' },
  } });
  client.emit('notification', { method: 'turn/completed', params: {
    threadId: 'owned-chat', turn: { id: 'old-turn', status: 'completed' },
  } });
  assert.equal(task.status, 'needs');
  assert.equal(task.turnId, 'new-turn');
  assert.equal(task.messages.some((m) => m.id === 'old-answer'), false);
  assert.equal(q.approvals.has('current-request'), true);
  assert.equal(attention, 0);
});
test('completion and its answer before the RPC reply are applied only to the accepted turn', async (t) => {
  const { q, client, c } = setup(t);
  const task = q.create({ title: 'Current pass', prompt: 'Check the fixture.' });
  q.patch(task.id, { threadId: 'owned-chat', status: 'ready', turnId: 'old-turn' });
  q.ownedThreads.add('owned-chat');
  let attention = 0;
  c.on('attention', () => attention++);
  client.send = async () => {
    for (const turnId of ['old-turn', 'new-turn']) {
      client.emit('notification', { method: 'item/completed', params: {
        threadId: 'owned-chat', turnId, item: { id: turnId + '-answer', type: 'agentMessage',
          text: turnId === 'new-turn' ? 'Waiting for the external fixture service.' : 'Obsolete answer.' },
      } });
      client.emit('notification', { method: 'turn/completed', params: {
        threadId: 'owned-chat', turn: { id: turnId, status: 'completed' },
      } });
    }
    return { turn: { id: 'new-turn' } };
  };
  const receipt = await c.send(task.id, 'Run the current pass');
  assert.equal(receipt.turnId, 'new-turn');
  assert.equal(task.status, 'waiting');
  assert.equal(task.notificationVersion, 'new-turn');
  assert.equal(task.messages.filter((m) => m.role === 'assistant').length, 1);
  assert.equal(task.messages.at(-1).text, 'Waiting for the external fixture service.');
  assert.equal(attention, 1);
  client.emit('notification', { method: 'turn/started', params: {
    threadId: 'owned-chat', turn: { id: 'old-turn' },
  } });
  assert.equal(task.turnId, 'new-turn');
  client.emit('notification', { method: 'turn/completed', params: {
    threadId: 'owned-chat', turn: { id: 'new-turn', status: 'completed' },
  } });
  client.emit('notification', { method: 'turn/started', params: {
    threadId: 'owned-chat', turn: { id: 'new-turn' },
  } });
  assert.equal(task.status, 'waiting');
  assert.equal(attention, 1);
});
test('a new task completed before start acknowledgement stays completed after acknowledgement', async (t) => {
  const { q, client, c } = setup(t);
  const task = q.create({ title: 'New pass', prompt: 'Check the fixture.' });
  client.start = async () => {
    client.emit('created', { taskId: task.id, threadId: 'owned-chat' });
    client.emit('notification', { method: 'turn/started', params: {
      threadId: 'owned-chat', turn: { id: 'new-turn' },
    } });
    client.emit('notification', { method: 'turn/completed', params: {
      threadId: 'owned-chat', turn: { id: 'new-turn', status: 'completed' },
    } });
    return { threadId: 'owned-chat', turnId: 'new-turn' };
  };
  await c.start(task.id);
  assert.equal(task.status, 'ready');
  assert.equal(task.notificationVersion, 'new-turn');
  assert.equal(c.awaitingAcceptance.size, 0);
});
test('buffered deltas preserve whitespace and a missing receipt cannot publish their answer', async (t) => {
  const { q, client, c } = setup(t);
  const task = q.create({ title: 'Current pass', prompt: 'Check the fixture.' });
  q.patch(task.id, { threadId: 'owned-chat', status: 'ready' });
  q.ownedThreads.add('owned-chat');
  client.send = async () => {
    for (const delta of ['Checks ', 'passed.']) client.emit('notification', {
      method: 'item/agentMessage/delta', params: { threadId: 'owned-chat', turnId: 'new-turn', itemId: 'answer', delta },
    });
    return { turnId: 'new-turn' };
  };
  await c.send(task.id, 'Run the current pass');
  assert.equal(task.messages.at(-1).text, 'Checks passed.');
  client.send = async () => {
    client.emit('notification', { method: 'item/completed', params: {
      threadId: 'owned-chat', turnId: 'unconfirmed-turn',
      item: { id: 'unconfirmed-answer', type: 'agentMessage', text: 'Cannot establish receipt ownership.' },
    } });
    return {};
  };
  await assert.rejects(c.send(task.id, 'Try another pass'), (error) => error.code === 'DELIVERY_RECEIPT');
  assert.equal(task.messages.some((m) => m.id === 'unconfirmed-answer'), false);
  assert.equal(c.awaitingAcceptance.size, 0);
});
test('an overflowing acceptance window preserves acceptance and asks for a source check', async (t) => {
  const { q, client, c } = setup(t);
  const task = q.create({ title: 'Current pass', prompt: 'Check the fixture.' });
  q.patch(task.id, { threadId: 'owned-chat', status: 'ready' });
  q.ownedThreads.add('owned-chat');
  client.send = async () => {
    for (let i = 0; i < 201; i++) client.emit('notification', {
      method: 'item/agentMessage/delta', params: { threadId: 'owned-chat', turnId: 'new-turn', itemId: 'answer', delta: 'x' },
    });
    return { turnId: 'new-turn' };
  };
  const receipt = await c.send(task.id, 'Run the current pass');
  assert.equal(receipt.delivery, 'sent');
  assert.equal(task.turnId, 'new-turn');
  assert.equal(task.status, 'blocked');
  assert.match(task.error, /accepted.*Open the source chat/);
  assert.equal(c.awaitingAcceptance.size, 0);
  // A terminal event after restart cannot make incomplete reconstruction ready.
  const reopened = new Queue(q.directory), reopenedClient = new EventEmitter();
  new Controller(reopened, reopenedClient);
  reopenedClient.emit('notification', { method: 'turn/completed', params: {
    threadId: 'owned-chat', turn: { id: 'new-turn', status: 'completed' },
  } });
  assert.equal(reopened.state.tasks[0].status, 'blocked');
  client.send = async () => ({ turnId: 'next-turn' });
  await c.send(task.id, 'Start a later explicit pass');
  assert.equal(task.presentationGapTurnId, '');
  assert.equal(task.status, 'working');
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
