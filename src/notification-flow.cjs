'use strict';
// No provider, network, phone number or Codex client lives in this module.
const { randomUUID, createHash } = require('node:crypto');
const { StateOrder } = require('./state-order.cjs');
const { statusLabel } = require('./attention.cjs');
const clone = (value) => structuredClone(value);
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keyOf = (ref) => JSON.stringify([ref.ownerId, ref.taskKey]);
const clean = (value, limit = 600) =>
  String(value || '')
    .trim()
    .slice(0, limit);
function validatePolicy(policy) {
  if (!policy || !Number.isFinite(policy.coalesceMs) || policy.coalesceMs < 0)
    throw new Error('Choose a routine update batching interval.');
  const calls = policy.calls;
  if (!calls || typeof calls.enabled !== 'boolean')
    throw new Error('Choose whether calls are enabled.');
  if (!['manual', 'manual-or-inferred'].includes(calls.urgency))
    throw new Error('Choose which urgency markings may trigger a call.');
  for (const field of ['unansweredMs', 'minIntervalMs'])
    if (!Number.isFinite(calls[field]) || calls[field] < 0)
      throw new Error('Choose a nonnegative ' + field + '.');
  for (const field of ['maxPerTask', 'maxPer24Hours'])
    if (!Number.isSafeInteger(calls[field]) || calls[field] < 1 || calls[field] > 10)
      throw new Error('Choose a bounded ' + field + '.');
  if (
    !Number.isSafeInteger(policy.maxSnoozeReminders) ||
    policy.maxSnoozeReminders < 0 ||
    policy.maxSnoozeReminders > 3
  )
    throw new Error('Choose a bounded number of snooze reminders.');
  if (policy.quietHours) {
    const { start, end, timeZone, appliesTo } = policy.quietHours;
    if (![start, end].every((s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)) || start === end)
      throw new Error('Choose distinct quiet-hour start and end times.');
    if (!['calls', 'all'].includes(appliesTo)) throw new Error('Choose what quiet hours silence.');
    new Intl.DateTimeFormat('en', { timeZone }).format(0);
  }
  return clone(policy);
}
function quiet(at, settings) {
  if (!settings) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: settings.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const minute =
    Number(parts.find((p) => p.type === 'hour').value) * 60 +
    Number(parts.find((p) => p.type === 'minute').value);
  const minutes = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const start = minutes(settings.start),
    end = minutes(settings.end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}
function describe(card, snapshot) {
  const source =
    card.sources?.find((s) => s.id === card.primarySourceId) ||
    (card.sources?.length === 1 ? card.sources[0] : null);
  const owner = snapshot.devices?.find((d) => d.id === card.owner?.id);
  if (!owner || !source || !card.taskKey || !card.id) return null;
  const requests = (snapshot.approvals || [])
    .filter((a) => a.taskId === card.id || a.taskId === card.taskKey)
    .map((a) => ({ id: a.id, kind: a.kind, questions: a.questions || [] }));
  const ref = {
    ownerId: owner.id,
    cardId: card.id,
    taskKey: card.taskKey,
    sourceId: source.id,
    computer: clean(owner.name, 100),
    device: owner.kind,
    chatName: clean(card.chatName || source.title, 160),
    task: clean(card.title, 160),
    summary: clean(card.summary),
    status: card.status,
    waitingOn: card.waitingOn || { kind: 'unknown', name: '' },
    urgent: !!card.urgent,
    priority: card.priority || 'auto',
    requests,
  };
  ref.revision = digest([card.notificationVersion || card.fingerprint || '', ref]);
  return {
    ref,
    present: true,
    online: owner.online === true && card.owner?.online === true,
    done: card.done === true || card.status === 'done',
    reviewed: card.reviewed === true,
    ready: card.readyForReview === true,
    snoozedUntil: Math.max(0, Number(card.snoozedUntil) || 0) * 1000,
    snoozedWithoutTime: card.snoozed === true && !card.snoozedUntil,
  };
}
function awaitingUser(row) {
  return (
    row.ref.status === 'needs' ||
    (['waiting', 'blocked'].includes(row.ref.status) && row.ref.waitingOn.kind === 'you')
  );
}
function messageText(refs, call = false) {
  const lines = refs.map((ref) =>
    [
      ref.computer + ' · ' + ref.chatName,
      ref.task,
      statusLabel(ref.status, ref.waitingOn) + ': ' + ref.summary,
    ].join('\n'),
  );
  return (call ? 'An urgent task is waiting on you.\n' : '') + lines.join('\n\n');
}
class NotificationFlow {
  constructor({
    policy,
    trustedSender,
    clock = Date.now,
    checkpoint = () => {},
    restored,
    id = randomUUID,
    command,
    refresh,
  }) {
    this.policy = validatePolicy(policy);
    if (!trustedSender?.channel || !trustedSender?.senderId)
      throw new Error('Bind a transport and trusted sender before accepting replies.');
    this.sender = clone(trustedSender);
    this.clock = clock;
    this.checkpoint = checkpoint;
    this.id = id;
    this.command = command;
    this.refresh = refresh;
    this.order = new StateOrder({ required: true });
    this.rows = new Map();
    this.outbox = new Map();
    this.inbox = new Map();
    this.callAttempts = [];
    this.ledger = [];
    if (restored) {
      if (restored.version !== 1 || digest(restored.sender) !== digest(this.sender))
        throw new Error('Saved notification state belongs to a different recipient.');
      this.rows = new Map(restored.rows);
      this.outbox = new Map(restored.outbox);
      this.inbox = new Map(restored.inbox);
      this.callAttempts = restored.callAttempts;
      this.ledger = restored.ledger;
      for (const record of [...this.outbox.values(), ...this.inbox.values()])
        if (record.state === 'inFlight') {
          record.state = 'uncertain';
          record.reason = 'Interrupted delivery; check the owner before retrying.';
        }
    }
  }
  export() {
    return clone({
      version: 1,
      sender: this.sender,
      policy: this.policy,
      rows: [...this.rows],
      outbox: [...this.outbox],
      inbox: [...this.inbox],
      callAttempts: this.callAttempts,
      ledger: this.ledger,
    });
  }
  configure(policy) {
    this.policy = validatePolicy(policy);
    this.cancelIneligible();
    this.save('policy-changed');
  }
  save(event, detail = {}) {
    this.ledger.push({ at: this.clock(), event, ...detail });
    this.ledger = this.ledger.slice(-500);
    // Must finish durably before the caller dispatches. A checkpoint failure throws.
    const result = this.checkpoint(this.export());
    if (result?.then) throw new Error('Notification checkpoints must be synchronous and durable.');
  }
  establish(snapshot, { silent = false } = {}) {
    this.order.reset();
    return this.observe(snapshot, { silent });
  }
  observe(snapshot, { silent = false } = {}) {
    if (!this.order.accept(snapshot.stateVersion)) return false;
    const time = this.clock(),
      seen = new Set();
    for (const card of [...snapshot.cards, ...snapshot.done]) {
      const value = describe(card, snapshot);
      if (!value) continue;
      const key = keyOf(value.ref);
      if (seen.has(key)) continue;
      seen.add(key);
      const before = this.rows.get(key);
      const wasOnline = before?.online;
      const changed = !before || before.ref.revision !== value.ref.revision;
      const row = changed
        ? {
            ...value,
            acknowledged: false,
            localReviewed: false,
            localSnoozedUntil: 0,
            reminderAt: 0,
            reminders: 0,
            notifiedAt: null,
            messageId: null,
            pending: false,
            dueAt: time + (awaitingUser(value) ? 0 : this.policy.coalesceMs),
          }
        : Object.assign(before, value);
      if (changed && !silent && this.eligible(row, time)) row.pending = true;
      if (!changed && !wasOnline && value.online && !row.messageId && this.eligible(row, time))
        row.pending = !silent;
      this.rows.set(key, row);
    }
    for (const [key, row] of this.rows)
      if (!seen.has(key)) {
        row.present = false;
        row.online = false;
      }
    this.cancelIneligible();
    this.save('snapshot');
    return true;
  }
  eligible(row, at = this.clock()) {
    return (
      row &&
      row.present &&
      row.online &&
      !row.done &&
      !row.reviewed &&
      !row.localReviewed &&
      !row.snoozedWithoutTime &&
      Math.max(row.snoozedUntil, row.localSnoozedUntil) <= at &&
      (awaitingUser(row) || row.ready || ['ready', 'waiting', 'blocked'].includes(row.ref.status))
    );
  }
  current(ref) {
    const row = this.rows.get(keyOf(ref));
    return row?.present &&
      row.ref.revision === ref.revision &&
      row.ref.sourceId === ref.sourceId &&
      row.ref.cardId === ref.cardId
      ? row
      : null;
  }
  callEligible(row, at) {
    const calls = this.policy.calls;
    return (
      calls.enabled &&
      this.eligible(row, at) &&
      awaitingUser(row) &&
      !row.acknowledged &&
      row.notifiedAt !== null &&
      at - row.notifiedAt >= calls.unansweredMs &&
      (row.ref.priority === 'urgent' || (calls.urgency === 'manual-or-inferred' && row.ref.urgent))
    );
  }
  cancelIneligible() {
    const time = this.clock();
    for (const item of this.outbox.values()) {
      if (!['queued', 'inFlight'].includes(item.state)) continue;
      const refs = item.refs.filter((ref) => {
        const row = this.current(ref);
        return item.kind === 'call'
          ? this.callEligible(row, time) && (item.state === 'inFlight' || this.budget(row, time))
          : this.eligible(row, time);
      });
      if (item.state === 'inFlight') {
        if (refs.length !== item.refs.length) item.invalidated = true;
      } else if (!refs.length) {
        item.state = 'cancelled';
        item.reason = 'The update is no longer eligible.';
      } else {
        item.refs = refs;
        item.text = messageText(refs, item.kind === 'call');
      }
    }
  }
  enqueue(kind, refs) {
    const item = {
      id: this.id(),
      kind,
      refs: clone(refs),
      text: messageText(refs, kind === 'call'),
      state: 'queued',
      createdAt: this.clock(),
      invalidated: false,
    };
    this.outbox.set(item.id, item);
    for (const ref of refs)
      if (kind === 'message') {
        const row = this.current(ref);
        row.pending = false;
        row.messageId = item.id;
      }
    return item;
  }
  budget(row, at) {
    const { maxPerTask, maxPer24Hours, minIntervalMs } = this.policy.calls;
    const key = keyOf(row.ref);
    return (
      this.callAttempts.filter((a) => a.key === key).length < maxPerTask &&
      this.callAttempts.filter((a) => at - a.at < 86400000).length < maxPer24Hours &&
      !this.callAttempts.some((a) => at - a.at < minIntervalMs)
    );
  }
  tick() {
    const time = this.clock(),
      isQuiet = quiet(time, this.policy.quietHours);
    for (const row of this.rows.values()) {
      if (
        row.messageId &&
        this.outbox.get(row.messageId)?.state === 'cancelled' &&
        !row.acknowledged &&
        this.eligible(row, time)
      ) {
        row.pending = true;
        row.dueAt = time;
      }
      if (row.reminderAt && time >= row.reminderAt && this.eligible(row, time)) {
        row.reminderAt = 0;
        if (row.reminders < this.policy.maxSnoozeReminders) {
          row.reminders++;
          row.pending = true;
          row.dueAt = time;
          row.acknowledged = false;
          row.notifiedAt = null;
        }
      }
    }
    this.cancelIneligible();
    if (!(isQuiet && this.policy.quietHours.appliesTo === 'all')) {
      const due = [...this.rows.values()].filter(
        (row) => row.pending && row.dueAt <= time && this.eligible(row, time),
      );
      for (const row of due.filter(awaitingUser)) this.enqueue('message', [row.ref]);
      const routine = due.filter((row) => !awaitingUser(row));
      if (routine.length)
        this.enqueue(
          'message',
          routine.map((row) => row.ref),
        );
    }
    if (!isQuiet)
      for (const row of this.rows.values())
        if (
          this.callEligible(row, time) &&
          this.budget(row, time) &&
          ![...this.outbox.values()].some(
            (item) =>
              item.kind === 'call' &&
              item.state === 'queued' &&
              item.refs.some((ref) => keyOf(ref) === keyOf(row.ref)),
          )
        )
          this.enqueue('call', [row.ref]);
    this.save('tick');
    return clone([...this.outbox.values()].filter((item) => item.state === 'queued'));
  }
  beginDelivery(id) {
    this.refresh?.();
    const item = this.outbox.get(id),
      at = this.clock();
    this.cancelIneligible();
    if (!item || item.state !== 'queued') throw new Error('This delivery is no longer available.');
    const isQuiet = quiet(at, this.policy.quietHours);
    if (isQuiet && (item.kind === 'call' || this.policy.quietHours.appliesTo === 'all'))
      throw new Error('Delivery is paused during quiet hours.');
    if (item.kind === 'call') {
      const row = this.current(item.refs[0]);
      if (!this.callEligible(row, at) || !this.budget(row, at))
        throw new Error('The call is no longer eligible.');
      this.callAttempts.push({ key: keyOf(row.ref), at, deliveryId: id });
    }
    item.state = 'inFlight';
    item.startedAt = at;
    this.save('dispatch-started', { id, kind: item.kind });
    return clone(item);
  }
  settleDelivery(id, { state, providerId = '' }) {
    const item = this.outbox.get(id);
    if (
      !item ||
      item.state !== 'inFlight' ||
      !['accepted', 'delivered', 'failed', 'uncertain'].includes(state)
    )
      throw new Error('Use a terminal result for an in-flight delivery.');
    item.state = state;
    item.providerId = clean(providerId, 200);
    item.settledAt = this.clock();
    if (item.kind === 'message' && ['accepted', 'delivered'].includes(state) && !item.invalidated)
      for (const ref of item.refs) {
        const row = this.current(ref);
        if (this.eligible(row) && row.messageId === id) row.notifiedAt = item.settledAt;
      }
    this.save('transport-' + state, { id });
    return clone(item);
  }
  receipt(id, { state }) {
    const item = this.outbox.get(id);
    if (!item || item.state !== 'accepted' || !['delivered', 'failed'].includes(state))
      throw new Error('Receipt does not match an accepted delivery.');
    item.state = state;
    if (state === 'failed')
      for (const ref of item.refs) {
        const row = this.current(ref);
        if (row?.messageId === id) row.notifiedAt = null;
      }
    this.cancelIneligible();
    this.save('transport-receipt', { id, state });
  }
  async receive(input) {
    // A future provider adapter must verify signatures/origin before supplying this envelope.
    if (input.channel !== this.sender.channel || input.senderId !== this.sender.senderId)
      throw new Error('This sender is not connected to Work Updates.');
    if (typeof input.eventId !== 'string' || !input.eventId || input.eventId.length > 200)
      throw new Error('A unique transport event identity is required.');
    const eventKey = JSON.stringify([input.channel, input.senderId, input.eventId]);
    if (this.inbox.has(eventKey)) return clone(this.inbox.get(eventKey));
    this.refresh?.();
    const item = this.outbox.get(input.notificationId);
    if (!item || item.kind !== 'message' || !['accepted', 'delivered'].includes(item.state))
      throw new Error('Reply to a known message from Work Updates.');
    const ref = input.taskKey
      ? item.refs.find((r) => r.taskKey === input.taskKey && r.ownerId === input.ownerId)
      : item.refs.length === 1
        ? item.refs[0]
        : null;
    if (!ref) throw new Error('Choose the exact task and computer for this reply.');
    if (input.ownerId && input.ownerId !== ref.ownerId)
      throw new Error('This message belongs to a different computer.');
    const row = this.current(ref);
    if (!row || !row.online || row.done)
      throw new Error('This update changed or its computer is unavailable.');
    if (
      [...this.inbox.values()].some(
        (r) =>
          r.key === keyOf(ref) &&
          r.revision === ref.revision &&
          ['inFlight', 'uncertain'].includes(r.state),
      )
    )
      throw new Error(
        'The previous reply may have arrived. Check its source chat before retrying.',
      );
    const target = { ownerId: ref.ownerId, id: ref.cardId, taskKey: ref.taskKey };
    let method, args;
    if (['reviewed', 'snooze'].includes(input.action)) {
      method = 'action';
      args = { ...target, action: input.action };
    } else if (input.action === 'reply') {
      if (ref.requests.length)
        throw new Error(
          'A pending question or approval needs its exact identity. Open the request.',
        );
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 12000)
        throw new Error('Add a reply of at most 12000 characters.');
      method = 'send';
      args = { ...target, sourceId: ref.sourceId, text: input.text.trim() };
    } else if (input.action === 'answer') {
      const request = ref.requests.find((r) => r.id === input.requestId && r.kind === 'question');
      const ids = request?.questions.map((q) => q.id);
      if (
        !ids?.length ||
        !input.answers ||
        Object.keys(input.answers).length !== ids.length ||
        ids.some(
          (id) =>
            typeof input.answers[id] !== 'string' ||
            !input.answers[id].trim() ||
            input.answers[id].length > 4000,
        )
      )
        throw new Error('Answer the exact current question identities.');
      method = 'respond';
      args = { ownerId: ref.ownerId, id: request.id, answers: clone(input.answers) };
    } else throw new Error('Use Reviewed, Snooze, Reply or an identified question answer.');
    if (!this.command) throw new Error('No task command handler is connected.');
    row.acknowledged = true;
    this.cancelIneligible();
    const record = {
      eventId: input.eventId,
      notificationId: item.id,
      key: keyOf(ref),
      revision: ref.revision,
      action: input.action,
      state: 'inFlight',
      receivedAt: this.clock(),
      codexAccepted: false,
    };
    this.inbox.set(eventKey, record);
    this.save('trusted-reply-received', { eventId: input.eventId });
    try {
      await this.command(method, args);
      this.refresh?.();
      // Reviewed/Snooze legitimately update flags but not this task revision.
      const current = this.rows.get(keyOf(ref));
      if (
        !current?.present ||
        !current.online ||
        current.ref.sourceId !== ref.sourceId ||
        current.ref.cardId !== ref.cardId
      )
        throw new Error('The owner changed before its result was confirmed.');
      record.state = 'accepted';
      record.codexAccepted = true;
      if (input.action === 'reviewed' && current.ref.revision === ref.revision)
        current.localReviewed = true;
      if (input.action === 'snooze' && current.ref.revision === ref.revision) {
        current.localSnoozedUntil = this.clock() + 3600000;
        current.reminderAt = current.localSnoozedUntil;
      }
    } catch (error) {
      record.state = error.definiteFailure === true ? 'rejected' : 'uncertain';
      record.reason = clean(error.message);
    }
    this.cancelIneligible();
    this.save('task-reply-' + record.state, { eventId: input.eventId });
    return clone(record);
  }
}
module.exports = { NotificationFlow, validatePolicy, quiet };
