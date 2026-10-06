'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startPreview } = require('../candidate/dot-inbox/server.cjs');
const { until } = require('../candidate/dot-inbox/protocol-fixture.cjs');
const { InboxModel } = require('../candidate/dot-inbox/model.js');
const parent = path.resolve(__dirname, '../artifacts/dot-inbox/protocol-tests');
function bound(
  card,
  action = 'reply',
  text = 'Synthetic TLS reply',
  sourceId = card.primarySourceId,
) {
  return {
    ownerId: card.owner.id,
    id: card.id,
    taskKey: card.taskKey,
    sourceId,
    contextRevision: card.contextRevision,
    action,
    text,
    eventId: crypto.randomUUID(),
  };
}
async function request(preview, route, input) {
  const response = await fetch(
    preview.origin + route,
    input
      ? {
          method: 'POST',
          headers: {
            Origin: preview.origin,
            'Content-Type': 'application/json',
            'X-Dot-Preview': 'fixture',
          },
          body: JSON.stringify(input),
        }
      : {},
  );
  const value = await response.json();
  if (!response.ok) throw Error(value.error);
  return value;
}
async function scenario(p, value) {
  return request(p, '/api/scenario', { value });
}
async function setup(t, extra = {}) {
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'wire-'));
  const options = {
    protocolFixtures: true,
    recoveryRoot: path.join(dir, 'recovery'),
    sessionsRoot: path.join(dir, 'sessions'),
    ...extra,
  };
  let preview = await startPreview(options);
  t.after(async () => {
    await preview.close();
  });
  return {
    get p() {
      return preview;
    },
    dir,
    async restart() {
      await preview.close();
      preview = await startPreview(options);
      return preview;
    },
  };
}
function card(preview, index = 1) {
  return preview
    .snapshot()
    .cards.find(
      (card) =>
        card.owner.id === preview.fixture.owners[index].identity.pairId &&
        card.kind !== 'local' &&
        !card.done,
    );
}
test('two actual pinned loopback TLS peers expose duplicate raw source IDs and reject certificate/identity mismatches', async (t) => {
  const { p } = await setup(t);
  const a = card(p, 0),
    b = card(p, 1);
  assert.notEqual(a.owner.id, b.owner.id);
  assert.equal(a.sources[0].id.split(':').at(-1), b.sources[0].id.split(':').at(-1));
  assert.equal(p.snapshot().transport.peers.filter((peer) => peer.online).length, 2);
  assert.equal(p.snapshot().cards.filter((card) => card.status === 'queued').length, 2);
  assert.ok(
    p.fixture.traceRows.some((row) => row.type === 'tls.request' && row.tls.startsWith('TLS')),
  );
  const requests = p.fixture.traceRows.filter((row) => row.type === 'tls.request').length;
  await scenario(p, 'pin-mismatch');
  assert.ok(p.fixture.pinRejected);
  assert.equal(
    p.fixture.traceRows.filter((row) => row.type === 'tls.request').length,
    requests,
    'Wrong pin sends no authenticated HTTP request',
  );
  await scenario(p, 'identity-mismatch');
  assert.equal(card(p).owner.online, false);
  assert.equal(card(p, 0).owner.online, true);
  assert.equal(p.fixture.commands.length, 0);
});
test('normal candidate HTTP route executes primary and grouped-source TLS commands once on their exact owner/context', async (t) => {
  const { p } = await setup(t);
  const b = card(p),
    a = card(p, 0);
  const primary = bound(b),
    secondary = bound(a, 'reply', 'Separate second-source reply', a.sources[1].id);
  assert.equal((await request(p, '/api/action', primary)).result.ownerAccepted, true);
  assert.equal((await request(p, '/api/action', secondary)).result.ownerAccepted, true);
  await request(p, '/api/action', primary);
  assert.equal(p.fixture.commands.length, 2);
  assert.equal(p.fixture.commands[0].hostId, p.fixture.owners[1].identity.id);
  assert.equal(p.fixture.commands[1].sourceId, a.sources[1].id.split(':').at(-1));
  assert.equal(p.fixture.commands[1].contextRevision, a.sourceContextRevision);
  assert.ok(
    card(p, 0).sources[1].messages.some(
      (message) => message.text === 'Separate second-source reply',
    ),
    'Conversation messages arrive in the accepted TLS state, not from direct fixture memory',
  );
  await assert.rejects(
    request(p, '/api/action', { ...bound(a), sourceId: b.primarySourceId }),
    /task or source/,
  );
  await scenario(p, 'context-changed');
  await assert.rejects(request(p, '/api/action', bound(b)), /task or source/);
  assert.equal(p.fixture.commands.length, 2);
});

test('a real TLS queued card opens read-only and recovers without invalid desktop bindings or losing another draft', async (t) => {
  const { p } = await setup(t);
  const { recoveryRecord } = require('../candidate/dot-inbox/desktop/policy.cjs');
  let stored;
  const storage = {
    getItem: () => stored,
    setItem: (_key, raw) => {
      stored = JSON.stringify(recoveryRecord(raw));
    },
  };
  const model = new InboxModel(storage);
  model.update(p.snapshot());
  model.open(card(p));
  model.draft('Keep the exact conversation draft.');
  const queued = model.items().find((c) => c.kind === 'local' && c.sources.length === 0);
  model.open(queued);
  assert.equal(model.persist(), true);
  assert.equal(model.storageError, '');
  assert.equal(model.current().noConversation, true);
  assert.match(model.current().reason, /no source conversation/);
  assert.throws(() => model.token(), /current online conversation/);
  const recovered = new InboxModel(storage);
  recovered.update(p.snapshot(), { reconnect: true });
  assert.equal(recovered.current().item.taskKey, queued.taskKey);
  assert.equal(recovered.current().item.owner.id, queued.owner.id);
  assert.equal(recovered.current().noConversation, true);
  recovered.open(card(p));
  assert.equal(recovered.draft(), 'Keep the exact conversation draft.');
  const oldDraft = recovered.selection.key;
  await scenario(p, 'offline');
  recovered.update(p.snapshot());
  recovered.open(queued);
  assert.equal(recovered.current().noConversation, true);
  assert.equal(recovered.openSaved(oldDraft), true);
  assert.equal(recovered.current().item.owner.online, false);
  assert.equal(recovered.draft(), 'Keep the exact conversation draft.');
  assert.throws(() => recovered.token(), /current online conversation/);
  await scenario(p, 'reconnect');
  recovered.update(p.snapshot());
  assert.equal(recovered.current().stale, false);
  assert.equal(recovered.draft(), 'Keep the exact conversation draft.');
  await scenario(p, 'replace-owner');
  recovered.update(p.snapshot());
  recovered.open(queued);
  assert.equal(recovered.current().noConversation, true);
  assert.equal(recovered.openSaved(oldDraft), true);
  assert.equal(recovered.current().stale, true);
  assert.equal(recovered.draft(), 'Keep the exact conversation draft.');
  assert.throws(() => recovered.token(), /current online conversation/);
  recovered.open(card(p));
  assert.equal(recovered.draft(), '');
  assert.equal(p.fixture.commands.length, 0);
});
test('owner rejects a context changed after dispatch but before synthetic execution over TLS', async (t) => {
  const { p } = await setup(t),
    owner = p.fixture.owners[1],
    execute = owner.host.options.command;
  let release;
  const gate = new Promise((r) => (release = r));
  let waiting = false;
  owner.host.options.command = async (method, input) => {
    waiting = true;
    await gate;
    return execute(method, input);
  };
  const pending = request(p, '/api/action', bound(card(p)));
  await until(() => waiting, 'owner execution gate');
  await scenario(p, 'context-changed');
  release();
  assert.equal((await pending).result.ownerAccepted, false);
  assert.equal(p.fixture.commands.length, 0);
  assert.ok(p.fixture.traceRows.some((row) => row.type === 'owner.binding-rejected'));
});
test('client rejects a TLS acceptance receipt for a different viewer context instead of claiming delivery', async (t) => {
  const { p } = await setup(t),
    owner = p.fixture.owners[1],
    json = owner.host.json.bind(owner.host);
  owner.host.json = (res, status, value) => {
    const copy = structuredClone(value);
    if (copy?.value?.fixtureReceipt)
      copy.value.fixtureReceipt.viewerContextRevision = 'foreign-viewer-context';
    json(res, status, copy);
  };
  const out = await request(p, '/api/action', bound(card(p)));
  assert.equal(out.result.state, 'uncertain');
  assert.equal(out.result.ownerAccepted, false);
  assert.equal(p.fixture.commands.length, 1);
});
test('wire disconnect/reconnect labels the cached owner, rejects offline actions and never redelivers', async (t) => {
  const { p } = await setup(t);
  const input = bound(card(p));
  await scenario(p, 'offline');
  assert.equal(card(p).owner.online, false);
  await assert.rejects(request(p, '/api/action', input), /offline/);
  await scenario(p, 'reconnect');
  assert.equal(card(p).owner.online, true);
  assert.equal(p.fixture.commands.length, 0);
  assert.equal((await request(p, '/api/action', input)).result.ownerAccepted, true);
  await scenario(p, 'offline');
  await scenario(p, 'reconnect');
  assert.equal(p.fixture.commands.length, 1);
});
test('older SSE and delayed command snapshots cannot undo newer task context; late acceptance preserves independent drafts', async (t) => {
  const { p } = await setup(t);
  await scenario(p, 'active');
  const model = new InboxModel();
  model.update(p.snapshot());
  const b = card(p),
    a = card(p, 0);
  model.open(b, b.primarySourceId);
  model.draft('Original exact TLS draft');
  const token = bound(b, 'reply', model.draft());
  model.begin({ ...model.token() }, 'reply', token.eventId);
  await scenario(p, 'peer-late-response');
  const pending = request(p, '/api/action', token);
  await until(() => p.fixture.owners[1].pending.length === 1, 'held TLS acceptance');
  assert.equal(p.journal.value.events.at(-1).state, 'inFlight');
  model.draft('New edit after dispatch');
  model.open(a, a.primarySourceId);
  model.draft('Independent owner A draft');
  await scenario(p, 'changed');
  const newTitle = card(p).title;
  await scenario(p, 'release-response');
  const result = await pending;
  model.update(result.snapshot, { reconnect: true });
  assert.equal(model.draft(), 'Independent owner A draft');
  assert.ok(model.export().drafts.some(([, text]) => text === 'New edit after dispatch'));
  assert.equal(card(p).title, newTitle);
  assert.equal(p.fixture.commands.length, 1);
  await scenario(p, 'duplicate');
  assert.ok(p.fixture.duplicateRejected);
  assert.equal(card(p).title, newTitle);
});
test('accepted-but-lost TLS response remains uncertain and cannot resend after durable process recovery', async (t) => {
  const run = await setup(t);
  const input = bound(card(run.p));
  await scenario(run.p, 'peer-response-loss');
  const outcome = await request(run.p, '/api/action', input);
  assert.equal(outcome.result.state, 'uncertain');
  assert.equal(run.p.fixture.commands.length, 1);
  await request(run.p, '/api/action', input);
  assert.equal(run.p.fixture.commands.length, 1);
  await assert.rejects(
    request(run.p, '/api/action', { ...input, eventId: crypto.randomUUID() }),
    /uncertain|pending|previous reply/,
  );
  await run.restart();
  assert.equal(run.p.journal.value.events[0].state, 'uncertain');
  assert.equal(run.p.fixture.commands.length, 1);
  assert.ok(card(run.p).replyUncertain.includes(input.sourceId));
  await assert.rejects(
    request(run.p, '/api/action', { ...input, eventId: crypto.randomUUID() }),
    /uncertain|pending|previous reply/,
  );
  assert.equal(run.p.fixture.owners[1].executed.size, 1);
});
for (const change of ['forgotten-owner', 'replace-owner'])
  test(
    'late TLS acceptance after ' +
      change +
      ' cannot adopt another owner session or recreate old ownership',
    async (t) => {
      const run = await setup(t);
      const input = bound(card(run.p));
      await scenario(run.p, 'peer-late-response');
      const pending = request(run.p, '/api/action', input);
      await until(() => run.p.fixture.owners[1].pending.length === 1, 'held response');
      await scenario(run.p, change);
      const result = await pending;
      assert.equal(result.result.ownerAccepted, false);
      assert.equal(result.result.state, 'uncertain');
      await scenario(run.p, 'release-response');
      assert.equal(run.p.fixture.commands.length, 1);
      assert.equal(
        run.p.snapshot().cards.some((card) => card.owner.id === input.ownerId),
        false,
      );
      await run.restart();
      assert.equal(
        run.p.snapshot().cards.some((card) => card.owner.id === input.ownerId),
        false,
      );
      assert.equal(run.p.fixture.commands.length, 1);
      if (change === 'forgotten-owner')
        await assert.rejects(scenario(run.p, 'reconnect'), /explicit re-pairing/);
    },
  );
for (const action of ['reviewed', 'snooze', 'done'])
  test(
    action + ' travels through normal TLS routing and cancels obsolete queued escalation durably',
    async (t) => {
      const run = await setup(t);
      await scenario(run.p, 'active');
      await scenario(run.p, 'advance');
      const calls = run.p
        .snapshot()
        .deliveries.filter((delivery) => delivery.kind === 'call' && delivery.state === 'queued');
      assert.ok(calls.length);
      const input = bound(card(run.p), action, '');
      assert.equal((await request(run.p, '/api/action', input)).result.ownerAccepted, true);
      assert.ok(
        run.p
          .snapshot()
          .deliveries.filter((delivery) => delivery.kind === 'call')
          .every((delivery) => delivery.state === 'cancelled'),
      );
      assert.equal(run.p.fixture.commands.at(-1).action, action);
      await run.restart();
      assert.ok(
        run.p
          .snapshot()
          .deliveries.filter((delivery) => delivery.kind === 'call')
          .every((delivery) => delivery.state === 'cancelled'),
      );
      assert.equal(run.p.fixture.commands.length, 1);
    },
  );
test('lost candidate HTTP receipt recovers accepted TLS outcome without reposting, while live input files remain byte-identical', async (t) => {
  fs.mkdirSync(parent, { recursive: true });
  const live = fs.mkdtempSync(path.join(parent, 'read-only-'));
  fs.mkdirSync(path.join(live, 'observer/data'), { recursive: true });
  const queue = new (require('../src/queue.cjs').Queue)(path.join(live, 'source'));
  queue.setFeed({ threads: [] });
  fs.writeFileSync(path.join(live, 'state.json'), JSON.stringify(queue.state));
  fs.writeFileSync(
    path.join(live, 'observer/data/feed.json'),
    JSON.stringify({ threads: [], collectedAt: Math.floor(Date.now() / 1000) }),
  );
  fs.writeFileSync(path.join(live, 'observer/data/health.json'), JSON.stringify({ ok: true }));
  const files = ['state.json', 'observer/data/feed.json', 'observer/data/health.json'];
  const hashes = () =>
    files.map((file) =>
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(live, file)))
        .digest('hex'),
    );
  const before = hashes();
  const run = await setup(t, { liveRoot: live });
  const input = bound(card(run.p));
  await scenario(run.p, 'receipt-loss');
  await assert.rejects(request(run.p, '/api/action', input));
  assert.equal(run.p.journal.value.events[0].ownerAccepted, true);
  await run.restart();
  assert.equal((await request(run.p, '/api/state')).preview.actionEvents[0].ownerAccepted, true);
  assert.equal(run.p.fixture.commands.length, 1);
  assert.deepEqual(hashes(), before);
  const trace = fs.readFileSync(run.p.fixture.traceFile, 'utf8');
  assert.ok(trace.includes('client.pin-verified'));
  assert.ok(!trace.includes('Bearer'));
  assert.ok(!trace.includes('PRIVATE KEY'));
  assert.ok(!trace.includes('wu1:'));
});
