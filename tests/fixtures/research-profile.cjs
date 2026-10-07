'use strict';
const crypto = require('node:crypto'),
  { Research } = require('../../src/research.cjs'),
  { currentScope } = require('../../src/responsibility-target.cjs');
function fixture() {
  const f = require('./authorization-profile.cjs').fixture();
  let clock = Date.now(),
    reads = 0,
    storeId = crypto.createHash('sha256').update(f.directory).digest('hex'),
    preferences = {};
  const records = [
      {
        id: crypto.createHash('sha256').update('original-request').digest('hex'),
        role: 'user',
        text: 'Review the synthetic result before calling the task complete',
        at: Math.floor(clock / 1000) - 10,
        truncated: false,
      },
    ],
    requests = [];
  const reader = {
    storeId: () => storeId,
    read: async (request) => {
      request.beforeRead();
      reads++;
      requests.push(request);
      const included = records
        .filter((r) => r.at >= request.since && r.at <= request.until)
        .slice(-request.limit);
      return {
        schema: 1,
        threadId: request.scope.sourceId,
        storeId,
        requestNonce: request.nonce,
        since: request.since,
        until: request.until,
        capturedAt: clock / 1000,
        records: structuredClone(included),
        coverage: {
          exhaustive: false,
          candidateRecords: included.length,
          includedRecords: included.length,
          bytesRead: 100,
          byteLimit: 4194304,
          recordLimit: request.limit,
          skippedRecords: 0,
          gaps: ['Bounded original-message fixture; full history is not established.'],
        },
      };
    },
  };
  f.policy.options.now = () => clock;
  let research = new Research({
    directory: f.directory,
    policy: f.policy,
    reader,
    snapshot: f.snapshot,
    now: () => clock,
    preferences: () => preferences,
  });
  f.assistant.options.research = research;
  const config = (overrides) => ({
    topic: 'synthetic result',
    initialLookbackSeconds: 86400,
    incrementalLookbackSeconds: 3600,
    until: new Date(clock + 2 * 86400000)
      .toISOString()
      .replace('.000Z', 'Z')
      .replace(/\.\d{3}Z$/, 'Z'),
    maxReads: 8,
    maxReadsPerDay: 4,
    recordLimit: 32,
    background: false,
    intervalSeconds: 0,
    ...overrides,
  });
  const old = f.close;
  return {
    ...f,
    get calls() {
      return f.calls;
    },
    get questions() {
      return f.questions;
    },
    get research() {
      return research;
    },
    get reads() {
      return reads;
    },
    get now() {
      return clock;
    },
    reader,
    records,
    requests,
    config,
    scope: () => currentScope({ sourceId: f.source.id, ownerId: f.scope.ownerId }, f.snapshot()),
    enable: (overrides) =>
      f.ask('/research enable ' + f.source.id + ': ' + JSON.stringify(config(overrides))),
    preferences: (value) => {
      preferences = value;
    },
    changeStore: () => {
      storeId = crypto.randomBytes(32).toString('hex');
    },
    advance: (ms) => (clock += ms),
    wall: () => {
      clock = Date.now();
    },
    restart() {
      research.close();
      research = new Research(research.options);
      f.assistant.options.research = research;
    },
    close() {
      research.close();
      old();
    },
  };
}
module.exports = { fixture };
