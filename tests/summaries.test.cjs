'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Queue } = require('../src/queue.cjs');
const { Summaries } = require('../src/summaries.cjs');
const { summaryKey, summaryInput } = require('../src/summary-key.cjs');
const { CodexSummaryProvider } = require('../src/summary-provider.cjs');
function source(id = 'chat') {
  return {
    id,
    title: 'Source chat name',
    taskTitle: 'Original request excerpt',
    body: 'Prepared a fix; needs your review.',
    summary: 'Recorded excerpt',
    turnId: 'turn-1',
    fingerprint: 'fp-1',
    status: 'needs',
    lifecycle: 'completed',
    contextLoaded: true,
    readyForReview: true,
    updatedAt: Date.now() / 1000,
  };
}
function fixture(t, provider) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-summaries-'));
  const queue = new Queue(directory);
  queue.state.settings.aiSummaries = true;
  queue.setFeed({ threads: [source()], monitoredCount: 1 });
  const summaries = new Summaries(queue, { provider });
  t.after(() => {
    summaries.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { queue, summaries, directory };
}
const result = {
  title: 'Review the queue fix',
  summary: 'The fix is prepared and needs your review.',
  model: 'gpt-6-luna',
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
test('cached AI changes presentation while preserving chat, exact source, reviewed state and identity', async (t) => {
  let calls = 0;
  const { queue, summaries, directory } = fixture(t, {
    summarize: async () => {
      calls++;
      return result;
    },
    close() {},
  });
  const original = queue.get('chat');
  queue.action('chat', 'reviewed');
  // A new completed update arrives after the initial baseline.
  summaries.refresh();
  await tick();
  queue.feed.threads[0].fingerprint = 'fp-2';
  summaries.refresh();
  await tick();
  const card = queue.get('chat');
  assert.equal(card.title, result.title);
  assert.equal(card.summary, result.summary);
  assert.equal(card.chatName, original.chatName);
  assert.equal(card.taskKey, original.taskKey);
  assert.equal(card.primarySourceId, 'chat');
  assert.equal(card.status, original.status);
  queue.action('chat', 'reviewed');
  summaries.refresh();
  await tick();
  assert.equal(queue.get('chat').reviewed, true);
  assert.equal(calls, 1);
  summaries.close();
  const reloaded = new Queue(directory);
  reloaded.setFeed(queue.feed);
  const restored = new Summaries(reloaded, {
    provider: {
      summarize: async () => {
        calls++;
        return result;
      },
      close() {},
    },
  });
  restored.refresh();
  await tick();
  assert.equal(calls, 1);
  assert.equal(reloaded.get('chat').title, result.title);
  restored.close();
});
test('a late response never overwrites the next pass and working context never gets an old summary', async (t) => {
  const waiting = [];
  const { queue, summaries } = fixture(t, {
    summarize: () => new Promise((resolve) => waiting.push(resolve)),
    close() {},
  });
  summaries.refresh();
  assert.equal(waiting.length, 1);
  Object.assign(queue.feed.threads[0], {
    fingerprint: 'fp-2',
    turnId: 'turn-2',
    body: 'A newer update.',
  });
  summaries.refresh();
  waiting.shift()(result);
  await tick();
  assert.equal(queue.get('chat').summaryOrigin, 'recorded');
  waiting.shift()({ ...result, title: 'Review the newer change' });
  await tick();
  assert.equal(queue.get('chat').title, 'Review the newer change');
  queue.feed.threads[0].lifecycle = 'working';
  queue.feed.threads[0].readyForReview = false;
  assert.equal(queue.get('chat').summaryOrigin, 'recorded');
});
test('catch-up excludes old catalogue cards; failure remains usable and is not retried on polls', async (t) => {
  let calls = 0;
  const { queue, summaries, directory } = fixture(t, {
    summarize: async () => {
      calls++;
      throw new Error('private prompt text');
    },
    close() {},
  });
  queue.feed.threads = Array.from({ length: 100 }, (_, i) => source('chat-' + i));
  queue.feed.threads.slice(3).forEach((s) => {
    s.updatedAt = 1;
  });
  summaries.refresh();
  await tick();
  summaries.refresh();
  await tick();
  assert.equal(calls, 1);
  assert.equal(summaries.pending.size, 2);
  assert.equal(queue.cards()[0].summaryOrigin, 'recorded');
  const cache = fs.readFileSync(path.join(directory, 'summary-cache.json'), 'utf8');
  assert.ok(!cache.includes('private prompt text'));
  assert.ok(!cache.includes('Prepared a fix'));
  assert.equal(Object.keys(JSON.parse(cache).seen).length, 100);
});
test('hourly budget persists across restart and excludes in-progress or unknown evidence', async (t) => {
  let calls = 0;
  const { queue, summaries } = fixture(t, {
    summarize: async () => {
      calls++;
      return result;
    },
    close() {},
  });
  summaries.cache.attempts = Array(20).fill(Date.now());
  summaries.refresh();
  await tick();
  assert.equal(calls, 0);
  assert.ok(summaries.retry);
  assert.equal(summaryKey({ ...source(), lifecycle: 'working' }), null);
  assert.equal(summaryKey({ ...source(), contextLoaded: false }), null);
  assert.ok(
    summaryInput({ ...source(), body: 'password=secret-value ' + 'a'.repeat(12000) }).update
      .length <= 3000,
  );
  assert.ok(
    !summaryInput({ ...source(), body: 'password=secret-value' }).update.includes('secret-value'),
  );
});
test('opt-out removes AI presentation and closes pending inference', async (t) => {
  let closed = 0;
  const { queue, summaries } = fixture(t, {
    summarize: async () => result,
    close() {
      closed++;
    },
  });
  summaries.refresh();
  await tick();
  assert.equal(queue.get('chat').summaryOrigin, 'ai');
  queue.state.settings.aiSummaries = false;
  summaries.refresh();
  assert.equal(queue.get('chat').summaryOrigin, 'recorded');
  assert.equal(closed, 1);
});
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.closed = false;
  }
  async connect() {}
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'model/list') return { data: [{ model: 'gpt-6-luna' }] };
    if (method === 'config/read') return { config: { mcp_servers: { test: {} }, plugins: {} } };
    if (method === 'thread/start')
      return { thread: { id: 'ephemeral-test', ephemeral: !this.persistent } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        this.emit('notification', {
          method: 'item/completed',
          params: {
            threadId: params.threadId,
            item: { type: 'agentMessage', text: JSON.stringify(result) },
          },
        });
        this.emit('notification', {
          method: 'turn/completed',
          params: { threadId: params.threadId, turn: { status: 'completed' } },
        });
      });
      return { turn: { id: 'synthetic-turn' } };
    }
  }
  close() {
    this.closed = true;
  }
  reject() {}
}
test('provider uses a small model, ephemeral read-only session, tool restrictions and a structured output', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-provider-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const client = new FakeClient();
  const provider = new CodexSummaryProvider({ directory, clientFactory: () => client });
  assert.equal((await provider.summarize(summaryInput(source()))).title, result.title);
  const start = client.calls.find((c) => c.method === 'thread/start').params;
  assert.equal(start.ephemeral, true);
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.config['features.shell_tool'], false);
  assert.equal(start.config['mcp_servers.test.enabled'], false);
  assert.equal(client.calls.find((c) => c.method === 'turn/start').params.effort, 'low');
  assert.equal(client.closed, true);
  assert.ok(!client.calls.some((c) => ['thread/resume', 'thread/name/set'].includes(c.method)));
});
test('provider refuses a persistent thread before starting inference', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-provider-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const client = new FakeClient();
  client.persistent = true;
  const provider = new CodexSummaryProvider({ directory, clientFactory: () => client });
  await assert.rejects(provider.summarize(summaryInput(source())), /NOT_EPHEMERAL/);
  assert.equal(client.closed, true);
  assert.ok(!client.calls.some((c) => c.method === 'turn/start'));
});
test('queued active work survives restart without processing the historical catalogue', async (t) => {
  const provider = { summarize: () => new Promise(() => {}), close() {} };
  const { queue, summaries, directory } = fixture(t, provider);
  queue.feed.threads = Array.from({ length: 50 }, (_, i) => source('chat-' + i));
  queue.feed.threads.slice(3).forEach((s) => {
    s.updatedAt = 1;
  });
  queue.save();
  summaries.refresh();
  summaries.close();
  const reloaded = new Queue(directory);
  reloaded.setFeed(queue.feed);
  let calls = 0;
  const restored = new Summaries(reloaded, {
    provider: {
      summarize: async () => {
        calls++;
        return result;
      },
      close() {},
    },
  });
  restored.refresh();
  await tick();
  await tick();
  assert.equal(calls, 2);
  assert.equal(restored.cache.attempts.length, 3);
  restored.close();
});
test('previously seen active cards catch up in priority order within the persistent hourly cap', async (t) => {
  const called = [];
  const { queue, summaries } = fixture(t, {
    summarize: async (input) => {
      called.push(input.chatName);
      return result;
    },
    close() {},
  });
  queue.feed.threads = Array.from({ length: 45 }, (_, i) => ({
    ...source('active-' + i),
    title: 'Active ' + i,
  }));
  queue.feed.threads[0].status = 'needs';
  queue.feed.threads.slice(1).forEach((s) => {
    s.status = 'ready';
  });
  summaries.cache.seeded = true;
  for (const s of queue.feed.threads) summaries.cache.seen[s.id] = summaryKey(s);
  summaries.refresh();
  await tick();
  assert.equal(called.length, 20);
  assert.equal(called[0], 'Active 0');
  assert.equal(summaries.pending.size, 25);
  assert.equal(queue.aiSummary.eligible, 45);
  assert.equal(queue.aiSummary.summarized, 20);
  assert.ok(queue.aiSummary.resumeAt > Date.now());
  summaries.refresh();
  await tick();
  assert.equal(called.length, 20);
});
test('reviewed, snoozed, done and working cards are skipped; returning to the queue triggers catch-up', async (t) => {
  let calls = 0;
  const { queue, summaries } = fixture(t, {
    summarize: async () => {
      calls++;
      return result;
    },
    close() {},
  });
  queue.feed.threads = ['reviewed', 'snoozed', 'done', 'working'].map((id) => source(id));
  queue.action('reviewed', 'reviewed');
  queue.action('snoozed', 'snooze');
  queue.action('done', 'done');
  queue.feed.threads[3].lifecycle = 'working';
  queue.feed.threads[3].readyForReview = false;
  summaries.refresh();
  await tick();
  assert.equal(calls, 0);
  assert.equal(summaries.pending.size, 0);
  queue.action('reviewed', 'restore');
  summaries.refresh();
  await tick();
  assert.equal(calls, 1);
  assert.equal(queue.get('reviewed').summaryOrigin, 'ai');
});
test('a failed current card retries only on explicit action, retains its budget and then stays cached', async (t) => {
  let calls = 0;
  const { queue, summaries, directory } = fixture(t, {
    summarize: async () => {
      calls++;
      throw new Error('SUMMARY_INVALID');
    },
    close() {},
  });
  summaries.refresh();
  await tick();
  summaries.refresh();
  await tick();
  assert.equal(calls, 1);
  summaries.close();
  const restored = new Summaries(queue, {
    provider: {
      summarize: async () => {
        calls++;
        return result;
      },
      close() {},
    },
  });
  t.after(() => restored.close());
  restored.refresh();
  await tick();
  assert.equal(calls, 1);
  assert.equal(queue.aiSummary.failed, 1);
  assert.equal(restored.retryFailed(), 1);
  await tick();
  assert.equal(calls, 2);
  assert.equal(restored.cache.attempts.length, 2);
  assert.equal(queue.aiSummary.failed, 0);
  assert.equal(restored.retryFailed(), 0);
  restored.refresh();
  await tick();
  assert.equal(calls, 2);
  assert.equal(queue.get('chat').summaryOrigin, 'ai');
});
test('cache write failure never starts inference or breaks the queue', async (t) => {
  let calls = 0;
  const { queue, summaries } = fixture(t, {
    summarize: async () => {
      calls++;
      return result;
    },
    close() {},
  });
  summaries.file = path.join(queue.directory, 'missing-parent', 'summary-cache.json');
  fs.writeFileSync(path.dirname(summaries.file), 'a file blocks the cache directory');
  assert.doesNotThrow(() => summaries.refresh());
  await tick();
  assert.equal(calls, 0);
  assert.equal(queue.get('chat').summaryOrigin, 'recorded');
  assert.ok(queue.aiSummary.message.includes('paused'));
});
test('provider cancels promptly and rejects unexpected tool requests', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-provider-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const client = new FakeClient();
  const original = client.call.bind(client);
  client.call = async (method, params) => (method === 'turn/start' ? {} : original(method, params));
  const provider = new CodexSummaryProvider({ directory, clientFactory: () => client });
  const pending = provider.summarize(summaryInput(source()));
  await tick();
  client.emit('request', { id: 1, method: 'item/commandExecution/requestApproval' });
  await assert.rejects(pending, /TOOL_REQUEST/);
  assert.equal(client.closed, true);
  const next = provider.summarize(summaryInput(source()));
  await tick();
  provider.close();
  await assert.rejects(next, /CANCELLED/);
});
test('invalid output does not stall unrelated queued cards and diagnostics contain only metadata', async (t) => {
  let calls = 0;
  const logs = [];
  const { queue, summaries } = fixture(t, {
    summarize: async () => {
      calls++;
      if (calls === 1) throw new Error('SUMMARY_INVALID');
      return result;
    },
    close() {},
  });
  summaries.options.log = { write: (event, details) => logs.push({ event, ...details }) };
  queue.feed.threads.push({ ...source('other'), status: 'ready' });
  summaries.refresh();
  await tick();
  await tick();
  assert.equal(calls, 2);
  assert.equal(queue.get('chat').summaryOrigin, 'recorded');
  assert.equal(queue.get('other').summaryOrigin, 'ai');
  assert.equal(logs[0].code, 'SUMMARY_INVALID');
  assert.ok(!JSON.stringify(logs).includes(result.summary));
});
