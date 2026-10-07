'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { RemotePeer, parseCode } = require('./peer.cjs');
const { compareCards, projectStatus } = require('./status-contract.cjs');
const { executionDevice } = require('./presentation.cjs');
const { StatePublisher, StateOrder } = require('./state-order.cjs');
const { readStore, atomicJSON } = require('./private-store.cjs');
const peerContract = require('./peer-contract.cjs');
const executorReport = require('./executor-report.cjs');
const now = () => Math.floor(Date.now() / 1000);
const prefix = (id) => 'peer:' + id + ':';
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 2048;
function identity(directory, platform = process.platform) {
  const file = path.join(directory, 'device.json');
  const store = readStore(file);
  let value = store.value;
  if (store.missing) {
    value = { version: 1, id: crypto.randomUUID(), ...executionDevice(platform) };
    value.name = value.label;
    fs.mkdirSync(directory, { recursive: true });
    atomicJSON(file, value);
  } else if (store.migrated) atomicJSON(file, value);
  return value;
}
function validState(value) {
  const contract = peerContract.negotiate(value);
  if (contract.executorReports === 1)
    require('./executor-report.cjs').validate(value.executorReport, value.host?.id);
  if (
    !value ||
    !Array.isArray(value.cards) ||
    !Array.isArray(value.done) ||
    !Array.isArray(value.approvals) ||
    !value.settings ||
    value.cards.length + value.done.length > 10000
  )
    throw new Error('The paired app returned an unsupported queue. Update that desktop app.');
  if (
    [...value.cards, ...value.done].some(
      (c) =>
        !validId(c.id) ||
        !validId(c.taskKey) ||
        !Array.isArray(c.sources) ||
        c.sources.some((s) => !validId(s.id)),
    )
  )
    throw new Error('The paired app returned invalid chat identities.');
  return value;
}
class Devices extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.local = options.identity || identity(options.directory);
    this.peers = new Map();
    this.file = path.join(options.directory, 'paired-devices.enc');
    this.lastUndo = null;
    this.publisher = new StatePublisher();
  }
  localState() {
    const report = this.options.executorReport?.(),
      contract = peerContract.capabilities();
    if (report !== undefined) {
      require('./executor-report.cjs').validate(report, this.local.id);
      contract.executorReports = 1;
    }
    const state = this.options.state(),
      execution = executorReport.projection(report, this.local.id);
    return this.publisher.stamp({
      ...state,
      cards: state.cards.map((c) => ({ ...c, executor: execution.task(c) })),
      done: state.done.map((c) => ({ ...c, executor: execution.task(c) })),
      host: this.local,
      peerContract: contract,
      ...(report ? { executorReport: report } : {}),
    });
  }
  receive(entry, value) {
    validState(value);
    if (value.host?.id === this.local.id)
      throw new Error('This is this computer’s own pairing code.');
    if (entry.hostId && value.host?.id && entry.hostId !== value.host.id)
      throw new Error('The paired computer identity changed. Pair it again.');
    const generation = entry.peer.generation || 0;
    if (entry.generation !== generation) {
      entry.generation = generation;
      entry.order.reset();
    }
    if (!entry.order.accept(value.stateVersion)) return false;
    if (value.host?.id) entry.hostId = value.host.id;
    entry.state = structuredClone(value);
    entry.name = value.host?.name || entry.name;
    entry.lastSeen = now();
    return true;
  }
  owner(entry, execution) {
    execution ||= executorReport.projection(
      entry.state?.peerContract?.executorReports === 1 ? entry.state.executorReport : null,
      entry.state?.host?.id || entry.id,
    );
    return {
      id: entry.id,
      name: entry.state?.host?.name || entry.name || 'Paired desktop',
      kind: entry.state?.host?.kind || 'unknown',
      local: false,
      online: !!entry.peer.connected,
      capabilities: peerContract.negotiate(entry.state),
      lastSeen: entry.lastSeen || 0,
      executor: execution.summary,
    };
  }
  card(card, entry, execution) {
    if (!entry)
      return {
        ...card,
        executor: (
          execution || executorReport.projection(this.options.executorReport?.(), this.local.id)
        ).task(card),
        owner: { ...this.local, local: true, online: true, lastSeen: now() },
      };
    const p = prefix(entry.id);
    execution ||= executorReport.projection(
      entry.state?.peerContract?.executorReports === 1 ? entry.state.executorReport : null,
      entry.state?.host?.id || entry.id,
    );
    const executor = execution.task(card);
    return projectStatus(
      {
        ...card,
        executor: {
          ...executor,
          taskId: executor.taskId ? p + executor.taskId : undefined,
          threadId: executor.threadId ? p + executor.threadId : executor.threadId,
        },
        id: p + card.id,
        taskKey: p + card.taskKey,
        primarySourceId: card.primarySourceId ? p + card.primarySourceId : undefined,
        sources: card.sources.map((s) => ({
          ...s,
          id: p + s.id,
          deliveryOutcomes: s.deliveryOutcomes?.map((d) => ({ ...d, sourceId: p + d.sourceId })),
        })),
        owner: this.owner(entry, execution),
      },
      { health: entry.state?.health, collectedAt: entry.state?.collectedAt },
    );
  }
  snapshot() {
    const local = this.options.state(),
      entries = [...this.peers.values()];
    const localExecution = executorReport.projection(
        this.options.executorReport?.(),
        this.local.id,
      ),
      peerExecutions = new Map(
        entries.map((e) => [
          e,
          executorReport.projection(
            e.state?.peerContract?.executorReports === 1 ? e.state.executorReport : null,
            e.state?.host?.id || e.id,
          ),
        ]),
      );
    const cards = local.cards.map((c) => this.card(c, undefined, localExecution)),
      done = local.done.map((c) => this.card(c, undefined, localExecution));
    const approvals = [...local.approvals],
      groups = [...(local.groups || [])];
    for (const entry of entries)
      if (entry.state) {
        const p = prefix(entry.id);
        cards.push(...entry.state.cards.map((c) => this.card(c, entry, peerExecutions.get(entry))));
        done.push(...entry.state.done.map((c) => this.card(c, entry, peerExecutions.get(entry))));
        approvals.push(
          ...entry.state.approvals.map((a) => ({ ...a, id: p + a.id, taskId: p + a.taskId })),
        );
        groups.push(
          ...(entry.state.groups || []).map((g) => ({
            ...g,
            id: p + g.id,
            threads: g.threads.map((id) => p + id),
          })),
        );
      }
    cards.sort(compareCards);
    const online = entries.filter((e) => e.peer.connected).length;
    const devices = [
      {
        ...this.local,
        local: true,
        online: true,
        lastSeen: now(),
        projects: local.settings.projects || [],
        executor: localExecution.summary,
      },
      ...entries.map((e) => ({
        ...this.owner(e, peerExecutions.get(e)),
        projects: e.state?.settings?.projects || [],
      })),
    ];
    const undoOwner = this.lastUndo && this.peers.get(this.lastUndo);
    return {
      ...local,
      cards,
      done,
      groups,
      approvals,
      devices,
      monitoredCount:
        (local.monitoredCount || 0) +
        entries.reduce((n, e) => n + (e.state?.monitoredCount || 0), 0),
      queued: cards.filter((c) => c.status === 'queued' && !c.done).length,
      ready: cards.filter((c) => c.readyForReview && !c.done && !c.reviewed && !c.snoozed).length,
      working: cards.filter((c) => c.status === 'working' && !c.done).length,
      undo: this.lastUndo ? !!undoOwner?.state?.undo && !!undoOwner.peer.connected : local.undo,
      remote: entries.length > 0,
      connected: entries.length > 0 && online === entries.length,
      connection: entries.length
        ? online === entries.length
          ? 'All devices connected'
          : online + ' of ' + entries.length + ' paired computers connected'
        : 'Local desktop',
    };
  }
  persist() {
    const records = [...this.peers.values()].map((e) => ({ id: e.id, code: e.code, name: e.name }));
    if (!records.length) fs.rmSync(this.file, { force: true });
    else
      fs.writeFileSync(this.file, this.options.encrypt(JSON.stringify(records)), { mode: 0o600 });
  }
  async add(code, { restore = false, id, name } = {}) {
    const address = parseCode(code);
    const duplicate = [...this.peers.values()].find(
      (e) => e.address.host === address.host && e.address.port === address.port,
    );
    if (duplicate && duplicate.address.pin === address.pin)
      return { id: duplicate.id, message: 'This computer is already paired.' };
    if (duplicate)
      throw new Error('Forget the old pairing before adding this computer with a new certificate.');
    if (this.peers.size >= 8) throw new Error('You can pair up to eight computers.');
    const peer = this.options.makePeer ? this.options.makePeer(code) : new RemotePeer(code);
    const entry = {
      id: id || crypto.randomUUID(),
      peer,
      code,
      address,
      name,
      state: null,
      lastSeen: 0,
      generation: null,
      order: new StateOrder(),
      eventCount: 0,
    };
    this.peers.set(entry.id, entry);
    peer.on('state', (value) => {
      if (this.peers.get(entry.id) !== entry) return;
      try {
        entry.eventCount++;
        if (this.receive(entry, value)) this.emit('change');
      } catch (error) {
        if (error.code === 'STATE_RESTARTED' && peer.resync) peer.resync();
        else {
          entry.error = error;
          peer.close();
        }
        this.emit('change');
      }
    });
    peer.on('connection', () => {
      if (this.peers.get(entry.id) === entry) this.emit('change');
    });
    try {
      await peer.connect();
      if (this.peers.get(entry.id) !== entry)
        throw new Error('This pairing was removed before it connected.');
      if (entry.error) throw entry.error;
      this.persist();
    } catch (error) {
      if (restore && !entry.error && this.peers.get(entry.id) === entry) {
        peer.reconnect();
      } else {
        peer.close();
        this.peers.delete(entry.id);
        this.emit('change');
        throw error;
      }
    }
    this.emit('change');
    return { id: entry.id, message: 'Computer connected. Both queues stay available.' };
  }
  async restore() {
    let records;
    try {
      records = JSON.parse(this.options.decrypt(fs.readFileSync(this.file)));
    } catch {}
    if (!Array.isArray(records)) {
      try {
        records = [
          {
            code: this.options.decrypt(
              fs.readFileSync(path.join(this.options.directory, 'paired-remote.enc')),
            ),
          },
        ];
      } catch {}
    }
    if (Array.isArray(records)) {
      await Promise.allSettled(
        records.slice(0, 8).map((r) => this.add(r.code, { ...r, restore: true })),
      );
      this.persist();
      fs.rmSync(path.join(this.options.directory, 'paired-remote.enc'), { force: true });
    }
  }
  remove(id) {
    const entries = id ? [this.peers.get(id)].filter(Boolean) : [...this.peers.values()];
    for (const e of entries) {
      this.peers.delete(e.id);
      e.peer.close();
    }
    if (entries.some((e) => e.id === this.lastUndo)) this.lastUndo = null;
    this.persist();
    this.emit('change');
  }
  target(value) {
    if (typeof value !== 'string' || !value.startsWith('peer:')) return { id: null, value };
    const match = /^peer:([a-f0-9-]{36}):(.+)$/i.exec(value);
    if (!match || !this.peers.has(match[1])) throw new Error('This computer is no longer paired.');
    return { id: match[1], value: match[2] };
  }
  async command(method, input = {}) {
    const next = { ...input };
    let owner = input.ownerId === this.local.id ? null : input.ownerId || null;
    delete next.ownerId;
    const infer = (value) => {
      const t = this.target(value);
      if (owner && t.id && owner !== t.id)
        throw new Error('Choose chats from one computer for this action.');
      if (t.id) owner = t.id;
      return t;
    };
    const fields = ['id', 'taskKey', 'sourceId'].filter((field) => input[field]);
    const targets = fields.map((field) => ({ field, ...infer(input[field]) }));
    if (targets.some((t) => t.id !== owner))
      throw new Error('This action includes a chat from another computer.');
    for (const target of targets) next[target.field] = target.value;
    if (owner && input.attachmentIds?.length)
      throw new Error(
        'Image delivery to another computer is not connected yet. Open this chat on its computer to attach images.',
      );
    if (Array.isArray(input.ids)) {
      const targets = input.ids.map(infer);
      if (targets.some((t) => t.id !== owner)) throw new Error('Group chats on the same computer.');
      next.ids = targets.map((t) => t.value);
    }
    if (method === 'undo') owner = this.lastUndo;
    if (method === 'refresh') {
      await this.options.command(method, next);
      await Promise.allSettled(
        [...this.peers.values()]
          .filter((e) => e.peer.connected)
          .map((e) => e.peer.command(method, {})),
      );
      return this.snapshot();
    }
    const entry = owner && this.peers.get(owner);
    if (owner && !entry) throw new Error('This computer is no longer paired.');
    if (entry && method === 'details' && !entry.peer.connected) {
      const card = [...(entry.state?.cards || []), ...(entry.state?.done || [])].find(
        (c) => c.id === next.id || c.taskKey === next.id,
      );
      if (!card || (next.taskKey && card.taskKey !== next.taskKey))
        throw new Error('This task changed. Reopen its latest update.');
      return this.card(card, entry);
    }
    if (entry && !entry.peer.connected)
      throw new Error(entry.name + ' is offline. Reconnect before sending this action.');
    if (entry && !peerContract.negotiate(entry.state).commands.includes(method))
      throw Object.assign(new Error('This paired computer does not support that action.'), {
        code: 'PEER_CAPABILITY',
        delivery: 'not-sent',
      });
    if (['send', 'queueMessage', 'cancelMessage'].includes(method) && !next.sourceId) {
      const state = entry ? entry.state : this.options.state(),
        card = [...(state?.cards || []), ...(state?.done || [])].find(
          (c) => c.id === next.id && (!next.taskKey || c.taskKey === next.taskKey),
        );
      if (card?.sources?.length !== 1)
        throw new Error('Choose the exact source chat before sending this message.');
      next.sourceId = card.sources[0].id;
    }
    const generation = entry?.peer.generation || 0,
      eventCount = entry?.eventCount;
    const result = entry
      ? await entry.peer.command(method, next)
      : await this.options.command(method, next);
    const current = () =>
      !entry || (this.peers.get(owner) === entry && generation === (entry.peer.generation || 0));
    const recordUndo = () => {
      if (current() && ['action', 'group'].includes(method)) this.lastUndo = owner;
      if (current() && method === 'undo') this.lastUndo = null;
    };
    if (result?.cards && result?.done) {
      if (entry && current() && (result.stateVersion || eventCount === entry.eventCount)) {
        try {
          this.receive(entry, result);
        } catch (error) {
          if (error.code === 'STATE_RESTARTED' && entry.peer.resync) entry.peer.resync();
          else throw error;
        }
      }
      recordUndo();
      return this.snapshot();
    }
    recordUndo();
    if (
      ['send', 'queueMessage', 'cancelMessage'].includes(method) &&
      result &&
      typeof result === 'object'
    ) {
      if (
        !current() ||
        !result.messageId ||
        (input.messageId && result.messageId !== input.messageId) ||
        result.sourceId !== next.sourceId
      )
        throw Object.assign(
          new Error(
            'The source did not return a matching delivery identity. Check it before retrying.',
          ),
          { delivery: 'uncertain', code: 'DELIVERY_RECEIPT' },
        );
      return {
        ...result,
        ownerId: entry ? entry.id : this.local.id,
        sourceId: entry ? prefix(entry.id) + next.sourceId : next.sourceId,
        ...(entry && result.taskId ? { taskId: prefix(entry.id) + result.taskId } : {}),
      };
    }
    if (method === 'details' && entry) return this.card(result, entry);
    if (entry && result && typeof result === 'object') {
      const p = prefix(entry.id),
        out = { ...result };
      if (out.id) out.id = p + out.id;
      if (out.taskId) out.taskId = p + out.taskId;
      return out;
    }
    return result;
  }
  close() {
    for (const e of this.peers.values()) e.peer.close();
  }
}
module.exports = { Devices, identity, validState, prefix };
