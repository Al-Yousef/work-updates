'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { InboxModel, label } = require('../candidate/dot-inbox/model.js');
const { startPreview } = require('../candidate/dot-inbox/server.cjs');
const { pairId, localId } = require('../candidate/dot-inbox/fixture.cjs');
function memoryStore() {
  return {
    value: null,
    fail: false,
    getItem() {
      if (this.fail) throw Error('blocked');
      return this.value;
    },
    setItem(k, v) {
      if (this.fail) throw Error('quota');
      this.value = v;
    },
  };
}
function mac(s) {
  return s.cards.find((c) => c.owner.id === pairId && c.chatName.startsWith('Mac companion'));
}
function token(c, action = 'reply', text = 'Durable synthetic reply') {
  return {
    ownerId: c.owner.id,
    id: c.id,
    taskKey: c.taskKey,
    sourceId: c.primarySourceId,
    contextRevision: c.contextRevision,
    eventId: crypto.randomUUID(),
    action,
    text,
  };
}
async function persistent(t) {
  const parent = path.resolve(__dirname, '../artifacts/dot-inbox');
  fs.mkdirSync(parent, { recursive: true });
  const recoveryRoot = fs.mkdtempSync(path.join(parent, 'durability-test-'));
  let f = await startPreview({ recoveryRoot });
  t.after(async () => {
    await f.close();
    const target = path.resolve(recoveryRoot);
    if (
      target.startsWith(parent + path.sep) &&
      path.basename(target).startsWith('durability-test-')
    )
      fs.rmSync(target, { recursive: true, force: true });
  });
  return {
    get f() {
      return f;
    },
    recoveryRoot,
    async restart() {
      await f.close();
      f = await startPreview({ recoveryRoot });
      return f;
    },
  };
}
test('typed drafts and navigation recover across reload without storing source logs', async (t) => {
  const p = await persistent(t);
  p.f.choose('active');
  const store = memoryStore(),
    m = new InboxModel(store);
  m.update(p.f.snapshot());
  const pc = m.items().find((c) => c.owner.id === localId);
  m.open(mac(m.snapshot));
  m.draft('Mac only');
  m.open(pc);
  m.draft('PC primary only');
  m.open(pc, pc.sources[1].id);
  m.draft('PC secondary only');
  m.close();
  m.persist();
  const saved = store.value;
  assert.equal(saved.includes('Waiting on you to choose'), false);
  assert.equal(saved.includes('Latest mockup'), false);
  const recovered = new InboxModel(store);
  recovered.update(p.f.snapshot());
  assert.equal(recovered.opened, false);
  assert.equal(recovered.draft(), 'PC secondary only');
  recovered.open(mac(recovered.snapshot));
  assert.equal(recovered.draft(), 'Mac only');
  recovered.open(pc);
  assert.equal(recovered.draft(), 'PC primary only');
  recovered.open(pc, pc.sources[1].id);
  assert.equal(recovered.draft(), 'PC secondary only');
  await p.restart();
  recovered.update(p.f.snapshot(), { reconnect: true });
  assert.equal(recovered.draft(), 'PC secondary only');
});
test('changed context, removed source and forgotten owner keep recoverable but stale drafts', async (t) => {
  const p = await persistent(t);
  p.f.choose('active');
  const store = memoryStore(),
    m = new InboxModel(store);
  m.update(p.f.snapshot());
  m.open(mac(m.snapshot));
  m.draft('Earlier context draft');
  m.persist();
  p.f.choose('context-changed');
  const reloaded = new InboxModel(store);
  reloaded.update(p.f.snapshot());
  assert.equal(reloaded.current().stale, true);
  assert.throws(() => reloaded.token(), /Reopen/);
  const oldKey = reloaded.selection.key;
  reloaded.adoptLatest();
  assert.equal(reloaded.draft(), '');
  reloaded.openSaved(oldKey);
  assert.equal(reloaded.draft(), 'Earlier context draft');
  p.f.choose('removed');
  reloaded.update(p.f.snapshot());
  assert.equal(reloaded.current().stale, true);
  assert.equal(reloaded.latest(), null);
  p.f.choose('active');
  p.f.choose('forgotten-owner');
  await p.restart();
  reloaded.update(p.f.snapshot(), { reconnect: true });
  assert.equal(reloaded.current().stale, true);
  assert.equal(reloaded.draft(), 'Earlier context draft');
  assert.throws(() => reloaded.token(), /Reopen/);
});
test('accepted action survives restart and exact duplicate cannot dispatch twice', async (t) => {
  const p = await persistent(t);
  p.f.choose('active');
  const input = token(mac(p.f.snapshot()));
  assert.equal((await p.f.act(input)).ownerAccepted, true);
  await p.restart();
  assert.equal((await p.f.act(input)).ownerAccepted, true);
  assert.equal(p.f.fixture.commands.filter((c) => c.method === 'send').length, 1);
  await assert.rejects(p.f.act({ ...input, eventId: crypto.randomUUID() }), /already accepted/);
  await assert.rejects(p.f.act({ ...input, ownerId: localId }), /different action/);
});
test('interrupted journal intent recovers uncertain without automatic or manual retry', async (t) => {
  const p = await persistent(t);
  p.f.choose('active');
  const input = token(mac(p.f.snapshot()));
  p.f.journal.begin(input);
  await p.restart();
  assert.equal((await p.f.act(input)).state, 'uncertain');
  await assert.rejects(p.f.act({ ...input, eventId: crypto.randomUUID() }), /pending or uncertain/);
  assert.equal(p.f.fixture.commands.length, 0);
});
for (const action of ['reviewed', 'snooze', 'done'])
  test(action + ' cancels recovered queued escalation', async (t) => {
    const p = await persistent(t);
    p.f.choose('active');
    p.f.choose('advance');
    await p.restart();
    assert.equal(
      p.f.snapshot().deliveries.some((d) => d.kind === 'call' && d.state === 'queued'),
      true,
    );
    if (action === 'done') p.f.choose('done');
    else assert.equal((await p.f.act(token(mac(p.f.snapshot()), action))).ownerAccepted, true);
    assert.equal(
      p.f.snapshot().cards.filter((c) => c.owner.id === pairId && c.chatName === 'Mac companion')
        .length,
      1,
    );
    if (action === 'done') assert.equal(label(mac(p.f.snapshot())), 'Done');
    assert.equal(
      p.f.snapshot().deliveries.some((d) => d.kind === 'call' && d.state === 'queued'),
      false,
    );
    await p.restart();
    assert.equal(
      p.f.snapshot().deliveries.some((d) => d.kind === 'call' && d.state === 'queued'),
      false,
    );
    assert.equal(p.f.fixture.commands.filter((c) => c.method === 'send').length, 0);
  });
test('uncertain reply and cancelled escalation survive restart while review/snooze remain usable', async (t) => {
  const p = await persistent(t);
  p.f.choose('uncertain');
  p.f.choose('advance');
  const input = token(mac(p.f.snapshot()));
  assert.equal((await p.f.act(input)).state, 'uncertain');
  await p.restart();
  assert.equal(
    p.f.snapshot().deliveries.some((d) => d.kind === 'call' && d.state === 'cancelled'),
    true,
  );
  for (const action of ['reviewed', 'snooze'])
    assert.equal((await p.f.act(token(mac(p.f.snapshot()), action))).ownerAccepted, true);
  await p.restart();
  assert.equal(p.f.fixture.commands.filter((c) => c.method === 'send').length, 1);
  await assert.rejects(p.f.act({ ...input, eventId: crypto.randomUUID() }), /previous reply/);
});
test('recovered acceptance clears only the sent draft and a late callback cannot switch sources', async (t) => {
  const p = await persistent(t);
  p.f.choose('active');
  const store = memoryStore(),
    m = new InboxModel(store);
  m.update(p.f.snapshot());
  m.open(mac(m.snapshot));
  m.draft('Original sent text');
  const intent = m.begin(m.token(), 'reply', crypto.randomUUID());
  const pc = m.items().find((c) => c.owner.id === localId);
  m.draft('Edited while pending');
  m.open(pc, pc.sources[1].id);
  m.draft('Other source draft');
  m.persist();
  await p.f.act(intent);
  await p.restart();
  const recovered = new InboxModel(store);
  recovered.update(p.f.snapshot());
  assert.equal(recovered.draft(), 'Other source draft');
  assert.equal(recovered.selection.item.owner.id, localId);
  recovered.open(mac(recovered.snapshot));
  assert.equal(recovered.draft(), 'Edited while pending');
  assert.equal(recovered.intents.get(intent.eventId).ownerAccepted, true);
  recovered.finish(intent, true);
  assert.equal(recovered.draft(), 'Edited while pending');
});
test('accepted response loss reconciles from read-only receipts without reposting', async (t) => {
  const p = await persistent(t);
  p.f.choose('active');
  const store = memoryStore(),
    m = new InboxModel(store);
  m.update(p.f.snapshot());
  m.open(mac(m.snapshot));
  m.draft('Lost response sample');
  const intent = m.begin(m.token(), 'reply', crypto.randomUUID());
  p.f.choose('receipt-loss');
  await assert.rejects(
    fetch(p.f.origin + '/api/action', {
      method: 'POST',
      headers: {
        Origin: p.f.origin,
        'X-Dot-Preview': 'fixture',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(intent),
    }),
  );
  const reloaded = new InboxModel(store);
  reloaded.update(p.f.snapshot());
  assert.equal(reloaded.draft(), '');
  assert.equal(reloaded.intents.get(intent.eventId).ownerAccepted, true);
  assert.equal(p.f.fixture.commands.filter((c) => c.method === 'send').length, 1);
});
test('storage failure preserves last saved draft, pauses dispatch and recovers in-memory edits', async (t) => {
  const p = await persistent(t);
  p.f.choose('active');
  const store = memoryStore(),
    m = new InboxModel(store);
  m.update(p.f.snapshot());
  m.open(mac(m.snapshot));
  m.draft('Last durable draft');
  const saved = store.value;
  store.fail = true;
  m.draft('Unsaved memory edit');
  assert.equal(store.value, saved);
  assert.throws(() => m.begin(m.token(), 'reply', crypto.randomUUID()), /storage/);
  assert.equal(m.draft(), 'Unsaved memory edit');
  store.fail = false;
  assert.equal(m.retryStorage(), true);
  const reloaded = new InboxModel(store);
  reloaded.update(p.f.snapshot());
  assert.equal(reloaded.draft(), 'Unsaved memory edit');
  p.f.choose('storage-error');
  await assert.rejects(p.f.act(token(mac(p.f.snapshot()))), /storage/);
  assert.equal(p.f.fixture.commands.length, 0);
  p.f.choose('storage-retry');
  assert.equal(p.f.journal.value.events.length, 0);
});
test('unreadable recovery data is preserved and actions fail closed', async (t) => {
  const p = await persistent(t);
  p.f.choose('active');
  await p.f.close();
  fs.writeFileSync(path.join(p.recoveryRoot, 'recovery.json'), '{broken');
  await p.restart();
  await assert.rejects(
    p.f.act(token(mac(p.f.snapshot()) || p.f.snapshot().cards[0])),
    /cannot be read/,
  );
  assert.equal(fs.readFileSync(path.join(p.recoveryRoot, 'recovery.json'), 'utf8'), '{broken');
  const store = memoryStore();
  store.value = '{broken';
  const m = new InboxModel(store);
  m.persist();
  assert.equal(store.value, '{broken');
  assert.equal(m.retryStorage(), false);
});
test('failure to save an accepted receipt recovers uncertain and cannot repeat the owner action', async (t) => {
  const p = await persistent(t);
  p.f.choose('active');
  const input = token(mac(p.f.snapshot()));
  p.f.journal.receipt = () => {
    throw Error('receipt save interrupted');
  };
  await assert.rejects(p.f.act(input), /receipt save interrupted/);
  assert.equal(p.f.fixture.commands.filter((c) => c.method === 'send').length, 1);
  await p.restart();
  assert.equal((await p.f.act(input)).state, 'uncertain');
  await assert.rejects(p.f.act({ ...input, eventId: crypto.randomUUID() }), /previous reply/);
  assert.equal(p.f.fixture.commands.filter((c) => c.method === 'send').length, 1);
});
