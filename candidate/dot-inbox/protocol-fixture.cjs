'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Queue } = require('../../src/queue.cjs');
const { Devices } = require('../../src/devices.cjs');
const { HostPeer, RemotePeer, parseCode } = require('../../src/peer.cjs');
const { StatePublisher } = require('../../src/state-order.cjs');
const { NotificationSession } = require('../../src/notification-session.cjs');
const { contextRevision } = require('./fixture.cjs');
const { uniqueCards } = require('./model.js');
const { atomicJson } = require('./desktop/policy.cjs');
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function until(predicate, label, timeout = 6000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timed out: ' + label);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
class ProtocolDevices extends Devices {
  async command(method, input) {
    const scope = this.scope.getStore();
    if (!scope) throw new Error('Protocol fixture requires a durable bound action intent.');
    const entry = this.peers.get(scope.input.ownerId);
    if (!entry || !entry.peer.connected) throw new Error('Protocol fixture owner is unavailable.');
    const generation = entry.peer.generation;
    const next = {
      ...input,
      sourceId: scope.input.sourceId,
      fixtureEventId: scope.input.eventId,
      fixtureHostId: entry.hostId,
      fixtureContext: scope.item.sourceContextRevision,
      fixtureViewerContext: scope.input.contextRevision,
    };
    const value = await super.command(method, next);
    if (this.peers.get(entry.id) !== entry || generation !== entry.peer.generation)
      throw new Error('The paired owner session changed before acceptance was confirmed.');
    return value;
  }
  receive(entry, state) {
    try {
      if (entry.peer.expectedHostId && state.host?.id !== entry.peer.expectedHostId)
        throw new Error('The enrolled local protocol fixture identity changed.');
      const accepted = super.receive(entry, state);
      this.trace?.(accepted ? 'snapshot.accepted' : 'snapshot.old-rejected', {
        ownerId: entry.id,
        hostId: state.host?.id,
        version: state.stateVersion,
      });
      return accepted;
    } catch (error) {
      this.trace?.('snapshot.rejected', { ownerId: entry.id, reason: error.message });
      throw error;
    }
  }
}
class ProtocolFixture {
  static async create(directory, options) {
    const fixture = new ProtocolFixture(directory, options);
    try {
      await fixture.start();
      return fixture;
    } catch (error) {
      fixture.close();
      throw error;
    }
  }
  constructor(directory, { restored, checkpoint, protocolRoot }) {
    if (restored && restored.kind !== 'loopback-protocol-v1')
      throw new Error(
        'Use separate protocol-fixture recovery; existing candidate records are preserved.',
      );
    this.directory = directory;
    this.root = protocolRoot;
    this.checkpoint = checkpoint;
    fs.mkdirSync(this.root, { recursive: true });
    this.traceFile = path.join(this.root, 'transport-trace.jsonl');
    this.traceRows = [];
    this.time = restored?.time || Date.now();
    this.sequence = restored?.sequence || 0;
    this.mode = restored?.mode || 'active';
    this.seedRevision = restored?.seedRevision || 0;
    this.commands = restored?.commands || [];
    this.scope = new AsyncLocalStorage();
    this.restored = restored;
    const configFile = path.join(this.root, 'identities.json');
    this.configFile = configFile;
    this.config = fs.existsSync(configFile)
      ? JSON.parse(fs.readFileSync(configFile))
      : {
          viewer: { id: crypto.randomUUID(), name: 'Local protocol review viewer', kind: 'pc' },
          chatId: crypto.randomUUID(),
          sourceId: crypto.randomUUID(),
          owners: ['A', 'B'].map((label) => ({
            id: crypto.randomUUID(),
            pairId: crypto.randomUUID(),
            name: 'Local protocol fixture ' + label,
            kind: 'pc',
            paired: true,
          })),
        };
    atomicJson(configFile, this.config);
    const keyFile = path.join(this.root, 'fixture-protection.key');
    const key = fs.existsSync(keyFile) ? fs.readFileSync(keyFile) : crypto.randomBytes(32);
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, key, { mode: 0o600 });
    this.protection = {
      encrypt(value) {
        const nonce = crypto.randomBytes(12),
          cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
        return Buffer.concat([
          nonce,
          cipher.update(value, 'utf8'),
          cipher.final(),
          cipher.getAuthTag(),
        ]);
      },
      decrypt(value) {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
        decipher.setAuthTag(value.subarray(-16));
        return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString(
          'utf8',
        );
      },
    };
    this.viewerQueue = new Queue(path.join(directory, 'viewer'));
    this.owners = this.config.owners.map((identity, index) => {
      const queue = new Queue(path.join(directory, 'owner-' + index));
      const saved = restored?.owners?.[index];
      if (saved) {
        queue.state = saved.state;
        queue.feed = saved.feed;
      }
      const owner = {
        identity,
        queue,
        publisher: new StatePublisher(),
        executed: new Map(saved?.executed || []),
        replies: new Map(saved?.replies || []),
        delay: false,
        lose: false,
        pending: [],
        offline: saved?.offline || false,
      };
      owner.state = () => {
        const state = queue.snapshot();
        const decorate = (card) => ({
          ...card,
          sources: card.sources.map((source) => ({
            ...source,
            messages: owner.replies.get(JSON.stringify([card.taskKey, source.id])) || [],
          })),
          sourceContextRevision: contextRevision({ ...card, owner: { id: identity.id } }),
        });
        return owner.publisher.stamp({
          ...state,
          cards: state.cards.map(decorate),
          done: state.done.map(decorate),
          host: { id: owner.hostOverride || identity.id, name: identity.name, kind: identity.kind },
        });
      };
      owner.host = new HostPeer({
        directory: path.join(this.root, 'owner-' + index),
        ...this.protection,
        state: owner.state,
        command: (method, input) => this.execute(owner, method, input),
      });
      const request = owner.host.request.bind(owner.host),
        json = owner.host.json.bind(owner.host);
      owner.host.request = (req, res) => {
        this.trace('tls.request', {
          fixture: index,
          route: req.url,
          method: req.method,
          tls: req.socket.getProtocol(),
          authorized: owner.host.authorized(req),
        });
        res.on('finish', () =>
          this.trace('tls.response', { fixture: index, route: req.url, status: res.statusCode }),
        );
        request(req, res);
      };
      owner.host.json = (res, status, value) => {
        if (value?.ok && owner.lose) {
          owner.lose = false;
          this.trace('fault.accepted-response-lost', { fixture: index });
          res.destroy();
          return;
        }
        if (value?.ok && owner.delay) {
          owner.delay = false;
          owner.pending.push(() => {
            if (!res.destroyed) json(res, status, value);
          });
          this.trace('fault.accepted-response-held', { fixture: index });
          return;
        }
        json(res, status, value);
      };
      return owner;
    });
    fs.mkdirSync(path.join(this.root, 'viewer'), { recursive: true });
    this.devices = new ProtocolDevices({
      directory: path.join(this.root, 'viewer'),
      identity: this.config.viewer,
      ...this.protection,
      state: () => this.viewerQueue.snapshot(),
      command: () => {
        throw new Error('No local or real Codex executor is connected.');
      },
      makePeer: (code) => this.makePeer(code),
    });
    this.devices.scope = this.scope;
    this.devices.trace = (type, value) => this.trace(type, value);
    if (!restored) this.seed();
  }
  trace(type, value = {}) {
    const row = { at: new Date().toISOString(), type, ...value };
    this.traceRows.push(row);
    fs.appendFileSync(this.traceFile, JSON.stringify(row) + '\n');
  }
  makePeer(code) {
    const address = parseCode(code);
    const owner = this.owners.find(
      (owner) => (owner.host.server?.address()?.port || owner.host.saved()?.port) === address.port,
    );
    if (address.host !== '127.0.0.1' || !owner)
      throw new Error('Only the two owned loopback fixture endpoints may be paired.');
    const peer = new RemotePeer(code),
      request = peer.request.bind(peer),
      command = peer.command.bind(peer);
    peer.expectedHostId = owner.identity.id;
    peer.request = async (route, method, body) => {
      try {
        const result = await request(route, method, body);
        this.trace('client.pin-verified', {
          port: peer.address.port,
          route,
          method: method || 'GET',
          tls: result.socket?.getProtocol(),
        });
        return result;
      } catch (error) {
        this.trace('client.request-failed', {
          port: peer.address.port,
          route,
          reason: error.message,
        });
        throw error;
      }
    };
    peer.command = async (method, input) => {
      const result = await command(method, input);
      const receipt = result.fixtureReceipt;
      if (
        !receipt?.accepted ||
        receipt.eventId !== input.fixtureEventId ||
        receipt.hostId !== input.fixtureHostId ||
        receipt.contextRevision !== input.fixtureContext ||
        receipt.viewerContextRevision !== input.fixtureViewerContext ||
        receipt.taskKey !== input.taskKey ||
        receipt.sourceId !== input.sourceId
      )
        throw new Error('Protocol fixture acceptance binding does not match.');
      this.trace('client.bound-acceptance', receipt);
      return result;
    };
    return peer;
  }
  seed() {
    this.seedRevision++;
    this.owners.forEach((owner, index) => {
      owner.queue.state.cards = {};
      owner.queue.state.tasks = [];
      owner.queue.state.done = {};
      owner.queue.state.groups = [
        {
          id: 'protocol-project',
          title: 'Local protocol work',
          threads: [this.config.chatId, this.config.sourceId],
        },
      ];
      owner.queue.setFeed({
        threads: [
          this.thread(
            this.config.chatId,
            'Protocol conversation ' + (index ? 'B' : 'A'),
            'Review the paired update',
            'Waiting on you to inspect this local TLS fixture.',
          ),
          this.thread(
            this.config.sourceId,
            'Grouped source ' + (index ? 'B' : 'A'),
            'Review the paired update',
            'A second source in the same fixture task.',
          ),
        ],
        monitoredCount: 2,
      });
      const card = owner.queue.cards()[0];
      owner.queue.state.cards[card.id] = {
        ...owner.queue.cardState(card.id),
        priority: index ? 'urgent' : 'normal',
      };
      owner.queue.create({
        title: 'Queued local protocol task ' + (index ? 'B' : 'A'),
        prompt: 'Synthetic task only; no Codex controller is connected.',
      });
    });
  }
  thread(id, title, taskTitle, body) {
    return {
      id,
      title,
      taskTitle,
      body,
      summary: body,
      status: 'needs',
      readyForReview: true,
      contextLoaded: true,
      fingerprint: 'protocol-' + id + '-' + this.seedRevision,
      updatedAt: Math.floor(this.time / 1000),
    };
  }
  async start() {
    for (const owner of this.owners) {
      if (owner.offline) continue;
      if (owner.host.saved()) await owner.host.restore();
      else await owner.host.start('127.0.0.1');
      this.trace('host.listening', {
        hostId: owner.identity.id,
        fixture: owner.identity.name,
        address: '127.0.0.1',
        port: parseCode(owner.host.code).port,
      });
    }
    await this.devices.restore();
    for (const owner of this.owners)
      if (
        owner.identity.paired &&
        !this.devices.peers.has(owner.identity.pairId) &&
        owner.host.code
      )
        await this.devices.add(owner.host.code, {
          id: owner.identity.pairId,
          name: owner.identity.name,
        });
    this.session = new NotificationSession(this.devices, {
      localQueue: this.viewerQueue,
      policy: {
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
      },
      trustedSender: { channel: 'synthetic', senderId: 'preview-owner' },
      clock: () => this.time,
      id: () => 'local-protocol-' + ++this.sequence,
      restored: this.restored?.flow,
      checkpoint: this.checkpoint,
    });
    this.devices.on('change', () => this.save());
    this.deliver();
    this.save();
  }
  export() {
    return {
      kind: 'loopback-protocol-v1',
      time: this.time,
      sequence: this.sequence,
      mode: this.mode,
      seedRevision: this.seedRevision,
      commands: this.commands,
      owners: this.owners.map((owner) => ({
        state: owner.queue.state,
        feed: owner.queue.feed,
        executed: [...owner.executed],
        replies: [...owner.replies],
        offline: owner.offline,
      })),
      flow: this.session?.flow.export(),
    };
  }
  save() {
    atomicJson(this.configFile, this.config);
    if (this.session) this.checkpoint(this.session.flow.export());
  }
  async dispatch(input, item, operation) {
    return this.scope.run({ input, item }, operation);
  }
  execute(owner, method, input) {
    const signature = digest([
      method,
      input.id,
      input.taskKey,
      input.sourceId,
      input.fixtureContext,
      input.fixtureViewerContext,
      input.text || '',
      input.action || '',
    ]);
    const previous = owner.executed.get(input.fixtureEventId);
    if (previous) {
      if (previous.signature !== signature) throw new Error('Synthetic event ID binding changed.');
      return { ...owner.state(), fixtureReceipt: previous.receipt };
    }
    const card = owner.queue.get(input.id, input.taskKey);
    if (
      !/^[a-f0-9-]{36}$/i.test(input.fixtureEventId || '') ||
      input.fixtureHostId !== owner.identity.id ||
      !card.sources.some((source) => source.id === input.sourceId) ||
      input.fixtureContext !== contextRevision({ ...card, owner: { id: owner.identity.id } })
    ) {
      this.trace('owner.binding-rejected', {
        hostId: owner.identity.id,
        eventId: input.fixtureEventId,
      });
      throw new Error('The synthetic owner task/source/context binding changed.');
    }
    if (method === 'send') {
      const key = JSON.stringify([card.taskKey, input.sourceId]);
      const messages = owner.replies.get(key) || [];
      messages.push(
        { role: 'user', text: input.text },
        {
          role: 'assistant',
          text: 'The synthetic owner recorded this message. Action receipts are reported separately; no external message was sent.',
        },
      );
      owner.replies.set(key, messages);
      owner.queue.action(input.id, 'reviewed', input.taskKey);
    } else if (method === 'action' && ['reviewed', 'snooze', 'done'].includes(input.action))
      owner.queue.action(input.id, input.action, input.taskKey);
    else throw new Error('Only synthetic reply/review/snooze/done commands are allowed.');
    const receipt = {
      accepted: true,
      eventId: input.fixtureEventId,
      hostId: owner.identity.id,
      contextRevision: input.fixtureContext,
      viewerContextRevision: input.fixtureViewerContext,
      taskKey: input.taskKey,
      sourceId: input.sourceId,
    };
    owner.executed.set(input.fixtureEventId, { signature, receipt });
    this.commands.push({
      method,
      ownerId: owner.identity.pairId,
      hostId: owner.identity.id,
      id: input.id,
      taskKey: input.taskKey,
      sourceId: input.sourceId,
      contextRevision: input.fixtureContext,
      eventId: input.fixtureEventId,
      action: input.action,
    });
    this.save();
    this.trace('owner.executed-once', receipt);
    owner.host.broadcast(owner.state());
    return { ...owner.state(), fixtureReceipt: receipt };
  }
  snapshot() {
    const state = this.devices.snapshot();
    state.cards = uniqueCards([...state.cards, ...state.done]).map((card) => {
      const value = {
        ...card,
        provenance: {
          mode: 'synthetic',
          channel: 'Local protocol fixture · TLS',
          project: 'Local protocol work',
          sender: card.chatName,
        },
      };
      value.contextRevision = contextRevision(value);
      return value;
    });
    return {
      ...state,
      fixtureLoading: false,
      fixtureError: this.error || '',
      transport: {
        kind: 'loopback-tls',
        peers: this.owners.map((owner) => ({
          hostId: owner.identity.id,
          ownerId: owner.identity.pairId,
          name: owner.identity.name,
          online: !!this.devices.peers.get(owner.identity.pairId)?.peer.connected,
          paired: owner.identity.paired,
        })),
        trace: this.traceRows.slice(-30),
        note: 'Real local pairing/TLS transport; synthetic owner execution. No physical Mac/iPhone proof.',
      },
    };
  }
  deliver() {
    if (!this.session) return;
    for (const item of this.session.flow.tick())
      if (item.kind === 'message') {
        this.session.flow.beginDelivery(item.id);
        this.session.flow.settleDelivery(item.id, {
          state: 'accepted',
          providerId: 'synthetic-notification-' + item.id,
        });
      }
  }
  async publish(owner = this.owners[1]) {
    const entry = this.devices.peers.get(owner.identity.pairId);
    if (!entry?.peer.connected) return;
    const state = owner.state();
    owner.host.broadcast(state);
    await until(
      () => entry.state?.stateVersion?.revision >= state.stateVersion.revision,
      'TLS snapshot propagation',
    );
    this.session.observe();
    this.deliver();
    this.save();
  }
  advance() {
    this.time += 601000;
    this.session.flow.tick();
    this.save();
  }
  async choose(value) {
    const owner = this.owners[1];
    const entry = this.devices.peers.get(owner.identity.pairId);
    if (value === 'offline') {
      owner.offline = true;
      owner.host.close();
      await until(() => !entry?.peer.connected, 'peer disconnect');
    } else if (value === 'reconnect') {
      if (!owner.identity.paired)
        throw new Error('Forgotten fixture owner requires explicit re-pairing.');
      owner.offline = false;
      await owner.host.restore();
      clearTimeout(entry.peer.timer);
      await entry.peer.connect();
      await until(() => entry.peer.connected, 'peer reconnect');
    } else if (value === 'peer-response-loss') owner.lose = true;
    else if (value === 'peer-late-response') owner.delay = true;
    else if (value === 'release-response') {
      for (const release of owner.pending.splice(0)) release();
    } else if (value === 'forgotten-owner') {
      owner.identity.paired = false;
      this.devices.remove(owner.identity.pairId);
    } else if (value === 'replace-owner') {
      this.devices.remove(owner.identity.pairId);
      owner.identity.pairId = crypto.randomUUID();
      owner.identity.paired = true;
      await this.devices.add(owner.host.code, { id: owner.identity.pairId });
    } else if (value === 'pin-mismatch') {
      const address = parseCode(owner.host.code);
      const wrong = this.makePeer(
        'wu1:' +
          Buffer.from(JSON.stringify({ ...address, pin: '0'.repeat(64) })).toString('base64url'),
      );
      try {
        await wrong.connect();
        throw new Error('Mismatched certificate accepted unexpectedly.');
      } catch (error) {
        if (!/certificate/.test(error.message)) throw error;
        this.pinRejected = true;
      } finally {
        wrong.close();
      }
    } else if (value === 'identity-mismatch') {
      owner.hostOverride = crypto.randomUUID();
      owner.host.broadcast(owner.state());
      await until(() => entry.error, 'identity mismatch rejected');
    } else if (value === 'duplicate') {
      const old = owner.state();
      owner.queue.action(owner.queue.cards()[0].id, 'reviewed');
      await this.publish(owner);
      const rejected = this.traceRows.filter((row) => row.type === 'snapshot.old-rejected').length;
      owner.host.broadcast(old);
      await until(
        () =>
          this.traceRows.filter((row) => row.type === 'snapshot.old-rejected').length > rejected,
        'older TLS snapshot rejected',
      );
      this.duplicateRejected = true;
    } else if (value === 'context-changed' || value === 'changed') {
      owner.queue.feed.threads[0].body += ' New local protocol context.';
      owner.queue.feed.threads[0].summary = owner.queue.feed.threads[0].body;
      if (value === 'changed') {
        owner.queue.feed.threads[0].taskTitle = 'Review a newer protocol task';
        owner.queue.feed.threads[0].fingerprint += '-new-task';
      }
      await this.publish(owner);
    } else if (value === 'removed') {
      owner.queue.feed.threads = owner.queue.feed.threads.filter(
        (source) => source.id !== this.config.chatId,
      );
      owner.queue.state.groups = [];
      await this.publish(owner);
    } else if (value === 'advance') this.advance();
    else if (value === 'active' || value === 'quiet') {
      this.mode = value;
      this.seed();
      for (const peer of this.owners) await this.publish(peer);
    } else throw new Error('Unsupported local protocol scenario.');
    this.session.observe();
    this.deliver();
    this.save();
  }
  close() {
    this.session?.close();
    this.devices?.close();
    for (const owner of this.owners || []) {
      for (const release of owner.pending.splice(0)) release();
      owner.host.close();
    }
  }
}
module.exports = { ProtocolFixture, until };
