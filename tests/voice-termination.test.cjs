'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { VoiceProvider } = require('../src/voice-provider.cjs'),
  { VoiceSession } = require('../src/voice-session.cjs');
function fixture(t, request) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-voice-end-'));
  const actorId = 'human:synthetic',
    secret = 'synthetic-key-not-an-account',
    encryptionKey = crypto.randomBytes(32);
  const calls = [];
  const providerOptions = {
    directory,
    actorId,
    available: () => true,
    encrypt: (text) => {
      const iv = crypto.randomBytes(12),
        c = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
      return Buffer.concat([iv, c.update(text), c.final(), c.getAuthTag()]);
    },
    decrypt: (bytes) => {
      const d = crypto.createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
      d.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([d.update(bytes.subarray(12, -16)), d.final()]).toString();
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return request
        ? request(url, options, calls.length)
        : url.endsWith('/hangup')
          ? { status: 200 }
          : {
              ok: true,
              headers: new Headers({ Location: '/v1/realtime/calls/rtc_exact_owned' }),
              text: async () => 'v=0\r\nsynthetic answer',
            };
    },
  };
  const provider = new VoiceProvider(providerOptions);
  provider.configure(secret);
  let stops = 0,
    now = Date.now();
  const options = {
    directory,
    actorId,
    provider,
    admission: () => 'allow',
    stopAudio: () => stops++,
    now: () => now,
  };
  const ledger = new VoiceSession(options),
    human = () => ({
      actorId,
      role: 'human',
      authority: 'accepted_human',
      messageId: crypto.randomUUID(),
    });
  const begin = () =>
    ledger.begin(human(), { maxSeconds: 15, billingConfirmed: true, microphoneConfirmed: true });
  const start = async () => {
    const { sessionId: id } = await begin();
    await ledger.connect(id, 'v=0\r\nsynthetic offer');
    return id;
  };
  t.after(async () => {
    await ledger.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    provider,
    providerOptions,
    ledger,
    options,
    directory,
    calls,
    human,
    begin,
    start,
    secret,
    get stops() {
      return stops;
    },
    advance: () => (now += 16000),
  };
}
test('End stops local audio immediately and targets one exact provider call; 200 only establishes initiation', async (t) => {
  const f = fixture(t),
    id = await f.start();
  const end = f.ledger.end(f.human(), id);
  assert.equal(f.stops, 1);
  assert.equal(end.unrelatedTasksStopped, false);
  const result = await f.ledger.waitForTermination(id);
  assert.equal(result.state, 'initiated');
  assert.equal(result.remoteTerminationRequested, true);
  assert.equal(result.remoteTerminationVerified, false);
  assert.equal(result.finalUsageVerified, false);
  assert.equal(f.calls[1].url, 'https://api.openai.com/v1/realtime/calls/rtc_exact_owned/hangup');
  assert.equal(f.calls[1].options.redirect, 'error');
  assert.equal(f.calls[1].options.headers.Authorization, 'Bearer ' + f.secret);
  f.ledger.end(f.human(), id);
  await f.ledger.close();
  assert.equal(f.calls.length, 2);
  const journal = fs.readFileSync(f.ledger.file, 'utf8');
  assert.equal(journal.includes('rtc_exact_owned'), false);
  assert.equal(journal.includes(f.secret), false);
});
test('an end during handshake waits for the original Location and uses its original credential after configuration changes', async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const f = fixture(t, async (url) => (url.endsWith('/hangup') ? { status: 200 } : gate));
  const { sessionId: id } = await f.begin(),
    connect = f.ledger.connect(id, 'v=0\r\n');
  const rejected = assert.rejects(connect, /unconfirmed/);
  f.ledger.end(f.human(), id);
  assert.equal(f.stops, 1);
  f.provider.configure('different-synthetic-key-never-used');
  release({
    ok: true,
    headers: new Headers({ Location: 'https://api.openai.com/v1/realtime/calls/rtc_original' }),
    text: async () => 'v=0\r\nlate',
  });
  await rejected;
  await f.ledger.waitForTermination(id);
  assert.equal(f.calls[1].options.headers.Authorization, 'Bearer ' + f.secret);
  assert.equal(f.ledger.entry(id).status, 'ended');
  assert.equal(f.calls.length, 2);
});
test('404 and other denial keep uncertainty; only a new explicit human retry repeats the exact end request', async (t) => {
  let attempts = 0;
  const f = fixture(t, async (url) =>
      url.endsWith('/hangup')
        ? { status: ++attempts === 1 ? 404 : 200 }
        : {
            ok: true,
            headers: new Headers({ Location: '/v1/realtime/calls/rtc_retry' }),
            text: async () => 'v=0\r\n',
          },
    ),
    id = await f.start();
  f.ledger.end(f.human(), id);
  const first = await f.ledger.waitForTermination(id);
  assert.equal(first.state, 'unconfirmed');
  assert.equal(first.retryAvailable, true);
  f.ledger.end(f.human(), id);
  await f.ledger.waitForTermination(id);
  assert.equal(attempts, 1);
  assert.throws(
    () => f.ledger.end({ ...f.human(), actorId: 'other' }, id, 'human_end', true),
    /human/,
  );
  f.ledger.end(f.human(), id, 'human_end', true);
  const second = await f.ledger.waitForTermination(id);
  assert.equal(second.state, 'initiated');
  assert.equal(attempts, 2);
  assert.equal(f.ledger.entry(id).providerTermination.attempts, 2);
});
test('unsafe, redirected, missing and query-bearing Location values never become a server end target', async (t) => {
  for (const location of [
    'https://other.invalid/v1/realtime/calls/rtc_foreign',
    '/v1/realtime/calls/rtc_owned?token=secret',
    '/v1/realtime/calls/../rtc_owned',
    '/v1/realtime/calls/%72tc_owned',
    '',
  ]) {
    await t.test(location || 'missing', async (sub) => {
      const f = fixture(sub, async () => ({
        ok: true,
        headers: new Headers(location ? { Location: location } : {}),
        text: async () => 'v=0\r\n',
      }));
      const { sessionId: id } = await f.begin();
      await assert.rejects(f.ledger.connect(id, 'v=0\r\n'), /unconfirmed/);
      const result = await f.ledger.waitForTermination(id);
      assert.equal(result.state, 'unavailable');
      assert.equal(f.calls.length, 1);
      assert.equal((await f.provider.terminate(crypto.randomUUID())).state, 'unavailable');
      assert.equal(f.calls.length, 1);
    });
  }
});
test('duration, disconnect and close terminate only their owned call, without reconnecting', async (t) => {
  for (const action of ['expire', 'disconnect', 'close'])
    await t.test(action, async (sub) => {
      const f = fixture(sub),
        id = await f.start();
      if (action === 'expire') {
        f.advance();
        f.ledger.expire();
      } else if (action === 'disconnect') f.ledger.disconnect(id);
      else await f.ledger.close();
      await f.ledger.waitForTermination(id);
      assert.equal(f.stops, 1);
      assert.equal(f.calls.length, 2);
      assert.equal(f.ledger.live, null);
    });
});
test('held journal bytes do not stop exact in-memory termination or turn server initiation into saved proof', async (t) => {
  const f = fixture(t),
    id = await f.start();
  fs.writeFileSync(f.ledger.file, '{"version":99,"preserve":"original"}');
  const before = fs.readFileSync(f.ledger.file);
  assert.throws(() => f.ledger.end(f.human(), id), /changed/);
  await f.ledger.close();
  await f.ledger.waitForTermination(id);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(fs.readFileSync(f.ledger.file), before);
  assert.equal(f.ledger.termination(id).remoteTerminationVerified, false);
});
test('restart retains uncertainty and cannot target a foreign call or reconnect using a retained call identifier', async (t) => {
  const f = fixture(t),
    id = await f.start();
  f.ledger.end(f.human(), id);
  await f.ledger.waitForTermination(id);
  const restarted = new VoiceSession({
    ...f.options,
    provider: new VoiceProvider(f.providerOptions),
  });
  const calls = f.calls.length;
  restarted.end(f.human(), id, 'human_end', true);
  await restarted.close();
  assert.equal(f.calls.length, calls);
  assert.equal(restarted.termination(id).state, 'initiated');
  assert.equal(restarted.termination(id).remoteTerminationVerified, false);
});
test('a destroyed audio renderer cannot prevent exact provider termination', async (t) => {
  const f = fixture(t), id = await f.start();
  f.options.stopAudio = () => { throw new Error('Renderer was destroyed'); };
  f.ledger.end(f.human(), id);
  await f.ledger.close();
  assert.equal(f.ledger.live, null);
  assert.equal(f.calls.length, 2);
  assert.equal(f.ledger.termination(id).state, 'initiated');
});
test('application close waits for the exact end request when checkpoint bytes are held', async (t) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async url => url.endsWith('/hangup') ? gate : {
    ok: true, headers: new Headers({ Location: '/v1/realtime/calls/rtc_close_held' }), text: async () => 'v=0\r\n',
  }), id = await f.start();
  fs.writeFileSync(f.ledger.file, '{"version":99,"preserve":"close-original"}');
  const before = fs.readFileSync(f.ledger.file);
  const closing = f.ledger.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.ledger.live, null);
  assert.equal(f.ledger.active, true);
  assert.equal(f.calls.length, 2);
  release({ status: 200 });
  await closing;
  assert.equal(f.ledger.active, false);
  assert.deepEqual(fs.readFileSync(f.ledger.file), before);
  assert.equal(f.ledger.termination(id).remoteTerminationVerified, false);
});
