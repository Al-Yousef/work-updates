'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  InboxModel,
  briefing,
  resolveBriefingReference,
} = require('../candidate/dot-inbox/model.js');
const { recoveryRecord } = require('../candidate/dot-inbox/desktop/policy.cjs');
const { startPreview } = require('../candidate/dot-inbox/server.cjs');

async function fixture(t) {
  const preview = await startPreview();
  t.after(() => preview.close());
  preview.choose('active');
  return preview;
}

test('briefing prioritizes actual requests and excludes reviewed, snoozed and done items', async (t) => {
  const f = await fixture(t),
    cards = f.snapshot().cards;
  const answer = briefing(cards, 'What needs me?');
  assert.equal(answer.kind, 'needs');
  assert.match(answer.entries[0].status, /^Urgent/);
  assert.equal(answer.entries.filter((entry) => entry.status.includes('Waiting on you')).length, 3);
  const excluded = cards.map((card, index) => ({
    ...card,
    reviewed: index % 3 === 0,
    snoozed: index % 3 === 1,
    done: index % 3 === 2,
  }));
  assert.deepEqual(briefing(excluded).entries, []);
  assert.match(briefing(excluded).text, /Nothing/);
});

test('waiting owner comes from recorded status, never a chat title', () => {
  const card = {
    owner: { id: 'a', name: 'This PC', online: true },
    id: 'chat',
    taskKey: 'task',
    contextRevision: '1',
    primarySourceId: 'source',
    sources: [{ id: 'source' }],
    provenance: { sender: 'Urgent waiting on you', channel: 'Local Codex', mode: 'read-only' },
    title: 'Urgent waiting on you',
    summary: 'Recorded summary',
    status: 'waiting',
    waitingOn: { kind: 'other', name: 'reviewer' },
    label: 'Waiting on reviewer',
    at: 1,
  };
  assert.equal(briefing([card], 'What is urgent?').entries.length, 0);
  assert.equal(briefing([card], 'What needs me?').entries.length, 0);
  assert.equal(briefing([card], 'What am I waiting on?').entries[0].status, 'Waiting on reviewer');
  assert.equal(
    briefing(
      [
        {
          ...card,
          owner: { ...card.owner, online: false },
          label: 'Waiting · owner unclear',
          waitingOn: { kind: 'unknown' },
        },
      ],
      'Waiting',
    ).entries[0].status,
    'Waiting · owner unclear · context cached',
  );
});

test('duplicate raw source IDs resolve only the exact owner, task and context', async (t) => {
  const f = await fixture(t),
    cards = f.snapshot().cards;
  const entries = briefing(cards, 'all updates').entries;
  for (const entry of entries) {
    const found = resolveBriefingReference(cards, entry.ref);
    assert.ok(found);
    assert.equal(found.owner.id, entry.ref.ownerId);
    for (const key of ['ownerId', 'id', 'taskKey', 'sourceId', 'contextRevision'])
      assert.equal(
        resolveBriefingReference(cards, { ...entry.ref, [key]: 'changed-' + entry.ref[key] }),
        undefined,
      );
  }
  const before = entries.find((entry) => entry.sender === 'Mac companion');
  f.choose('context-changed');
  assert.equal(resolveBriefingReference(f.snapshot().cards, before.ref), undefined);
  assert.ok(
    briefing(f.snapshot().cards, 'all updates').entries.some(
      (entry) => entry.ref.contextRevision !== before.ref.contextRevision,
    ),
  );
});

test('assistant question never sends, reviews, snoozes, calls or creates owner commands', async (t) => {
  const f = await fixture(t),
    model = new InboxModel();
  model.update(f.snapshot());
  const before = f.snapshot().preview.commands.length;
  for (const query of [
    'Send Morgan a reply',
    'Call me now',
    'Snooze all chats',
    'Remind me tomorrow',
    '<script>send()</script>',
    'What needs me?',
    'All updates',
  ]) {
    model.ask(query);
    const result = briefing(model.items(), model.assistant.question);
    if (/^(Send|Call|Snooze|Remind|<)/.test(query)) assert.equal(result.kind, 'unsupported');
  }
  assert.equal(model.intents.size, 0);
  assert.equal(f.snapshot().preview.commands.length, before);
});

test('assistant draft is separate from source drafts and Back/reload restores its question', async (t) => {
  const f = await fixture(t),
    model = new InboxModel();
  model.update(f.snapshot());
  model.ask('What am I waiting on?');
  model.assistantDraft('What is urgent?');
  model.open(model.items()[0]);
  model.draft('Keep this source draft.');
  model.back();
  assert.equal(model.view, 'assistant');
  assert.equal(model.assistantDraft(), 'What is urgent?');
  model.close();
  const recovered = new InboxModel();
  recovered.restore(recoveryRecord(JSON.stringify(model.export())));
  recovered.update(f.snapshot());
  assert.equal(recovered.view, 'assistant');
  assert.equal(recovered.assistant.question, 'What am I waiting on?');
  assert.equal(recovered.assistantDraft(), 'What is urgent?');
  assert.equal(recovered.draft(), 'Keep this source draft.');
  recovered.ask();
  assert.equal(recovered.assistantDraft(), '');
  assert.equal(recovered.draft(), 'Keep this source draft.');
});

test('recovery contains user questions and routing, never generated answers or incoming context', async (t) => {
  const f = await fixture(t),
    model = new InboxModel();
  const snapshot = f.snapshot();
  snapshot.cards[0].summary = 'PRIVATE-INCOMING-SOURCE-CONTENT';
  snapshot.cards[0].sources[0].body = 'PRIVATE-INCOMING-BODY';
  model.update(snapshot);
  model.ask('What needs me?');
  assert.ok(
    briefing(model.items()).entries.some(
      (entry) => entry.summary === 'PRIVATE-INCOMING-SOURCE-CONTENT',
    ),
  );
  model.open(model.items()[0]);
  model.back();
  const raw = JSON.stringify(model.export());
  assert.doesNotMatch(raw, /PRIVATE-INCOMING|entries|summary|sender/);
  const sanitized = recoveryRecord(
    JSON.stringify({ ...model.export(), assistant: { ...model.assistant, incoming: 'discard' } }),
  );
  assert.deepEqual(Object.keys(sanitized.assistant).sort(), ['draft', 'question']);
  assert.throws(
    () =>
      recoveryRecord(JSON.stringify({ ...model.export(), assistant: { question: 'x', draft: 2 } })),
    /assistant/,
  );
  assert.throws(
    () =>
      recoveryRecord(
        JSON.stringify({ ...model.export(), assistant: { question: 'x'.repeat(2001), draft: '' } }),
      ),
    /assistant/,
  );
  const legacy = model.export();
  delete legacy.assistant;
  assert.equal(recoveryRecord(JSON.stringify(legacy)).assistant.question, 'What needs me?');
});

test('queued tasks stay without a conversation destination in assistant results', async (t) => {
  const f = await fixture(t),
    cards = f.snapshot().cards;
  const queued = {
    ...cards[0],
    kind: 'local',
    id: 'queued',
    taskKey: 'queued-task',
    sources: [],
    primarySourceId: undefined,
    status: 'queued',
    waitingOn: { kind: 'unknown' },
    readyForReview: false,
    label: 'Queued',
  };
  const entry = briefing([queued], 'all updates').entries[0];
  assert.equal(entry.hasConversation, false);
  assert.equal(entry.ref.sourceId, 'queue:no-source');
  const model = new InboxModel();
  model.update({ ...f.snapshot(), cards: [queued] });
  model.navigate('assistant');
  model.open(resolveBriefingReference([queued], entry.ref), entry.ref.sourceId);
  assert.equal(model.current().noConversation, true);
  assert.throws(() => model.token(), /current online/);
  model.back();
  assert.equal(model.view, 'assistant');
});

test('loading and unavailable briefings never assert cached items are current', async (t) => {
  const f = await fixture(t),
    cards = f.snapshot().cards;
  assert.deepEqual(briefing(cards, 'What needs me?', { loading: true }).entries, []);
  const unavailable = briefing(cards, 'What needs me?', { error: 'Connection unavailable.' });
  assert.equal(unavailable.unavailable, true);
  assert.deepEqual(unavailable.entries, []);
  assert.match(unavailable.text, /cannot refresh/);
});
