'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  crypto = require('node:crypto');
const { fixture } = require('./fixtures/work-control-profile.cjs'),
  { command } = require('../src/work-command.cjs');
const bytes = (f) => fs.readFileSync(f.controls.file, 'utf8');
test('work commands require exact current literal human controls; behavior questions and source text do not write permissions', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  assert.equal(command('Can you stop all work?'), null);
  assert.equal(command('"/work stop-all"'), null);
  assert.equal(command('/work stop-all\nthen send other messages'), null);
  assert.deepEqual(command('/work stop-all'), { kind: 'stop-all', target: 'all' });
  const before = JSON.stringify(f.policy.state);
  await f.ask('Explain pause versus stop');
  assert.equal(JSON.stringify(f.policy.state), before);
  assert.equal(fs.existsSync(f.controls.file), false);
  await assert.rejects(
    f.controls.control('stop-all', 'all', { ...f.control('/work stop-all'), role: 'assistant' }),
  );
});
test('pause-main holds its queued pass, children and schedules across restart while preserving the original message for verified resume', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const parent = await f.parent(),
    r = f.responsibilities.entry(parent),
    messageId = r.currentStep.messageId;
  const child = await f.start();
  assert.equal(child.status, 'completed', child.answer);
  const paused = await f.ask('/work pause-main ' + parent);
  assert.equal(paused.status, 'completed', paused.answer);
  f.source.lifecycle = 'completed';
  f.sources[0].lifecycle = 'completed';
  await f.messages.pump();
  assert.equal(f.calls, 0);
  assert.equal(
    f.controls.responsibilityAdmission(
      f.delegations.child(f.delegations.entry(child.delegationId)),
    ),
    'wait',
  );
  f.restartControls();
  await f.messages.pump();
  assert.equal(f.calls, 0);
  const resumed = await f.ask('/work resume-main ' + parent);
  assert.equal(resumed.status, 'completed', resumed.answer);
  assert.equal(f.responsibilities.entry(parent).currentStep.messageId, messageId);
  await f.messages.pump();
  assert.ok(f.calls >= 1);
});
test('pause from sleeping or awaiting human input never wakes the responsibility implicitly', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const id = await f.parent();
  f.responsibilities.wait(
    id,
    'sleeping',
    'Wait for the next human checkpoint',
    f.human('Wait for the next human checkpoint'),
  );
  await f.ask('/work pause-main ' + id);
  await f.ask('/work resume-main ' + id);
  assert.equal(f.responsibilities.entry(id).state, 'sleeping');
  f.source.lifecycle = 'completed';
  await f.messages.pump();
  assert.equal(f.calls, 0);
});
test('disable-schedule cannot be bypassed by schedule now and resuming leaves unrelated schedules and holds intact', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const id = await f.parent(),
    r = f.responsibilities.entry(id);
  const schedule = f.schedules.create(
    f.human('Run the synthetic responsibility at the stated bounded times'),
    r,
    f.spec(),
    { mode: 'scheduled', maxRuns: 3, maxChecks: 10 },
  );
  const result = await f.ask('/work disable-schedule ' + schedule);
  assert.equal(result.status, 'completed', result.answer);
  f.schedules.control(schedule, 'now', f.human('Run this schedule now'));
  await f.schedules.tick();
  assert.equal(f.schedules.entry(schedule).runs.length, 0);
  await f.ask('/work resume-schedule ' + schedule);
  assert.equal(f.controls.active('schedule', schedule), undefined);
});
test('stop-child cancels only its exact queued intent and retains parent and other queued work', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const parent = await f.parent(),
    started = await f.start(),
    e = f.delegations.entry(started.delegationId);
  const result = await f.ask('/work stop-child ' + e.id);
  assert.equal(result.status, 'completed', result.answer);
  assert.equal(f.messages.state.entries.find((m) => m.id === e.messageId).status, 'cancelled');
  assert.equal(
    f.messages.state.entries.find(
      (m) => m.id === f.responsibilities.entry(parent).currentStep.messageId,
    ).status,
    'queued',
  );
  assert.equal(f.calls, 0);
  assert.equal(f.interrupts, 0);
});
test('accepted child stop requests one exact owned turn and matching terminal proof is distinct from acknowledgement and parent completion', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  await f.parent();
  f.sources[0].lifecycle = 'completed';
  const started = await f.start(),
    e = f.delegations.entry(started.delegationId);
  await f.messages.pump();
  f.observe();
  assert.equal(f.delegations.entry(e.id).phase, 'accepted');
  const stopped = await f.ask('/work stop-child ' + e.id);
  assert.equal(stopped.status, 'completed', stopped.answer);
  const checkpoint = f.controls
    .action(stopped.workControlId)
    .resources.find((r) => r.kind === 'responsibility');
  assert.equal(checkpoint.status, 'interrupt_requested');
  assert.equal(f.interrupts, 1);
  assert.equal(f.delegations.entry(e.id).leaseHeld, true);
  f.restartControls();
  f.controls.reconcile();
  assert.equal(f.interrupts, 1);
  f.complete(e.id, 'interrupted');
  f.controls.reconcile();
  assert.equal(
    f.controls.action(stopped.workControlId).resources[0].status,
    'terminal_interrupted',
  );
  assert.equal(f.delegations.entry(e.id).leaseHeld, false);
  assert.notEqual(f.responsibilities.entry(e.parentId).state, 'completed');
});
test('an unowned or changed active turn is handed off without adopting a chat or interrupting a replacement', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  await f.parent();
  f.sources[0].lifecycle = 'completed';
  const started = await f.start(),
    e = f.delegations.entry(started.delegationId);
  await f.messages.pump();
  f.observe();
  f.client.active.set(e.scope.sourceId, 'replacement-turn');
  const result = await f.ask('/work stop-child ' + e.id);
  assert.equal(result.status, 'completed', result.answer);
  assert.equal(f.interrupts, 0);
  assert.equal(f.controls.action(result.workControlId).resources[0].status, 'handoff');
});
test('interrupt timeout retains unknown committed action and restart never retries it', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  await f.parent();
  f.sources[0].lifecycle = 'completed';
  const started = await f.start(),
    e = f.delegations.entry(started.delegationId);
  await f.messages.pump();
  f.observe();
  f.client.onInterrupt = async () => {
    throw Object.assign(new Error('Lost synthetic acknowledgement'), { delivery: 'uncertain' });
  };
  const result = await f.ask('/work stop-child ' + e.id);
  assert.equal(f.controls.action(result.workControlId).resources[0].status, 'unknown');
  assert.equal(f.interrupts, 1);
  f.restartControls();
  f.controls.reconcile();
  assert.equal(f.interrupts, 1);
  assert.equal(f.delegations.entry(e.id).leaseHeld, true);
});
test('executor revocation cancels its unsent tracked work and blocks new direct or child sends without restoring any grants', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const parent = await f.parent(),
    owner = f.responsibilities.entry(parent).scope.ownerId;
  const result = await f.ask('/work revoke-executor ' + owner);
  assert.equal(result.status, 'completed', result.answer);
  assert.ok(
    f.policy.state.revokedAccounts.some(
      (a) => a.kind === 'source_owner' && a.id === owner && a.state === 'revoked',
    ),
  );
  assert.equal(
    f.messages.state.entries.find(
      (m) => m.id === f.responsibilities.entry(parent).currentStep.messageId,
    ).status,
    'cancelled',
  );
  const card = f.snapshot().cards.find((c) => c.sources.some((s) => s.id === f.sources[1].id));
  assert.throws(() =>
    f.messages.enqueue({
      id: card.id,
      taskKey: card.taskKey,
      sourceId: f.sources[1].id,
      messageId: crypto.randomUUID(),
      text: 'New direct synthetic instruction',
    }),
  );
  assert.equal(f.calls, 0);
  f.restartControls();
  assert.equal(f.controls.active('executor', owner).active, true);
});
test('stop-all persists its fence before in-flight reads return and resume refuses a pending read checkpoint', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const parent = await f.parent(),
    scope = f.responsibilities.entry(parent).scope,
    id = crypto.randomUUID(),
    entry = { id, scope, phase: 'reading', pending: { id: crypto.randomUUID() } };
  const research = { state: { entries: [entry] }, pending: new Set([id]), entry: () => entry };
  f.setResearch(research);
  const stopped = await f.ask('/work stop-all');
  assert.equal(stopped.status, 'completed', stopped.answer);
  assert.equal(f.controls.readAdmission(scope), 'wait');
  const resumed = await f.ask('/work resume-all');
  assert.equal(resumed.status, 'failed');
  assert.equal(f.controls.active('all', 'all').active, true);
  entry.pending = null;
  research.pending.clear();
  const retry = await f.ask('/work resume-all');
  assert.equal(retry.status, 'completed', retry.answer);
  assert.equal(f.controls.active('all', 'all'), undefined);
  assert.equal(f.calls, 0);
});
test('unknown source mutation prevents resume until its exact receipt is reconciled, with no resend on restart', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const id = await f.parent(),
    r = f.responsibilities.entry(id),
    message = f.messages.state.entries.find((m) => m.id === r.currentStep.messageId);
  f.responsibilities.change((next) => {
    next.entries.find((e) => e.id === id).currentStep.status = 'unconfirmed';
  });
  message.status = 'uncertain';
  f.messages.save();
  await f.ask('/work pause-main ' + id);
  const result = await f.ask('/work resume-main ' + id);
  assert.equal(result.status, 'failed');
  f.restartControls();
  assert.equal(f.calls, 0);
  message.status = 'cancelled';
  f.messages.save();
  f.observe();
  const recovered = await f.ask('/work resume-main ' + id);
  assert.equal(recovered.status, 'completed', recovered.answer);
  assert.equal(f.calls, 0);
});
test('fence save failure prevents interrupt and revocation; corrupt or future journals preserve their original bytes', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const id = await f.parent();
  f.controls.options.write = () => {
    throw new Error('Synthetic storage failure');
  };
  const before = JSON.stringify(f.policy.state),
    failed = await f.ask('/work stop-all');
  assert.equal(failed.status, 'failed');
  assert.equal(f.interrupts, 0);
  assert.equal(JSON.stringify(f.policy.state), before);
  assert.equal(fs.existsSync(f.controls.file), false);
  delete f.controls.options.write;
  await f.ask('/work pause-main ' + id);
  const saved = bytes(f);
  for (const bad of ['{broken', JSON.stringify({ version: 99, holds: [], actions: [] })]) {
    fs.writeFileSync(f.controls.file, bad);
    assert.throws(() => f.restartControls(), /original file is preserved/);
    assert.equal(bytes(f), bad);
  }
  fs.writeFileSync(f.controls.file, saved);
  f.restartControls();
});
test('Codex interrupt validates the exact loaded active turn and returns a request receipt without claiming terminal completion', async () => {
  const { Codex } = require('../src/codex.cjs'),
    client = new Codex();
  client.loaded.add('owned-source');
  client.active.set('owned-source', 'owned-turn');
  let calls = [];
  client.call = async (method, params) => {
    calls.push({ method, params });
    return {};
  };
  await assert.rejects(client.stop('owned-source', 'newer-turn'), /no interrupt was sent/);
  await assert.rejects(client.stop('unowned', 'owned-turn'));
  assert.equal(calls.length, 0);
  const receipt = await client.stop('owned-source', 'owned-turn');
  assert.deepEqual(receipt, {
    sourceId: 'owned-source',
    turnId: 'owned-turn',
    delivery: 'interrupt_requested',
  });
  assert.equal(calls.length, 1);
  assert.equal(client.active.get('owned-source'), 'owned-turn');
});

test('stop-all remains available while the assistant awaits a real Research adapter read, discards its result and retains responding until it settles', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  await f.parent();
  const { Research } = require('../src/research.cjs');
  let release,
    startedResolve,
    reads = 0;
  const started = new Promise((resolve) => (startedResolve = resolve)),
    storeId = 'b'.repeat(64);
  const reader = {
    storeId: () => storeId,
    read: async (request) => {
      request.beforeRead();
      reads++;
      startedResolve();
      await new Promise((resolve) => (release = resolve));
      return {
        schema: 1,
        threadId: request.scope.sourceId,
        storeId,
        requestNonce: request.nonce,
        since: request.since,
        until: request.until,
        capturedAt: Date.now() / 1000,
        records: [
          {
            id: 'c'.repeat(64),
            role: 'assistant',
            text: 'Late synthetic original reply must be discarded after stop',
            at: request.until,
            truncated: false,
          },
        ],
        coverage: {
          exhaustive: false,
          candidateRecords: 1,
          includedRecords: 1,
          bytesRead: 100,
          byteLimit: 4194304,
          recordLimit: request.limit,
          skippedRecords: 0,
          gaps: ['Bounded synthetic read'],
        },
      };
    },
    close() {},
  };
  const research = new Research({
    directory: f.directory,
    policy: f.policy,
    reader,
    snapshot: f.snapshot,
    admission: (scope) => f.controls.readAdmission(scope),
  });
  t.after(() => research.close());
  f.setResearch(research);
  f.assistant.options.research = research;
  const config = {
    topic: 'synthetic result',
    initialLookbackSeconds: 3600,
    incrementalLookbackSeconds: 3600,
    until: new Date(Date.now() + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    maxReads: 8,
    maxReadsPerDay: 4,
    recordLimit: 8,
    background: false,
    intervalSeconds: 0,
  };
  const enabled = await f.ask('/research enable ' + f.source.id + ': ' + JSON.stringify(config));
  assert.equal(enabled.status, 'completed', enabled.answer);
  const first = f.ask('/research read ' + enabled.researchId);
  await started;
  assert.equal(f.assistant.active, true);
  const stopped = await f.ask('/work stop-all');
  assert.equal(stopped.status, 'completed', stopped.answer);
  assert.equal(f.assistant.active, true);
  assert.throws(
    () => f.assistant.ask({ messageId: crypto.randomUUID(), text: 'New unrelated question' }),
    /Hyphen is answering/,
  );
  release();
  await first;
  assert.equal(f.assistant.active, false);
  assert.equal(research.entry(enabled.researchId).records.length, 0);
  assert.equal(reads, 1);
  await research.read(enabled.researchId, { manual: true });
  assert.equal(reads, 1);
});

test('changed owner or task scope cannot turn a held queued intent into a verified resume', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const id = await f.parent();
  await f.ask('/work pause-main ' + id);
  const original = f.controls.options.snapshot;
  f.controls.options.snapshot = () => ({
    ...f.snapshot(),
    cards: f
      .snapshot()
      .cards.map((c) => ({ ...c, owner: { ...c.owner, id: 'replacement-owner' } })),
  });
  const refused = await f.ask('/work resume-main ' + id);
  assert.equal(refused.status, 'failed');
  assert.equal(f.controls.active('main', id).active, true);
  assert.equal(f.calls, 0);
  f.controls.options.snapshot = original;
});

test('a pause arriving during source preparation prevents its later send, and a post-interrupt journal failure keeps an unknown checkpoint', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  await f.parent();
  f.sources[0].lifecycle = 'completed';
  const started = await f.start(),
    e = f.delegations.entry(started.delegationId);
  let release, preparingResolve;
  const preparing = new Promise((resolve) => (preparingResolve = resolve));
  f.client.prepare = async (id) => {
    f.client.loaded.add(id);
    preparingResolve();
    await new Promise((resolve) => (release = resolve));
  };
  const pumping = f.messages.pump();
  await preparing;
  await f.ask('/work pause-main ' + e.parentId);
  release();
  await pumping;
  assert.equal(f.calls, 0);
  // Separate owned profile avoids restoring an uncertain or refused pass.
  const g = fixture();
  t.after(() => g.close());
  await g.parent();
  g.sources[0].lifecycle = 'completed';
  const accepted = await g.start(),
    child = g.delegations.entry(accepted.delegationId);
  await g.messages.pump();
  g.observe();
  const atomic = require('../src/private-store.cjs').atomicJSON;
  g.controls.options.write = (file, value) => {
    if (value.actions.some((a) => a.resources.some((r) => r.status === 'interrupt_requested')))
      throw new Error('Synthetic result checkpoint failure');
    atomic(file, value);
  };
  const result = await g.ask('/work stop-child ' + child.id);
  assert.equal(g.interrupts, 1);
  assert.equal(g.controls.action(result.workControlId).resources[0].status, 'unknown');
  delete g.controls.options.write;
  g.restartControls();
  g.controls.reconcile();
  assert.equal(g.interrupts, 1);
});
