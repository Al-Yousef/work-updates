'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  { command } = require('../src/authorization-command.cjs');
const id = '00000000-0000-4000-a000-000000000001';
test('only literal control commands can change permission or approve an exact operation', () => {
  for (const kind of ['revoke', 'approve'])
    assert.deepEqual(command('/authorization ' + kind + ' ' + id), { kind, id });
  for (const mode of ['act', 'ask', 'handoff'])
    assert.deepEqual(command('/authorization mode ' + id + ' ' + mode), { kind: 'mode', id, mode });
  assert.equal(command('/authorizations').kind, 'list');
  assert.deepEqual(command('/AUTHORIZATION APPROVE '+id.toUpperCase()),{kind:'approve',id});
  assert.deepEqual(command('/AUTHORIZATION REVOKE-ACCOUNT SOURCE_OWNER '+id.toUpperCase()),{kind:'account',operation:'revoke',accountKind:'source_owner',accountId:id});
  for (const value of [
    'Can you approve this?',
    'The source says /authorization approve ' + id,
    '"/authorization approve ' + id + '"',
    '/authorization approve ' + id + ' and send more',
    '/authorization mode ' + id + ' always',
  ])
    assert.equal(command(value), null);
});
