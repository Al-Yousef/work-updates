'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { now, text } = require('./queue.cjs');
const { inferAttention } = require('./attention.cjs');
const { taskSource } = require('./task-source.cjs');
const { executionDevice } = require('./presentation.cjs');
function statusFromText(value) {
  if (inferAttention(value).waitingOn.kind === 'you') return 'needs';
  if (/\b(remaining blocker|still blocked|blocked by|blocked until|blocked on)\b/i.test(value))
    return 'blocked';
  if (
    /\b(awaiting|waiting for|waiting on)\b/i.test(value) &&
    !/\b(not|no longer) (awaiting|waiting)\b/i.test(value)
  )
    return 'waiting';
  return 'ready';
}
class Controller extends EventEmitter {
  constructor(queue, client) {
    super();
    this.queue = queue;
    this.client = client;
    client.on('created', ({ taskId, threadId }) => queue.patch(taskId, { threadId }));
    client.on('notification', (m) => this.event(m));
    client.on('request', (m) => this.request(m));
    client.on('disconnected', (details) => {
      for (const t of queue.state.tasks)
        if (
          ['working', 'starting', 'needs'].includes(t.status) &&
          (!details?.threadIds || details.threadIds.includes(t.threadId))
        )
          queue.patch(t.id, {
            status: 'blocked',
            error:
              details?.message ||
              'Codex disconnected. Open chat to check its progress before retrying.',
          });
      for (const [id, request] of queue.approvals) {
        const task = queue.state.tasks.find((t) => t.id === request.taskId);
        if (!details?.threadIds || details.threadIds.includes(task?.threadId))
          queue.approvals.delete(id);
      }
      queue.save();
    });
  }
  taskFor(threadId) {
    return this.queue.state.tasks.find((t) => t.threadId === threadId);
  }
  async start(id) {
    const q = this.queue,
      task = q.state.tasks.find((t) => t.id === id);
    if (!task) throw new Error('Queue a task first.');
    if (q.busy.has(id) || ['starting', 'working', 'needs'].includes(task.status)) return task;
    if (task.status === 'done') throw new Error('Reopen this task before starting it.');
    q.busy.add(id);
    const cwd = task.cwd || path.join(q.directory, 'tasks', task.id);
    try {
      fs.mkdirSync(cwd, { recursive: true });
      q.patch(id, { status: 'starting', cwd, error: '', device: executionDevice() });
      if (!task.messages.some((m) => m.role === 'user')) q.message(id, 'user', task.prompt);
      const result = await this.client.start(task, cwd);
      q.patch(id, { ...result, ...(task.status === 'starting' ? { status: 'working' } : {}) });
      return task;
    } catch (error) {
      q.patch(id, { status: 'blocked', error: error.message });
      throw error;
    } finally {
      q.busy.delete(id);
    }
  }
  async send(id, input, sourceId, expectedTaskKey) {
    const q = this.queue,
      card = q.get(id, expectedTaskKey),
      value = text(input, 12000);
    if (!value) throw new Error('Write a message first.');
    if (card.done) throw new Error('Reopen this task before sending another message.');
    const source = card.sources.length ? taskSource(card, sourceId) : null;
    const lock = source?.id || id;
    if (q.busy.has(lock)) throw new Error('A message is already being sent.');
    let task = q.state.tasks.find((t) => t.id === id || t.threadId === source?.id);
    if (task && !task.threadId) throw new Error('Start this task before sending a message.');
    if ([...q.approvals.values()].some((r) => r.taskId === id))
      throw new Error('Answer the pending request before sending another message.');
    if (!task) {
      if (!source) throw new Error('Choose a source chat.');
      if (source.lifecycle === 'working')
        throw new Error('This chat is working in Codex. Open it there to steer the current pass.');
      task = q.create({ title: card.title, prompt: value, cwd: source.cwd });
      q.patch(task.id, { threadId: source.id, adopted: true });
      if (source.body) q.message(task.id, 'assistant', source.body);
    }
    if (q.busy.has(task.id)) throw new Error('A message is already being sent.');
    q.busy.add(task.id);
    q.busy.add(lock);
    q.message(task.id, 'user', value);
    q.patch(task.id, {
      status: 'working',
      error: '',
      reviewedVersion: '',
      device: executionDevice(),
    });
    try {
      await this.client.send(task.threadId, value);
      return { taskId: task.id };
    } catch (error) {
      q.patch(task.id, { status: 'blocked', error: error.message });
      error.taskId = task.id;
      throw error;
    } finally {
      q.busy.delete(task.id);
      q.busy.delete(lock);
    }
  }
  async stop(id) {
    const task = this.queue.state.tasks.find((t) => t.id === id);
    if (!task?.threadId) throw new Error('There is no running chat for this task.');
    await this.client.stop(task.threadId);
  }
  event({ method, params: p }) {
    p ||= {};
    const q = this.queue,
      task = this.taskFor(p.threadId);
    if (!task) return;
    if (method === 'turn/started')
      q.patch(task.id, { status: 'working', turnId: p.turn.id, error: '' });
    else if (method === 'item/agentMessage/delta') {
      const current = task.messages.find((m) => m.id === p.itemId);
      q.message(task.id, 'assistant', (current?.text || '') + (p.delta || ''), p.itemId);
    } else if (method === 'item/completed' && p.item?.type === 'agentMessage')
      q.message(task.id, 'assistant', p.item.text || '', p.item.id);
    else if (method === 'turn/completed') {
      const latest = task.messages.filter((m) => m.role === 'assistant').at(-1)?.text || '';
      const status = p.turn.status === 'completed' ? statusFromText(latest) : 'blocked';
      const done = task.status === 'done';
      q.patch(task.id, {
        status: done ? 'done' : status,
        ...inferAttention(latest, status),
        notificationVersion: p.turn.id,
        completedAt: now(),
        error:
          p.turn.error?.message ||
          (p.turn.status === 'interrupted' ? 'This pass was stopped.' : ''),
      });
      for (const [id, request] of q.approvals)
        if (request.taskId === task.id) q.approvals.delete(id);
      q.save();
      if (!done)
        this.emit('attention', {
          key: p.turn.id,
          status,
          title: task.title,
          ...inferAttention(latest, status),
        });
    } else if (method === 'serverRequest/resolved') {
      q.approvals.delete(String(p.requestId));
      q.save();
    }
  }
  request(message) {
    const q = this.queue,
      p = message.params || {},
      task = this.taskFor(p.threadId);
    if (!task) {
      this.client.reject(message.id);
      return;
    }
    const kinds = {
      'item/commandExecution/requestApproval': 'command',
      'item/fileChange/requestApproval': 'files',
      'item/tool/requestUserInput': 'question',
      'item/permissions/requestApproval': 'permissions',
    };
    const kind = kinds[message.method];
    if (!kind) {
      this.client.reject(message.id);
      q.patch(task.id, {
        status: 'blocked',
        error: 'This Codex request is not supported here yet. Open the source chat in Codex.',
      });
      return;
    }
    const request = {
      id: String(message.id),
      taskId: task.id,
      kind,
      title: task.title,
      reason: p.reason || '',
      command: p.command || '',
      cwd: p.cwd || '',
      questions: p.questions || [],
      permissions: p.permissions || {},
      grantRoot: p.grantRoot || '',
      reply: (result) => this.client.reply(message.id, result),
    };
    q.approvals.set(request.id, request);
    q.patch(task.id, { status: 'needs' });
    this.emit('attention', { key: 'approval:' + request.id, status: 'needs', title: task.title });
  }
  respond(id, decision, answers) {
    const q = this.queue,
      request = q.approvals.get(String(id));
    if (!request) throw new Error('This request has already been resolved.');
    if (request.kind === 'question') {
      if (!answers || typeof answers !== 'object') throw new Error('Answer the question first.');
      const out = {};
      for (const question of request.questions) {
        const value = text(answers[question.id] || '', 4000);
        if (!value) throw new Error('Answer each question.');
        out[question.id] = { answers: [value] };
      }
      request.reply({ answers: out });
    } else if (request.kind === 'permissions') {
      if (!['accept', 'decline'].includes(decision)) throw new Error('Choose Allow once or Deny.');
      request.reply({
        permissions: decision === 'accept' ? request.permissions : {},
        scope: 'turn',
      });
    } else {
      if (!['accept', 'decline', 'cancel'].includes(decision))
        throw new Error('Choose Allow once or Deny.');
      request.reply({ decision });
    }
    q.approvals.delete(request.id);
    q.patch(request.taskId, { status: 'working' });
    return q.snapshot();
  }
}
module.exports = { Controller, statusFromText };
