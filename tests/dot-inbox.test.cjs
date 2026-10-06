'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { InboxModel, identity, ordered } = require('../candidate/dot-inbox/model.js');
const { startPreview } = require('../candidate/dot-inbox/server.cjs');
const { pairId, localId } = require('../candidate/dot-inbox/fixture.cjs');
async function fixture(t) {
  const value = await startPreview();
  t.after(() => value.close());
  return value;
}
function chooseMac(snapshot) {
  return snapshot.cards.find((c) => c.owner.id === pairId && c.chatName === 'Mac companion');
}
function input(card, extra = {}) {
  return {
    ownerId: card.owner.id,
    id: card.id,
    taskKey: card.taskKey,
    sourceId: card.primarySourceId,
    contextRevision: card.contextRevision,
    eventId: crypto.randomUUID(),
    action: 'reply',
    text: 'Continue with this sample.',
    ...extra,
  };
}
test('dot rests quietly and prioritizes waiting on user then urgency', async (t) => {
  const f = await fixture(t),
    model = new InboxModel();
  model.update(f.snapshot());
  assert.equal(model.attention().count, 0);
  f.choose('active');
  model.update(f.snapshot());
  assert.equal(model.items()[0].owner.id, pairId);
  assert.equal(model.items()[0].chatName, 'Mac companion');
  assert.ok(
    model
      .items()
      .slice(0, 3)
      .every((c) => c.waitingOn.kind === 'you'),
  );
  assert.equal(model.attention().needs, 3);
});
test('Back, collapse and source switching preserve separate owner-bound drafts', async (t) => {
  const f = await fixture(t);
  f.choose('active');
  const model = new InboxModel();
  model.update(f.snapshot());
  const mac = chooseMac(model.snapshot),
    pc = model.snapshot.cards.find((c) => c.owner.id === localId);
  model.open(mac);
  model.draft('Mac draft');
  model.back();
  model.close();
  model.toggle();
  model.open(pc);
  assert.equal(model.draft(), '');
  model.draft('PC draft');
  model.open(pc, pc.sources[1].id);
  assert.equal(model.draft(), '');
  model.draft('Second source draft');
  model.open(mac);
  assert.equal(model.draft(), 'Mac draft');
  model.open(pc);
  assert.equal(model.draft(), 'PC draft');
  model.open(pc, pc.sources[1].id);
  assert.equal(model.draft(), 'Second source draft');
  assert.notEqual(identity(mac), identity(pc));
});
test('offline and reconnect retain context, selected owner and draft without stale overwrite', async (t) => {
  const f = await fixture(t);
  f.choose('active');
  const model = new InboxModel();
  model.update(f.snapshot());
  model.open(chooseMac(model.snapshot));
  model.draft('Keep my draft.');
  const prior = f.snapshot();
  f.choose('offline');
  model.update(f.snapshot());
  assert.equal(model.current().stale, false);
  assert.equal(model.current().item.owner.online, false);
  assert.throws(() => model.token(), /online/);
  f.choose('reconnect');
  model.update(f.snapshot());
  assert.equal(model.current().item.owner.online, true);
  assert.equal(model.draft(), 'Keep my draft.');
  assert.equal(model.update(prior), false);
  assert.equal(model.current().item.owner.id, pairId);
});
test('new task and removed source disable stale actions while retaining earlier drafts', async (t) => {
  const f = await fixture(t);
  f.choose('active');
  const model = new InboxModel();
  model.update(f.snapshot());
  const original = chooseMac(model.snapshot);
  model.open(original);
  model.draft('Original task draft');
  const old = model.token();
  f.choose('changed');
  model.update(f.snapshot());
  assert.equal(model.current().stale, true);
  assert.throws(() => model.token(), /current/);
  await assert.rejects(f.act({ ...old, eventId: crypto.randomUUID(), action: 'reply' }), /changed/);
  model.adoptLatest();
  assert.equal(model.draft(), '');
  assert.equal(model.current().item.title, 'Review a different Mac task');
  f.choose('active');
  model.update(f.snapshot());
  model.open(chooseMac(model.snapshot));
  assert.equal(model.draft(), 'Original task draft');
  f.choose('removed');
  model.update(f.snapshot());
  assert.equal(model.current().stale, true);
  assert.equal(model.latest(), null);
  assert.equal(model.draft(), 'Original task draft');
});
test('mismatched computer/source and read-only data cannot dispatch', async (t) => {
  const f = await fixture(t);
  f.choose('active');
  const card = chooseMac(f.snapshot());
  await assert.rejects(f.act(input(card, { ownerId: localId })), /changed/);
  await assert.rejects(f.act(input(card, { sourceId: 'unrelated-chat' })), /changed/);
  assert.equal(f.fixture.commands.length, 0);
  const model = new InboxModel();
  const snapshot = f.snapshot();
  card.provenance.mode = 'read-only';
  snapshot.cards = [card];
  model.update(snapshot);
  model.open(card);
  assert.throws(() => model.token(), /read-only/);
});
test('reply routes exact namespaced raw duplicate to its computer once', async (t) => {
  const f = await fixture(t);
  f.choose('active');
  const card = chooseMac(f.snapshot()),
    command = input(card);
  const result = await f.act(command);
  assert.equal(result.ownerAccepted, true);
  assert.equal(result.providerAccepted, true);
  const executed = f.fixture.commands.at(-1);
  assert.equal(executed.ownerId, pairId);
  assert.equal(executed.sourceId, '40000000-0000-4000-8000-000000000001');
  assert.equal((await f.act(command)).ownerAccepted, true);
  assert.equal(f.fixture.commands.length, 1);
  const source = chooseMac(f.snapshot()).sources[0];
  assert.equal(source.messages[0].text, command.text);
});
test('a secondary source in an existing grouped task gets the reply itself', async (t) => {
  const f = await fixture(t);
  f.choose('active');
  const card = f.snapshot().cards.find((c) => c.owner.id === localId);
  const result = await f.act(input(card, { sourceId: card.sources[1].id }));
  assert.equal(result.ownerAccepted, true);
  assert.equal(f.fixture.commands.at(-1).sourceId, card.sources[1].id);
  const fresh = f.snapshot().cards.find((c) => c.id === card.id);
  assert.equal(fresh.sources[0].messages.length, 0);
  assert.equal(fresh.sources[1].messages.length, 2);
});
for (const action of ['reviewed', 'snooze'])
  test(action + ' reaches the same item and cancels obsolete queued call previews', async (t) => {
    const f = await fixture(t);
    f.choose('active');
    const card = chooseMac(f.snapshot());
    f.choose('advance');
    assert.ok(f.snapshot().deliveries.some((i) => i.kind === 'call' && i.state === 'queued'));
    const result = await f.act(input(card, { action }));
    assert.equal(result.ownerAccepted, true);
    const state = f.snapshot();
    assert.ok(state.deliveries.some((i) => i.kind === 'call' && i.state === 'cancelled'));
    assert.equal(chooseMac(state).done, false);
    assert.equal(chooseMac(state)[action === 'reviewed' ? 'reviewed' : 'snoozed'], true);
    assert.equal(state.cards.find((c) => c.owner.id === localId).reviewed, false);
  });
test('uncertain acceptance stays distinct, keeps draft and blocks automatic or manual redelivery', async (t) => {
  const f = await fixture(t);
  f.choose('uncertain');
  const model = new InboxModel();
  model.update(f.snapshot());
  model.open(chooseMac(model.snapshot));
  model.draft('Do not lose this draft.');
  const token = model.token();
  const result = await f.act({ ...token, eventId: crypto.randomUUID(), action: 'reply' });
  assert.equal(result.providerAccepted, true);
  assert.equal(result.ownerAccepted, false);
  assert.equal(result.state, 'uncertain');
  model.update(f.snapshot());
  model.finish(token, false);
  assert.equal(model.draft(), token.text);
  await assert.rejects(f.act(input(chooseMac(f.snapshot()))), /previous reply/);
  assert.equal(f.fixture.commands.length, 1);
  f.choose('advance');
  const reviewed = await f.act(input(chooseMac(f.snapshot()), { action: 'reviewed' }));
  assert.equal(reviewed.ownerAccepted, true);
  assert.equal(chooseMac(f.snapshot()).reviewed, true);
  assert.equal(
    f.snapshot().deliveries.some((d) => d.kind === 'call' && d.state === 'queued'),
    false,
  );
  await assert.rejects(f.act(input(chooseMac(f.snapshot()))), /previous reply/);
});
test('late acceptance clears only the sent draft and never switches the selected chat', async (t) => {
  const f = await fixture(t);
  f.choose('active');
  const model = new InboxModel();
  model.update(f.snapshot());
  const mac = chooseMac(model.snapshot),
    pc = model.snapshot.cards.find((c) => c.owner.id === localId);
  model.open(mac);
  model.draft('Sent text');
  const token = model.token();
  model.pending.add(token.key);
  model.draft('Edited while sending');
  model.open(pc);
  model.draft('PC text');
  model.finish(token, true);
  assert.equal(model.selection.item.owner.id, localId);
  assert.equal(model.draft(), 'PC text');
  model.open(mac);
  assert.equal(model.draft(), 'Edited while sending');
});
test('transport restart requires explicit resync and preserves the draft', async (t) => {
  const f = await fixture(t);
  const model = new InboxModel();
  f.choose('active');
  model.update(f.snapshot());
  model.open(chooseMac(model.snapshot));
  model.draft('Restart draft');
  const next = f.snapshot();
  next.stateVersion.epoch = crypto.randomUUID();
  assert.throws(() => model.update(next), /restarted/);
  model.update(next, { reconnect: true });
  assert.equal(model.draft(), 'Restart draft');
});
test('loopback server rejects foreign origin and arbitrary file access', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await fetch(f.origin + '/api/state', { headers: { Origin: 'https://example.com' } })).status,
    403,
  );
  assert.equal(
    (
      await fetch(f.origin + '/api/scenario', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'active' }),
      })
    ).status,
    403,
  );
  assert.equal((await fetch(f.origin + '/state.json')).status, 404);
  assert.match(
    (await fetch(f.origin)).headers.get('content-security-policy'),
    /frame-ancestors 'none'/,
  );
  assert.equal(f.server.address().address, '127.0.0.1');
});
test('delayed peer duplicate cannot replace newer context', async (t) => {
  const f = await fixture(t);
  f.choose('active');
  const old = f.fixture.entry.state;
  f.choose('changed');
  assert.equal(f.fixture.devices.receive(f.fixture.entry, old), false);
  assert.equal(chooseMac(f.snapshot()).title, 'Review a different Mac task');
  assert.ok(ordered(f.snapshot().cards).length);
});

test('optional live snapshots are read-only and cannot dispatch any action', async (t) => {
  const source = await fixture(t);
  source.choose('active');
  const directory = path.join(source.directory, 'read-only-input');
  const files = {
    'state.json': source.fixture.pc.state,
    'observer/data/feed.json': source.fixture.pc.feed,
    'observer/data/health.json': { ok: true },
  };
  const originals = new Map();
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = JSON.stringify(value);
    fs.writeFileSync(file, bytes);
    originals.set(file, bytes);
  }
  const preview = await startPreview({ liveRoot: directory });
  t.after(() => preview.close());
  const cards = preview.snapshot().cards.filter((c) => c.provenance.mode === 'read-only');
  assert.ok(cards.length > 0);
  for (const action of ['reply', 'reviewed', 'snooze'])
    await assert.rejects(
      preview.act(input(cards[0], { action })),
      /Live Codex actions are disabled/,
    );
  assert.equal(preview.fixture.commands.length, 0);
  preview.snapshot();
  for (const [file, bytes] of originals) assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});
