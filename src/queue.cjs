'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const now = () => Math.floor(Date.now() / 1000);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
const labels = {
  queued: 'Queued',
  starting: 'Starting chat',
  working: 'Working',
  ready: 'Ready to review',
  needs: 'Needs you',
  blocked: 'Blocked',
  waiting: 'Waiting',
  unknown: 'Check status',
  done: 'Done',
};
function text(value, max) {
  if (typeof value !== 'string' || value.trim().length > max)
    throw new Error('Please use a shorter text value.');
  return value.trim();
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

class Queue extends EventEmitter {
  constructor(directory) {
    super();
    this.directory = directory;
    this.file = path.join(directory, 'state.json');
    this.state = read(this.file, {
      version: 1,
      tasks: [],
      cards: {},
      done: {},
      groups: [],
      settings: { pin: true, corner: false, attention: true, queueSince: now() - 7 * 86400 },
    });
    this.state.tasks ??= [];
    this.state.cards ??= {};
    this.state.done ??= {};
    this.state.groups ??= [];
    this.state.settings ??= {};
    this.feed = { threads: [], monitoredCount: 0, collectedAt: 0 };
    this.health = { ok: true };
    this.busy = new Set();
    this.undo = null;
    this.approvals = new Map();
    // A crash must offer a retry, never create a second chat automatically.
    for (const task of this.state.tasks)
      if (['starting', 'working', 'needs'].includes(task.status)) {
        task.status = 'blocked';
        task.error = 'The app restarted. Reopen this task to continue.';
      }
  }
  save() {
    atomic(this.file, this.state);
    this.emit('change', this.snapshot());
  }
  setFeed(feed, health = { ok: true }) {
    this.feed = feed;
    this.health = health;
    this.emit('change', this.snapshot());
  }
  importLegacy(root) {
    if (this.state.importedLegacy) return;
    const pref = read(path.join(root, 'data', 'preferences.json'), null);
    if (!pref) return;
    this.state.cards = pref.cards || {};
    this.state.groups = pref.groups || [];
    this.state.settings.pin = pref.topmost !== false;
    this.state.settings.queueSince = pref.queueSince || now() - 7 * 86400;
    this.state.importedLegacy = true;
    this.save();
  }
  cardState(id) {
    return this.state.cards[id] ?? { dismissed: '', snoozedUntil: 0, manual: 'auto' };
  }
  cards() {
    const used = new Set(this.state.tasks.map((t) => t.threadId).filter(Boolean));
    const result = [];
    const make = (id, name, sources) => {
      const display =
        [...sources]
          .filter((s) => s.readyForReview)
          .sort((a, b) => b.completedAt - a.completedAt)[0] ||
        [...sources].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const state = this.cardState(id);
      const taskTitle = display.taskTitle || name;
      const key = id + ':' + hash(taskTitle.toLowerCase());
      const fp = [...sources]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((s) => s.id + ':' + s.fingerprint)
        .join('|');
      const status = state.manual && state.manual !== 'auto' ? state.manual : display.status;
      return {
        id,
        taskKey: key,
        title: taskTitle,
        chatName: name,
        kind: 'observed',
        status,
        label: labels[status] || display.label || 'Updated',
        at: display.notificationAt || display.updatedAt,
        fingerprint: fp,
        readyForReview: display.readyForReview,
        sources: sources.map((s) => ({
          id: s.id,
          title: s.title,
          body: s.body || '',
          contextLoaded: !!s.contextLoaded,
          cwd: s.cwd || '',
          lifecycle: s.lifecycle,
        })),
        reviewed: state.dismissed === fp,
        snoozed: state.snoozedUntil > now(),
        snoozedUntil: state.snoozedUntil || 0,
        done: !!this.state.done[key],
      };
    };
    for (const group of this.state.groups) {
      const sources = this.feed.threads.filter(
        (t) => group.threads.includes(t.id) && !used.has(t.id),
      );
      if (sources.length) {
        sources.forEach((s) => used.add(s.id));
        result.push(make(group.id, group.title, sources));
      }
    }
    for (const chat of this.feed.threads)
      if (!used.has(chat.id)) result.push(make(chat.id, chat.title, [chat]));
    for (const task of this.state.tasks)
      result.push({
        ...task,
        kind: 'local',
        taskKey: task.id,
        label: labels[task.status] || 'Queued',
        at: task.updatedAt || task.createdAt,
        sources: task.threadId
          ? [
              {
                id: task.threadId,
                title: task.title,
                body: task.messages?.filter((m) => m.role === 'assistant').at(-1)?.text || '',
                contextLoaded: true,
                cwd: task.cwd,
                lifecycle: task.status,
              },
            ]
          : [],
        readyForReview: task.status === 'ready',
        reviewed: task.reviewedVersion === task.notificationVersion,
        snoozed: task.snoozedUntil > now(),
        done: task.status === 'done',
      });
    return result.sort(
      (a, b) =>
        (a.status === 'needs'
          ? 0
          : a.readyForReview
            ? 1
            : a.status === 'queued'
              ? 2
              : a.status === 'working'
                ? 3
                : 4) -
          (b.status === 'needs'
            ? 0
            : b.readyForReview
              ? 1
              : b.status === 'queued'
                ? 2
                : b.status === 'working'
                  ? 3
                  : 4) || b.at - a.at,
    );
  }
  snapshot() {
    const cards = this.cards();
    return {
      cards,
      done: Object.values(this.state.done),
      monitoredCount: this.feed.monitoredCount || this.feed.threads.length,
      collectedAt: this.feed.collectedAt,
      health: this.health,
      settings: this.state.settings,
      queued: cards.filter((c) => c.status === 'queued' && !c.done).length,
      ready: cards.filter((c) => c.readyForReview && !c.done && !c.reviewed && !c.snoozed).length,
      working: cards.filter((c) => c.status === 'working' && !c.done).length,
      undo: !!this.undo,
      approvals: [...this.approvals.values()].map(({ reply, ...safe }) => safe),
    };
  }
  get(id) {
    const card = this.state.done[id] || this.cards().find((c) => c.id === id);
    if (!card) throw new Error('This task is no longer in the queue.');
    return card;
  }
  create(input) {
    const title = text(input.title, 100),
      prompt = text(input.prompt, 12000);
    if (!title || !prompt) throw new Error('Add a title and a prompt.');
    const task = {
      id: crypto.randomUUID(),
      title,
      prompt,
      cwd: input.cwd ? text(input.cwd, 1024) : '',
      status: 'queued',
      createdAt: now(),
      updatedAt: now(),
      messages: [],
      notificationVersion: 'queued',
      snoozedUntil: 0,
      threadId: null,
    };
    this.state.tasks.push(task);
    this.save();
    return task;
  }
  action(id, action) {
    const card = this.get(id);
    id = card.id;
    const task = this.state.tasks.find((t) => t.id === id);
    if (action === 'done' && ['working', 'starting', 'needs'].includes(card.status))
      throw new Error('Wait for the current pass to finish, or stop it before marking Done.');
    this.undo = {
      id,
      task: task
        ? {
            status: task.status,
            doneAt: task.doneAt || 0,
            snoozedUntil: task.snoozedUntil || 0,
            reviewedVersion: task.reviewedVersion,
          }
        : null,
      card: structuredClone(this.cardState(id)),
      key: card.taskKey,
      done: this.state.done[card.taskKey] ? structuredClone(this.state.done[card.taskKey]) : null,
    };
    if (action === 'done') {
      this.state.done[card.taskKey] = {
        ...card,
        done: true,
        doneAt: now(),
        status: 'done',
        label: 'Done',
      };
      if (task) {
        task.status = 'done';
        task.doneAt = now();
      }
    } else if (action === 'reopen') {
      delete this.state.done[card.taskKey];
      if (task) {
        task.status = task.threadId ? 'ready' : 'queued';
        task.doneAt = 0;
        task.snoozedUntil = 0;
        task.reviewedVersion = '';
      } else if (this.cards().some((c) => c.taskKey === card.taskKey)) {
        this.state.cards[id] = { ...this.cardState(id), dismissed: '', snoozedUntil: 0 };
      } else {
        const restored = this.create({
          title: card.title,
          prompt: 'Continue this task: ' + card.title,
        });
        this.undo.created = restored.id;
      }
    } else if (action === 'reviewed') {
      if (task) task.reviewedVersion = task.notificationVersion;
      else this.state.cards[id] = { ...this.cardState(id), dismissed: card.fingerprint };
    } else if (action === 'snooze') {
      if (task) task.snoozedUntil = now() + 3600;
      else this.state.cards[id] = { ...this.cardState(id), snoozedUntil: now() + 3600 };
    } else if (action === 'restore') {
      if (task) {
        task.snoozedUntil = 0;
        task.reviewedVersion = '';
      } else this.state.cards[id] = { ...this.cardState(id), dismissed: '', snoozedUntil: 0 };
    } else throw new Error('Unknown task action.');
    this.save();
    return this.snapshot();
  }
  undoLast() {
    if (this.undo) {
      const before = this.undo,
        task = this.state.tasks.find((t) => t.id === before.id);
      if (task && before.task) Object.assign(task, before.task);
      if (before.created)
        this.state.tasks = this.state.tasks.filter((t) => t.id !== before.created);
      this.state.cards[before.id] = before.card;
      if (before.done) this.state.done[before.key] = before.done;
      else delete this.state.done[before.key];
      this.undo = null;
      this.save();
    }
    return this.snapshot();
  }
  patch(id, fields) {
    const task = this.state.tasks.find((t) => t.id === id);
    if (!task) throw new Error('Task not found.');
    if (
      (this.undo?.id === id || this.undo?.created === id) &&
      ['starting', 'working', 'needs'].includes(fields.status)
    )
      this.undo = null;
    Object.assign(task, fields, { updatedAt: now() });
    this.save();
    return task;
  }
  message(id, role, value, messageId) {
    const task = this.state.tasks.find((t) => t.id === id);
    if (!task) return;
    const key = messageId || crypto.randomUUID();
    let msg = task.messages.find((m) => m.id === key);
    if (!msg) {
      msg = { id: key, role, text: '', at: now() };
      task.messages.push(msg);
    }
    msg.text = value.slice(0, 16000);
    task.messages = task.messages.slice(-60);
    this.save();
  }
}
module.exports = { Queue, atomic, read, now, text, hash };
