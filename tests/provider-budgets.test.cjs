'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { ResourceBudgets, defaults } = require('../src/resource-budgets.cjs'),
  { VoiceSession } = require('../src/voice-session.cjs'),
  { BrowserSessions } = require('../src/browser-sessions.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-provider-budgets-')),
    actorId = 'human:local';
  let clock = Date.now(),
    calls = 0,
    stops = 0;
  const budgetOptions = {
      directory,
      actorId,
      now: () => clock,
      responsibilities: { entry: (id) => ({ id }) },
    },
    budgets = new ResourceBudgets(budgetOptions);
  t.after(() => {
    budgets.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const human = (text) => ({
    role: 'human',
    authority: 'accepted_human',
    actorId,
    messageId: crypto.randomUUID(),
    text,
  });
  function configure(patch) {
    const config = {
      until: new Date(clock + 3600000).toISOString(),
      limits: { ...defaults, ...patch },
    };
    budgets.configure(human('/budget global: ' + JSON.stringify(config)), 'global', config);
  }
  const provider = {
    support: () => ({ configured: true, provider: 'openai-realtime', model: 'synthetic-voice' }),
    connect: async () => {
      calls++;
      return 'v=0\r\nsynthetic';
    },
  };
  const voiceOptions = {
      directory,
      actorId,
      provider,
      budgets,
      now: () => clock,
      admission: () => 'allow',
      stopAudio: () => stops++,
    },
    voice = new VoiceSession(voiceOptions);
  const begin = (reservation = 100) =>
    voice.begin(human(), {
      maxSeconds: 30,
      microphoneConfirmed: true,
      billingConfirmed: true,
      tokenReservation: reservation,
    });
  function response(id, name, input, output) {
    voice.events(id, { type: 'response.created', response: { id: name } });
    voice.events(id, {
      type: 'response.done',
      response: {
        id: name,
        status: 'completed',
        usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
      },
    });
  }
  return {
    directory,
    actorId,
    human,
    budgets,
    budgetOptions,
    voice,
    voiceOptions,
    provider,
    begin,
    response,
    configure,
    get calls() {
      return calls;
    },
    get stops() {
      return stops;
    },
  };
}
test('voice refuses exhausted tokens, unpriced finite cost and invalid reservations before microphone or provider creation', async (t) => {
  const f = fixture(t);
  f.configure({ tokens: 10 });
  await assert.rejects(f.begin(11), /budget reached/);
  f.configure({ costMicros: 100 });
  await assert.rejects(f.begin(5), /budget reached/);
  f.configure({ costMicros: null });
  await assert.rejects(f.begin(0), /finite voice token reservation/);
  assert.equal(f.calls, 0);
  assert.deepEqual(f.voice.state.sessions, []);
  assert.deepEqual(f.budgets.state.entries, []);
});
test('voice totals accepted response usage without dropping unknown responses, keeps cost unknown and preserves accounting through end and restart', async (t) => {
  const f = fixture(t),
    s = await f.begin();
  await f.voice.connect(s.sessionId, 'v=0\r\nsynthetic offer');
  f.response(s.sessionId, 'first', 10, 5);
  f.response(s.sessionId, 'second', 20, 10);
  f.voice.events(s.sessionId, { type: 'response.created', response: { id: 'missing' } });
  f.voice.events(s.sessionId, {
    type: 'response.done',
    response: { id: 'missing', status: 'completed' },
  });
  f.voice.events(s.sessionId, {
    type: 'response.done',
    response: {
      id: 'first',
      status: 'completed',
      usage: { input_tokens: 999, output_tokens: 1, total_tokens: 1000 },
    },
  });
  assert.deepEqual(f.voice.entry(s.sessionId).usageActual, {
    inputTokens: 30,
    outputTokens: 15,
    totalTokens: 45,
  });
  assert.deepEqual(f.voice.entry(s.sessionId).usageCoverage, {
    reportedResponses: 2,
    missingUsageResponses: 1,
    activeResponses: 0,
  });
  const reservation = f.budgets.state.entries[0];
  assert.equal(reservation.actual.tokens, 45);
  assert.equal(reservation.actual.costMicros, null);
  assert.equal(f.voice.end(f.human(), s.sessionId).remoteTerminationVerified, false);
  const restarted = new ResourceBudgets(f.budgetOptions);
  assert.equal(restarted.state.entries[0].status, 'unknown');
  assert.equal(restarted.state.entries[0].actual.tokens, 45);
  assert.equal(restarted.accounting('global').tokens, 100);
  assert.equal(restarted.accounting('global').concurrency, 1);
  restarted.close();
  assert.equal(f.calls, 1);
  assert.equal(f.voice.entry(s.sessionId).costActualUSD, null);
});
test('reported usage above the voice reservation stops local audio and retains an uncertain provider checkpoint', async (t) => {
  const f = fixture(t),
    s = await f.begin(20);
  await f.voice.connect(s.sessionId, 'v=0\r\nsynthetic');
  f.response(s.sessionId, 'overage', 20, 5);
  assert.equal(f.stops, 1);
  assert.equal(f.voice.live, null);
  assert.equal(f.voice.entry(s.sessionId).reason, 'resource_budget');
  assert.equal(f.budgets.state.entries[0].actual.tokens, 25);
  assert.equal(f.budgets.state.entries[0].status, 'unknown');
  assert.equal(f.calls, 1);
});
test('a never-started call releases only its own slot while an interrupted handshake retains shared concurrency and cannot reconnect', async (t) => {
  const f = fixture(t);
  f.configure({ concurrency: 1 });
  const untouched = await f.begin();
  f.voice.end(f.human(), untouched.sessionId);
  assert.equal(f.budgets.state.entries[0].status, 'not_started');
  assert.equal(f.calls, 0);
  let finish;
  f.provider.connect = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const s = await f.begin(),
    pending = f.voice.connect(s.sessionId, 'v=0\r\nsynthetic');
  await Promise.resolve();
  f.voice.end(f.human(), s.sessionId);
  finish('v=0\r\nlate');
  await assert.rejects(pending, /unconfirmed/);
  assert.equal(f.budgets.state.entries[1].status, 'unknown');
  assert.equal(f.budgets.accounting('global').concurrency, 1);
  const restartedVoice = new VoiceSession(f.voiceOptions);
  await assert.rejects(
    restartedVoice.begin(f.human(), {
      maxSeconds: 30,
      billingConfirmed: true,
      microphoneConfirmed: true,
      tokenReservation: 100,
    }),
    /budget reached/,
  );
});
test('voice refuses aggregate usage overflow without overwriting its previous accepted checkpoint', async (t) => {
  const f = fixture(t);
  delete f.voice.options.budgets;
  const s = await f.begin();
  await f.voice.connect(s.sessionId, 'v=0\r\nsynthetic');
  f.response(s.sessionId, 'large-first', Number.MAX_SAFE_INTEGER - 1, 1);
  f.voice.events(s.sessionId, { type: 'response.created', response: { id: 'large-second' } });
  const bytes = fs.readFileSync(f.voice.file);
  assert.throws(
    () =>
      f.voice.events(s.sessionId, {
        type: 'response.done',
        response: {
          id: 'large-second',
          status: 'completed',
          usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
        },
      }),
    /supported bound/,
  );
  assert.deepEqual(fs.readFileSync(f.voice.file), bytes);
  assert.equal(f.voice.entry(s.sessionId).usageActual.totalTokens, Number.MAX_SAFE_INTEGER);
});
async function browserFixture(t) {
  const f = fixture(t);
  let reads = 0,
    navigations = 0,
    current = 'https://example.test/page';
  const adapter = {
    url: () => current,
    show: () => {},
    hide: () => {},
    stop: async () => true,
    close: () => {},
    read: async () => {
      reads++;
      return 'Synthetic original page';
    },
    navigate: async (url) => {
      navigations++;
      current = url;
    },
  };
  const browser = new BrowserSessions({
    directory: f.directory,
    actorId: f.actorId,
    budgets: f.budgets,
    admission: () => 'allow',
    verifyBinding: async () => {},
    create: async () => adapter,
  });
  const spec = {
    taskId: 'owned-local-task',
    grantId: crypto.randomUUID(),
    url: current,
    origins: ['https://example.test'],
  };
  const s = await browser.open(f.human('/browser open ' + JSON.stringify(spec)), spec);
  await browser.returnControl(f.human('/browser return ' + s.sessionId), s.sessionId);
  return {
    ...f,
    browser,
    adapter,
    lease: browser.lease(s.sessionId),
    get reads() {
      return reads;
    },
    get navigations() {
      return navigations;
    },
  };
}
test('private browser reads and navigation consume shared connector limits before I/O without changing authority', async (t) => {
  const f = await browserFixture(t);
  f.configure({ readsPerHour: 1 });
  const result = await f.browser.read(f.lease);
  assert.equal(result.instructionsAuthorized, false);
  assert.equal(f.reads, 1);
  const e = f.budgets.state.entries[0];
  assert.equal(e.provider, 'private-browser');
  assert.equal(e.taskKey, 'owned-local-task');
  assert.deepEqual(e.actual, { tokens: 0, costMicros: 0 });
  await assert.rejects(f.browser.navigate(f.lease, 'https://example.test/next'), /budget reached/);
  assert.equal(f.navigations, 0);
});
test('failed browser I/O retains its uncertain reservation across restart and prevents further work at shared concurrency', async (t) => {
  const f = await browserFixture(t);
  f.configure({ concurrency: 1 });
  f.adapter.read = async () => {
    throw new Error('Owned browser transport failed');
  };
  await assert.rejects(f.browser.read(f.lease), /transport failed/);
  assert.equal(f.budgets.state.entries[0].status, 'unknown');
  const restarted = new ResourceBudgets(f.budgetOptions);
  assert.equal(restarted.accounting('global').concurrency, 1);
  restarted.close();
  await assert.rejects(f.browser.navigate(f.lease, 'https://example.test/next'), /budget reached/);
  assert.equal(f.navigations, 0);
});
