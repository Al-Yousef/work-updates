'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Queue } = require('../../src/queue.cjs');
const { Devices } = require('../../src/devices.cjs');
const { StatePublisher } = require('../../src/state-order.cjs');
const { NotificationSession } = require('../../src/notification-session.cjs');
const { uniqueCards } = require('./model.js');
const localId = '30000000-0000-4000-8000-000000000001';
const remoteId = '30000000-0000-4000-8000-000000000002';
const pairId = '30000000-0000-4000-8000-000000000003';
const sharedChat = '40000000-0000-4000-8000-000000000001';
const secondChat = '40000000-0000-4000-8000-000000000002';
const mailChat = '40000000-0000-4000-8000-000000000003';
const dmChat = '40000000-0000-4000-8000-000000000004';
const contextRevision = (card) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        card.owner.id,
        card.id,
        card.taskKey,
        card.fingerprint,
        card.notificationVersion,
        card.title,
        card.summary,
        card.sources.map((s) => [s.id, s.title, s.body]),
      ]),
    )
    .digest('hex');
const policy = {
  coalesceMs: 0,
  maxSnoozeReminders: 1,
  quietHours: null,
  calls: {
    enabled: true,
    urgency: 'manual',
    unansweredMs: 600000,
    minIntervalMs: 3600000,
    maxPerTask: 1,
    maxPer24Hours: 2,
  },
};
class InboxFixture {
  constructor(directory, { restored = null, checkpoint = () => {} } = {}) {
    this.directory = directory;
    this.time = Date.now();
    this.sequence = 0;
    this.commands = [];
    this.replies = new Map();
    this.uncertain = false;
    this.mode = 'quiet';
    this.pc = new Queue(path.join(directory, 'pc'));
    this.mac = new Queue(path.join(directory, 'mac'));
    this.publisher = new StatePublisher();
    this.devices = new Devices({
      directory,
      identity: { id: localId, name: 'Sample PC', kind: 'pc' },
      state: () => this.pc.snapshot(),
      command: (method, input) => this.execute(this.pc, method, input, localId),
      encrypt: (s) => Buffer.from(s),
      decrypt: (b) => b.toString(),
    });
    this.peer = new EventEmitter();
    this.peer.connected = true;
    this.peer.generation = 1;
    this.peer.command = async (method, input) => {
      this.execute(this.mac, method, input, pairId);
      return this.publish();
    };
    this.peer.close = () => {
      this.peer.connected = false;
    };
    const { StateOrder } = require('../../src/state-order.cjs');
    this.entry = {
      id: pairId,
      peer: this.peer,
      hostId: remoteId,
      name: 'Sample Mac',
      state: null,
      generation: 1,
      order: new StateOrder(),
      eventCount: 0,
    };
    this.devices.peers.set(pairId, this.entry);
    this.setup('quiet');
    if (restored) {
      this.pc.state = restored.pcState;
      this.mac.state = restored.macState;
      this.pc.feed = restored.pcFeed;
      this.mac.feed = restored.macFeed;
      this.time = restored.time;
      this.sequence = restored.sequence;
      this.mode = restored.mode;
      this.uncertain = restored.uncertain;
      this.replies = new Map(restored.replies);
      this.commands = restored.commands;
      this.peer.connected = restored.online;
      if (!restored.peerPresent) this.devices.peers.delete(pairId);
      this.publish();
    }
    this.session = new NotificationSession(this.devices, {
      localQueue: this.pc,
      policy,
      trustedSender: { channel: 'synthetic', senderId: 'preview-owner' },
      clock: () => this.time,
      id: () => 'dot-fixture-' + ++this.sequence,
      restored: restored?.flow,
      checkpoint,
    });
  }
  export() {
    return {
      pcState: this.pc.state,
      macState: this.mac.state,
      pcFeed: this.pc.feed,
      macFeed: this.mac.feed,
      time: this.time,
      sequence: this.sequence,
      mode: this.mode,
      uncertain: this.uncertain,
      replies: [...this.replies],
      commands: this.commands,
      online: this.peer.connected,
      peerPresent: this.devices.peers.has(pairId),
      flow: this.session?.flow.export(),
    };
  }
  thread(id, title, taskTitle, body, status = 'ready', extra = {}) {
    return {
      id,
      title,
      taskTitle,
      body,
      summary: body,
      status,
      fingerprint: this.mode + '-' + id + '-' + (extra.revision || '1'),
      readyForReview: ['ready', 'needs'].includes(status),
      contextLoaded: true,
      updatedAt: Math.floor(Date.now() / 1000),
      ...extra,
    };
  }
  setup(mode) {
    // Explicit fixture reset can restore the sample peer; ordinary reconnect cannot.
    if (!this.devices.peers.has(pairId)) {
      this.entry.order.reset();
      this.peer.generation++;
      this.devices.peers.set(pairId, this.entry);
    }
    this.mode = mode;
    this.error = '';
    this.loading = false;
    this.uncertain = mode === 'uncertain';
    this.peer.connected = mode !== 'offline';
    const quiet = mode === 'quiet';
    this.pc.state.cards = {};
    this.mac.state.cards = {};
    this.pc.state.groups = [
      { id: 'sample-project', title: 'Desktop app', threads: [sharedChat, secondChat] },
    ];
    this.mac.state.groups = [];
    this.pc.setFeed({
      threads: [
        this.thread(
          sharedChat,
          'Queue reliability',
          'Review the desktop fix',
          quiet
            ? 'The fixture fix has already been reviewed.'
            : 'Waiting on you to review the desktop fix. The keyboard and close checks passed in this sample.',
          quiet ? 'ready' : 'needs',
        ),
        this.thread(
          secondChat,
          'Desktop layout',
          'Review the desktop fix',
          'Waiting on the reviewer to check the compact layout.',
          'waiting',
        ),
      ],
      monitoredCount: 2,
    });
    this.mac.setFeed({
      threads: [
        this.thread(
          sharedChat,
          'Mac companion',
          'Choose the compact layout',
          quiet
            ? 'The fixture layout has already been reviewed.'
            : 'Waiting on you to choose the compact layout. This sample is marked urgent.',
          quiet ? 'ready' : 'needs',
        ),
        this.thread(
          mailChat,
          'Sam · sample email',
          'Confirm the meeting time',
          'Could Tuesday afternoon work? This is a synthetic email, not a connected mailbox.',
          'needs',
        ),
        this.thread(
          dmChat,
          'Morgan · sample DM',
          'Review the latest mockup',
          'The latest mockup is ready when you have a moment. This DM is a fixture.',
          'ready',
        ),
      ],
      monitoredCount: 3,
    });
    for (const queue of [this.pc, this.mac])
      for (const c of queue.cards()) {
        queue.state.cards[c.id] = {
          ...queue.cardState(c.id),
          dismissed: quiet ? c.fingerprint : '',
          priority: c.id === sharedChat && queue === this.mac ? 'urgent' : 'normal',
        };
      }
    if (mode === 'empty') {
      this.pc.setFeed({ threads: [] });
      this.mac.setFeed({ threads: [] });
    }
    if (mode === 'loading') this.loading = true;
    if (mode === 'error')
      this.error = 'The sample inbox is unavailable. Reconnect to load it again.';
    if (mode === 'long') {
      this.mac.feed.threads[0].title =
        'Mac companion · a longer conversation name that must remain readable';
      this.mac.feed.threads[0].body =
        'Waiting on you to review a longer update. ' +
        'The compact layout keeps the owning computer and conversation visible while the message scrolls. '.repeat(
          9,
        );
      this.mac.feed.threads[0].summary = this.mac.feed.threads[0].body;
    }
    this.publish();
    this.session?.observe();
    this.deliver();
  }
  publish() {
    const state = this.publisher.stamp({
      ...this.mac.snapshot(),
      host: { id: remoteId, name: 'Sample Mac', kind: 'mac' },
    });
    if (this.devices.peers.has(pairId)) this.devices.receive(this.entry, state);
    this.devices.emit('change');
    return state;
  }
  deliver() {
    if (!this.session) return;
    for (const item of this.session.flow.tick())
      if (item.kind === 'message') {
        this.session.flow.beginDelivery(item.id);
        this.session.flow.settleDelivery(item.id, {
          state: 'accepted',
          providerId: 'local-fixture-' + item.id,
        });
      }
  }
  execute(queue, method, input, ownerId) {
    this.commands.push({
      method,
      ownerId,
      id: input.id,
      taskKey: input.taskKey,
      sourceId: input.sourceId,
    });
    if (method === 'action') queue.action(input.id, input.action, input.taskKey);
    else if (method === 'send') {
      const card = queue.get(input.id, input.taskKey);
      const source = card.sources.find((s) => s.id === input.sourceId);
      if (!source) throw new Error('The fixture source does not belong to this task.');
      const sourceKey = JSON.stringify([ownerId, card.taskKey, source.id]);
      const messages = this.replies.get(sourceKey) || [];
      messages.push({ role: 'user', text: input.text });
      this.replies.set(sourceKey, messages);
      if (this.uncertain)
        throw new Error(
          'Fixture acceptance was lost. The reply may have arrived; no automatic retry.',
        );
      messages.push({
        role: 'assistant',
        text: 'The sample owner accepted your reply. No real message was sent.',
      });
      queue.action(input.id, 'reviewed', input.taskKey);
    } else throw new Error('Only synthetic review, snooze and reply are enabled.');
    return queue.snapshot();
  }
  snapshot() {
    const snapshot = this.devices.snapshot();
    snapshot.cards = uniqueCards([...snapshot.cards, ...snapshot.done]).map((card) => {
      const remote = card.owner.id === pairId;
      const rawId = card.id.replace(/^peer:[a-f0-9-]{36}:/i, '');
      const channel =
        rawId === mailChat ? 'Email fixture' : rawId === dmChat ? 'DM fixture' : 'Codex fixture';
      const project =
        channel === 'Codex fixture' ? (remote ? 'Mac companion' : 'Desktop app') : 'Personal inbox';
      const provenance = {
        mode: 'synthetic',
        channel,
        project,
        sender:
          rawId === mailChat
            ? 'Sam (sample)'
            : rawId === dmChat
              ? 'Morgan (sample)'
              : card.chatName,
      };
      const value = { ...card, provenance };
      value.contextRevision = contextRevision(value);
      value.sources = value.sources.map((source) => {
        const rawSource = source.id.replace(/^peer:[a-f0-9-]{36}:/i, '');
        const key = JSON.stringify([
          card.owner.id,
          remote ? card.taskKey.replace(/^peer:[a-f0-9-]{36}:/i, '') : card.taskKey,
          rawSource,
        ]);
        return { ...source, messages: this.replies.get(key) || [] };
      });
      return value;
    });
    return { ...snapshot, fixtureLoading: this.loading, fixtureError: this.error };
  }
  changed() {
    const source = this.mac.feed.threads[0];
    source.taskTitle = 'Review a different Mac task';
    source.body = source.summary =
      'This is a newer synthetic task in the same chat. Review this context before replying.';
    source.fingerprint += '-changed';
    this.publish();
    this.deliver();
  }
  removed() {
    this.mac.feed.threads = this.mac.feed.threads.filter((s) => s.id !== sharedChat);
    this.publish();
  }
  advance() {
    this.time += 601000;
    this.session.flow.tick();
  }
  close() {
    this.session.close();
    this.devices.close();
  }
}
module.exports = { InboxFixture, contextRevision, sharedChat, pairId, localId };
