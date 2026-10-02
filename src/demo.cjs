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
    setTimeout(() => {
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
    return { threadId, turn: { id }, turnId: id };
  }
  async stop(threadId) {
    const id = this.active.get(threadId);
    this.emit('notification', {
      method: 'turn/completed',
      params: { threadId, turn: { id, status: 'interrupted' } },
    });
    this.active.delete(threadId);
  }
  reply() {}
  reject() {}
  close() {}
}
module.exports = { feed, DemoCodex };
