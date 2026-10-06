'use strict';
// A local replay using real Queue/Devices classes and synthetic in-memory peers.
// No socket, Codex client, provider SDK, credentials or external request is created.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Queue, atomic } = require('../src/queue.cjs');
const { Devices } = require('../src/devices.cjs');
const { StatePublisher } = require('../src/state-order.cjs');
const { NotificationSession } = require('../src/notification-session.cjs');
const output = path.resolve(__dirname, '../artifacts/notifications');
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(output, 'fixture-'));
const localId = '11111111-1111-4111-8111-111111111111';
const remoteId = '22222222-2222-4222-8222-222222222222';
const chatId = '33333333-3333-4333-8333-333333333333';
const sender = { channel: 'synthetic', senderId: 'preview-owner' };
const policy = {
  coalesceMs: 30000,
  maxSnoozeReminders: 1,
  quietHours: { start: '22:00', end: '08:00', timeZone: 'America/Toronto', appliesTo: 'all' },
  calls: {
    enabled: true,
    urgency: 'manual',
    unansweredMs: 600000,
    minIntervalMs: 3600000,
    maxPerTask: 1,
    maxPer24Hours: 2,
  },
};
let time = Date.parse('2026-10-03T16:00:00Z'),
  sequence = 0,
  incomingSequence = 0;
const clock = () => time;
const queues = {
  local: new Queue(path.join(directory, 'pc')),
  remote: new Queue(path.join(directory, 'mac')),
};
const events = [],
  checks = [],
  commands = [];
function feed(
  queue,
  {
    name = 'Queue reliability',
    task = 'Review the queue fix',
    summary = 'The synthetic fix is ready to review.',
    status = 'working',
    revision = 'initial',
    id = chatId,
    urgent = false,
  } = {},
) {
  const thread = {
    id,
    title: name,
    taskTitle: task,
    summary,
    body: summary,
    status,
    fingerprint: revision,
    updatedAt: Math.floor(time / 1000),
    readyForReview: status === 'ready',
    contextLoaded: true,
  };
  queue.state.cards[id] = { ...queue.cardState(id), priority: urgent ? 'urgent' : 'normal' };
  queue.setFeed({ threads: [thread], monitoredCount: 1, collectedAt: Math.floor(time / 1000) });
}
function event(kind, text, extra = {}) {
  events.push({ at: time, kind, text, ...extra });
}
function check(name, condition) {
  assert.ok(condition, name);
  checks.push({ name, passed: true });
}
function execute(queue, method, input, owner) {
  commands.push({ method, input: structuredClone(input), owner });
  if (method === 'action') {
    queue.action(input.id, input.action, input.taskKey);
    if (input.action === 'snooze') {
      // Keep the synthetic Queue's wall-clock field in the replay's virtual clock.
      queue.state.cards[input.id].snoozedUntil = Math.floor((time + 3600000) / 1000);
      queue.save();
    }
  } else if (method === 'send') {
    const source = queue.feed.threads.find((t) => t.id === input.sourceId);
    assert.ok(source, 'Synthetic reply reached the bound chat');
    feed(queue, {
      name: source.title,
      task: source.taskTitle,
      summary: 'The synthetic owner accepted the reply and resumed.',
      status: 'working',
      revision: source.fingerprint + '-reply',
    });
  } else throw new Error('Unsupported synthetic command.');
  return queue.snapshot();
}
feed(queues.local);
feed(queues.remote, { name: 'Mac layout', task: 'Review a layout update' });
let peer;
const publisher = new StatePublisher({ clock });
const devices = new Devices({
  directory,
  identity: { id: localId, name: 'Sample PC', kind: 'pc' },
  state: () => queues.local.snapshot(),
  command: (method, input) => execute(queues.local, method, input, 'pc'),
  encrypt: (s) => Buffer.from(s),
  decrypt: (b) => b.toString(),
  makePeer: () => {
    peer = new EventEmitter();
    peer.connected = false;
    peer.generation = 1;
    peer.publish = () => {
      const state = publisher.stamp({
        ...queues.remote.snapshot(),
        host: { id: remoteId, name: 'Sample Mac', kind: 'mac' },
      });
      peer.emit('state', state);
      return state;
    };
    peer.connect = async () => {
      peer.connected = true;
      peer.publish();
    };
    peer.command = async (method, input) => {
      execute(queues.remote, method, input, 'mac');
      return peer.publish();
    };
    peer.close = () => {
      peer.connected = false;
    };
    return peer;
  },
});
let session;
async function receive(item, ref, action, text) {
  event('you', text || (action === 'reviewed' ? 'Reviewed' : 'Snooze 1h'), {
    computer: ref.computer,
    chatName: ref.chatName,
  });
  const result = await session.flow.receive({
    ...sender,
    eventId: 'synthetic-input-' + ++incomingSequence,
    notificationId: item.id,
    ownerId: ref.ownerId,
    taskKey: ref.taskKey,
    action,
    text,
  });
  event(
    'result',
    'Synthetic task command: ' +
      result.state +
      '. This is separate from the message delivery receipt.',
  );
  return result;
}
function deliver(item) {
  session.flow.beginDelivery(item.id);
  session.flow.settleDelivery(item.id, { state: 'accepted', providerId: 'synthetic-' + item.id });
  event('work-updates', item.text, {
    refs: item.refs,
    deliveryId: item.id,
    transport: 'synthetic accepted',
  });
}
(async () => {
  try {
    const pairing = await devices.add(
      'wu1:' +
        Buffer.from(
          JSON.stringify({
            host: '127.0.0.1',
            port: 12010,
            pin: 'a'.repeat(64),
            token: 'b'.repeat(64),
          }),
        ).toString('base64url'),
    );
    session = new NotificationSession(devices, {
      localQueue: queues.local,
      policy,
      trustedSender: sender,
      clock,
      id: () => 'preview-' + ++sequence,
      checkpoint: (state) => atomic(path.join(directory, 'notification-state.json'), state),
    });
    check(
      'Opening the replay does not notify old baseline chats',
      session.flow.tick().length === 0,
    );
    feed(queues.local, { status: 'ready', revision: 'ready-1' });
    feed(queues.remote, {
      name: 'Mac layout',
      task: 'Review a layout update',
      status: 'ready',
      revision: 'ready-1',
    });
    peer.publish();
    time += 30000;
    const routine = session.flow.tick()[0];
    check('Two routine updates coalesce into one message', routine.refs.length === 2);
    deliver(routine);
    const macRef = routine.refs.find((r) => r.ownerId === pairing.id);
    await receive(routine, macRef, 'reviewed');
    check(
      'Reviewed reaches the Mac only despite identical raw chat IDs',
      queues.remote.cards()[0].reviewed && !queues.local.cards()[0].reviewed,
    );
    check('Reviewed does not complete the underlying task', !queues.remote.cards()[0].done);

    feed(queues.local, {
      status: 'needs',
      revision: 'needs-1',
      summary: 'Waiting on you to choose the next implementation step.',
    });
    const needs = session.flow.tick()[0];
    deliver(needs);
    await receive(needs, needs.refs[0], 'snooze');
    time += 600000;
    check('Snooze prevents an escalation', !session.flow.tick().some((i) => i.kind === 'call'));
    await receive(needs, needs.refs[0], 'reply', 'Continue with the local proof.');
    check(
      'Reply routes to the original PC and exact source chat',
      commands.at(-1).owner === 'pc' && commands.at(-1).input.sourceId === chatId,
    );

    feed(queues.remote, {
      name: 'Mac layout',
      task: 'Review a layout update',
      status: 'needs',
      revision: 'urgent-1',
      summary: 'Waiting on you for an explicitly marked urgent decision.',
      urgent: true,
    });
    peer.publish();
    const urgent = session.flow.tick()[0];
    deliver(urgent);
    time += 600000;
    const cancelledCall = session.flow.tick().find((i) => i.kind === 'call');
    event('call-preview', cancelledCall.text + '\nPreview only. No phone is dialled.');
    await receive(urgent, urgent.refs[0], 'reviewed');
    check(
      'Reviewing before dispatch cancels the queued call',
      session.flow.outbox.get(cancelledCall.id).state === 'cancelled',
    );
    event('result', 'Call cancelled because you reviewed the current update.');

    feed(queues.remote, {
      name: 'Release decision',
      task: 'Choose the next local release candidate',
      id: '44444444-4444-4444-8444-444444444444',
      status: 'needs',
      revision: 'another-urgent-1',
      summary: 'Waiting on you for another manually marked urgent decision.',
      urgent: true,
    });
    peer.publish();
    const another = session.flow.tick()[0];
    deliver(another);
    time += 600000;
    const call = session.flow.tick().find((i) => i.kind === 'call');
    session.flow.beginDelivery(call.id);
    session.flow.settleDelivery(call.id, { state: 'uncertain', providerId: 'synthetic-call' });
    event(
      'call-preview',
      call.text + '\nSynthetic dispatch outcome: uncertain. No real call was placed.',
    );
    time += 3600000;
    check(
      'An uncertain call is never silently redialled',
      !session.flow.tick().some((i) => i.kind === 'call'),
    );
    event('result', 'Uncertain delivery stays in the local journal. The replay does not retry it.');

    const report = {
      mode: 'local synthetic replay',
      policy,
      events,
      checks,
      commands,
      outcomes: [...session.flow.outbox.values()].map(({ id, kind, state, invalidated }) => ({
        id,
        kind,
        state,
        invalidated,
      })),
    };
    atomic(path.join(output, 'dry-run.json'), report);
    const stamp = (at) =>
      new Date(at).toLocaleTimeString('en-CA', {
        timeZone: 'America/Toronto',
        hour: '2-digit',
        minute: '2-digit',
      });
    const lines = [
      '# Work Updates conversation and call preview',
      '',
      'Local synthetic replay. No message, call, provider connection or real Codex reply was sent.',
      '',
      'Run again with: npm run demo:notifications',
      '',
      '## Explicit preview settings',
      '',
      '- Routine updates batch for 30 seconds; waiting on you gets a separate message.',
      '- Calls: manually marked urgent plus waiting on you, unanswered for 10 minutes after transport acceptance.',
      '- Quiet hours: 22:00-08:00 America/Toronto for messages and calls.',
      '- At most one attempted call per task, two per rolling 24 hours, at least one hour apart.',
      '- One Snooze reminder per revision. These are preview choices, not saved user preferences.',
      '',
      '## Conversation replay',
      '',
      ...events.flatMap((e) => [
        '**' +
          stamp(e.at) +
          ' · ' +
          {
            'work-updates': 'Work Updates',
            you: 'You',
            result: 'Local result',
            'call-preview': 'Call preview',
          }[e.kind] +
          '**',
        '',
        ...e.text.split('\n').map((line) => '> ' + line),
        '',
      ]),
      '## Acceptance ledger',
      '',
      ...checks.map((c) => '- PASS: ' + c.name),
      '',
      'The deterministic test suite additionally covers delayed snapshots, reconnects, forgotten pairings, quiet-hour boundaries, strict limits, pending questions and uncertain replies.',
      '',
      '## Delivery choice still pending',
      '',
      'SMS needs a phone provider and paid number/usage; incoming sender identity must be verified. Telegram needs a bot and an allowed private chat; outgoing message IDs and incoming reply references map to this journal. Phone calls need their own voice adapter. None is connected.',
      '',
      'The installed desktop app is unchanged. Native-versus-web mobile choice and personal installation remain separate from this flow.',
      '',
    ];
    fs.writeFileSync(path.join(output, 'PREVIEW.md'), lines.join('\n'));
    process.stdout.write(lines.join('\n') + '\n');
  } finally {
    session?.close();
    devices.close();
    const target = path.resolve(directory);
    assert.ok(target.startsWith(output + path.sep) && path.basename(target).startsWith('fixture-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
