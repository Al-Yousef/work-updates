'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  https = require('node:https');
const { HostPeer, RemotePeer, privateAddress, parseCode } = require('../src/peer.cjs');
test('a closed pairing cannot accept a late initial state', async (t) => {
  const { code } = await setup(t),
    client = new RemotePeer(code);
  let release;
  client.json = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const connecting = client.connect();
  client.close();
  release({ cards: [] });
  await assert.rejects(connecting, /closed/);
  assert.equal(client.connected, false);
});
test('an old stream close cannot mark a replacement generation offline', async (t) => {
  const { code } = await setup(t),
    client = new RemotePeer(code);
  t.after(() => client.close());
  const { EventEmitter } = require('node:events');
  const response = new EventEmitter();
  response.setTimeout = () => {};
  response.destroy = () => {};
  client.request = async () => response;
  client.generation = 1;
  await client.events(1);
  client.generation = 2;
  client.connected = true;
  response.emit('close');
  assert.equal(client.connected, true);
  assert.equal(client.timer, undefined);
});
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-peer-'));
  const calls = [];
  const host = new HostPeer({
    directory: dir,
    encrypt: (v) => Buffer.from(v),
    decrypt: (v) => v.toString(),
    state: () => ({ cards: [], queued: 0 }),
    command: async (method, input) => {
      calls.push({ method, input });
      return { id: 'synthetic-task' };
    },
  });
  t.after(() => {
    host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const code = await host.start('127.0.0.1');
  return { host, code, calls };
}

test('a mutation accepted before the TLS response breaks is never automatically resent', async (t) => {
  const { host, code, calls } = await setup(t),
    peer = new RemotePeer(code);
  t.after(() => peer.close());
  await peer.connect();
  const send = host.json.bind(host);
  host.json = (res, status, value) => {
    if (value?.ok === true) {
      res.destroy();
      return;
    }
    return send(res, status, value);
  };
  await assert.rejects(
    peer.command('create', { title: 'Uncertain sample', prompt: 'Synthetic only.' }),
  );
  assert.equal(calls.length, 1);
  await peer.json('/state');
  assert.equal(calls.length, 1, 'A fresh read does not repeat the accepted POST');
});
test('private pairing streams state and restricts commands', async (t) => {
  const { host, code, calls } = await setup(t);
  const client = new RemotePeer(code);
  t.after(() => client.close());
  await client.connect();
  assert.equal(client.connected, true);
  assert.deepEqual(
    await client.command('create', { title: 'Sample task', prompt: 'Sample prompt' }),
    { id: 'synthetic-task' },
  );
  assert.equal(calls.length, 1);
  await assert.rejects(client.command('shell', {}));
  const update = new Promise((resolve) => client.once('state', resolve));
  host.broadcast({ cards: [{ title: 'Sample task' }], queued: 1 });
  assert.equal((await update).queued, 1);
});
test('certificate mismatch prevents authenticated requests and revoked tokens are denied', async (t) => {
  const { host, code, calls } = await setup(t),
    value = parseCode(code);
  const wrongPin = new RemotePeer(
    'wu1:' + Buffer.from(JSON.stringify({ ...value, pin: '0'.repeat(64) })).toString('base64url'),
  );
  t.after(() => wrongPin.close());
  await assert.rejects(wrongPin.connect(), /certificate/);
  assert.equal(calls.length, 0);
  const wrongToken = new RemotePeer(
    'wu1:' + Buffer.from(JSON.stringify({ ...value, token: '0'.repeat(64) })).toString('base64url'),
  );
  t.after(() => wrongToken.close());
  await assert.rejects(wrongToken.connect(), /revoked/);
  host.revoke();
  assert.equal(host.saved(), null);
});
test('browser origins and missing authentication cannot read private state', async (t) => {
  const { code } = await setup(t),
    p = parseCode(code);
  async function request(headers) {
    return new Promise((resolve, reject) => {
      const req = https.get(
        { host: p.host, port: p.port, path: '/state', rejectUnauthorized: false, headers },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
    });
  }
  assert.equal(await request({}), 401);
  assert.equal(
    await request({ Authorization: 'Bearer ' + p.token, Origin: 'https://example.com' }),
    401,
  );
});
test('pairing rejects public IPs, hostnames, invalid pins and remote bind addresses', async (t) => {
  assert.equal(privateAddress('192.168.1.20'), true);
  assert.equal(privateAddress('100.100.100.100'), true);
  for (const host of ['8.8.8.8', '0.0.0.0', '169.254.1.1', 'localhost', '::1'])
    assert.equal(privateAddress(host), false);
  assert.throws(() => parseCode('anything'));
  const { host } = await setup(t);
  await assert.rejects(host.start('8.8.8.8'));
});
