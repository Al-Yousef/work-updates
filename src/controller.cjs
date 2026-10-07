'use strict';
const {admission:checkDeadline}=require('./dispatch-deadline.cjs');
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
  constructor(queue, client, options = {}) {
    super();
    this.queue = queue;
    this.client = client;
    this.desktop = options.desktop;
    this.completedTurns = new Set();
    this.awaitingAcceptance = new Map();
    this.log = options.log;
    client.on('created', ({ taskId, threadId }) => {
      queue.ownedThreads.add(threadId);
      queue.patch(taskId, { threadId });
    });
    client.on('loaded', ({ threadId }) => queue.ownedThreads.add(threadId));
    client.on('notification', (m) => this.event(m));
    client.on('request', (m) => this.request(m));
    client.on('disconnected', (details) => {
      for (const threadId of details?.threadIds || queue.ownedThreads)
        queue.ownedThreads.delete(threadId);
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
  rememberCompletion(threadId, turnId) {
    const key = threadId + '\0' + turnId;
    this.completedTurns.add(key);
    if (this.completedTurns.size > 200)
      this.completedTurns.delete(this.completedTurns.values().next().value);
  }
  acceptTurn(task, turnId, fields = {}) {
    const pending = this.awaitingAcceptance.get(task.id);
    this.awaitingAcceptance.delete(task.id);
    this.queue.patch(task.id, { ...fields, turnId, presentationGapTurnId: '' });
    if (pending?.overflow) {
      this.queue.patch(task.id, {
        status: 'blocked',
        presentationGapTurnId: turnId,
        error: 'Codex accepted this pass, but its updates could not be reconstructed. Open the source chat to check progress.',
      });
      return;
    }
    for (const message of pending?.events || []) {
      const eventTurnId = message.params.turn?.id || message.params.turnId;
      if (eventTurnId === turnId) this.event(message);
      else if (message.method === 'turn/completed')
        this.rememberCompletion(message.params.threadId, eventTurnId);
    }
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
      this.awaitingAcceptance.set(id, { events: [] });
      const result = await this.client.start(task, cwd);
      q.ownedThreads.add(result.threadId);
      this.acceptTurn(task, result.turnId, {
        ...result, ...(task.status === 'starting' ? { status: 'working' } : {}),
      });
      return task;
    } catch (error) {
      q.patch(id, { status: 'blocked', error: error.message });
      throw error;
    } finally {
      this.awaitingAcceptance.delete(id);
      q.busy.delete(id);
    }
  }
  async send(id, input, sourceId, expectedTaskKey, options = {}) {
    const card=this.queue.get(id,expectedTaskKey),source=card.sources.length?taskSource(card,sourceId):null;
    const correlation={messageId:options.messageId,sourceId:source?.id,cardId:card.id,taskKey:card.taskKey};
    const run=()=>this.sendBound(id,input,sourceId,expectedTaskKey,options);
    return this.log?.scope?this.log.scope(correlation,run):run();
  }
  async sendBound(id, input, sourceId, expectedTaskKey, options = {}) {
    checkDeadline(options);
    const q = this.queue,
      card = q.get(id, expectedTaskKey),
      value = text(input, 12000);
    const images=options.images||[];
    if (!value&&!images.length) throw new Error('Write a message or attach an image first.');
    if (card.done) throw new Error('Reopen this task before sending another message.');
    const source = card.sources.length ? taskSource(card, sourceId) : null;
    const lock = source?.id || id;
    if (q.busy.has(lock)) throw new Error('A message is already being sent.');
    let task = q.state.tasks.find((t) => t.id === id || t.threadId === source?.id);
    if (task && !task.threadId) throw new Error('Start this task before sending a message.');
    if ([...q.approvals.values()].some((r) => r.taskId === id))
      throw new Error('Answer the pending request before sending another message.');
    if (!source) throw new Error('Choose a source chat.');
    if (!this.desktop && !q.ownedThreads.has(source.id) && source.lifecycle === 'working')
      throw new Error('This chat is working in Codex. Open it there to steer the current pass.');
    if (task && q.busy.has(task.id)) throw new Error('A message is already being sent.');
    q.busy.add(lock);
    if (task) q.busy.add(task.id);
    let dispatchStarted = false;
    const started=Date.now();
    this.log?.write('dispatch.bound',{messageId:options.messageId,sourceId:source.id,cardId:card.id,taskKey:card.taskKey,phase:'ownership-discovery'});
    try {
      if (this.desktop && !q.ownedThreads.has(source.id)) {
        // Ask the existing desktop owner to submit the reply. Observed chats
        // remain observed; do not create a local task or claim their writer.
        const owner = await this.desktop.owner(source.id);
        checkDeadline(options);
        if (owner) {
          this.log?.write('dispatch.owner',{owner:'desktop',ownerId:owner,route:'desktop'});
          dispatchStarted = true;
          const receipt=await this.desktop.send(source.id, value, {
            owner, working: source.lifecycle === 'working', messageId: options.messageId, images,expiresAt:options.expiresAt,beforeDispatch:options.beforeDispatch,
          });
          if(task?.error)q.patch(task.id,{error:''});
          this.log?.write('dispatch.accepted',{route:'desktop',turnId:receipt.turnId,delivery:receipt.delivery,elapsedMs:Date.now()-started});
          return receipt;
        }
        if (source.lifecycle === 'working')
          throw new Error('Codex is working in this chat. Queue the reply or open its chat.');
      }
      // Resume must succeed before an observed chat becomes an app-owned task.
      // A writer-lock rejection leaves its update and context intact.
      if (this.client.prepare) await this.client.prepare(source.id);
      checkDeadline(options);
      this.log?.write('dispatch.owner',{owner:'app-server',route:'app-server'});
      if (!task) {
        task = q.create({ title: card.title, prompt: value, cwd: source.cwd });
        q.patch(task.id, { threadId: source.id, adopted: true,adoptedTaskKey:card.taskKey });
        if (source.body) q.message(task.id, 'assistant', source.body);
      }
      q.ownedThreads.add(source.id);
      q.busy.add(task.id);
      q.message(task.id, 'user', value, options.messageId, images);
      q.patch(task.id, {
        status: 'working',
        error: '',
        reviewedVersion: '',
        device: executionDevice(),
      });
      dispatchStarted = true;
      this.awaitingAcceptance.set(task.id, { events: [] });
      const result = await this.client.send(task.threadId, value, images,{messageId:options.messageId,expiresAt:options.expiresAt,beforeDispatch:options.beforeDispatch});
      const turnId=result?.turn?.id||result?.turnId;
      if(typeof turnId!=='string'||!turnId.trim())throw Object.assign(new Error('Codex did not return an acceptance receipt. Check the chat before retrying.'),{code:'DELIVERY_RECEIPT',delivery:'uncertain'});
      // Acceptance may precede turn/started. Bind presentation to the same
      // authoritative turn immediately; preserve a completion already seen.
      this.acceptTurn(task, turnId);
      this.log?.write('dispatch.accepted',{route:'app-server',turnId,delivery:'sent',elapsedMs:Date.now()-started});
      return { taskId: task.id, messageId: options.messageId, delivery: 'sent', route: 'app-server',
        turnId };
    } catch (error) {
      if (!dispatchStarted) {
        error.delivery = 'not-sent';
        error.phase ||= 'preparing-chat';
      }
      if (task) {
        q.patch(task.id, { status: 'blocked', error: error.message });
        error.taskId = task.id;
      }
      this.log?.write('dispatch.failed',{code:error.code,phase:error.phase,delivery:error.delivery,message:error.message,elapsedMs:Date.now()-started});
      throw error;
    } finally {
      if (task) this.awaitingAcceptance.delete(task.id);
      if (task) q.busy.delete(task.id);
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
    if (method === 'thread/closed') {
      q.ownedThreads.delete(p.threadId);
      q.save();
      return;
    }
    if (!task) return;
    q.ownedThreads.add(p.threadId);
    const pending = this.awaitingAcceptance.get(task.id);
    if (pending && ['turn/started', 'turn/completed', 'item/agentMessage/delta', 'item/completed'].includes(method)) {
      if (pending.events.length >= 200) pending.overflow = true;
      else if (method === 'turn/started' || method === 'turn/completed')
        pending.events.push({ method, params: {
          threadId: p.threadId,
          turn: { id: p.turn?.id, status: p.turn?.status, error: p.turn?.error ? { message: String(p.turn.error.message || '').slice(0, 1000) } : undefined },
        } });
      else if (method === 'item/agentMessage/delta')
        pending.events.push({ method, params: {
          threadId: p.threadId, turnId: p.turnId, itemId: p.itemId, delta: String(p.delta || '').slice(0, 16000),
        } });
      else if (p.item?.type === 'agentMessage')
        pending.events.push({ method, params: {
          threadId: p.threadId, turnId: p.turnId,
          item: { id: p.item.id, type: 'agentMessage', text: String(p.item.text || '').slice(0, 16000) },
        } });
      return;
    }
    const turnId = p.turn?.id || p.turnId;
    const turnKey = p.threadId + '\0' + turnId;
    if (task.presentationGapTurnId && turnId === task.presentationGapTurnId &&
      ['turn/started', 'turn/completed', 'item/agentMessage/delta', 'item/completed'].includes(method)) return;
    if (method === 'turn/completed') {
      this.rememberCompletion(p.threadId, turnId);
    }
    // A chat may carry delayed notifications from an earlier pass. They must
    // not replace the current answer, clear its requests or announce readiness.
    if (
      turnId && task.turnId && turnId !== task.turnId &&
      ['turn/started', 'turn/completed', 'item/agentMessage/delta', 'item/completed'].includes(method)
    ) return;
    if (method === 'turn/started') {
      if (this.completedTurns.has(turnKey) || task.notificationVersion === turnId) return;
      q.patch(task.id, { status: task.status === 'done' ? 'done' : 'working', turnId: p.turn.id, error: '' });
    } else if (method === 'item/agentMessage/delta') {
      const current = task.messages.find((m) => m.id === p.itemId);
      q.message(task.id, 'assistant', (current?.text || '') + (p.delta || ''), p.itemId);
    } else if (method === 'item/completed' && p.item?.type === 'agentMessage')
      q.message(task.id, 'assistant', p.item.text || '', p.item.id);
    else if (method === 'turn/completed') {
      if (task.completedAt && task.notificationVersion === turnId) return;
      const latest = task.messages.filter((m) => m.role === 'assistant').at(-1)?.text || '';
      const status = p.turn.status === 'completed' ? statusFromText(latest) : 'blocked';
      const done = task.status === 'done';
      q.patch(task.id, {
        status: done ? 'done' : status,
        ...inferAttention(latest, status),
        notificationVersion: p.turn.id,
        turnOutcome: ['completed','failed','interrupted'].includes(p.turn.status)?p.turn.status:'failed',
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
