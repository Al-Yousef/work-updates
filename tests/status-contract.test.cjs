'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { fixtures } = require('./fixtures/status-contract.cjs');
const { compareCards, availability, projectStatus } = require('../src/status-contract.cjs');
const { Queue } = require('../src/queue.cjs');
const { Devices } = require('../src/devices.cjs');
test('shared status fixtures preserve ownership, revisions, fallback states and execution devices in native projection', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-status-fixtures-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const fixture of fixtures(directory)) {
    const card = fixture.frame.cards[0], expected = fixture.expected;
    assert.equal(card.status, expected.status, fixture.id);
    assert.equal(card.label, expected.label, fixture.id);
    if (expected.waiting) assert.equal(card.waitingOn.kind, expected.waiting, fixture.id);
    assert.equal(card.device.kind, expected.deviceKind, fixture.id);
    assert.equal(card.activity, expected.activity, fixture.id);
    assert.equal(card.summaryState, expected.summaryState, fixture.id);
    assert.ok(card.summaryNotice.length > 0);
    assert.notEqual(card.chatName, card.title);
    assert.ok(card.taskKey);
    assert.equal(typeof card.primarySourceId, 'string');
    const devices = new Devices({ directory, identity: { id: 'fixture-viewer', kind: 'pc' }, state: () => fixture.state });
    const peer = { id: 'fixture-peer', state: fixture.state, peer: { connected: fixture.id !== 'offline' } };
    const remote = devices.card(fixture.state.cards[0], peer);
    assert.equal(remote.status, expected.status, fixture.id + ' peer status');
    assert.equal(remote.label, expected.label, fixture.id + ' peer label');
    assert.equal(remote.device.kind, expected.deviceKind, fixture.id + ' execution device');
    assert.equal(remote.summaryState, expected.summaryState, fixture.id + ' peer summary');
    assert.equal(remote.activity, expected.activity, fixture.id + ' peer activity');
    assert.ok(remote.id.startsWith('peer:fixture-peer:'));
    assert.ok(remote.taskKey.startsWith('peer:fixture-peer:'));
    if (fixture.id === 'offline') assert.equal(card.device.online, false);
    if (fixture.id.startsWith('summary-')) {
      assert.equal(card.summaryOrigin, fixture.id === 'summary-cached' ? 'ai' : 'recorded');
      assert.match(card.summary, /fixture/);
    }
  }
});
test('ordering is stable across equal timestamps, invalid dates and reversed input order', () => {
  const cards = [{ id: 'b', status: 'working', at: 1 }, { id: 'a', status: 'working', at: 1 },
    { id: 'urgent', status: 'waiting', urgent: true, at: NaN }, { id: 'you', status: 'needs', at: 0 }];
  const expected = ['you', 'urgent', 'a', 'b'];
  assert.deepEqual([...cards].sort(compareCards).map(c => c.id), expected);
  assert.deepEqual([...cards].reverse().sort(compareCards).map(c => c.id), expected);
});
test('future or stale collector evidence stops activity; an actual local writer has independent provenance', () => {
  for (const at of [0, NaN, 940, 1006]) assert.equal(availability({ collectedAt: at, now: 1000 }).state, 'stale');
  const card = { status: 'working', label: 'Working', device: { kind: 'mac' } };
  assert.equal(projectStatus(card, { health: { ok: false } }).activity, false);
  const live = projectStatus(card, { health: { ok: false }, live: true });
  assert.equal(live.status, 'working');
  assert.equal(live.availability.provenance, 'local-writer');
});
test('reading and reviewing do not finish a task; explicit completion and reopening are separate', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-status-actions-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const q = new Queue(directory), task = q.create({ title: 'Review fixture', prompt: 'A fixture.' });
  q.patch(task.id, { status: 'ready', notificationVersion: 'v1' });
  q.get(task.id);
  assert.equal(task.status, 'ready');
  q.action(task.id, 'reviewed');
  assert.equal(task.status, 'ready');
  q.action(task.id, 'done');
  assert.equal(task.status, 'done');
  q.action(task.id, 'reopen');
  assert.equal(task.status, 'queued');
});
