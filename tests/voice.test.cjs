'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { VoiceSession } = require('../src/voice-session.cjs'),
  { VoiceProvider } = require('../src/voice-provider.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-voice-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const actorId = 'human:synthetic',
    human = () => ({
      role: 'human',
      authority: 'accepted_human',
      actorId,
      messageId: crypto.randomUUID(),
    });
  let time = 100000,
    admission = 'allow',
    stops = 0,
    calls = 0;
  const provider = {
    support: () => ({ configured: true, provider: 'openai-realtime', model: 'fixture-model' }),
    connect: async () => {
      calls++;
      return 'v=0\r\nsynthetic answer';
    },
  };
  const options = {
    directory,
    actorId,
    provider,
    now: () => time,
    admission: () => admission,
    stopAudio: () => stops++,
  };
  const ledger = new VoiceSession(options),
    begin = () =>
      ledger.begin(human(), { maxSeconds: 15, billingConfirmed: true, microphoneConfirmed: true });
  return {
    directory,
    options,
    human,
    provider,
    ledger,
    begin,
    get calls() {
      return calls;
    },
    get stops() {
      return stops;
    },
    advance: () => (time += 16000),
    hold: () => (admission = 'wait'),
  };
}
test('microphone and separate billing require this human before any connection', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.ledger.begin(
      { ...f.human(), role: 'model' },
      { maxSeconds: 15, billingConfirmed: true, microphoneConfirmed: true },
    ),
    /human/,
  );
  await assert.rejects(
    f.ledger.begin(f.human(), {
      maxSeconds: 15,
      billingConfirmed: false,
      microphoneConfirmed: true,
    }),
    /consent/,
  );
  assert.equal(f.calls, 0);
  assert.equal(f.ledger.state.sessions.length, 0);
  const info = await f.begin();
  assert.equal(info.recordingStored, false);
  assert.equal(info.costActualUSD, null);
  await f.ledger.connect(info.sessionId, 'v=0\r\nsynthetic offer');
  assert.equal(f.calls, 1);
  assert.equal(f.ledger.inspect().taskDispatch, false);
  assert.equal(f.ledger.inspect().outboundTelephony, false);
});
test('accepted response identities delimit completion, typed steering and unknown cost', async (t) => {
  const f = fixture(t),
    { sessionId: id } = await f.begin();
  await f.ledger.connect(id, 'v=0\r\n');
  assert.throws(
    () =>
      f.ledger.events(id, {
        type: 'response.done',
        response: { id: 'foreign', status: 'completed' },
      }),
    /unaccepted/,
  );
  f.ledger.events(id, { type: 'response.created', response: { id: 'r1' } });
  const sent = f.ledger.steer(f.human(), id, 'Actually, explain that first');
  assert.deepEqual(sent.events.slice(0, 2), [
    { type: 'response.cancel', response_id: 'r1' },
    { type: 'output_audio_buffer.clear' },
  ]);
  assert.equal(sent.taskActionsAuthorized, false);
  f.ledger.events(id, {
    type: 'response.done',
    response: {
      id: 'r1',
      status: 'completed',
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    },
  });
  const e = f.ledger.entry(id);
  assert.equal(e.responses[0].status, 'completed');
  assert.equal(e.usageActual.totalTokens, 11);
  assert.equal(e.costActualUSD, null);
  f.ledger.events(id, { type: 'response.done', response: { id: 'r1', status: 'failed' } });
  assert.equal(f.ledger.entry(id).responses[0].status, 'completed');
  assert.throws(
    () => f.ledger.steer({ ...f.human(), actorId: 'other' }, id, 'send to someone'),
    /human/,
  );
});
test('ending during handshake discards the late answer and duplicate connect cannot bill twice', async (t) => {
  const f = fixture(t);
  let release;
  f.provider.connect = () => new Promise((resolve) => (release = resolve));
  const { sessionId: id } = await f.begin(),
    pending = f.ledger.connect(id, 'v=0\r\n');
  await assert.rejects(f.ledger.connect(id, 'v=0\r\n'), /changed/);
  const ended = f.ledger.end(f.human(), id);
  assert.equal(ended.unrelatedTasksStopped, false);
  assert.equal(ended.remoteTerminationVerified, false);
  release('v=0\r\nlate');
  await assert.rejects(pending, /unconfirmed/);
  assert.equal(f.ledger.entry(id).status, 'ended');
  assert.equal(f.ledger.live, null);
});
test('restart, disconnect, finite duration and stop hold never reconnect', async (t) => {
  const f = fixture(t),
    { sessionId: id } = await f.begin();
  await f.ledger.connect(id, 'v=0\r\n');
  f.ledger.events(id, { type: 'response.created', response: { id: 'active' } });
  const restarted = new VoiceSession(f.options);
  assert.equal(restarted.entry(id).status, 'unconfirmed');
  assert.equal(restarted.entry(id).responses[0].status, 'unconfirmed');
  assert.equal(f.calls, 1);
  assert.equal(restarted.live, null);
  assert.throws(() => f.ledger.mute(f.human(), id, true), /changed/);
  const next = await restarted.begin(f.human(), {
    maxSeconds: 15,
    billingConfirmed: true,
    microphoneConfirmed: true,
  });
  await restarted.connect(next.sessionId, 'v=0\r\n');
  f.hold();
  restarted.expire();
  assert.equal(restarted.entry(next.sessionId).status, 'ended');
  assert.equal(f.stops, 1);
});
test('malformed, future and externally changed journals preserve original bytes', async (t) => {
  const f = fixture(t);
  await f.begin();
  const file = path.join(f.directory, 'voice.json');
  let value = JSON.parse(fs.readFileSync(file));
  value.version = 99;
  fs.writeFileSync(file, JSON.stringify(value));
  const before = fs.readFileSync(file);
  assert.throws(() => new VoiceSession(f.options), /recovery|unsupported/i);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.throws(() => f.ledger.end(f.human(), f.ledger.live.id), /changed/);
  assert.deepEqual(fs.readFileSync(file), before);
});
test('provider transport keeps key server-side, fixes endpoint, bounds timeout and refuses plaintext storage', async (t) => {
  const f = fixture(t),
    secret = 'synthetic-api-key-never-used',
    key = crypto.randomBytes(32),
    iv = crypto.randomBytes(12);
  let request;
  const encrypt = (s) => {
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([c.update(s), c.final(), c.getAuthTag()]);
  };
  const decrypt = (b) => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(b.subarray(-16));
    return Buffer.concat([d.update(b.subarray(0, -16)), d.final()]).toString();
  };
  const provider = new VoiceProvider({
    directory: f.directory,
    actorId: f.options.actorId,
    encrypt,
    decrypt,
    available: () => true,
    fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, text: async () => 'v=0\r\nfixture' };
    },
  });
  assert.equal(provider.support().configured, false);
  provider.configure(secret);
  assert.equal(fs.readFileSync(provider.file).includes(Buffer.from(secret)), false);
  assert.equal(JSON.stringify(provider.support()).includes(secret), false);
  await provider.connect({
    sdp: 'v=0\r\noffer',
    model: 'gpt-realtime-2.1',
    signal: new AbortController().signal,
  });
  assert.equal(request.url, 'https://api.openai.com/v1/realtime/calls');
  assert.equal(request.options.redirect, 'error');
  const session = JSON.parse(request.options.body.get('session'));
  assert.deepEqual(session.tools, []);
  assert.equal(session.audio.input.turn_detection.interrupt_response, true);
  assert.equal(request.options.body.get('sdp'), 'v=0\r\noffer');
  const unavailable = new VoiceProvider({
    directory: f.directory,
    actorId: f.options.actorId,
    available: () => false,
  });
  assert.throws(() => unavailable.configure(secret), /encryption/);
});
