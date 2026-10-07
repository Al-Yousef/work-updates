'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { Schedules } = require('../src/schedules.cjs');
const human = (text) => ({ role: 'human', messageId: crypto.randomUUID(), text });
function fixture(overrides = {}) {
  let now = Date.parse('2026-10-06T12:00:00Z'),
    saved = null,
    proof = null;
  const calls = [];
  const responsibility = {
    id: crypto.randomUUID(),
    instruction: 'Prepare the exact requested fixture result',
    revision: 1,
    state: 'waiting_user',
    scope: {
      sourceId: 'source',
      ownerId: 'owner',
      deviceId: 'owner',
      executionDevice: { kind: 'pc', name: 'Fixture PC' },
      taskKey: 'task',
      taskRevision: 'revision',
      id: 'card',
      chatName: 'Fixture chat',
    },
  };
  const options = {
    now: () => now,
    read: () => structuredClone(saved),
    write: (value) => {
      saved = structuredClone(value);
    },
    probe: () => ({ eligible: true, fingerprint: 'stable' }),
    outcome: () => proof,
    run: async (entry) => {
      calls.push(entry);
      assert.equal(saved.entries[0].runs.at(-1).id, entry.run.id);
      assert.equal(saved.entries[0].runs.at(-1).status, 'dispatching');
      return {
        status: 'accepted',
        messageId: crypto.randomUUID(),
        sourceId: 'source',
        ownerId: 'owner',
        turnId: 'turn-' + calls.length,
      };
    },
    ...overrides,
  };
  const store = new Schedules(options),
    schedule = {
      kind: 'interval',
      timeZone: 'America/Toronto',
      anchorAt: now + 60000,
      intervalMs: 60000,
      endAt: now + 3600000,
    };
  const create = (limits = {}) =>
    store.create(
      human('Repeat this responsibility at the explicitly requested timing until its end date'),
      responsibility,
      schedule,
      { maxRuns: 4, ...limits },
    );
  const complete = () => {
    const run = store.snapshot()[0].runs.at(-1);
    proof = { ...run, status: 'completed', sourceId: 'source', ownerId: 'owner' };
    store.observe();
    proof = null;
  };
  return {
    store,
    options,
    create,
    schedule,
    responsibility,
    calls,
    complete,
    advance: (ms) => {
      now += ms;
    },
    read: () => structuredClone(saved),
    setProof: (value) => {
      proof = value;
    },
  };
}
test('each due run saves one stable intent before dispatch and accepted overlap prevents another run', async () => {
  const f = fixture(),
    id = f.create();
  await f.store.tick();
  assert.equal(f.calls.length, 0);
  f.advance(60000);
  await Promise.all([f.store.tick(), f.store.tick()]);
  assert.equal(f.calls.length, 1);
  const first = f.store.entry(id).runs[0];
  assert.equal(first.trigger, 'scheduled');
  assert.equal(first.plannedAt, first.checkpointAt);
  assert.equal(f.store.entry(id).lastActualRun, first.acceptedAt);
  f.advance(5 * 60000);
  await f.store.tick();
  assert.equal(f.calls.length, 1);
  f.complete();
  await f.store.tick();
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].run.id, f.calls[1].run.id);
});
test('restart while dispatching marks the same run unknown and rescheduling cannot replay it', async () => {
  const f = fixture({ run: () => new Promise(() => {}) }),
    id = f.create();
  f.advance(60000);
  void f.store.tick();
  const run = f.read().entries[0].runs[0];
  f.store.close();
  const restarted = new Schedules(f.options);
  assert.equal(restarted.entry(id).state, 'blocked');
  assert.equal(restarted.entry(id).runs[0].id, run.id);
  assert.equal(restarted.entry(id).runs[0].status, 'unconfirmed');
  restarted.control(id, 'reschedule', human('Change this schedule timing'), {
    ...f.schedule,
    intervalMs: 120000,
  });
  await restarted.tick();
  assert.equal(restarted.entry(id).state, 'blocked');
  assert.equal(restarted.entry(id).runs.length, 1);
});
test('a queued receipt is not an actual source run and exact terminal evidence releases overlap', async () => {
  const f = fixture({
      run: async () => ({
        status: 'queued',
        messageId: crypto.randomUUID(),
        sourceId: 'source',
        ownerId: 'owner',
      }),
    }),
    id = f.create();
  f.advance(60000);
  await f.store.tick();
  assert.equal(f.store.entry(id).lastActualRun, null);
  const run = f.store.entry(id).runs[0];
  f.setProof({ ...run, status: 'accepted', turnId: 'turn-1', sourceId: 'other', ownerId: 'owner' });
  f.store.observe();
  assert.equal(f.store.entry(id).runs[0].status, 'queued');
  f.setProof({
    ...run,
    status: 'accepted',
    turnId: 'turn-1',
    sourceId: 'source',
    ownerId: 'owner',
    acceptedAt: f.options.now() - 100,
  });
  f.store.observe();
  assert.equal(f.store.entry(id).lastActualRun, f.options.now() - 100);
  f.setProof({
    ...run,
    status: 'completed',
    turnId: 'another-turn',
    sourceId: 'source',
    ownerId: 'owner',
  });
  f.store.observe();
  assert.equal(f.store.entry(id).runs[0].status, 'accepted');
});
test('deadline checks back off for unchanged source state and stop at their bound', async () => {
  const f = fixture(),
    id = f.create({ mode: 'deadline', maxChecks: 2 });
  f.advance(60000);
  await f.store.tick();
  assert.equal(f.calls[0].run.trigger, 'deadline');
  f.complete();
  f.advance(60000);
  await f.store.tick();
  const first = f.store.entry(id);
  assert.equal(first.unchangedChecks, 1);
  assert.equal(first.nextWake, f.options.now() + 120000);
  assert.equal(f.calls.length, 1);
  f.advance(120000);
  await f.store.tick();
  assert.equal(f.store.entry(id).state, 'expired');
  assert.equal(f.calls.length, 1);
});
test('event-triggered runs act on changed source evidence with their own planned and actual timestamps', async () => {
  const f = fixture(),
    id = f.create({ mode: 'event' });
  f.advance(60000);
  await f.store.tick();
  assert.equal(f.calls.length, 0);
  f.advance(60000);
  await f.store.tick();
  assert.equal(f.calls.length, 0);
  f.options.probe = () => ({ eligible: true, fingerprint: 'changed' });
  f.advance(120000);
  await f.store.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.entry(id).runs[0].trigger, 'event');
});
test('pause, cancel, end date and run limits prevent future dispatch without cancelling another writer', async () => {
  const f = fixture(),
    id = f.create({ maxRuns: 1 });
  f.store.control(id, 'pause', human('Pause this schedule'));
  f.advance(60000);
  await f.store.tick();
  assert.equal(f.calls.length, 0);
  f.store.control(id, 'resume', human('Resume the same schedule'));
  f.advance(60000);
  await f.store.tick();
  assert.equal(f.calls.length, 1);
  f.complete();
  f.advance(60000);
  await f.store.tick();
  assert.equal(f.store.entry(id).state, 'expired');
  const b = fixture(),
    other = b.create();
  b.store.control(other, 'cancel', human('Cancel this schedule'));
  b.advance(60000);
  await b.store.tick();
  assert.equal(b.calls.length, 0);
  assert.equal(b.store.entry(other).state, 'cancelled');
});
test('missed work creates one catch-up after restart, while disk failure creates no dispatch', async () => {
  const f = fixture(),
    id = f.create();
  f.store.close();
  f.advance(10 * 60000);
  const restarted = new Schedules(f.options);
  await restarted.tick();
  assert.equal(f.calls.length, 1);
  assert.ok(restarted.entry(id).runs[0].checkpointAt > restarted.entry(id).runs[0].plannedAt);
  const b = fixture();
  b.create();
  b.advance(60000);
  b.options.write = () => {
    throw new Error('Injected disk failure');
  };
  await assert.rejects(b.store.tick(), /disk failure/);
  assert.equal(b.calls.length, 0);
});
test('source participants cannot create schedules and a changed receipt never grants successful delivery', async () => {
  const f = fixture({
    run: async () => ({
      status: 'accepted',
      messageId: crypto.randomUUID(),
      sourceId: 'other',
      ownerId: 'owner',
      turnId: 'turn',
    }),
  });
  assert.throws(
    () =>
      f.store.create(
        { ...human('Repeat this action'), role: 'source' },
        f.responsibility,
        f.schedule,
        { maxRuns: 2 },
      ),
    /human/,
  );
  const id = f.create();
  f.advance(60000);
  await f.store.tick();
  assert.equal(f.store.entry(id).state, 'blocked');
  assert.equal(f.store.entry(id).runs[0].status, 'unconfirmed');
  assert.equal(f.store.entry(id).lastActualRun, null);
});

test('user-requested runs keep their trigger and a confirmed cancelled source revokes recurrence', async () => {
  const f = fixture(),
    id = f.create();
  f.store.control(id, 'now', human('Run this schedule once now'));
  await f.store.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.entry(id).runs[0].trigger, 'user');
  const run = f.store.entry(id).runs[0];
  f.setProof({ ...run, status: 'cancelled', sourceId: 'source', ownerId: 'owner' });
  f.store.observe();
  assert.equal(f.store.entry(id).state, 'cancelled');
  f.advance(60000);
  await f.store.tick();
  assert.equal(f.calls.length, 1);
});

test('exact durable run correlation can recover an unknown checkpoint without invoking the worker twice', async () => {
  const f = fixture({ run: () => new Promise(() => {}) }),
    id = f.create();
  f.advance(60000);
  void f.store.tick();
  const unknown = f.read().entries[0].runs[0];
  f.store.close();
  const restarted = new Schedules(f.options),
    messageId = crypto.randomUUID();
  f.setProof({
    runId: 'another-run',
    messageId,
    status: 'accepted',
    sourceId: 'source',
    ownerId: 'owner',
    turnId: 'turn',
  });
  restarted.observe();
  assert.equal(restarted.entry(id).state, 'blocked');
  f.setProof({
    runId: unknown.id,
    messageId,
    status: 'accepted',
    sourceId: 'source',
    ownerId: 'owner',
    turnId: 'turn',
  });
  restarted.observe();
  assert.equal(restarted.entry(id).runs[0].status, 'accepted');
  assert.equal(restarted.entry(id).state, 'active');
  await restarted.tick();
  assert.equal(restarted.entry(id).runs.length, 1);
});

test('a single-run limit preserves that admitted queue until completion, and expiry still ends a paused schedule', async () => {
  const f = fixture({
      run: async () => ({
        status: 'queued',
        messageId: crypto.randomUUID(),
        sourceId: 'source',
        ownerId: 'owner',
      }),
    }),
    id = f.create({ maxRuns: 1 });
  f.advance(60000);
  await f.store.tick();
  await f.store.tick();
  assert.equal(f.store.entry(id).state, 'active');
  assert.equal(f.store.entry(id).runs.length, 1);
  f.store.control(id, 'pause', human('Pause the schedule'));
  f.advance(3600000);
  await f.store.tick();
  assert.equal(f.store.entry(id).state, 'expired');
  assert.equal(f.store.entry(id).runs[0].status, 'queued');
});

test('a human pause persists through restart during admission and resuming cannot replay the uncertain run', async () => {
  const f = fixture({ run: () => new Promise(() => {}) }),
    id = f.create();
  f.advance(60000);
  void f.store.tick();
  f.store.control(id, 'pause', human('Keep this schedule paused'));
  f.store.close();
  const restarted = new Schedules(f.options);
  assert.equal(restarted.entry(id).state, 'paused');
  assert.equal(restarted.entry(id).reason, 'human_paused');
  assert.equal(restarted.entry(id).runs[0].status, 'unconfirmed');
  restarted.control(id, 'resume', human('Resume this existing schedule'));
  assert.equal(restarted.entry(id).state, 'blocked');
  await restarted.tick();
  assert.equal(restarted.entry(id).runs.length, 1);
});
