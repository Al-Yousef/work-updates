'use strict';
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { now } = require('./queue.cjs');
const { executionDevice } = require('./presentation.cjs');
function feed() {
  return {
    device: executionDevice(),
    monitoredCount: 3,
    collectedAt: now(),
    threads: [
      {
        id: '10000000-0000-4000-8000-000000000001',
        title: 'Launch planning',
        taskTitle: 'Review launch notes',
        body: 'Urgent action: review the launch notes. The draft includes the release summary and the remaining review checklist.',
        status: 'ready',
        label: 'Ready to review',
        fingerprint: 'sample-launch',
        readyForReview: true,
        contextLoaded: true,
        completedAt: now() - 180,
        updatedAt: now() - 180,
        notificationAt: now() - 180,
        lifecycle: 'completed',
      },
      {
        id: '10000000-0000-4000-8000-000000000002',
        title: 'Desktop app',
        taskTitle: 'Check installer behavior',
        body: 'Waiting on the reviewer to confirm the installer results. Preferences survived the upgrade checks.',
        status: 'waiting',
        label: 'Waiting on reviewer',
        fingerprint: 'sample-installer',
        readyForReview: false,
        contextLoaded: true,
        updatedAt: now() - 60,
        notificationAt: now() - 60,
        lifecycle: 'completed',
      },
      {
        id: '10000000-0000-4000-8000-000000000003',
        title: 'Interface review',
        taskTitle: 'Choose the compact layout',
        body: 'Need your choice between the compact and expanded queue. Both previews are ready.',
        status: 'needs',
        label: 'Needs you',
        fingerprint: 'sample-layout',
        readyForReview: true,
        contextLoaded: true,
        completedAt: now() - 360,
        updatedAt: now() - 360,
        notificationAt: now() - 360,
        lifecycle: 'completed',
      },
    ],
  };
}
class DemoCodex extends EventEmitter {
  constructor() {
    super();
    this.active = new Map();
    this.timers = new Map();
  }
  async start(task) {
    const threadId = task.threadId || crypto.randomUUID();
    this.emit('created', { taskId: task.id, threadId });
    return this.send(threadId, task.prompt);
  }
  async send(threadId) {
    const id = crypto.randomUUID();
    this.active.set(threadId, id);
    this.emit('notification', { method: 'turn/started', params: { threadId, turn: { id } } });
    const timer=setTimeout(() => {
      this.timers.delete(threadId);
      if(this.active.get(threadId)!==id)return;
      this.emit('notification', {
        method: 'item/completed',
        params: {
          threadId,
          item: {
            id: 'sample-' + id,
            type: 'agentMessage',
            text: 'This is a demo conversation. The requested sample task is ready for review.',
          },
        },
      });
      this.active.delete(threadId);
      this.emit('notification', {
        method: 'turn/completed',
        params: { threadId, turn: { id, status: 'completed' } },
      });
    }, 500);
    this.timers.set(threadId,timer);
    return { threadId, turn: { id }, turnId: id };
  }
  async stop(threadId,expectedTurnId=this.active.get(threadId)) {
    const id = this.active.get(threadId);
    if(!id||id!==expectedTurnId)throw Object.assign(new Error('The exact demo turn is unavailable'),{delivery:'not-sent'});
    clearTimeout(this.timers.get(threadId));this.timers.delete(threadId);
    this.emit('notification', {
      method: 'turn/completed',
      params: { threadId, turn: { id, status: 'interrupted' } },
    });
    this.active.delete(threadId);
    return {sourceId:threadId,turnId:id,delivery:'interrupt_requested'};
  }
  reply() {}
  reject() {}
  close() {for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();this.active.clear();}
}
function startDemoObserver(queue,{initial=feed(),clock=now,intervalMs=5000}={}) {
  queue.setFeed(initial,{ok:true,synthetic:true});
  let stopped=false;
  const pulse=()=>{if(!stopped)queue.setFeed({...queue.feed,collectedAt:clock()},{ok:true,synthetic:true});};
  const timer=setInterval(pulse,intervalMs);timer.unref?.();
  return {pid:null,request:pulse,close:()=>{stopped=true;clearInterval(timer);}};
}
module.exports = { feed, DemoCodex, startDemoObserver };
