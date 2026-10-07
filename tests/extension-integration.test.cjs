'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { WorkControls } = require('../src/work-controls.cjs');
const { Reflections } = require('../src/reflections.cjs');

function fixture(t) {
  const f = require('./fixtures/activity-profile.cjs').fixture();
  let controls = new WorkControls({
    directory: f.directory,
    policy: f.policy,
    messages: f.messages,
    responsibilities: f.responsibilities,
    schedules: f.schedules,
    snapshot: f.snapshot,
    research: () => f.research,
  });
  f.assistant.options.workControls = controls;
  f.research.options.admission = (scope) => controls.readAdmission(scope);
  f.responsibilities.options.admission = (entry) => controls.responsibilityAdmission(entry);
  f.triage.options.admission = (entry) => controls.responsibilityAdmission(entry);
  const reflections = new Reflections({
    directory: f.directory,
    policy: f.policy,
    research: f.research,
    commitments: f.commitments,
    now: () => f.now,
  });
  f.assistant.options.reflections = reflections;
  t.after(() => {
    reflections.close();
    controls.close();
    f.close();
  });
  return {
    f,
    reflections,
    get controls() {
      return controls;
    },
    restartControls() {
      controls.close();
      controls = new WorkControls(controls.options);
      f.assistant.options.workControls = controls;
    },
  };
}

async function prepare(f, reflections) {
  const research = await f.enableResearch();
  assert.equal(research.status, 'completed', research.answer);
  await f.research.read(research.researchId, { manual: true });
  const due = new Date(f.now + 60000);
  const config = {
    timeZone: 'UTC',
    cadence: 'daily',
    wallTime: due.toISOString().slice(11, 16),
    weekdays: [],
    until: new Date(f.now + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    maxReviews: 8,
    retentionDays: 1,
    recordLimit: 8,
    characterBudget: 8000,
    commitmentLimit: 8,
  };
  const enabled = await f.ask(
    '/reflection enable ' + research.researchId + ': ' + JSON.stringify(config),
  );
  assert.equal(enabled.status, 'completed', enabled.answer);
  const reflectionId = reflections.state.entries[0].id;
  await f.enable();
  f.finding();
  // These terminal source values belong to this synthetic transport fixture.
  // They exercise reconciliation, not independent goal verification.
  f.source.turnId = 'synthetic-notification-turn';
  f.source.turnOutcome = 'completed';
  f.source.lifecycle = 'completed';
  f.triage.observe(f.snapshot());
  assert.equal(f.triage.state.deliveries.length, 1);
  assert.equal(f.triage.state.deliveries[0].status, 'prepared');
  return { researchId: research.researchId, reflectionId };
}

test('a durable global stop holds real research, reflection cadence and prepared inbox delivery through restart; resume preserves identities', async (t) => {
  const p = fixture(t),
    { f, reflections } = p;
  const ids = await prepare(f, reflections);
  const messageId = f.responsibilities.entry(f.responsibilityId).currentStep.messageId;
  const noticeId = f.triage.state.deliveries[0].id;
  const stopped = await f.ask('/work stop-all');
  assert.equal(stopped.status, 'completed', stopped.answer);
  assert.equal(f.reads, 1);
  p.restartControls();
  f.advance(120000);
  await f.research.read(ids.researchId, { manual: true });
  reflections.tick();
  await f.triage.pump();
  assert.equal(f.reads, 1);
  assert.equal(reflections.state.checkpoints.length, 0);
  assert.equal(reflections.context().scopes.length, 0);
  assert.equal(f.triage.state.deliveries[0].status, 'prepared');
  assert.ok(f.activity.query({ limit: 100 }).events.length > 0);
  assert.equal(f.calls, 0);
  assert.equal(f.questions, 0);

  const resumed = await f.ask('/work resume-all');
  assert.equal(resumed.status, 'completed', resumed.answer);
  assert.equal(f.responsibilities.entry(f.responsibilityId).currentStep.messageId, messageId);
  await f.research.read(ids.researchId, { manual: true });
  reflections.tick();
  assert.equal(reflections.state.checkpoints.length, 0);
  const checkpoint = await f.ask('/reflection checkpoint ' + ids.reflectionId);
  assert.equal(checkpoint.status, 'completed', checkpoint.answer);
  await f.triage.pump();
  assert.equal(f.reads, 2);
  assert.equal(reflections.state.checkpoints.length, 1);
  assert.equal(f.triage.state.deliveries.length, 1);
  assert.equal(f.triage.state.deliveries[0].id, noticeId);
  assert.equal(f.triage.state.deliveries[0].status, 'accepted');
  assert.equal(f.triage.state.deliveries[0].receipt.kind, 'inbox_stored');
  const starts = f.activity
    .query({ filters: { type: 'source_read' }, limit: 100 })
    .events.filter((e) => e.phase === 'started');
  assert.equal(starts.length, 2);
  assert.equal(f.calls, 0);
  assert.equal(f.questions, 0);
});

test('executor revocation hides retained reflection context and holds notifications while activity retains metadata without reading the source', async (t) => {
  const p = fixture(t),
    { f, reflections } = p;
  const ids = await prepare(f, reflections);
  const checkpoint = await f.ask('/reflection checkpoint ' + ids.reflectionId);
  assert.equal(checkpoint.status, 'completed', checkpoint.answer);
  assert.equal(reflections.state.checkpoints.length, 1);
  const revoked = await f.ask('/work revoke-executor ' + f.scope().ownerId);
  assert.equal(revoked.status, 'completed', revoked.answer);
  p.restartControls();
  await f.research.read(ids.researchId, { manual: true });
  await f.triage.pump();
  assert.equal(reflections.context().scopes.length, 0);
  assert.equal(f.research.context().entries[0].records.length, 0);
  assert.equal(f.research.context().entries[0].recordCoverage.state, 'scope_unavailable');
  assert.equal(f.triage.state.deliveries[0].status, 'prepared');
  assert.equal(f.reads, 1);
  const view = await f.ask('/activity');
  assert.equal(view.status, 'completed', view.answer);
  assert.ok(f.activity.query({ limit: 100 }).events.length > 0);
  assert.equal(f.reads, 1);
  assert.equal(f.calls, 0);
  assert.equal(f.questions, 0);
});
