'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { Queue } = require('../src/queue.cjs'),
  { Messages } = require('../src/messages.cjs'),
  { Responsibilities } = require('../src/responsibilities.cjs'),
  { Schedules } = require('../src/schedules.cjs'),
  { Assistant } = require('../src/assistant.cjs'),
  { feed } = require('../src/demo.cjs');
const target = require('../src/responsibility-target.cjs'),
  bridge = require('../src/scheduled-responsibility.cjs'),
  { outcome } = require('../src/assistant-coordination.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-schedule-integration-')),
    queue = new Queue(directory);
  queue.setFeed(feed());
  let clock = Date.now(),
    schedules,
    responsibilities;
  const sent = [],
    questions = [];
  const messages = new Messages(
    queue,
    {
      send: async (id, text, source, key, input) => {
        sent.push(input);
        return { messageId: input.messageId, sourceId: source, turnId: 'turn-' + sent.length };
      },
    },
    { auto: false, admission: (message) => bridge.admission(responsibilities, schedules, message) },
  );
  const snapshot = () => {
    const state = messages.decorate(queue.snapshot());
    state.cards = state.cards.map((c) => ({
      ...c,
      chatName: c.chatName || c.title,
      owner: { id: 'pc', name: 'This PC', kind: 'pc', online: true, local: true },
    }));
    return state;
  };
  const dispatch = async (mode, input) => ({
    ...(await (mode === 'cancel'
      ? messages.cancel(input.messageId, input.sourceId)
      : messages.enqueue(input))),
    ownerId: 'pc',
  });
  responsibilities = new Responsibilities({
    directory,
    snapshot,
    ...target,
    outcome,
    dispatch,
    cancel: (input) => dispatch('cancel', input),
  });
  schedules = new Schedules({
    directory,
    now: () => clock,
    probe: (entry) => bridge.probe(responsibilities, entry),
    run: (entry) => bridge.run(responsibilities, entry),
    outcome: (entry, run) => bridge.outcome(responsibilities, entry, run),
  });
  const assistant = new Assistant({
    directory,
    snapshot,
    responsibilities,
    schedules,
    provider: {
      async answer(input) {
        questions.push(input);
        return { answer: 'Read-only schedule status.', links: [] };
      },
      close() {},
    },
  });
  const card = snapshot().cards[0],
    source = queue.feed.threads.find((s) => s.id === card.primarySourceId),
    scope = target.currentScope({ ownerId: 'pc', sourceId: source.id }, snapshot()),
    human = (text) => ({ role: 'human', messageId: crypto.randomUUID(), text });
  const id = responsibilities.create(human('Prepare the requested synthetic result.'), scope, {
    kind: 'human_verified',
    description: 'The requested result is reviewed',
  });
  const ask = async (text) => {
    const messageId = crypto.randomUUID();
    assistant.ask({ messageId, text });
    await assistant.work;
    return assistant.state.messages.find((m) => m.id === messageId);
  };
  t.after(() => {
    assistant.close();
    schedules.close();
    responsibilities.close();
    messages.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('hyphen-schedule-integration-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    queue,
    messages,
    responsibilities,
    schedules,
    assistant,
    source,
    scope,
    id,
    human,
    ask,
    sent,
    questions,
    snapshot,
    advance: (ms) => {
      clock += ms;
    },
    spec: () => ({
      kind: 'interval',
      timeZone: 'America/Toronto',
      intervalMs: 60000,
      anchorAt: clock + 60000,
      endAt: clock + 3600000,
    }),
  };
}
test('literal human scheduling persists timing and grant, questions remain read-only, and cancellation prevents delivery', async (t) => {
  const f = fixture(t),
    end = new Date(Date.now() + 3600000).toISOString(),
    response = await f.ask(
      '/schedule start ' + f.id + ' every 1m zone America/Toronto until ' + end + ' runs 3',
    );
  assert.equal(response.status, 'completed');
  const id = response.scheduleId;
  assert.equal(f.schedules.entry(id).grant.instruction, 'Prepare the requested synthetic result.');
  assert.equal(f.schedules.entry(id).origin.messageId, response.id);
  await f.ask('When is this scheduled work due?');
  assert.equal(f.questions.length, 1);
  assert.equal(f.questions[0].schedules[0].id, id);
  assert.equal(f.sent.length, 0);
  await f.ask('/schedule cancel ' + id);
  f.advance(60000);
  await f.schedules.tick();
  assert.equal(f.messages.state.entries.length, 0);
  assert.equal(f.schedules.entry(id).state, 'cancelled');
});
test('scheduled queue uses the original instruction and preserves exact run identity through restart and matching completion', async (t) => {
  const f = fixture(t),
    id = f.schedules.create(
      f.human('Repeat this exact responsibility at the specified interval'),
      f.responsibilities.entry(f.id),
      f.spec(),
      { maxRuns: 3 },
    );
  f.advance(60000);
  await f.schedules.tick();
  const run = f.schedules.entry(id).runs[0];
  assert.equal(run.status, 'queued');
  const messageId = run.messageId;
  f.schedules.close();
  const restarted = new Schedules({ ...f.schedules.options });
  f.schedules = restarted;
  f.messages.admission = (message) => bridge.admission(f.responsibilities, restarted, message);
  t.after(() => restarted.close());
  await restarted.tick();
  assert.equal(restarted.entry(id).runs.length, 1);
  assert.equal(f.messages.state.entries.length, 1);
  f.source.lifecycle = 'completed';
  await f.messages.pump();
  f.responsibilities.observe(f.snapshot());
  restarted.observe();
  assert.equal(f.sent.length, 1);
  assert.equal(restarted.entry(id).runs[0].messageId, messageId);
  assert.equal(restarted.entry(id).runs[0].status, 'accepted');
  f.source.turnId = 'turn-1';
  f.source.turnOutcome = 'completed';
  f.responsibilities.observe(f.snapshot());
  restarted.observe();
  assert.equal(restarted.entry(id).runs[0].status, 'completed');
  assert.equal(f.responsibilities.entry(f.id).state, 'waiting_user');
});
test('pausing an admitted scheduled message holds its own queued delivery and resuming releases that existing identity', async (t) => {
  const f = fixture(t),
    id = f.schedules.create(
      f.human('Schedule this exact responsibility'),
      f.responsibilities.entry(f.id),
      f.spec(),
      { maxRuns: 3 },
    );
  f.advance(60000);
  await f.schedules.tick();
  const messageId = f.schedules.entry(id).runs[0].messageId;
  f.schedules.control(id, 'pause', f.human('Pause this schedule'));
  f.source.lifecycle = 'completed';
  await f.messages.pump();
  assert.equal(f.sent.length, 0);
  assert.equal(f.messages.state.entries[0].status, 'queued');
  f.schedules.control(id, 'resume', f.human('Resume this schedule'));
  await f.messages.pump();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].messageId, messageId);
});
test('cancelling or expiring a scheduled queue preserves unrelated queued work', async (t) => {
  const f = fixture(t),
    id = f.schedules.create(
      f.human('Schedule this responsibility'),
      f.responsibilities.entry(f.id),
      f.spec(),
      { maxRuns: 3 },
    );
  f.advance(60000);
  await f.schedules.tick();
  const otherId = crypto.randomUUID();
  f.messages.enqueue({
    ...f.scope,
    messageId: otherId,
    text: 'An unrelated current human request',
  });
  f.schedules.control(id, 'cancel', f.human('Cancel this schedule'));
  f.source.lifecycle = 'completed';
  await f.messages.pump();
  assert.equal(f.sent.length, 0);
  assert.equal(f.messages.state.entries[0].status, 'cancelled');
  await f.messages.pump();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].messageId, otherId);
});
test('changed human instruction, unavailable source and unsupported remote owner cannot expand a standing schedule grant', async (t) => {
  const f = fixture(t),
    id = f.schedules.create(
      f.human('Schedule this original responsibility'),
      f.responsibilities.entry(f.id),
      f.spec(),
      { maxRuns: 3 },
    );
  f.responsibilities.steer(f.id, f.human('A different current human instruction'));
  f.advance(60000);
  await f.schedules.tick();
  assert.equal(f.messages.state.entries.length, 0);
  assert.equal(f.sent.length, 0);
  const saved = f.responsibilities.options.snapshot;
  f.responsibilities.options.snapshot = () => {
    const state = saved();
    state.cards = state.cards.map((c) => ({ ...c, owner: { ...c.owner, local: false } }));
    return state;
  };
  assert.throws(
    () =>
      bridge.target(f.responsibilities, {
        responsibilityId: f.id,
        grant: {
          instruction: f.responsibilities.entry(f.id).instruction,
          responsibilityRevision: f.responsibilities.entry(f.id).revision,
          ...f.responsibilities.entry(f.id).scope,
        },
      }),
    /local source owner/,
  );
  assert.equal(f.schedules.entry(id).runs.length, 0);
});
test('new schedule schema prevents incompatible rollback and corrupt bytes are preserved', (t) => {
  const f = fixture(t);
  f.schedules.create(
    f.human('One scheduled responsibility'),
    f.responsibilities.entry(f.id),
    f.spec(),
    { maxRuns: 2 },
  );
  const file = path.join(f.directory, 'schedules.json'),
    before = fs.readFileSync(file),
    contract = { ...require('../src/update-compatibility.json').stores };
  delete contract['schedules.json'];
  assert.throws(
    () => require('../src/private-store.cjs').inspectStores(f.directory, contract),
    /incompatible program/,
  );
  assert.deepEqual(fs.readFileSync(file), before);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => new Schedules(f.schedules.options), /preserved/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('schedule expiry cancels its unsent message before the source becomes idle', async (t) => {
  const f = fixture(t),
    spec = f.spec(),
    id = f.schedules.create(
      f.human('Schedule until this explicit end'),
      f.responsibilities.entry(f.id),
      spec,
      { maxRuns: 3 },
    );
  f.advance(60000);
  await f.schedules.tick();
  t.mock.method(Date, 'now', () => spec.endAt + 1);
  f.queue.feed.collectedAt = Date.now() / 1000;
  f.source.lifecycle = 'completed';
  f.advance(3600000);
  await f.schedules.tick();
  await f.messages.pump();
  assert.equal(f.sent.length, 0);
  assert.equal(f.messages.state.entries[0].status, 'cancelled');
  assert.equal(f.schedules.entry(id).state, 'expired');
});

test('one explicit run now can execute while recurrence stays paused, and rescheduling retains original queued expiry', async (t) => {
  const f = fixture(t),
    spec = f.spec(),
    id = f.schedules.create(
      f.human('Schedule this bounded responsibility'),
      f.responsibilities.entry(f.id),
      spec,
      { maxRuns: 3 },
    );
  f.schedules.control(id, 'pause', f.human('Pause recurrence'));
  f.schedules.control(id, 'now', f.human('Run just once now'));
  await f.schedules.tick();
  assert.equal(f.schedules.entry(id).state, 'paused');
  assert.equal(f.schedules.entry(id).runs[0].trigger, 'user');
  f.source.lifecycle = 'completed';
  await f.messages.pump();
  assert.equal(f.sent.length, 1);
  assert.equal(f.schedules.entry(id).state, 'paused');
  const b = fixture(t),
    old = b.spec(),
    other = b.schedules.create(
      b.human('Schedule another bounded responsibility'),
      b.responsibilities.entry(b.id),
      old,
      { maxRuns: 3 },
    );
  b.advance(60000);
  await b.schedules.tick();
  b.schedules.control(other, 'reschedule', b.human('Extend future timing'), {
    ...old,
    endAt: old.endAt + 3600000,
  });
  b.source.lifecycle = 'completed';
  await b.messages.pump();
  assert.equal(b.sent.length, 1);
  assert.equal(b.messages.state.entries[0].expiresAt, old.endAt);
});

test('new human steering revokes the old queued schedule grant and retains the independent new instruction', async (t) => {
  const f = fixture(t),
    id = f.schedules.create(
      f.human('Schedule this original instruction'),
      f.responsibilities.entry(f.id),
      f.spec(),
      { maxRuns: 3 },
    );
  f.advance(60000);
  await f.schedules.tick();
  f.responsibilities.steer(f.id, f.human('Prepare the new human-requested result instead.'));
  f.source.lifecycle = 'completed';
  await f.messages.pump();
  assert.equal(f.sent.length, 0);
  assert.equal(f.messages.state.entries[0].status, 'cancelled');
  f.responsibilities.observe(f.snapshot());
  f.schedules.observe();
  assert.equal(f.responsibilities.entry(f.id).currentStep.status, 'ready');
  assert.equal(
    f.responsibilities.entry(f.id).instruction,
    'Prepare the new human-requested result instead.',
  );
  await f.responsibilities.pump();
  await f.messages.pump();
  assert.equal(f.sent.length, 1);
  assert.equal(f.schedules.entry(id).state, 'cancelled');
});

test('the production controller admits the scheduled message through app-server ownership preparation exactly once', async (t) => {
  const f = fixture(t),
    client = new (require('node:events').EventEmitter)();
  let calls = 0;
  client.prepare = async () => {};
  client.send = async (thread, text, images, options) => {
    require('../src/dispatch-deadline.cjs').admission(options);
    calls++;
    return { turn: { id: 'controller-turn-' + calls } };
  };
  f.messages.controller = new (require('../src/controller.cjs').Controller)(f.queue, client);
  const id = f.schedules.create(
    f.human('Schedule this original responsibility'),
    f.responsibilities.entry(f.id),
    f.spec(),
    { maxRuns: 2 },
  );
  f.advance(60000);
  await f.schedules.tick();
  f.source.lifecycle = 'completed';
  await f.messages.pump();
  assert.equal(
    calls,
    1,
    JSON.stringify({
      message: f.messages.state.entries[0],
      scope: f.responsibilities.entry(f.id).scope,
      cards: f.snapshot().cards.map((c) => ({
        id: c.id,
        taskKey: c.taskKey,
        sources: c.sources.map((s) => ({ id: s.id, kind: s.kind })),
        owner: c.owner,
      })),
    }),
  );
  assert.equal(f.messages.state.entries[0].status, 'sent');
  f.responsibilities.observe(f.snapshot());
  f.schedules.observe();
  assert.equal(f.schedules.entry(id).runs[0].status, 'accepted');
  client.emit('notification', {
    method: 'turn/completed',
    params: { threadId: f.source.id, turn: { id: 'controller-turn-1', status: 'completed' } },
  });
  f.responsibilities.observe(f.snapshot());
  f.schedules.observe();
  assert.equal(f.schedules.entry(id).runs[0].status, 'completed');
  f.advance(60000);
  await f.schedules.tick();
  await f.messages.pump();
  assert.equal(calls, 1, 'A follow-up waits for matching collected source progress');
  f.source.turnId = 'controller-turn-1';
  await f.messages.pump();
  f.responsibilities.observe(f.snapshot());
  f.schedules.observe();
  assert.equal(calls, 2);
  assert.equal(f.queue.state.tasks.length, 1);
  assert.equal(f.schedules.entry(id).runs[1].status, 'accepted');
  assert.equal(f.responsibilities.entry(f.id).scope.taskKey, f.scope.taskKey);
  assert.deepEqual(f.responsibilities.entry(f.id).scope.executionDevice, f.scope.executionDevice);
});
