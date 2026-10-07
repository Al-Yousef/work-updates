'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { ResourceBudgets, defaults } = require('../src/resource-budgets.cjs');
const { AssistantProvider } = require('../src/assistant-provider.cjs');
const { Assistant } = require('../src/assistant.cjs');
const { Queue } = require('../src/queue.cjs'),
  { Messages } = require('../src/messages.cjs'),
  { feed } = require('../src/demo.cjs');
const reported = {
  totalTokens: 120,
  inputTokens: 100,
  cachedInputTokens: 20,
  cacheWriteInputTokens: 0,
  outputTokens: 20,
  reasoningOutputTokens: 10,
};
function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-budget-'));
  let clock = Date.now();
  const config = {
    directory,
    actorId: 'synthetic-human',
    now: () => clock,
    responsibilities: { entry: (id) => ({ id }) },
    ...options,
  };
  const b = new ResourceBudgets(config);
  t.after(() => {
    b.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function configure(scope = 'global', overrides = {}) {
    const c = {
      until: new Date(clock + 3600000).toISOString(),
      limits: { ...defaults, ...overrides },
    };
    b.configure(
      {
        role: 'human',
        authority: 'accepted_human',
        actorId: config.actorId,
        messageId: crypto.randomUUID(),
        text: '/budget ' + scope + ': ' + JSON.stringify(c),
      },
      scope,
      c,
    );
  }
  return { directory, b, config, configure, advance: (ms) => (clock += ms) };
}
const request = (overrides = {}) => ({
  id: crypto.randomUUID(),
  kind: 'model',
  provider: 'fixture',
  model: 'synthetic',
  estimate: { tokens: 100, costMicros: null },
  ...overrides,
});
test('global and parent/child budgets reserve atomically before dispatch; estimates and larger actuals remain separate', (t) => {
  const parent = crypto.randomUUID(),
    child = crypto.randomUUID(),
    f = setup(t, { scopes: () => [parent, child] });
  f.configure('global', { tokens: 500 });
  f.configure(parent, { tokens: 150 });
  f.configure(child, { tokens: 150 });
  const id = f.b.reserve(request());
  f.b.started(id, 'turn');
  f.b.finish(id, { reported, turnId: 'turn' });
  assert.equal(f.b.accounting(parent).tokens, 120);
  assert.equal(f.b.state.entries[0].estimate.tokens, 100);
  assert.equal(f.b.state.entries[0].actual.tokens, 120);
  assert.equal(f.b.state.entries[0].actual.costMicros, null);
  assert.throws(() => f.b.reserve(request()), /budget reached/);
  assert.equal(f.b.state.entries.length, 1);
});
test('a finite cost cap refuses unpriced inference and unknown actuals never become zero', (t) => {
  const f = setup(t);
  f.configure('global', { costMicros: 500 });
  assert.equal(f.b.inspect().scopes[0].remaining.costMicros, 500);
  assert.equal(f.b.inspect().scopes[0].newModelCostRequiresPricing, true);
  assert.throws(() => f.b.reserve(request()), /budget reached/);
  const id = f.b.reserve(request({ estimate: { tokens: 100, costMicros: 300 } }));
  f.b.started(id, 't');
  f.b.finish(id, { reported, turnId: 't' });
  assert.equal(f.b.state.entries[0].actual.costMicros, null);
  assert.throws(
    () => f.b.reserve(request({ estimate: { tokens: 100, costMicros: 300 } })),
    /budget reached/,
  );
});
test('concurrent reservations and restarted uncertain calls retain capacity and cannot replay', (t) => {
  const f = setup(t);
  f.configure('global', { concurrency: 1 });
  const input = request();
  f.b.reserve(input);
  f.b.started(input.id, 'exact');
  assert.throws(() => f.b.reserve(request()), /budget reached/);
  f.b.close();
  const fresh = new ResourceBudgets(f.config);
  t.after(() => fresh.close());
  assert.equal(fresh.state.entries[0].status, 'unknown');
  assert.throws(() => fresh.reserve(input), /reconcile/);
  assert.throws(() => fresh.reserve(request()), /budget reached/);
});
test('failed checkpoints and externally altered journals refuse inference admission', (t) => {
  const f = setup(t, {
    write: () => {
      throw new Error('synthetic disk failure');
    },
  });
  assert.throws(() => f.b.reserve(request()), /disk failure/);
  assert.equal(f.b.state.entries.length, 0);
  assert.throws(() => f.b.reserve(request()), /recovery/);
  const clean = setup(t);
  clean.b.reserve(request());
  fs.writeFileSync(clean.b.file, '{}');
  assert.throws(() => clean.b.reserve(request()), /changed outside/);
  assert.equal(fs.readFileSync(clean.b.file, 'utf8'), '{}');
});
test('budget configuration requires the exact current human control and expired limits remain inspectable', (t) => {
  const f = setup(t),
    c = { until: new Date(Date.now() + 3600000).toISOString(), limits: defaults };
  assert.throws(
    () =>
      f.b.configure(
        { role: 'source', authority: 'accepted_human', actorId: 'synthetic-human' },
        'global',
        c,
      ),
    /human control/,
  );
  f.configure();
  f.advance(3600001);
  assert.equal(f.b.inspect().scopes[0].expired, true);
  assert.throws(() => f.b.reserve(request()), /expired/);
});
test('connector throttling and unchanged-result backoff occur before reader invocation', async (t) => {
  const f = setup(t);
  f.configure('global', { readsPerHour: 2 });
  let calls = 0;
  const reader = f.b.reader({
    storeId: () => 's',
    read: async () => {
      calls++;
      return { records: [{ id: 'record', text: 'synthetic' }] };
    },
  });
  const input = { storeId: 's', scope: { sourceId: 'synthetic-source' } };
  await reader.read(input);
  await assert.rejects(reader.read(input), (e) => e.code === 'RESEARCH_RATE_LIMITED');
  assert.equal(calls, 1);
  f.advance(60000);
  await reader.read(input);
  assert.equal(calls, 2);
  f.advance(60000);
  await assert.rejects(reader.read(input), (e) => e.code === 'RESEARCH_RATE_LIMITED');
  f.advance(60000);
  await assert.rejects(reader.read(input), /budget reached/);
  assert.equal(calls, 2);
});
test('provider rate limits retain an explicit connector delay across restart', async (t) => {
  const f = setup(t),
    reader = f.b.reader({
      read: async () => {
        throw Object.assign(new Error('rate limit'), {
          code: 'RESEARCH_RATE_LIMITED',
          retryAfterMs: 90000,
        });
      },
    });
  const input = { storeId: 's', scope: { sourceId: 'synthetic-source' } };
  await assert.rejects(reader.read(input), /rate limit/);
  f.b.close();
  const fresh = new ResourceBudgets(f.config);
  t.after(() => fresh.close());
  await assert.rejects(
    fresh.reader({ read: () => assert.fail('Backoff must precede reads') }).read(input),
    (e) => e.retryAfterMs === 90000,
  );
});
class ProviderFixture extends EventEmitter {
  constructor(mode) {
    super();
    this.mode = mode;
    this.calls = [];
  }
  async connect() {}
  async call(method, input) {
    this.calls.push(method);
    if (method === 'model/list') return { data: [{ model: 'gpt-6-luna' }] };
    if (method === 'config/read') return { config: {} };
    if (method === 'thread/start') return { thread: { id: 'synthetic-thread', ephemeral: true } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        this.emit('notification', {
          method: 'turn/started',
          params: { threadId: input.threadId, turn: { id: 'synthetic-turn' } },
        });
        this.emit('notification', {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: this.mode === 'foreign' ? 'foreign' : input.threadId,
            turnId: 'synthetic-turn',
            tokenUsage: { last: reported, total: reported, modelContextWindow: 100000 },
          },
        });
        this.emit('notification', {
          method: 'item/completed',
          params: {
            threadId: input.threadId,
            item: {
              type: 'agentMessage',
              text: JSON.stringify({ answer: 'Synthetic answer', links: [], action: null }),
            },
          },
        });
        this.emit('notification', {
          method: 'turn/completed',
          params: { threadId: input.threadId, turn: { id: 'synthetic-turn', status: 'completed' } },
        });
      });
      return { turn: { id: 'synthetic-turn' } };
    }
  }
  close() {
    this.closed = true;
  }
  reject() {
    assert.fail('No fixture tool request');
  }
}
test('actual provider wiring records only matching thread/turn usage; model catalog is not entitlement proof', async (t) => {
  const f = setup(t),
    client = new ProviderFixture(),
    provider = new AssistantProvider({
      directory: f.directory,
      budgets: f.b,
      clientFactory: () => client,
    });
  await provider.answer({ question: 'Synthetic question' });
  assert.equal(client.closed, true);
  assert.equal(f.b.state.entries[0].actual.tokens, 120);
  assert.equal(f.b.state.entries[0].status, 'settled');
  assert.equal(f.b.inspect().planEntitlements, 'unknown');
  assert.equal(f.b.inspect().hardExecutionTokenCap, false);
  const foreign = new ProviderFixture('foreign');
  await new AssistantProvider({
    directory: f.directory,
    budgets: f.b,
    clientFactory: () => foreign,
  }).answer({ question: 'Synthetic question' });
  assert.equal(f.b.state.entries[1].actual, null);
});
test('exhausted budgets prevent thread/inference creation rather than failing after the model call', async (t) => {
  const f = setup(t);
  f.configure('global', { runs: 0 });
  const client = new ProviderFixture();
  await assert.rejects(
    new AssistantProvider({
      directory: f.directory,
      budgets: f.b,
      clientFactory: () => client,
    }).answer({ question: 'Synthetic' }),
    /budget reached/,
  );
  assert.ok(!client.calls.includes('thread/start'));
  assert.ok(!client.calls.includes('turn/start'));
  assert.equal(client.closed, true);
});
test('real message dispatch wiring refuses an exhausted budget and retains accepted workers until exact terminal evidence', async (t) => {
  const f = setup(t),
    q = new Queue(f.directory);
  q.setFeed(feed());
  let calls = 0;
  const m = new Messages(
    q,
    {
      send: async () => {
        calls++;
        return { turnId: 'synthetic-worker' };
      },
    },
    { auto: false },
  );
  m.budgets = f.b;
  t.after(() => m.close());
  const snapshot = () => {
    const state = q.snapshot();
    return {
      ...state,
      fresh: true,
      collectedAt: Date.now() / 1000,
      cards: state.cards.map((c) => ({
        ...c,
        owner: { id: 'synthetic-local', local: true, online: true },
      })),
    };
  };
  const c = q.cards()[0],
    input = {
      id: c.id,
      taskKey: c.taskKey,
      sourceId: c.primarySourceId,
      text: 'Synthetic work',
      messageId: crypto.randomUUID(),
    };
  f.configure('global', { runs: 0 });
  await assert.rejects(m.send(input), /budget reached/);
  assert.equal(calls, 0);
  f.configure('global', { concurrency: 1 });
  await m.send({ ...input, messageId: crypto.randomUUID() });
  assert.equal(calls, 1);
  assert.equal(f.b.accounting('global').concurrency, 1);
  const source = q.feed.threads.find((s) => s.id === input.sourceId);
  source.lifecycle = 'completed';
  source.turnOutcome = 'completed';
  source.turnId = 'wrong';
  f.b.reconcile(snapshot());
  assert.equal(f.b.accounting('global').concurrency, 1);
  source.turnId = 'synthetic-worker';
  f.b.reconcile(snapshot());
  assert.equal(f.b.accounting('global').concurrency, 0);
});
test('literal budget controls work through the assistant without inference or access expansion', async (t) => {
  const f = setup(t),
    q = new Queue(f.directory);
  q.setFeed(feed());
  const a = new Assistant({
    directory: f.directory,
    budgets: f.b,
    snapshot: () => q.snapshot(),
    provider: { answer: () => assert.fail('Control must bypass inference'), close() {} },
  });
  t.after(() => a.close());
  const id = crypto.randomUUID();
  a.ask({ messageId: id, text: '/budget inspect' });
  while (a.active) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(a.state.messages.find((m) => m.id === id).status, 'completed');
  assert.match(a.state.messages.find((m) => m.id === id).answer, /hardProviderCostCap/);
});
