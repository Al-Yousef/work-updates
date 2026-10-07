'use strict';
const { Triage } = require('../../src/triage.cjs'),
  { Commitments } = require('../../src/commitments.cjs'),
  { destination } = require('../../src/notification-destination.cjs');
function fixture() {
  const f = require('./research-profile.cjs').fixture(),
    commitments = new Commitments({ directory: f.directory, humanActorId: f.policy.actorId }),
    deviceId = 'fixture-local-inbox';
  const responsibilityId = f.responsibilities.create(
    f.human('/responsibility start Review the synthetic result.'),
    f.scope(),
    {
      kind: 'human_verified',
      description: 'Review the synthetic result against the human instruction.',
    },
  );
  let triage;
  const dest = destination({ assistant: f.assistant, deviceId, now: () => f.now }),
    options = {
      directory: f.directory,
      policy: f.policy,
      responsibilities: f.responsibilities,
      research: f.research,
      snapshot: f.snapshot,
      deviceId,
      destination: dest,
      preferences: () => commitments.preferenceSnapshot(),
      now: () => f.now,
    };
  triage = new Triage(options);
  f.assistant.options.triage = triage;
  f.assistant.options.commitments = commitments;
  const config = (overrides) => ({
    destination: { kind: 'inbox', deviceId, audience: 'self' },
    conditions: ['needs_user', 'ready', 'blocked', 'failure', 'urgent'],
    quietHours: null,
    routineUpdates: 'off',
    escalateAfterSeconds: 120,
    minIntervalSeconds: 60,
    maxReminders: 1,
    maxAttempts: 8,
    until: new Date(f.now + 2 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...overrides,
  });
  return {
    ...f,
    get calls() {
      return f.calls;
    },
    get reads() {
      return f.reads;
    },
    get questions() {
      return f.questions;
    },
    get now() {
      return f.now;
    },
    get research() {
      return f.research;
    },
    get triage() {
      return triage;
    },
    commitments,
    destination: dest,
    deviceId,
    responsibilityId,
    config,
    enable: (overrides) =>
      f.ask('/notice configure ' + responsibilityId + ': ' + JSON.stringify(config(overrides))),
    finding({ state = 'waiting_user', status = 'completed', urgency = false } = {}) {
      f.responsibilities.change((next) => {
        const r = next.entries.find((r) => r.id === responsibilityId);
        r.state = state;
        r.currentStep.status = status;
        if (['accepted', 'completed'].includes(status))
          r.currentStep.turnId = 'synthetic-notification-turn';
        r.wakeReason = { kind: state };
      });
      const cardId = f.scope().id;
      f.queue.state.cards[cardId] = {
        ...f.queue.cardState(cardId),
        priority: urgency ? 'urgent' : 'normal',
      };
    },
    restart() {
      const nextOptions = { ...triage.options, research: f.research };
      triage.close();
      triage = new Triage(nextOptions);
      f.assistant.options.triage = triage;
    },
    close() {
      triage.close();
      commitments.close();
      f.close();
    },
  };
}
module.exports = { fixture };
