'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { Codex } = require('../src/codex.cjs');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
function fixture(options = {}) {
  const processes = [],
    logs = [];
  const client = new Codex({
    log: { write: (event, details) => logs.push({ event, ...details }) },
    spawn: () => {
      const proc = new EventEmitter();
      proc.pid = 100 + processes.length;
      proc.stdin = new PassThrough();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.messages = [];
      proc.kill = () => {
        proc.killed = true;
      };
      proc.respond = (m) => proc.stdout.write(JSON.stringify(m) + '\n');
      proc.stdin.on('data', (data) => {
        const m = JSON.parse(data.toString());
        proc.messages.push(m);
        if (m.method === 'initialize' && !options.noInitialize)
          queueMicrotask(() => proc.respond({ id: m.id, result: {} }));
      });
      processes.push(proc);
      return proc;
    },
    ...options,
  });
  return { client, processes, logs };
}

test('one crashed process rejects pending RPCs once and a late exit cannot disconnect its replacement', async () => {
  const { client, processes, logs } = fixture();
  let failures = 0;
  client.on('disconnected', () => failures++);
  await Promise.all([client.connect(), client.connect()]);
  assert.equal(processes.length, 1);
  const first = processes[0];
  client.loaded.add('owned-thread');
  const pending = client.call('thread/read', { threadId: 'owned-thread' });
  const rejected = assert.rejects(pending, /disconnected/);
  first.emit('error', Object.assign(new Error('Process disappeared'), { code: 'PROCESS_GONE' }));
  await rejected;
  assert.equal(failures, 1);
  assert.equal(client.waiting.size, 0);
  assert.equal(first.killed, true);
  await client.connect();
  client.loaded.add('replacement-thread');
  first.emit('exit', 17, null);
  assert.equal(client.ready, true);
  assert.equal(client.proc, processes[1]);
  assert.ok(client.loaded.has('replacement-thread'));
  assert.equal(failures, 1);
  assert.ok(logs.some((l) => l.event === 'codex.process.exit' && l.exitCode === 17));
  client.close();
});

test('closing intentionally records a shutdown without reporting a disconnected task', async () => {
  const { client, processes, logs } = fixture();
  let failures = 0;
  client.on('disconnected', () => failures++);
  await client.connect();
  client.close();
  processes[0].emit('exit', 0, null);
  assert.equal(failures, 0);
  assert.equal(client.ready, false);
  assert.equal(processes[0].killed, true);
  assert.ok(logs.some((l) => l.reason === 'app shutdown' && l.intentional));
});

test('broken stdin rejects outstanding work and records the pipe error without an uncaught stream error', async () => {
  const { client, processes, logs } = fixture();
  await client.connect();
  const pending = client.call('turn/start', { threadId: 'owned-thread', input: [] });
  const rejected = assert.rejects(pending, /disconnected/);
  processes[0].stdin.destroy(Object.assign(new Error('Broken pipe'), { code: 'EPIPE' }));
  await rejected;
  assert.equal(client.ready, false);
  assert.ok(logs.some((l) => l.code === 'EPIPE'));
});

test('writer-lock errors keep their RPC method and code and never begin a turn or disconnect other work', async () => {
  const { client, processes, logs } = fixture();
  await client.connect();
  const send = client.send('external-thread', 'Private message body');
  await new Promise((r) => setImmediate(r));
  const request = processes[0].messages.at(-1);
  assert.equal(request.method, 'thread/resume');
  const rejected = assert.rejects(send, (e) => e.code === -32600 && e.method === 'thread/resume');
  processes[0].respond({
    id: request.id,
    error: { code: -32600, message: 'thread already has an active writer' },
  });
  await rejected;
  assert.equal(client.ready, true);
  assert.equal(client.loaded.has('external-thread'), false);
  assert.equal(
    processes[0].messages.some((m) => m.method === 'turn/start'),
    false,
  );
  assert.ok(logs.some((l) => l.event === 'codex.rpc.error' && l.threadId === 'external-thread'));
  assert.ok(!JSON.stringify(logs).includes('Private message body'));
  client.close();
});

test('an unconfirmed turn times out without retrying it and diagnostics omit input and result bodies', async () => {
  const { client, processes, logs } = fixture({ requestTimeoutMs: 20 });
  await client.connect();
  await assert.rejects(
    client.call('turn/start', {
      threadId: 'owned-thread',
      input: [{ text: 'Private input body' }],
    }),
    /check before retrying/,
  );
  assert.equal(processes[0].messages.filter((m) => m.method === 'turn/start').length, 1);
  assert.equal(client.waiting.size, 0);
  assert.ok(logs.some((l) => l.event === 'codex.rpc.timeout' && l.method === 'turn/start'));
  const read = client.call('thread/read', { threadId: 'owned-thread' });
  processes[0].respond({
    id: processes[0].messages.at(-1).id,
    result: { body: 'Private result body' },
  });
  await read;
  assert.ok(!JSON.stringify(logs).includes('Private input body'));
  assert.ok(!JSON.stringify(logs).includes('Private result body'));
  client.close();
});

test('failed initialization kills its child and a later connection initializes independently', async () => {
  const { client, processes } = fixture({ noInitialize: true });
  const connected = client.connect();
  const request = processes[0].messages[0];
  const rejected = assert.rejects(connected, /Initialization refused/);
  processes[0].respond({ id: request.id, error: { code: -1, message: 'Initialization refused' } });
  await rejected;
  assert.equal(processes[0].killed, true);
  assert.equal(client.proc, null);
  const retry = client.connect();
  processes[1].respond({ id: processes[1].messages[0].id, result: {} });
  await retry;
  assert.equal(client.ready, true);
  client.close();
});

test('stderr and malformed protocol lines are bounded and stdout EOF is an actionable disconnect', async () => {
  const { client, processes, logs } = fixture();
  await client.connect();
  processes[0].stderr.write('A useful server error\n');
  processes[0].stderr.write('x'.repeat(20000) + '\n');
  processes[0].stdout.write('invalid private protocol text\n');
  assert.ok(
    logs.some((l) => l.event === 'codex.stderr' && l.message.includes('useful server error')),
  );
  assert.ok(
    logs.some((l) => l.event === 'codex.stderr' && l.truncated && l.message.length === 8192),
  );
  assert.ok(!JSON.stringify(logs).includes('invalid private protocol text'));
  const disconnected = new Promise((r) => client.once('disconnected', r));
  processes[0].stdout.end();
  await disconnected;
  assert.equal(client.ready, false);
});
test('turn lifecycle is logged without recording streamed conversation text', async () => {
  const { client, processes, logs } = fixture();
  await client.connect();
  processes[0].respond({
    method: 'turn/started',
    params: { threadId: 'owned-thread', turn: { id: 'turn', status: 'inProgress' } },
  });
  processes[0].respond({
    method: 'item/agentMessage/delta',
    params: { threadId: 'owned-thread', itemId: 'message', delta: 'Private streamed text' },
  });
  processes[0].respond({
    method: 'turn/completed',
    params: { threadId: 'owned-thread', turn: { id: 'turn', status: 'completed' } },
  });
  assert.ok(logs.some((l) => l.event === 'codex.turn.started' && l.turnId === 'turn'));
  assert.ok(logs.some((l) => l.event === 'codex.turn.completed' && l.status === 'completed'));
  assert.ok(!JSON.stringify(logs).includes('Private streamed text'));
  client.close();
});
test('resuming an unexpected thread never sends to it', async () => {
  const client = new Codex();
  client.connect = async () => {};
  const calls = [];
  client.call = async (method, params) => {
    calls.push({ method, params });
    return { thread: { id: 'other-thread' } };
  };
  await assert.rejects(client.send('selected-thread', 'A test message'), /unexpected chat/);
  assert.deepEqual(
    calls.map((c) => c.method),
    ['thread/resume'],
  );
});
test('a reply resumes and sends to the same selected thread id', async () => {
  const client = new Codex();
  client.connect = async () => {};
  const calls = [];
  client.call = async (method, params) => {
    calls.push({ method, params });
    return { thread: { id: params.threadId }, turn: { id: 'turn' } };
  };
  await client.send('selected-thread', 'A test message');
  assert.deepEqual(
    calls.map((c) => c.params.threadId),
    ['selected-thread', 'selected-thread'],
  );
});
