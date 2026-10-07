'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { Assistant } = require('../src/assistant.cjs'),
  { Responsibilities } = require('../src/responsibilities.cjs'),
  { Queue } = require('../src/queue.cjs'),
  { Messages } = require('../src/messages.cjs'),
  { feed } = require('../src/demo.cjs');
const target = require('../src/responsibility-target.cjs'),
  { outcome } = require('../src/assistant-coordination.cjs'),
  { inspectStores } = require('../src/private-store.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-responsibility-integration-')),
    queue = new Queue(directory);
  queue.setFeed(feed());
  const sends = [],
    questions = [];
  const messages = new Messages(
    queue,
    {
      send: async (id, text, source, key, input) => {
        sends.push({ text, messageId: input.messageId });
        return {
          messageId: input.messageId,
          sourceId: source,
          turnId: 'turn-' + sends.length,
          route: 'fixture',
        };
      },
    },
    { auto: false },
  );
  const snapshot = () => {
    const state = messages.decorate(queue.snapshot());
    state.cards = state.cards.map((c) => ({
      ...c,
      chatName: c.chatName || c.title,
      owner: { id: 'pc', name: 'This PC', kind: 'pc', online: true },
    }));
    return state;
  };
  const dispatch = async (mode, input) => ({
    ...(await (mode === 'cancel'
      ? messages.cancel(input.messageId, input.sourceId)
      : mode === 'queue'
        ? messages.enqueue(input)
        : messages.send(input))),
    ownerId: 'pc',
  });
  const responsibilities = new Responsibilities({
    directory,
    snapshot,
    ...target,
    outcome,
    dispatch,
    cancel: (input) => dispatch('cancel', input),
  });
  const provider = {
    async answer(input) {
      questions.push(input);
      return { answer: 'Read-only status answer.', links: [] };
    },
    close() {},
  };
  const assistant = new Assistant({ directory, snapshot, provider, dispatch, responsibilities }),
    card = snapshot().cards[0],
    source = queue.feed.threads.find((s) => s.id === card.primarySourceId);
  assistant.focus(card);
  const ask = async (text) => {
    const id = crypto.randomUUID();
    assistant.ask({ messageId: id, text });
    await assistant.work;
    return assistant.state.messages.find((m) => m.id === id);
  };
  const observe = () => {
    responsibilities.observe(snapshot());
    assistant.observe(snapshot());
  };
  t.after(() => {
    assistant.close();
    responsibilities.close();
    messages.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('hyphen-responsibility-integration-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    queue,
    messages,
    snapshot,
    responsibilities,
    assistant,
    provider,
    card,
    source,
    sends,
    questions,
    ask,
    observe,
  };
}
test('a current human request persists responsibility and exact child intent before delivery, then waits for outcome review', async (t) => {
  const f = fixture(t),
    body = 'Prepare the synthetic release evidence.';
  const response = await f.ask('Keep working in this chat: ' + body);
  assert.equal(response.status, 'completed');
  assert.equal(f.questions.length, 0);
  const id = response.responsibilityId,
    entry = f.responsibilities.entry(id);
  assert.equal(entry.origin.text, 'Keep working in this chat: ' + body);
  assert.equal(entry.currentStep.text, body);
  assert.equal(entry.currentStep.status, 'queued');
  assert.equal(f.sends.length, 0);
  f.source.lifecycle = 'completed';
  await f.messages.pump();
  f.observe();
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].text, body);
  assert.equal(entry.currentStep.messageId, f.sends[0].messageId);
  f.source.turnId = 'turn-1';
  f.source.turnOutcome = 'completed';
  f.observe();
  assert.equal(f.responsibilities.entry(id).state, 'waiting_user');
  await f.ask('/responsibility verify ' + id);
  assert.equal(f.responsibilities.entry(id).state, 'completed');
  assert.equal(f.sends.length, 1);
});
test('questions use current grounded responsibility state and never cancel or dispatch more work', async (t) => {
  const f = fixture(t),
    response = await f.ask('/responsibility start Prepare the requested synthetic result.'),
    id = response.responsibilityId;
  await f.ask('How is that responsibility going?');
  assert.equal(f.questions.length, 1);
  assert.equal(f.questions[0].responsibilities[0].id, id);
  assert.equal(f.questions[0].responsibilities[0].state, 'waiting_external');
  assert.equal(f.sends.length, 0);
  assert.equal(f.responsibilities.entry(id).currentStep.status, 'queued');
  await f.ask('/responsibility cancel ' + id);
  assert.equal(f.responsibilities.entry(id).state, 'cancelled');
  assert.equal(f.messages.state.entries.filter((e) => e.status === 'queued').length, 0);
  assert.equal(f.messages.state.entries[0].status, 'cancelled');
});
test('source-turn criteria require matching completion; replacement card links keep the original source and owner', async (t) => {
  const f = fixture(t),
    response = await f.ask('/responsibility start-pass Run one source pass.'),
    id = response.responsibilityId;
  f.source.lifecycle = 'completed';
  await f.messages.pump();
  f.observe();
  f.source.turnId = 'old-turn';
  f.source.turnOutcome = 'completed';
  f.observe();
  assert.equal(f.responsibilities.entry(id).state, 'waiting_external');
  f.source.turnId = 'turn-1';
  f.observe();
  assert.equal(f.responsibilities.entry(id).state, 'completed');
  const opened = f.assistant.use({ messageId: response.id, index: 0 });
  assert.equal(opened.sourceId, f.source.id);
  assert.equal(opened.draft, '');
});
test('restart retains queued responsibility and refuses replay; older rollback contracts preserve the new journal', async (t) => {
  const f = fixture(t),
    response = await f.ask('/responsibility start Retain the original requested result.'),
    id = response.responsibilityId;
  f.responsibilities.close();
  const restarted = new Responsibilities({ ...f.responsibilities.options });
  t.after(() => restarted.close());
  assert.equal(await restarted.dispatch(id), false);
  assert.equal(f.sends.length, 0);
  const old = require('../src/update-compatibility.json').stores;
  const unsupported = { ...old };
  delete unsupported['responsibilities.json'];
  const before = fs.readFileSync(restarted.file);
  assert.throws(() => inspectStores(f.directory, unsupported), /incompatible program/);
  assert.deepEqual(fs.readFileSync(restarted.file), before);
});
test('stale source state refuses responsibility admission without a delivery', async (t) => {
  const f = fixture(t);
  const original = f.assistant.options.snapshot;
  f.assistant.options.snapshot = () => ({ ...original(), collectedAt: 1 });
  const stale = await f.ask('/responsibility start One exact human instruction.');
  assert.equal(stale.status, 'failed');
  assert.equal(f.responsibilities.snapshot().length, 0);
  assert.equal(f.sends.length, 0);
});
test('changed execution device and ambiguous source ownership reject ready dispatch without changing its intent', async (t) => {
  const f = fixture(t),
    scope = target.currentScope({ sourceId: f.source.id, ownerId: 'pc' }, f.snapshot()),
    id = f.responsibilities.create(
      { role: 'human', messageId: crypto.randomUUID(), text: 'One source-bound task' },
      scope,
      { kind: 'human_verified', description: 'Review result' },
    ),
    intent = f.responsibilities.entry(id).currentStep.messageId;
  f.source.device = {
    kind: scope.executionDevice.kind === 'mac' ? 'pc' : 'mac',
    label: 'Changed device',
  };
  await assert.rejects(f.responsibilities.dispatch(id), /revision or execution device/);
  assert.equal(f.responsibilities.entry(id).currentStep.messageId, intent);
  assert.equal(f.messages.state.entries.length, 0);
  const state = f.snapshot();
  state.cards.push({ ...state.cards[0], id: 'duplicate-source-card' });
  assert.throws(
    () => target.currentScope({ sourceId: f.source.id, ownerId: 'pc' }, state),
    /unavailable/,
  );
  assert.equal(f.sends.length, 0);
});
test('stored human steering advances once after the earlier source turn, without stopping its active writer', async (t) => {
  const f = fixture(t),
    response = await f.ask('/responsibility start First requested pass.'),
    id = response.responsibilityId;
  f.source.lifecycle = 'completed';
  await f.messages.pump();
  f.observe();
  const first = f.responsibilities.entry(id).currentStep.messageId;
  await f.ask('/responsibility steer ' + id + ': Add the new human-requested part.');
  assert.equal(f.sends.length, 1);
  f.source.turnId = 'turn-1';
  f.source.turnOutcome = 'completed';
  f.observe();
  assert.equal(f.responsibilities.entry(id).currentStep.status, 'ready');
  assert.notEqual(f.responsibilities.entry(id).currentStep.messageId, first);
  await f.responsibilities.pump();
  await f.messages.pump();
  f.observe();
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1].text, 'Add the new human-requested part.');
  await f.responsibilities.pump();
  assert.equal(f.sends.length, 2);
});
