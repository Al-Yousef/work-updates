'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { Codex } = require('../src/codex.cjs');
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
