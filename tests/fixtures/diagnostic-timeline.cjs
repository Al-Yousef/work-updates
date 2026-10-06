'use strict';
const crypto = require('node:crypto'),
  path = require('node:path');
const { EventEmitter } = require('node:events');
const { Queue } = require('../../src/queue.cjs');
const { Controller } = require('../../src/controller.cjs');
const { Messages } = require('../../src/messages.cjs');
const { DiagnosticLog } = require('../../src/diagnostics.cjs');
async function seed(directory) {
  const log = new DiagnosticLog(path.join(directory, 'logs'), {
    protectedDirectory: directory,
    metadata: { version: '0.6.9', nativeProtocol: 'work-updates-native-v1', snapshotProtocol: 1 },
  });
  log.setContext({ deviceId: 'fixture-device' });
  const q = new Queue(directory),
    sourceId = '10000000-0000-4000-8000-000000000001';
  q.setFeed({
    collectedAt: Date.now() / 1000,
    threads: [
      {
        id: sourceId,
        title: 'Synthetic chat',
        taskTitle: 'Synthetic task',
        fingerprint: 'fixture-revision',
        status: 'ready',
        lifecycle: 'completed',
        contextLoaded: true,
        updatedAt: Date.now() / 1000,
        body: 'PRIVATE_FIXTURE_ANSWER',
        device: { kind: 'pc' },
      },
    ],
  });
  const client = new EventEmitter();
  client.close = () => {};
  let scenario;
  client.prepare = async () => {
    if (scenario === 'resume-timeout')
      throw Object.assign(new Error('Synthetic resume timeout'), { code: 'CODEX_TIMEOUT' });
    if (scenario === 'writer-lock')
      throw Object.assign(new Error('already has an active writer'), { code: -32600 });
  };
  client.send = async () => {
    throw Object.assign(new Error('Synthetic lost receipt'), {
      code: 'CODEX_TIMEOUT',
      phase: 'awaiting-receipt',
      delivery: 'uncertain',
    });
  };
  const controller = new Controller(q, client, { log }),
    messages = new Messages(q, controller, { auto: false, log });
  const intents = [];
  try {
    for (scenario of ['resume-timeout', 'writer-lock', 'lost-receipt']) {
      const card = q.cards().find((c) => c.sources.some((s) => s.id === sourceId)),
        messageId = crypto.randomUUID();
      intents.push({ scenario, messageId });
      try {
        await messages.send({
          id: card.id,
          taskKey: card.taskKey,
          sourceId,
          messageId,
          text: 'PRIVATE_FIXTURE_PROMPT',
        });
        throw new Error('Fixture unexpectedly dispatched successfully');
      } catch (error) {
        if (error.message === 'Fixture unexpectedly dispatched successfully') throw error;
      }
    }
  } finally {
    messages.close();
    client.close();
  }
  return { log, queue: q, intents, sourceId };
}
module.exports = { seed };
