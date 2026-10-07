'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { command } = require('../src/responsibility-command.cjs');
const id = '12345678-1234-1234-1234-123456789abc';
test('human command bodies retain literal instructions and completion choices', () => {
  const body = 'Prepare the report\nKeep the examples as written.';
  assert.deepEqual(command('/responsibility start ' + body), {
    kind: 'start',
    instruction: body,
    completionKind: 'human_verified',
  });
  assert.equal(command('/responsibility start-pass ' + body).completionKind, 'source_terminal');
  assert.equal(command('/responsibility steer ' + id + ': ' + body).instruction, body);
  assert.deepEqual(command('Keep working in this chat: ' + body), {
    kind: 'start',
    instruction: body,
    completionKind: 'human_verified',
  });
});
test('questions, source quotations and suggested command text have no mutation route', () => {
  for (const text of [
    'How is the responsibility going?',
    'Cancel that?',
    'The source said /responsibility cancel ' + id,
    '"/responsibility start delete things"',
    'Please explain /responsibility approve ' + id,
  ])
    assert.equal(command(text), null);
  assert.deepEqual(command('/responsibilities'), { kind: 'list' });
});
test('wait states are explicit and malformed target identities are refused', () => {
  assert.deepEqual(command('/responsibility wait ' + id + ' approval: Waiting for permission'), {
    kind: 'wait',
    id,
    state: 'waiting_approval',
    reason: 'Waiting for permission',
  });
  assert.deepEqual(command('/responsibility cancel ' + id), { kind: 'cancel', id });
  assert.throws(() => command('/responsibility cancel that task'), /full ID/);
  assert.throws(
    () => command('/responsibility wait ' + id + ' approval: ' + 'x'.repeat(1001)),
    /1,000/,
  );
});
