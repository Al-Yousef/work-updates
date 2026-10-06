'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { inferAttention, statusLabel } = require('./attention.cjs');
const { device, executionDevice, shortSummary, taskSummary } = require('./presentation.cjs');
const { summaryKey } = require('./summary-key.cjs');
const { compareCards, projectStatus } = require('./status-contract.cjs');
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
function conversation(observed=[],owned=[]) {
  const messages=observed.map(message=>({...message})),matched=new Set();
  for(const message of owned) {
    const index=messages.findIndex((previous,i)=>!matched.has(i)&&
      (message.id&&previous.id?message.id===previous.id:
        previous.role===message.role&&previous.text===message.text&&Math.abs((previous.at||0)-(message.at||0))<=5));
    if(index<0){messages.push(message);matched.add(messages.length-1);continue;}
    matched.add(index);const previous=messages[index];
    messages[index]={...previous,...message,images:[...new Map([...(previous.images||[]),...(message.images||[])].map(image=>[typeof image==='string'?image:image.path,image])).values()].slice(0,4)};
  }
  return messages.sort((a,b)=>(a.at||0)-(b.at||0)).slice(-12);
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
    this.ownedThreads = new Set();
    this.summaries = new Map();
    this.summaryStates = new Map();
    this.aiSummary = { enabled: false, cached: 0, pending: 0, message: '' };
    // A crash must offer a retry, never create a second chat automatically.
    for (const task of this.state.tasks)
      if (
        ['starting', 'working'].includes(task.status) ||
        (task.status === 'needs' && !(task.completedAt && task.notificationVersion === task.turnId))
      ) {
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
  setSummaries(values, status, states = new Map()) {
    this.summaries = values;
    this.summaryStates = states;
    this.aiSummary = status;
    this.emit('change', this.snapshot());
  }
  presentation(source) {
    return this.state.settings.aiSummaries === true
      ? this.summaries.get(summaryKey(source))
      : undefined;
  }
  summaryState(source) {
    if (this.state.settings.aiSummaries !== true) return 'disabled';
    const key = summaryKey(source);
    return this.summaries.has(key) ? 'cached' : this.summaryStates.get(key) || 'recorded';
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
      const display = [...sources].sort((a, b) => compareCards(
        { ...a, ...inferAttention(a.body, a.status) }, { ...b, ...inferAttention(b.body, b.status) },
      ))[0];
      const state = this.cardState(id);
      const taskTitle = display.taskTitle || 'Current task unavailable';
      const presentation = this.presentation(display);
      const key = id + ':' + hash(taskTitle.toLowerCase());
      const fp = [...sources]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((s) => s.id + ':' + s.fingerprint)
        .join('|');
      const status = state.manual && state.manual !== 'auto' ? state.manual : display.status;
      const inferred = inferAttention(display.body, status);
      const waitingOn =
        state.manual && state.manual !== 'auto'
          ? status === 'needs'
            ? { kind: 'you', name: '' }
            : state.waitingOn || { kind: 'unknown', name: '' }
          : inferred.waitingOn;
      const urgent =
        state.priority === 'urgent' || (state.priority !== 'normal' && inferred.urgent);
      return {
        id,
        taskKey: key,
        title: presentation?.title || taskTitle,
        chatName: display.title,
        groupName: sources.length > 1 ? name : '',
        summary:
          presentation?.summary ||
          shortSummary(display.summary || display.body) ||
          'No recorded update yet.',
        summaryOrigin: presentation ? 'ai' : 'recorded',
        summaryState: this.summaryState(display),
        device: device(display.device || this.feed.device),
        primarySourceId: display.id,
        kind: 'observed',
        manual: state.manual || 'auto',
        status,
        waitingOn,
        urgent,
        priority: state.priority || 'auto',
        label: statusLabel(status, waitingOn),
        at: display.notificationAt || display.updatedAt,
        fingerprint: fp,
        readyForReview: display.readyForReview,
        sources: sources.map((s) => ({
          id: s.id,
          title: s.title,
          taskTitle: this.presentation(s)?.title || s.taskTitle || '',
          summary: this.presentation(s)?.summary || shortSummary(s.summary || s.body),
          device: device(s.device || this.feed.device),
          body: s.body || '',
          conversation: s.conversation || [],
          conversationLoaded: !!s.conversationLoaded,
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
    for (const task of this.state.tasks) {
      const observed = this.feed.threads.find((s) => s.id === task.threadId);
      if (
        observed?.contextLoaded &&
        !this.ownedThreads.has(task.threadId) &&
        !this.busy.has(task.id) &&
        !['queued', 'starting', 'done'].includes(task.status)
      ) {
        const card = make(task.id, observed.title, [observed]);
        card.sources = card.sources.map(source=>({...source,
          conversation:conversation(source.conversation,task.messages),
          conversationLoaded:source.conversationLoaded||!!task.messages?.length}));
        result.push({
          ...card,
          taskKey: task.id,
          threadId: task.threadId,
          messages: [],
          notificationVersion: observed.fingerprint,
          replyError: task.error ? 'Reply connection: ' + taskSummary(task) : '',
          reviewed:
            task.reviewedVersion === observed.fingerprint ||
            (!!observed.turnId && task.reviewedVersion === observed.turnId),
          snoozed: task.snoozedUntil > now(),
          snoozedUntil: task.snoozedUntil || 0,
        });
        continue;
      }
      const summary = taskSummary(
        task,
        [...this.approvals.values()].find((r) => r.taskId === task.id),
      );
      const sourceDevice = device(
        task.device || (observed && (observed.device || this.feed.device)),
      );
      const presentation =
        task.completedAt && task.turnId === observed?.turnId ? this.presentation(observed) : null;
      result.push({
        ...task,
        title: presentation?.title || observed?.taskTitle || task.title,
        chatName: observed?.title || (task.threadId ? task.title : 'New chat'),
        summary: presentation?.summary || summary,
        summaryOrigin: presentation ? 'ai' : 'recorded',
        summaryState: task.turnId === observed?.turnId ? this.summaryState(observed) :
          this.state.settings.aiSummaries === true ? 'recorded' : 'disabled',
        device: sourceDevice,
        primarySourceId: task.threadId,
        kind: 'local',
        taskKey: task.id,
        ...inferAttention(
          task.messages?.filter((m) => m.role === 'assistant').at(-1)?.text,
          task.status,
        ),
        urgent:
          this.cardState(task.id).priority === 'urgent' ||
          (this.cardState(task.id).priority !== 'normal' &&
            inferAttention(
              task.messages?.filter((m) => m.role === 'assistant').at(-1)?.text,
              task.status,
            ).urgent),
        priority: this.cardState(task.id).priority || 'auto',
        label: statusLabel(
          task.status,
          inferAttention(
            task.messages?.filter((m) => m.role === 'assistant').at(-1)?.text,
            task.status,
          ).waitingOn,
        ),
        at: task.updatedAt || task.createdAt,
        sources: task.threadId
          ? [
              {
                id: task.threadId,
                title: observed?.title || task.title,
                taskTitle: observed?.taskTitle || task.title,
                summary,
                device: sourceDevice,
                body: task.messages?.filter((m) => m.role === 'assistant').at(-1)?.text || '',
                conversation: conversation(observed?.conversation,task.messages),
                conversationLoaded: observed?.conversationLoaded || !!task.messages?.length,
                contextLoaded: true,
                cwd: task.cwd,
                lifecycle: task.status,
              },
            ]
          : [],
        readyForReview:
          task.status === 'ready' ||
          !!(task.completedAt && task.notificationVersion === task.turnId),
        reviewed: task.reviewedVersion === task.notificationVersion,
        snoozed: task.snoozedUntil > now(),
        done: task.status === 'done',
      });
    }
    return result.map(card => projectStatus(card, {
      health: this.health, collectedAt: this.feed.collectedAt,
      live: card.kind === 'local' && this.ownedThreads.has(card.threadId),
    })).sort(compareCards);
  }
  snapshot() {
    const cards = this.cards();
    return {
      cards,
      done: Object.values(this.state.done),
      monitoredCount: this.feed.monitoredCount || this.feed.threads.length,
      collectedAt: this.feed.collectedAt,
      health: this.health,
      aiSummary: this.aiSummary,
      settings: this.state.settings,
      groups: this.state.groups,
      queued: cards.filter((c) => c.status === 'queued' && !c.done).length,
      ready: cards.filter((c) => c.readyForReview && !c.done && !c.reviewed && !c.snoozed).length,
      working: cards.filter((c) => c.status === 'working' && !c.done).length,
      undo: !!this.undo,
      approvals: [...this.approvals.values()].map(({ reply, ...safe }) => safe),
    };
  }
  get(id, expectedTaskKey) {
    const card = this.state.done[id] || this.cards().find((c) => c.id === id || c.taskKey === id);
    if (!card) throw new Error('This task is no longer in the queue.');
    if (expectedTaskKey && card.taskKey !== expectedTaskKey)
      throw new Error('This task changed. Return to the queue and open its latest update.');
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
      device: executionDevice(),
    };
    this.state.tasks.push(task);
    this.save();
    return task;
  }
  action(id, action, expectedTaskKey) {
    const card = this.get(id, expectedTaskKey);
    id = card.id;
    const task = this.state.tasks.find((t) => t.id === id);
    if (
      action === 'done' &&
      (['working', 'starting'].includes(card.status) ||
        (card.status === 'needs' && !card.readyForReview))
    )
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
    if (action.startsWith('priority:')) {
      const priority = action.slice(9);
      if (!['auto', 'urgent', 'normal'].includes(priority))
        throw new Error('Choose a supported priority.');
      this.state.cards[id] = { ...this.cardState(id), priority };
    } else if (action.startsWith('owner:')) {
      if (task) throw new Error('The current chat controls its waiting status.');
      const owner = text(action.slice(6), 80);
      if (!owner) throw new Error('Name the person or team you are waiting on.');
      this.state.cards[id] = {
        ...this.cardState(id),
        manual: 'waiting',
        waitingOn: { kind: 'other', name: owner },
      };
    } else if (action.startsWith('status:')) {
      const manual = action.slice(7);
      if (task || !['auto', 'needs', 'waiting', 'blocked', 'working'].includes(manual))
        throw new Error('Choose a supported chat status.');
      this.state.cards[id] = {
        ...this.cardState(id),
        manual,
        waitingOn: manual === 'needs' ? { kind: 'you', name: '' } : { kind: 'unknown', name: '' },
      };
    } else if (action === 'done') {
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
      if (task) task.reviewedVersion = card.notificationVersion || task.notificationVersion;
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
    if (this.undo?.groups) {
      this.state.groups = this.undo.groups;
      this.undo = null;
      this.save();
      return this.snapshot();
    }
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
  message(id, role, value, messageId, images=[]) {
    const task = this.state.tasks.find((t) => t.id === id);
    if (!task) return;
    const key = messageId || crypto.randomUUID();
    let msg = task.messages.find((m) => m.id === key);
    if (!msg) {
      msg = { id: key, role, text: '', at: now() };
      task.messages.push(msg);
    }
    msg.text = value.slice(0, 16000);
    if(images.length)msg.images=images;
    task.messages = task.messages.slice(-60);
    this.save();
  }
  group(input) {
    const before = structuredClone(this.state.groups),
      existing = this.state.groups.find((g) => g.id === input.id);
    if (input.action === 'remove') {
      if (!existing) throw new Error('This group no longer exists.');
      this.state.groups = this.state.groups.filter((g) => g.id !== input.id);
    } else {
      const title = text(input.title, 100);
      if (!title || !Array.isArray(input.ids))
        throw new Error('Name the group and select at least two chats.');
      const ids = [...new Set(input.ids)];
      const owned = new Set(this.state.tasks.map((t) => t.threadId));
      if (
        ids.length < 2 ||
        ids.length > 80 ||
        ids.some((id) => owned.has(id) || !this.feed.threads.some((t) => t.id === id))
      )
        throw new Error('Select between 2 and 80 existing Codex chats.');
      if (input.id && !existing) throw new Error('This group no longer exists.');
      const group = { id: existing?.id || 'group:' + crypto.randomUUID(), title, threads: ids };
      this.state.groups = this.state.groups
        .filter((g) => g.id !== group.id)
        .map((g) => ({ ...g, threads: g.threads.filter((id) => !ids.includes(id)) }))
        .filter((g) => g.threads.length > 1);
      this.state.groups.push(group);
    }
    this.undo = { groups: before };
    this.save();
    return this.snapshot();
  }
}
module.exports = { Queue, atomic, read, now, text, hash };
