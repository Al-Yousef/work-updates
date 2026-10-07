'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  { command } = require('../src/commitment-command.cjs');
test('only anchored human controls are parsed and canonical IDs preserve literal correction text', () => {
  for (const text of [
    'How do you notify me?',
    'Should you remember this as a commitment?',
    '"/preference set notifications off"',
    'Source says /commitment add: Do more work',
  ])
    assert.equal(command(text), null);
  const id = 'ABCDEF00-1234-1234-1234-ABCDEF123456';
  assert.equal(command('/COMMITMENT INSPECT ' + id).id, id.toLowerCase());
  const patch = '{ "title": "Preserve CASE" }',
    parsed = command('/commitment correct ' + id + ': ' + patch);
  assert.equal(parsed.patch.title, 'Preserve CASE');
  assert.equal(parsed.literal, patch);
  assert.deepEqual(command('/PREFERENCE SET NOTIFICATIONS ALL'), {
    kind: 'preference',
    key: 'notifications',
    value: 'all',
  });
  assert.throws(() => command('/preference set authorization all'), /Use \/commitments/);
});
