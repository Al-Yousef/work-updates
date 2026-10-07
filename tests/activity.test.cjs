'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  crypto = require('node:crypto');
const { fixture } = require('./fixtures/activity-profile.cjs'),
  { readStore, atomicJSON } = require('../src/private-store.cjs'),
  { Activity, identity } = require('../src/activity.cjs'),
  { command } = require('../src/activity-command.cjs');
function profile(t) {
  const f = fixture();
  t.after(() => f.close());
  return f;
}
function event(f, i = 0) {
  return {
    type: 'finding',
    status: 'ready',
    reason: 'worker_finding',
    scope: identity(f.scope()),
    links: { responsibilityId: f.responsibilityId, findingId: 'finding-' + i },
    synthetic: true,
  };
}
test('initial projection discloses missing history and unknown execution timestamps without reading or sending', (t) => {
  const f = profile(t),
    q = f.activity.query();
  assert.equal(q.coverage.exhaustive, false);
  assert.equal(q.coverage.priorHistory, 'not established');
  assert.equal(q.counts.sourceReadAttemptsStarted, 0);
  assert.equal(q.counts.checkingSessionsStarted, 0);
  assert.ok(
    q.events.every(
      (e) =>
        e.timing === 'retained_projection' && e.actualStartAt === null && e.actualEndAt === null,
    ),
  );
  assert.equal(f.reads, 0);
  assert.equal(f.calls, 0);
  assert.deepEqual(readStore(f.activity.file).value, f.activity.state);
});
test('actual reader boundaries, validated coverage, retries and sessions correlate to one exact scope without counting transitions as extra reads', async (t) => {
  const f = profile(t),
    enabled = await f.enableResearch(),
    id = enabled.researchId;
  await f.research.read(id, { manual: true });
  let q = f.activity.query({ limit: 100 });
  assert.equal(q.counts.sourceReadAttemptsStarted, 1);
  assert.equal(q.counts.checkingSessionsStarted, 1);
  const reads = q.events.filter((e) => e.type === 'source_read');
  assert.ok(reads.some((e) => e.phase === 'started' && e.actualStartAt !== null));
  assert.ok(
    reads.some((e) => e.phase === 'returned' && e.evidence === 'unvalidated_reader_return'),
  );
  assert.ok(reads.some((e) => e.coverage.acceptedForResearch && e.links.sourceRecordId));
  assert.ok(
    reads.every((e) => e.scope.sourceId === f.source.id && e.scope.accountKind === 'codex_store'),
  );
  const raw = f.reader.read;
  f.reader.read = async () => {
    throw new Error('SECRET reader error text must not be copied');
  };
  await f.research.read(id, { manual: true });
  f.reader.read = raw;
  await f.research.read(id, { manual: true });
  q = f.activity.query({ limit: 100 });
  assert.equal(q.counts.sourceReadAttemptsStarted, 3);
  assert.equal(q.counts.checkingSessionsStarted, 3);
  assert.equal(q.counts.retriesPlanned, 1);
  assert.equal(JSON.stringify(f.activity.state).includes('SECRET'), false);
  assert.equal(f.calls, 0);
});
test('revoked read scope creates no new actual-start count and rejected source text cannot become activity control', async (t) => {
  const f = profile(t),
    r = await f.enableResearch();
  await f.research.read(r.researchId, { manual: true });
  await f.ask('/research revoke ' + r.researchId);
  await f.research.read(r.researchId, { manual: true });
  assert.equal(f.activity.query({ limit: 100 }).counts.sourceReadAttemptsStarted, 1);
  assert.equal(command('How do activity exports work?'), null);
  assert.equal(command('"/activity export: {\"redacted\":true}"'), null);
  assert.equal(command('/activity list: {"kind":"export","redacted":true}').kind, 'invalid');
  assert.throws(
    () =>
      f.activity.export(
        { ...f.control('/activity export: {"redacted":true,"filters":{}}'), role: 'source' },
        {},
      ),
    /accepted human/,
  );
});
test('owned dispatch records planned and actual local call times; receipt and broader goal remain separate', async (t) => {
  const f = profile(t),
    r = f.responsibilities.entry(f.responsibilityId);
  let calls = 0;
  const send = f.activity.dispatch(async (mode, input) => {
    calls++;
    return {
      messageId: input.messageId,
      sourceId: input.sourceId,
      ownerId: r.scope.ownerId,
      delivery: 'sent',
      turnId: 'synthetic-activity-turn',
    };
  }, f.responsibilities);
  const input = {
    id: r.scope.id,
    sourceId: r.scope.sourceId,
    taskKey: r.scope.taskKey,
    messageId: r.currentStep.messageId,
    text: r.currentStep.text,
  };
  await send('queue', input);
  const events = f.activity
    .query({ limit: 100 })
    .events.filter((e) => e.type === 'worker_run' && e.timing === 'instrumented');
  assert.equal(events.length, 3);
  assert.ok(events.some((e) => e.phase === 'started' && e.actualStartAt));
  assert.ok(events.some((e) => e.phase === 'returned' && e.actualEndAt));
  assert.ok(
    events.every((e) => e.links.responsibilityId === r.id && e.links.stepId === r.currentStep.id),
  );
  assert.equal(calls, 1);
  await assert.rejects(
    send('queue', { ...input, taskKey: 'changed-task' }),
    /exact owned dispatch/,
  );
  assert.equal(calls, 1);
  assert.equal(f.responsibilities.entry(r.id).state, 'running');
});
test('journal verification failure prevents a newly instrumented source read or dispatch and preserves the original bytes', async (t) => {
  const f = profile(t),
    r = await f.enableResearch();
  const prior = fs.readFileSync(f.activity.file);
  f.activity.options.write = () => {};
  await f.research.read(r.researchId, { manual: true });
  assert.equal(f.reads, 0);
  assert.deepEqual(fs.readFileSync(f.activity.file), prior);
  assert.ok(f.activity.error);
  let calls = 0;
  const send = f.activity.dispatch(async () => {
      calls++;
    }, f.responsibilities),
    entry = f.responsibilities.entry(f.responsibilityId);
  await assert.rejects(
    send('queue', {
      id: entry.scope.id,
      sourceId: entry.scope.sourceId,
      taskKey: entry.scope.taskKey,
      messageId: entry.currentStep.messageId,
    }),
    /recovery/,
  );
  assert.equal(calls, 0);
});
test('findings, quiet decisions, notification storage receipts and user acknowledgement retain exact task and evidence links', async (t) => {
  const f = profile(t);
  await f.enable();
  f.finding();
  await f.triage.pump();
  const d = f.triage.state.deliveries[0];
  await f.ask('/notice acknowledge ' + d.id);
  const q = f.activity.query({ limit: 100 });
  assert.equal(q.counts.findingsObserved, 1);
  assert.equal(q.counts.notificationIntentsObserved, 1);
  assert.ok(
    q.events.some(
      (e) =>
        e.type === 'notification' && e.phase === 'acknowledged' && e.evidence === 'inbox_stored',
    ),
  );
  assert.ok(q.events.some((e) => e.type === 'notification_decision' && e.links.findingId));
  assert.ok(
    q.events
      .filter((e) => ['finding', 'notification'].includes(e.type))
      .every((e) => e.links.responsibilityId === f.responsibilityId),
  );
  assert.equal(JSON.stringify(q).includes('Reported update for'), false);
});
test('pagination pins a high-water sequence, binds filters, survives restart and reports retention moving beneath the cursor', (t) => {
  const f = profile(t);
  for (let i = 0; i < 40; i++) f.activity.record(event(f, i), ['page', i]);
  const filters = { type: 'finding' },
    first = f.activity.query({ filters, limit: 5 }),
    cursor = first.nextCursor;
  f.activity.record(event(f, 100), ['new', 100]);
  f.restartActivity();
  const second = f.activity.query({ filters, limit: 5, cursor });
  assert.equal(second.events.length, 5);
  assert.ok(second.events.every((e) => e.seq < first.events.at(-1).seq));
  assert.throws(() => f.activity.query({ filters: { type: 'notification' }, cursor }), /cursor/);
  const h = f.control('/activity configure: {"retentionDays":30,"maxEvents":32}');
  f.activity.configure(h, { retentionDays: 30, maxEvents: 32 });
  const later = f.activity.query({ filters, limit: 5, cursor });
  assert.equal(later.coverage.retentionAdvancedSinceCursor, true);
  assert.ok(later.coverage.droppedEventsByType.finding > 0);
});
test('time retention removes old metadata, preserves counts as event losses and unchanged polling does not recreate pruned projections', (t) => {
  const f = profile(t);
  f.advance(31 * 86400000);
  f.activity.record(event(f, 1), ['after-retention']);
  const count = f.activity.state.events.length;
  f.activity.capture(f.stores);
  f.activity.capture(f.stores);
  assert.equal(f.activity.state.events.length, count);
  assert.ok(f.activity.query().coverage.droppedEventsByType.worker_run > 0);
});
test('corrupt, future and independently changed activity journals fail closed without overwrite', (t) => {
  const f = profile(t),
    good = fs.readFileSync(f.activity.file, 'utf8');
  for (const bad of ['{broken', JSON.stringify({ ...JSON.parse(good), version: 99 })]) {
    fs.writeFileSync(f.activity.file, bad);
    assert.throws(() => new Activity(f.activity.options), /original file/);
    assert.equal(fs.readFileSync(f.activity.file, 'utf8'), bad);
  }
  fs.writeFileSync(f.activity.file, good);
  const changed = JSON.parse(good);
  changed.nextSeq++;
  atomicJSON(f.activity.file, changed);
  assert.throws(() => f.activity.record(event(f), ['independent']), /original file/);
  assert.deepEqual(readStore(f.activity.file).value, changed);
});
test('restart closes an interrupted actual call as unknown and does not call its source again', (t) => {
  const f = profile(t),
    e = {
      ...event(f),
      type: 'source_read',
      timing: 'instrumented',
      phase: 'started',
      actualStartAt: f.now,
      links: { operationId: crypto.randomUUID(), runId: crypto.randomUUID() },
    };
  f.activity.record(e, ['interrupted']);
  f.restartActivity();
  const q = f.activity.query({ limit: 100 });
  assert.ok(
    q.events.some(
      (e) =>
        e.type === 'source_read' && e.phase === 'unknown' && e.reason === 'restart_unconfirmed',
    ),
  );
  const count = f.activity.state.events.length;
  f.restartActivity();
  assert.equal(f.activity.state.events.length, count);
  assert.equal(f.reads, 0);
});

test('a disappeared journal is not silently recreated over an independent deletion', (t) => {
  const f = profile(t);
  fs.unlinkSync(f.activity.file);
  assert.throws(() => f.activity.record(event(f), ['deleted-store']), /original file/);
  assert.equal(fs.existsSync(f.activity.file), false);
});

test('waiting causes and approval references are qualified metadata with no reason prose', (t) => {
  const f = profile(t);
  f.responsibilities.change((next) => {
    const r = next.entries.find((r) => r.id === f.responsibilityId);
    r.state = 'waiting_approval';
    r.wakeReason = {
      kind: 'authorization_ask',
      operationId: crypto.randomUUID(),
      reason: 'SECRET private approval explanation',
    };
  });
  const event = f.activity.query({ filters: { type: 'waiting' } }).events[0];
  assert.equal(event.reason, 'authorization_ask');
  assert.ok(event.links.requestId);
  assert.equal(JSON.stringify(f.activity.state).includes('SECRET'), false);
});
test('redacted export requires a literal human opt-in, preserves correlations and excludes all raw identities, prompts, paths and errors', async (t) => {
  const f = profile(t);
  await f.enable();
  f.finding();
  await f.triage.pump();
  const rawIds = [f.source.id, f.scope().ownerId, f.scope().taskKey, f.responsibilityId];
  const input = f.control('/activity export: {"redacted":true,"filters":{"synthetic":true}}'),
    receipt = f.activity.export(input, { synthetic: true }),
    bytes = fs.readFileSync(receipt.file, 'utf8'),
    report = JSON.parse(bytes);
  assert.equal(report.redacted, true);
  assert.equal(report.synthetic, true);
  assert.ok(report.events.length > 3);
  for (const raw of rawIds) assert.equal(bytes.includes(raw), false, raw);
  assert.equal(bytes.includes(f.directory), false);
  assert.equal(bytes.includes('Review the synthetic'), false);
  const linked = report.events.filter((e) => e.links.responsibilityId);
  assert.equal(new Set(linked.map((e) => e.links.responsibilityId)).size, 1);
  assert.ok(linked.every((e) => e.at % 60000 === 0));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), receipt.sha256);
  assert.throws(
    () => f.activity.export(f.control('please export activity'), {}),
    /explicit redacted/,
  );
});
test('failed export readback never reports saved and does not add a confirmed receipt', (t) => {
  const f = profile(t);
  f.activity.options.exportRead = () => Buffer.from('bad');
  assert.throws(
    () => f.activity.export(f.control('/activity export: {"redacted":true,"filters":{}}'), {}),
    /readback failed/,
  );
  assert.equal(f.activity.state.exports.length, 0);
});
test('assistant activity commands stay bounded with a usable cursor and behavior questions cannot change retention or export', async (t) => {
  const f = profile(t);
  for (let i = 0; i < 20; i++) f.activity.record(event(f, i), ['render', i]);
  const result = await f.ask('/activity list: {"filters":{"type":"finding"},"limit":20}');
  assert.equal(result.status, 'completed', result.error);
  assert.ok(result.answer.length < 5400);
  const parsed = JSON.parse(result.answer);
  assert.ok(parsed.nextCursor);
  assert.ok(parsed.events.length < 20);
  const before = JSON.stringify(f.activity.state);
  await f.ask('How do activity and export work?');
  assert.equal(JSON.stringify(f.activity.state), before);
});

test('collector producer records remain content-free and distinct, with no invented scope or extra count on repeated feed publication', (t) => {
  const f = profile(t),
    sessionId = crypto.randomBytes(16).toString('hex'),
    readId = crypto.randomBytes(16).toString('hex');
  const access = {
    schema: 1,
    sessionId,
    storeId: 'a'.repeat(64),
    startedAt: f.now - 10,
    endedAt: f.now,
    outcome: 'returned',
    droppedReads: 4,
    reads: [
      {
        id: readId,
        sourceId: f.source.id,
        reason: 'collector_context_read',
        startedAt: f.now - 5,
        endedAt: f.now,
        outcome: 'returned',
        text: 'SECRET collector body',
      },
    ],
  };
  f.activity.collector(access);
  f.activity.collector(access);
  const q = f.activity.query({ limit: 100 });
  assert.equal(q.counts.sourceReadAttemptsStarted, 1);
  assert.equal(q.counts.checkingSessionsStarted, 1);
  const events = q.events.filter((e) => e.timing === 'producer_record');
  assert.ok(events.some((e) => e.reason === 'reader_gap'));
  assert.ok(
    events
      .filter((e) => e.type === 'source_read' && e.links.operationId)
      .every((e) => e.scope.ownerId === null && e.scope.taskKey === null),
  );
  assert.equal(JSON.stringify(f.activity.state).includes('SECRET'), false);
});

test('delegated output and parent/child links correlate without exposing selected context or marking the parent goal complete', async (t) => {
  const f = require('./fixtures/delegation-profile.cjs').fixture(),
    activity = new Activity({
      directory: f.directory,
      actorId: () => f.policy.actorId,
      synthetic: true,
    });
  t.after(() => {
    activity.close();
    f.close();
  });
  activity.attach({
    policy: f.policy,
    responsibilities: f.responsibilities,
    schedules: f.schedules,
    delegations: f.delegations,
  });
  f.responsibilities.options.dispatch = activity.dispatch(
    f.responsibilities.options.dispatch,
    f.responsibilities,
  );
  const response = await f.start();
  assert.equal(response.status, 'completed', response.answer);
  const e = f.delegations.entry(response.delegationId);
  f.sources[0].lifecycle = 'completed';
  await f.messages.pump();
  f.complete(e.id);
  const q = activity.query({ filters: { type: 'delegated_run' }, limit: 100 });
  assert.equal(q.counts.delegatedRunsObserved, 1);
  assert.ok(
    q.events.some(
      (row) =>
        row.status === 'completed_run' &&
        row.links.parentId === e.parentId &&
        row.links.childId === e.childId &&
        row.links.turnId,
    ),
  );
  assert.equal(JSON.stringify(activity.state).includes('Review the first synthetic result'), false);
  assert.notEqual(f.responsibilities.entry(e.parentId).state, 'completed');
});

test('visible activity links resolve only the same current source owner and task, with a read-only bounded model context', async (t) => {
  const f = profile(t);
  await f.enable();
  f.finding();
  await f.triage.pump();
  const response = await f.ask('/activity list: {"filters":{"type":"finding"}}');
  assert.equal(response.status, 'completed', response.error);
  assert.equal(response.links[0].sourceId, f.source.id);
  assert.equal(response.links[0].ownerId, f.scope().ownerId);
  assert.equal(response.links[0].chatName, 'Source activity');
  const context = f.activity.context();
  assert.ok(JSON.stringify(context).length < 8000);
  assert.equal(context.coverage.exhaustive, false);
  f.activity.options.snapshot = () => ({ cards: [] });
  assert.equal((await f.ask('/activity list: {"filters":{"type":"finding"}}')).links.length, 0);
});

test('saved local message receipts correlate by exact message and task without inventing an owner or copying the draft', (t) => {
  const f = profile(t),
    messageId = crypto.randomUUID();
  const entry = {
    id: messageId,
    sourceId: f.source.id,
    cardId: f.scope().id,
    taskKey: f.scope().taskKey,
    createdAt: f.now,
    status: 'sent',
    textHash: 'f'.repeat(64),
    text: 'SECRET draft',
    receipt: { turnId: 'synthetic-direct-turn' },
    receiptIdentity: {
      messageId,
      sourceId: f.source.id,
      textHash: 'f'.repeat(64),
      turnId: 'synthetic-direct-turn',
    },
    completedAt: f.now,
  };
  f.activity.capture({ ...f.stores, messages: { state: { entries: [entry] } } });
  const q = f.activity.query({ filters: { type: 'source_message' } }),
    row = q.events[0];
  assert.equal(q.counts.sourceMessageIntentsObserved, 1);
  assert.equal(row.links.messageId, messageId);
  assert.equal(row.links.turnId, 'synthetic-direct-turn');
  assert.equal(row.scope.ownerId, null);
  assert.equal(row.actualStartAt, null);
  assert.equal(row.actualEndAt, f.now);
  assert.equal(JSON.stringify(f.activity.state).includes('SECRET'), false);
});
