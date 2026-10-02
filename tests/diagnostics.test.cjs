'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiagnosticLog } = require('../src/diagnostics.cjs');
function fixture(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-logs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new DiagnosticLog(directory, options);
}
test('private logs redact common credentials and omit structured request or reply bodies', (t) => {
  const log = fixture(t);
  const token = 'sk-' + 'test_private_token_value';
  log.write('rpc.error', {
    message: 'Bearer private-value password=private-password ' + token,
    params: { input: 'private request' },
    result: { text: 'private result' },
    code: -32600,
  });
  const value = fs.readFileSync(log.file, 'utf8');
  assert.ok(!/private-value|private-password|private request|private result/.test(value));
  assert.ok(!value.includes(token));
  assert.equal(JSON.parse(value).code, -32600);
  assert.ok(value.includes('[redacted]'));
  log.write('stderr', {
    message: JSON.stringify({
      access_token: 'private-json-token',
      password: 'private-json-password',
      authorization: 'Basic private-auth',
    }),
  });
  const jsonText = fs.readFileSync(log.file, 'utf8');
  assert.ok(!/private-json-token|private-json-password|private-auth/.test(jsonText));
});
test('diagnostics rotate with a fixed backup count and retain the newest errors', (t) => {
  const log = fixture(t, { maxBytes: 600, backups: 2 });
  for (let i = 0; i < 40; i++) log.write('test', { id: i, message: 'bounded entry' });
  assert.equal(fs.readdirSync(log.directory).length, 3);
  for (const file of fs.readdirSync(log.directory))
    assert.ok(fs.statSync(path.join(log.directory, file)).size <= 600);
  assert.equal(fs.readFileSync(log.file, 'utf8').trim().split('\n').map(JSON.parse).at(-1).id, 39);
});
test('a denied log destination does not interrupt the application', (t) => {
  const log = fixture(t);
  fs.writeFileSync(log.file, 'file');
  const blocked = new DiagnosticLog(path.join(log.file, 'folder'));
  assert.doesNotThrow(() => blocked.write('test'));
  assert.ok(blocked.error);
});
