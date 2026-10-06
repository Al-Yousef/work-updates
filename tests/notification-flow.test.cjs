'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { NotificationFlow, quiet } = require('../src/notification-flow.cjs');
const { StatePublisher } = require('../src/state-order.cjs');
const sender = { channel: 'synthetic', senderId: 'demo-owner' };
const policy = {
  coalesceMs: 1000,
  maxSnoozeReminders: 1,
  quietHours: null,
  calls: {
    enabled: true,
    urgency: 'manual',
    unansweredMs: 10000,
    minIntervalMs: 1000,
    maxPerTask: 1,
    maxPer24Hours: 2,
  },
};
function card(extra = {}) {
  return {
    id: 'card-a',
    taskKey: 'task-a',
    primarySourceId: 'chat-a',
    chatName: 'Sample chat',
    title: 'Sample current task',
    summary: 'A decision is needed.',
    status: 'needs',
    waitingOn: { kind: 'you', name: '' },
    priority: 'urgent',
    fingerprint: 'v1',
    sources: [{ id: 'chat-a', title: 'Sample chat' }],
    owner: { id: 'computer-a', name: 'Sample PC', kind: 'pc', online: true },
    ...extra,
  };
}
function fixture(options = {}) {
  let time = Date.parse('2026-10-02T16:00:00Z'),
    sequence = 0;
  const commands = [],
    saved = [],
    publisher = new StatePublisher({ clock: () => time });
  const flow = new NotificationFlow({
    policy,
    trustedSender: sender,
    clock: () => time,
    id: () => 'delivery-' + ++sequence,
    checkpoint: (s) => saved.push(s),
    command: async (method, input) => {
      commands.push({ method, input });
      return {};
    },
    ...options,
  });
  function snapshot(cards = [card()], approvals = []) {
    return publisher.stamp({
      cards,
      done: [],
      approvals,
      devices: [...new Map(cards.map((c) => [c.owner.id, c.owner])).values()],
    });
  }
  const feed = (cards, approvals) => {
    const s = snapshot(cards, approvals);
    flow.observe(s);
    return s;
  };
  const notify = () => {
    const item = flow.tick().find((i) => i.kind === 'message');
    assert.ok(item);
    flow.beginDelivery(item.id);
    flow.settleDelivery(item.id, { state: 'accepted', providerId: 'synthetic-receipt' });
    return item;
  };
  const incoming = (item, extra = {}) => ({
    ...sender,
    eventId: 'reply-1',
    notificationId: item.id,
    action: 'reply',
    text: 'Synthetic reply',
    ...extra,
  });
  return {
    flow,
    commands,
    saved,
    publisher,
    snapshot,
    feed,
    notify,
    incoming,
    advance: (ms) => {
      time += ms;
    },
    setTime: (value) => {
      time = Date.parse(value);
    },
  };
}
test('duplicate, delayed and reconnected snapshots do not repeat a known notification', () => {
  const f = fixture(),
    old = f.feed(),
    item = f.notify();
  assert.equal(f.flow.observe(old), false);
  f.feed();
  f.advance(2000);
  assert.equal(f.flow.tick().filter((i) => i.kind === 'message').length, 0);
  f.feed([card({ fingerprint: 'v2', summary: 'The next decision is ready.' })]);
  assert.equal(f.flow.observe(old), false);
  const next = f.notify();
  assert.notEqual(next.id, item.id);
  const restarted = new StatePublisher();
  f.flow.establish(
    restarted.stamp({
      ...f.snapshot([card({ fingerprint: 'v2', summary: 'The next decision is ready.' })]),
    }),
  );
  assert.equal(f.flow.tick().filter((i) => i.kind === 'message').length, 0);
});
test('working deltas stay silent and routine finished updates coalesce to their latest revision', () => {
  const f = fixture();
  f.feed([card({ status: 'working', waitingOn: { kind: 'unknown' }, readyForReview: false })]);
  assert.equal(f.flow.tick().length, 0);
  const routine = (id, extra = {}) =>
    card({
      id,
      taskKey: id,
      status: 'ready',
      waitingOn: { kind: 'unknown' },
      priority: 'normal',
      readyForReview: true,
      ...extra,
    });
  f.feed([routine('one'), routine('two')]);
  f.advance(500);
  f.feed([routine('one', { fingerprint: 'v2', summary: 'Latest result.' }), routine('two')]);
  assert.equal(f.flow.tick().length, 0);
  f.advance(1000);
  const items = f.flow.tick();
  assert.equal(items.length, 1);
  assert.equal(items[0].refs.length, 2);
  assert.match(items[0].text, /Latest result/);
  f.advance(5000);
  assert.equal(f.flow.tick().length, 1);
});
test('reviewing, snoozing, completing and going offline cancel a queued escalation', () => {
  for (const change of [
    { reviewed: true },
    { snoozed: true, snoozedUntil: Date.parse('2026-10-02T17:00:00Z') / 1000 },
    { done: true, status: 'done' },
    { status: 'working', waitingOn: { kind: 'unknown' } },
    { owner: { id: 'computer-a', name: 'Sample PC', kind: 'pc', online: false } },
  ]) {
    const f = fixture();
    f.feed();
    f.notify();
    f.advance(10000);
    const call = f.flow.tick().find((i) => i.kind === 'call');
    assert.ok(call);
    f.feed([card(change)]);
    assert.equal(f.flow.outbox.get(call.id).state, 'cancelled');
    assert.throws(() => f.flow.beginDelivery(call.id), /no longer available/);
  }
});
test('a later revision invalidates an old reply and restarts the unanswered clock after its own message', async () => {
  const f = fixture();
  f.feed();
  const original = f.notify();
  f.advance(9000);
  f.feed([card({ fingerprint: 'v2', summary: 'A different decision is needed.' })]);
  await assert.rejects(f.flow.receive(f.incoming(original)), /changed/);
  f.advance(1000);
  assert.equal(f.flow.tick().filter((i) => i.kind === 'call').length, 0);
  f.notify();
  f.advance(10000);
  assert.ok(f.flow.tick().some((i) => i.kind === 'call'));
  assert.equal(f.commands.length, 0);
});
test('ordinary blocked tasks and inferred urgency never call under the manual-urgency choice', () => {
  for (const change of [
    { status: 'blocked', waitingOn: { kind: 'unknown' } },
    { status: 'waiting', waitingOn: { kind: 'other', name: 'Reviewer' } },
    { priority: 'auto', urgent: true },
  ]) {
    const f = fixture();
    f.feed([card(change)]);
    f.advance(1000);
    f.notify();
    f.advance(20000);
    assert.equal(f.flow.tick().filter((i) => i.kind === 'call').length, 0);
  }
});
test('quiet hours use the selected timezone, hold messages when selected, and expire at the boundary', () => {
  const q = { start: '22:00', end: '08:00', timeZone: 'America/Toronto', appliesTo: 'all' };
  const f = fixture({ policy: { ...policy, quietHours: q } });
  f.setTime('2026-10-03T03:00:00Z');
  f.feed();
  assert.equal(f.flow.tick().length, 0);
  f.setTime('2026-10-03T12:00:00Z');
  const message = f.notify();
  f.advance(10000);
  const call = f.flow.tick().find((i) => i.kind === 'call');
  assert.ok(call);
  f.setTime('2026-10-04T03:00:00Z');
  assert.throws(() => f.flow.beginDelivery(call.id), /quiet hours/);
  assert.ok(message);
  assert.equal(quiet(Date.parse('2026-11-01T06:30:00Z'), q), true);
  assert.equal(quiet(Date.parse('2026-11-01T13:00:00Z'), q), false);
});
test('call limits reserve at dispatch, count uncertain attempts, and survive restart', () => {
  const f = fixture();
  f.feed();
  f.notify();
  f.advance(10000);
  const call = f.flow.tick().find((i) => i.kind === 'call');
  f.flow.beginDelivery(call.id);
  f.flow.settleDelivery(call.id, { state: 'uncertain' });
  f.advance(10000);
  assert.equal(f.flow.tick().filter((i) => i.kind === 'call').length, 0);
  const g = fixture({ restored: f.flow.export() });
  g.feed();
  g.advance(50000);
  assert.equal(g.flow.tick().filter((i) => i.kind === 'call').length, 0);
  assert.throws(() => g.flow.beginDelivery(call.id), /no longer available/);
});
test('strict global call limits and spacing also apply to already queued calls', () => {
  const f = fixture({ policy: { ...policy, calls: { ...policy.calls, maxPer24Hours: 1 } } });
  f.feed([
    card(),
    card({ id: 'b', taskKey: 'b', primarySourceId: 'chat-b', sources: [{ id: 'chat-b' }] }),
  ]);
  for (const item of f.flow.tick()) {
    f.flow.beginDelivery(item.id);
    f.flow.settleDelivery(item.id, { state: 'accepted' });
  }
  f.advance(10000);
  const calls = f.flow.tick().filter((i) => i.kind === 'call');
  assert.equal(calls.length, 2);
  f.flow.beginDelivery(calls[0].id);
  assert.throws(() => f.flow.beginDelivery(calls[1].id), /no longer available/);
  f.feed([
    card(),
    card({ id: 'b', taskKey: 'b', primarySourceId: 'chat-b', sources: [{ id: 'chat-b' }] }),
  ]);
  assert.equal(f.flow.outbox.get(calls[0].id).invalidated, false);
});
test('uncertain outbound messages and interrupted dispatches are never automatically resent', () => {
  const f = fixture();
  f.feed();
  const item = f.flow.tick()[0];
  f.flow.beginDelivery(item.id);
  const g = fixture({ restored: f.flow.export() });
  g.feed();
  assert.equal(g.flow.outbox.get(item.id).state, 'uncertain');
  g.advance(90000);
  assert.equal(g.flow.tick().length, 0);
  const h = fixture();
  h.feed();
  const sent = h.flow.tick()[0];
  h.flow.beginDelivery(sent.id);
  h.flow.settleDelivery(sent.id, { state: 'uncertain' });
  h.feed();
  h.advance(90000);
  assert.equal(h.flow.tick().length, 0);
});
test('two computers with identical raw task and chat IDs receive separate bound actions', async () => {
  const f = fixture();
  const second = card({
    owner: { id: 'computer-b', name: 'Sample Mac', kind: 'mac', online: true },
  });
  f.feed([card(), second]);
  const messages = f.flow.tick();
  assert.equal(messages.length, 2);
  for (const item of messages) {
    f.flow.beginDelivery(item.id);
    f.flow.settleDelivery(item.id, { state: 'accepted' });
    const result = await f.flow.receive(f.incoming(item, { eventId: item.id, action: 'reviewed' }));
    assert.equal(result.codexAccepted, true);
  }
  assert.deepEqual(
    f.commands.map((c) => c.input.ownerId),
    ['computer-a', 'computer-b'],
  );
});
test('forget and re-pair reject a stale reply even when the same raw IDs return', async () => {
  const f = fixture();
  f.feed();
  const item = f.notify();
  f.feed([]);
  f.feed([card({ owner: { id: 'new-pair', name: 'Sample PC', kind: 'pc', online: true } })]);
  await assert.rejects(f.flow.receive(f.incoming(item)), /changed|unavailable/);
  assert.equal(f.commands.length, 0);
});
test('removing then restoring unchanged context does not duplicate an already known message', () => {
  const f = fixture();
  f.feed();
  f.notify();
  f.feed([]);
  f.feed();
  assert.equal(f.flow.tick().filter((i) => i.kind === 'message').length, 0);
});
test('an unknown sender, ambiguous digest task, or mismatched computer cannot dispatch an action', async () => {
  const f = fixture();
  f.feed();
  const item = f.notify();
  await assert.rejects(f.flow.receive(f.incoming(item, { senderId: 'someone-else' })), /sender/);
  await assert.rejects(
    f.flow.receive(f.incoming(item, { ownerId: 'computer-b' })),
    /different computer/,
  );
  const routine = (id) =>
    card({
      id,
      taskKey: id,
      status: 'ready',
      waitingOn: { kind: 'unknown' },
      readyForReview: true,
    });
  f.feed([routine('one'), routine('two')]);
  f.advance(1000);
  const digest = f.notify();
  await assert.rejects(f.flow.receive(f.incoming(digest)), /exact task/);
  assert.equal(f.commands.length, 0);
});
test('provider acceptance and delivery receipts are separate from accepting a reply into Codex', async () => {
  const f = fixture();
  f.feed();
  const item = f.notify();
  assert.equal(f.commands.length, 0);
  assert.equal(f.flow.inbox.size, 0);
  f.flow.receipt(item.id, { state: 'delivered' });
  assert.equal(f.commands.length, 0);
  const result = await f.flow.receive(f.incoming(item));
  assert.equal(result.codexAccepted, true);
  assert.equal(f.commands.length, 1);
  const repeat = await f.flow.receive(f.incoming(item));
  assert.deepEqual(repeat, result);
  assert.equal(f.commands.length, 1);
});
test('a confirmed failed transport receipt cancels a pending call without resending the message', () => {
  const f = fixture();
  f.feed();
  const item = f.notify();
  f.advance(10000);
  const call = f.flow.tick().find((i) => i.kind === 'call');
  f.flow.receipt(item.id, { state: 'failed' });
  assert.equal(f.flow.outbox.get(call.id).state, 'cancelled');
  assert.equal(f.flow.tick().length, 0);
});
test('the unanswered timer starts at transport acceptance, not before a slow dispatch returns', () => {
  const f = fixture();
  f.feed();
  const item = f.flow.tick()[0];
  f.flow.beginDelivery(item.id);
  f.advance(20000);
  assert.equal(f.flow.tick().filter((i) => i.kind === 'call').length, 0);
  f.flow.settleDelivery(item.id, { state: 'accepted' });
  assert.equal(f.flow.tick().filter((i) => i.kind === 'call').length, 0);
  f.advance(9999);
  assert.equal(f.flow.tick().filter((i) => i.kind === 'call').length, 0);
  f.advance(1);
  assert.equal(f.flow.tick().filter((i) => i.kind === 'call').length, 1);
});
test('a plain yes never becomes approval and only exact current question identities can be answered', async () => {
  const f = fixture();
  f.feed(
    [card()],
    [
      {
        id: 'question-1',
        taskId: 'card-a',
        kind: 'question',
        questions: [{ id: 'choice-1', question: 'Which synthetic option?' }],
      },
    ],
  );
  const item = f.notify();
  await assert.rejects(f.flow.receive(f.incoming(item, { text: 'yes' })), /exact identity/);
  await assert.rejects(
    f.flow.receive(
      f.incoming(item, {
        action: 'answer',
        requestId: 'another-request',
        answers: { 'choice-1': 'A' },
      }),
    ),
    /exact current/,
  );
  await assert.rejects(
    f.flow.receive(
      f.incoming(item, {
        action: 'answer',
        requestId: 'question-1',
        answers: { 'wrong-choice': 'A' },
      }),
    ),
    /exact current/,
  );
  const result = await f.flow.receive(
    f.incoming(item, { action: 'answer', requestId: 'question-1', answers: { 'choice-1': 'A' } }),
  );
  assert.equal(result.codexAccepted, true);
  assert.deepEqual(f.commands[0], {
    method: 'respond',
    input: { ownerId: 'computer-a', id: 'question-1', answers: { 'choice-1': 'A' } },
  });
  const g = fixture();
  g.feed([card()], [{ id: 'permission-1', taskId: 'card-a', kind: 'permissions', questions: [] }]);
  const permission = g.notify();
  await assert.rejects(
    g.flow.receive(
      g.incoming(permission, {
        action: 'answer',
        requestId: 'permission-1',
        answers: { yes: 'yes' },
      }),
    ),
    /exact current/,
  );
});
test('Reviewed mutes the current revision and Snooze allows only the chosen number of reminders', async () => {
  const f = fixture();
  f.feed();
  const item = f.notify();
  await f.flow.receive(f.incoming(item, { action: 'reviewed' }));
  f.advance(50000);
  assert.equal(f.flow.tick().length, 0);
  const g = fixture();
  g.feed();
  const snoozed = g.notify();
  await g.flow.receive(g.incoming(snoozed, { action: 'snooze' }));
  g.advance(3599999);
  assert.equal(g.flow.tick().length, 0);
  g.advance(1);
  const reminder = g.notify();
  await g.flow.receive(g.incoming(reminder, { eventId: 'reply-2', action: 'snooze' }));
  g.advance(3600000);
  assert.equal(g.flow.tick().length, 0);
});
test('a lost Codex reply acknowledgment is uncertain, suppressed on replay, and does not trigger a call', async () => {
  let calls = 0;
  const f = fixture({
    command: async () => {
      calls++;
      throw new Error('Reply acknowledgment was lost.');
    },
  });
  f.feed();
  const item = f.notify();
  const result = await f.flow.receive(f.incoming(item));
  assert.equal(result.state, 'uncertain');
  assert.equal(result.codexAccepted, false);
  await f.flow.receive(f.incoming(item));
  await assert.rejects(
    f.flow.receive(f.incoming(item, { eventId: 'new-event' })),
    /previous reply/,
  );
  f.advance(50000);
  assert.equal(f.flow.tick().length, 0);
  assert.equal(calls, 1);
});
test('a legitimate new working revision during a reply confirms that reply without acknowledging the new update', async () => {
  let f;
  f = fixture({
    command: async () => {
      f.feed([
        card({ status: 'working', fingerprint: 'v2', summary: 'Continuing the synthetic task.' }),
      ]);
    },
  });
  f.feed();
  const item = f.notify();
  const result = await f.flow.receive(f.incoming(item));
  assert.equal(result.codexAccepted, true);
  assert.equal([...f.flow.rows.values()][0].acknowledged, false);
});
test('calls can be disabled explicitly and queued calls cancel immediately', () => {
  const f = fixture();
  f.feed();
  f.notify();
  f.advance(10000);
  const call = f.flow.tick().find((i) => i.kind === 'call');
  f.flow.configure({ ...policy, calls: { ...policy.calls, enabled: false } });
  assert.equal(f.flow.outbox.get(call.id).state, 'cancelled');
});
test('a checkpoint failure prevents a dispatch from being returned to a transport', () => {
  const f = fixture();
  f.feed();
  const item = f.flow.tick()[0];
  f.flow.checkpoint = () => {
    throw new Error('Synthetic disk failure.');
  };
  assert.throws(() => f.flow.beginDelivery(item.id), /disk failure/);
  assert.throws(() => f.flow.beginDelivery(item.id), /no longer available/);
});
