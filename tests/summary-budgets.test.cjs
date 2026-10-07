'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  { EventEmitter } = require('node:events');
const { Queue } = require('../src/queue.cjs'),
  { Summaries } = require('../src/summaries.cjs'),
  { CodexSummaryProvider } = require('../src/summary-provider.cjs'),
  { ResourceBudgets, defaults } = require('../src/resource-budgets.cjs');
const output = {
  title: 'Review the synthetic change',
  summary: 'The prepared change needs review.',
};
const usage = {
  totalTokens: 120,
  inputTokens: 100,
  cachedInputTokens: 20,
  cacheWriteInputTokens: 0,
  outputTokens: 20,
  reasoningOutputTokens: 10,
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, scopes = () => []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-summary-budgets-')),
    queue = new Queue(directory);
  let now = Date.now(),
    admission = 'allow',
    mode = 'complete';
  const clients = [];
  queue.state.settings.aiSummaries = true;
  const source = {
    id: 'synthetic-source',
    title: 'Synthetic source',
    taskTitle: 'Review this prepared output',
    body: 'Prepared; not merged.',
    summary: 'Prepared',
    turnId: 'source-turn',
    fingerprint: 'synthetic-1',
    status: 'needs',
    lifecycle: 'completed',
    contextLoaded: true,
    readyForReview: true,
    updatedAt: now / 1000,
  };
  queue.setFeed({ threads: [source], monitoredCount: 1 });
  const options = {
      directory,
      actorId: 'human:fixture',
      now: () => now,
      scopes,
      responsibilities: { entry: (id) => ({ id }) },
    },
    budgets = new ResourceBudgets(options);
  class Client extends EventEmitter {
    constructor() {
      super();
      this.calls = [];
      this.closed = false;
      clients.push(this);
    }
    async connect() {}
    async call(method, params) {
      this.calls.push({ method, params });
      if (method === 'model/list') return { data: [{ model: 'gpt-6-luna' }] };
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/start') {
        if (mode === 'preheld') admission = 'deny';
        return { thread: { id: 'summary-thread', ephemeral: true } };
      }
      if (method === 'turn/start') {
        queueMicrotask(() => {
          this.emit('notification', {
            method: 'turn/started',
            params: { threadId: 'summary-thread', turn: { id: 'summary-turn' } },
          });
          if (mode !== 'missing') {
            this.emit('notification', {
              method: 'thread/tokenUsage/updated',
              params: {
                threadId: 'foreign-thread',
                turnId: 'summary-turn',
                tokenUsage: { last: { ...usage, totalTokens: 999 } },
              },
            });
            this.emit('notification', {
              method: 'thread/tokenUsage/updated',
              params: {
                threadId: 'summary-thread',
                turnId: 'foreign-turn',
                tokenUsage: { last: { ...usage, totalTokens: 999 } },
              },
            });
            this.emit('notification', {
              method: 'thread/tokenUsage/updated',
              params: {
                threadId: 'summary-thread',
                turnId: 'summary-turn',
                tokenUsage: { last: usage },
              },
            });
          }
          if (mode === 'pending') return;
          this.emit('notification', {
            method: 'item/completed',
            params: {
              threadId: 'summary-thread',
              item: { type: 'agentMessage', text: JSON.stringify(output) },
            },
          });
          this.emit('notification', {
            method: 'turn/completed',
            params: {
              threadId: 'summary-thread',
              turn: {
                id: mode === 'wrong-turn' ? 'foreign-turn' : 'summary-turn',
                status: 'completed',
              },
            },
          });
        });
        return { turn: { id: 'summary-turn' } };
      }
    }
    close() {
      this.closed = true;
    }
    reject() {}
  }
  const summaryOptions = {
    budgets,
    now: () => now,
    admission: () => admission,
    clientFactory: () => new Client(),
  };
  let summaries = new Summaries(queue, summaryOptions);
  t.after(() => {
    summaries.close();
    budgets.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const configure = (scope, patch) => {
    const config = {
      until: new Date(now + 3600000).toISOString(),
      limits: { ...defaults, ...patch },
    };
    budgets.configure(
      {
        role: 'human',
        authority: 'accepted_human',
        actorId: 'human:fixture',
        messageId: crypto.randomUUID(),
        text: '/budget ' + scope + ': ' + JSON.stringify(config),
      },
      scope,
      config,
    );
  };
  return {
    directory,
    queue,
    source,
    budgets,
    options,
    clients,
    summaryOptions,
    configure,
    get summaries() {
      return summaries;
    },
    set mode(v) {
      mode = v;
    },
    set admission(v) {
      admission = v;
    },
    restart() {
      summaries.close();
      summaries = new Summaries(queue, summaryOptions);
    },
    async settle() {
      for (let i = 0; i < 100; i++) {
        await tick();
        if (!summaries.running) return;
      }
      throw new Error('Synthetic summary did not settle');
    },
    advance() {
      now += 3600000;
    },
  };
}
test('default summary-provider wiring refuses shared exhaustion before inference and its saved hold survives polling, new excerpts and restart until explicit retry', async (t) => {
  const f = fixture(t);
  f.configure('global', { runs: 0 });
  f.summaries.refresh();
  await f.settle();
  assert.equal(
    f.clients[0].calls.some((c) => ['thread/start', 'turn/start'].includes(c.method)),
    false,
  );
  assert.equal(f.queue.get(f.source.id).summaryOrigin, 'recorded');
  assert.equal(f.queue.aiSummary.resourceHeld, true);
  assert.equal(f.queue.aiSummary.resumeAt, 0);
  f.source.fingerprint = 'synthetic-2';
  f.summaries.refresh();
  f.restart();
  f.summaries.refresh();
  await f.settle();
  assert.equal(f.clients.length, 1);
  f.configure('global', { runs: 10 });
  f.summaries.refresh();
  await f.settle();
  assert.equal(f.clients.length, 1);
  // Return the held update so the explicit existing retry control reviews that attempt.
  f.source.fingerprint = 'synthetic-1';
  f.summaries.refresh();
  assert.equal(f.summaries.retryFailed(), 1);
  await f.settle();
  assert.equal(f.queue.get(f.source.id).summaryOrigin, 'ai');
  assert.equal(f.budgets.state.entries.length, 1);
  assert.equal(f.budgets.state.entries[0].sourceId, f.source.id);
});
test('source-bound responsibility budgets and unpriced finite cost refuse summary threads while original queue evidence remains usable', async (t) => {
  const scope = crypto.randomUUID(),
    f = fixture(t, (id, input) => (input.sourceId === 'synthetic-source' ? [scope] : []));
  f.configure(scope, { runs: 0 });
  f.summaries.refresh();
  await f.settle();
  assert.equal(
    f.clients[0].calls.some((c) => c.method === 'thread/start'),
    false,
  );
  f.configure(scope, { runs: 10 });
  f.configure('global', { costMicros: 100 });
  f.summaries.retryFailed();
  await f.settle();
  assert.equal(
    f.clients.at(-1).calls.some((c) => c.method === 'thread/start'),
    false,
  );
  assert.deepEqual(f.budgets.state.entries, []);
  assert.equal(f.queue.get(f.source.id).summaryOrigin, 'recorded');
});
test('accepted summary usage ignores foreign identities, preserves estimated versus actual tokens and leaves missing usage and bill unknown', async (t) => {
  const f = fixture(t);
  f.summaries.refresh();
  await f.settle();
  const first = f.budgets.state.entries[0];
  assert.equal(first.provider, 'codex-summary');
  assert.equal(first.status, 'settled');
  assert.equal(first.model, 'gpt-6-luna');
  assert.equal(first.turnId, 'summary-turn');
  assert.equal(first.actual.tokens, 120);
  assert.equal(first.actual.costMicros, null);
  assert.ok(first.estimate.tokens >= 1200);
  assert.equal(first.usage.cachedInputTokens, 20);
  assert.ok(first.durationMs >= 0);
  f.mode = 'missing';
  f.source.fingerprint = 'synthetic-missing';
  f.summaries.refresh();
  await f.settle();
  assert.equal(f.budgets.state.entries[1].actual, null);
  assert.equal(f.queue.get(f.source.id).summaryOrigin, 'ai');
});
test('cancelling a live summary retains reported usage and unresolved shared capacity across restart and never claims provider termination', async (t) => {
  const f = fixture(t);
  f.configure('global', { concurrency: 1 });
  f.mode = 'pending';
  f.summaries.refresh();
  await tick();
  assert.equal(f.summaries.running, true);
  f.admission = 'deny';
  f.summaries.refresh();
  await f.settle();
  assert.equal(f.clients[0].closed, true);
  assert.equal(f.budgets.state.entries[0].status, 'unknown');
  assert.equal(f.budgets.state.entries[0].actual.tokens, 120);
  const fresh = new ResourceBudgets(f.options);
  t.after(() => fresh.close());
  assert.equal(fresh.accounting('global').concurrency, 1);
  const client = new EventEmitter();
  client.connect = async () => {};
  client.call = async (method) =>
    method === 'model/list' ? { data: [{ model: 'gpt-6-luna' }] } : { config: {} };
  client.close = () => {};
  const provider = new CodexSummaryProvider({
    directory: path.join(f.directory, 'other-workspace'),
    budgets: fresh,
    clientFactory: () => client,
  });
  await assert.rejects(provider.summarize({ update: 'Unrelated new synthetic excerpt' }), {
    code: 'RESOURCE_BUDGET',
  });
  assert.equal(fresh.state.entries.length, 1);
});
test('a hold before inference releases only a never-started reservation and a wrong terminal turn cannot settle a summary', async (t) => {
  const f = fixture(t);
  f.mode = 'preheld';
  f.summaries.refresh();
  await f.settle();
  assert.equal(
    f.clients[0].calls.some((c) => c.method === 'turn/start'),
    false,
  );
  assert.equal(f.budgets.state.entries[0].status, 'not_started');
  assert.equal(f.budgets.accounting('global').concurrency, 0);
  f.admission = 'allow';
  f.mode = 'wrong-turn';
  f.advance();
  f.summaries.retryFailed();
  await f.settle();
  assert.equal(f.budgets.state.entries[1].status, 'unknown');
  assert.equal(f.budgets.state.entries[1].actual.tokens, 120);
  assert.equal(f.queue.get(f.source.id).summaryOrigin, 'recorded');
});
test('corrupt, future and independently replaced summary caches preserve original bytes and admit no repeat inference; a lost cache cannot replay a retained budget identity', async (t) => {
  const f = fixture(t);
  f.summaries.refresh();
  await f.settle();
  const file = f.summaries.file;
  for (const bytes of [
    '{broken',
    JSON.stringify({ version: 99, entries: {}, seen: {}, attempts: [] }),
  ]) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => new Summaries(f.queue, f.summaryOptions), /original file is preserved/);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
  const replacement = JSON.stringify({ version: 1, entries: {}, seen: {}, attempts: [] });
  fs.writeFileSync(file, replacement);
  f.source.fingerprint = 'changed-source';
  f.summaries.refresh();
  await f.settle();
  assert.equal(fs.readFileSync(file, 'utf8'), replacement);
  assert.equal(f.clients.length, 1);
  f.source.fingerprint = 'synthetic-1';
  f.restart();
  f.summaries.refresh();
  await f.settle();
  assert.equal(
    f.clients.at(-1).calls.some((c) => c.method === 'thread/start'),
    false,
  );
  assert.equal(f.budgets.state.entries.length, 1);
  assert.equal(f.queue.aiSummary.resourceHeld, true);
  assert.equal(f.summaries.retryFailed(), 1);
  await f.settle();
  assert.equal(f.budgets.state.entries.length, 2);
  assert.notEqual(f.budgets.state.entries[0].id, f.budgets.state.entries[1].id);
});
