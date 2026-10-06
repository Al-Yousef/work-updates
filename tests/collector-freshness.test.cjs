'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const {
  CollectionReceipt,
  sourceIdentity,
  startReadOnlyObserver,
} = require('../src/read-only-observer.cjs');
const { startObserver } = require('../src/observer.cjs');
const { startPreview } = require('../candidate/dot-inbox/server.cjs');
const { InboxModel, identity } = require('../candidate/dot-inbox/model.js');
const python =
  process.env.WORK_UPDATES_PYTHON ||
  path.join(
    os.homedir(),
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'python',
    'python.exe',
  );
const wait = async (predicate, health = () => ({})) => {
  const limit = Date.now() + 20000;
  while (!predicate()) {
    if (Date.now() > limit) throw new Error('Isolated collector did not reach the expected state: ' + JSON.stringify(health()));
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
};
function source(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-freshness-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'codex');
  fs.mkdirSync(home);
  execFileSync(
    python,
    [
      '-c',
      `import sqlite3,sys,time\nfrom pathlib import Path\nhome=Path(sys.argv[1])\ndb=sqlite3.connect(home/'state_5.sqlite')\ndb.execute('CREATE TABLE threads (id TEXT,name TEXT,title TEXT,preview TEXT,cwd TEXT,rollout_path TEXT,updated_at INTEGER,archived INTEGER,source TEXT)')\ndb.execute('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)',('same-raw-id','PRIVATE LIVE CHAT','PRIVATE TASK','PRIVATE CONTENT','','',int(time.time()),0,'cli'))\ndb.commit();db.close()`,
      home,
    ],
    { windowsHide: true },
  );
  return { dir, home, before: fs.readFileSync(path.join(home, 'state_5.sqlite')) };
}
test('heartbeat renews without chat changes and expires using elapsed time', () => {
  let wall = 1000000,
    clock = 0;
  const r = new CollectionReceipt('owner-source', {
    staleMs: 1000,
    wall: () => wall,
    clock: () => clock,
  });
  const session = crypto.randomUUID();
  r.begin(session);
  const envelope = (sequence) => ({
    session,
    sourceId: 'owner-source',
    sequence,
    ok: true,
    completedAt: wall / 1000,
    feed: { collectedAt: Math.floor(wall / 1000), threads: [{ id: 'one', updatedAt: 10 }] },
  });
  assert.equal(r.accept(envelope(1)), true);
  clock += 900;
  wall += 900;
  assert.equal(r.health().ok, true);
  assert.equal(r.accept(envelope(2)), true);
  assert.equal(r.feed.threads[0].updatedAt, 10);
  clock += 900;
  assert.equal(r.health().ok, true);
  clock += 101;
  assert.equal(r.health().status, 'stale');
  assert.equal(r.health().ok, false);
});
test('late, duplicate, foreign source, future and previous-generation receipts fail closed', () => {
  let wall = 1000000;
  const r = new CollectionReceipt('source', { wall: () => wall, clock: () => wall });
  const session = crypto.randomUUID();
  r.begin(session);
  const e = {
    session,
    sourceId: 'source',
    sequence: 3,
    ok: true,
    completedAt: 1000,
    feed: { collectedAt: 1000, threads: [] },
  };
  assert.equal(r.accept(e), true);
  for (const input of [
    e,
    { ...e, sequence: 2 },
    { ...e, sequence: 4, sourceId: 'another-owner' },
    { ...e, sequence: 4, completedAt: 2000 },
    { ...e, sequence: 4, completedAt: 900 },
  ])
    assert.equal(r.accept(input), false);
  const next = crypto.randomUUID();
  r.begin(next);
  assert.equal(r.health().ok, false);
  assert.equal(r.accept({ ...e, sequence: 99 }), false);
  wall += 10;
  assert.equal(r.accept({ ...e, session: next, sequence: 1, completedAt: wall / 1000 }), true);
  assert.equal(r.health().ok, true);
});
test('error receipt and disconnected process cannot claim an old success as current', () => {
  let clock = 0;
  const r = new CollectionReceipt('source', { wall: () => 1000000, clock: () => clock });
  const session = crypto.randomUUID();
  r.begin(session);
  assert.ok(
    r.accept({
      session,
      sourceId: 'source',
      sequence: 1,
      completedAt: 1000,
      ok: true,
      feed: { collectedAt: 1000, threads: [] },
    }),
  );
  clock = 500;
  assert.ok(r.accept({ session, sourceId: 'source', sequence: 2, completedAt: 1000, ok: false }));
  assert.equal(r.health().status, 'error');
  assert.equal(r.health().ageMs, 500);
  r.disconnect();
  assert.equal(r.health().ok, false);
  assert.equal(
    r.accept({
      session,
      sourceId: 'source',
      sequence: 3,
      completedAt: 1000,
      ok: true,
      feed: { collectedAt: 1000, threads: [] },
    }),
    false,
  );
});
test('Python collector identifies the same canonical source as its Node parent', t => {
  const s = source(t), session = crypto.randomUUID();
  const output = execFileSync(python, ['-X','utf8',path.join(__dirname,'../bridge/collector.py'),
    '--stdio','--once','--codex-home',s.home,'--session',session,'--parent-pid',String(process.pid)],
    {windowsHide:true,encoding:'utf8'});
  const envelope = JSON.parse(output);
  assert.equal(envelope.session,session);
  assert.equal(envelope.sourceId,sourceIdentity(s.home));
  assert.equal(envelope.ok,true,'Synthetic collector failed: ' + envelope.error);
  assert.equal(envelope.feed.threads.length,1);
});

test('actual in-memory Python collector reads unchanged chats, restarts after exit and writes no source/cache files', async (t) => {
  const s = source(t),
    receipts = [];
  const watcher = startReadOnlyObserver(
    { codexHome: s.home, python, pollSeconds: 0.1, retryMs: 40 },
    (feed, health) => {
      if (feed)
        receipts.push({
          sequence: health.sequence,
          generation: health.generation,
          updatedAt: feed.threads[0].updatedAt,
        });
    },
  );
  t.after(() => watcher.close());
  await wait(() => receipts.length >= 3, watcher.health);
  assert.equal(new Set(receipts.map((r) => r.updatedAt)).size, 1);
  const pid = watcher.pid;
  process.kill(pid);
  await wait(() => watcher.pid !== pid && watcher.health().ok, watcher.health);
  assert.ok(watcher.health().restarts >= 1);
  assert.ok(receipts.some((r) => r.generation === 2));
  assert.equal(watcher.sourceId, sourceIdentity(s.home));
  assert.deepEqual(fs.readdirSync(s.home), ['state_5.sqlite']);
  assert.deepEqual(fs.readFileSync(path.join(s.home, 'state_5.sqlite')), s.before);
});
test('file watcher ignores historical OK and automatically restarts a stopped helper', async (t) => {
  const s = source(t),
    root = path.join(s.dir, 'observer');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'data', 'feed.json'),
    JSON.stringify({ collectedAt: Date.now() / 1000, threads: [] }),
  );
  fs.writeFileSync(
    path.join(root, 'data', 'health.json'),
    JSON.stringify({ ok: true, at: Date.now() / 1000 }),
  );
  const events = [];
  const watcher = startObserver(
    root,
    { codexHome: s.home, python, pollSeconds: 1, checkMs: 40, retryMs: 40 },
    (feed, health) => events.push({ feed, health }),
  );
  t.after(() => watcher.close());
  assert.equal(events[0].health.ok, false);
  await wait(() => events.some((e) => e.health.ok));
  const pid = watcher.pid;
  process.kill(pid);
  await wait(() => watcher.pid !== pid && events.at(-1).health.ok);
  assert.ok(events.some((e) => /stopped/.test(e.health.message)));
  assert.deepEqual(fs.readFileSync(path.join(s.home, 'state_5.sqlite')), s.before);
});
test('candidate keeps exact owner/source draft and receipts across stopped/read-only recovery, with private text withheld', async (t) => {
  const s = source(t),
    liveRoot = path.join(s.dir, 'live');
  fs.mkdirSync(path.join(liveRoot, 'observer', 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(liveRoot, 'state.json'),
    JSON.stringify({
      tasks: [],
      cards: { 'same-raw-id': { manual: 'waiting', waitingOn: { kind: 'unknown', name: '' } } },
      done: {},
      groups: [],
      settings: { queueSince: 0 },
    }),
  );
  fs.writeFileSync(
    path.join(liveRoot, 'observer', 'data', 'feed.json'),
    JSON.stringify({ threads: [], collectedAt: 1 }),
  );
  fs.writeFileSync(
    path.join(liveRoot, 'observer', 'data', 'health.json'),
    JSON.stringify({ ok: true, at: 1 }),
  );
  const f = await startPreview({
    liveRoot,
    collectLocal: s.home,
    privacyReview: true,
    sessionsRoot: path.join(s.dir, 'sessions'),
    recoveryRoot: path.join(s.dir, 'recovery'),
    collectorOptions: { python, pollSeconds: 0.1 },
  });
  t.after(() => f.close());
  f.choose('active');
  await wait(() => f.collector.health().ok, f.collector.health);
  const model = new InboxModel();
  model.update(f.snapshot());
  const card = model.snapshot.cards.find((c) => c.provenance.mode === 'read-only');
  assert.equal(JSON.stringify(card).includes('PRIVATE'), false);
  assert.equal(card.label, 'Waiting · owner unclear');
  model.open(card);
  model.draft('Draft for this exact local source.');
  const before = identity(card),
    journal = fs.readFileSync(f.journal.file);
  const staleSnapshot = f.snapshot();
  f.choose('collector-stop');
  model.update(f.snapshot());
  assert.equal(model.current().item.owner.online, false);
  assert.equal(model.draft(), 'Draft for this exact local source.');
  f.choose('collector-reconnect');
  await wait(() => f.collector.health().ok);
  model.update(f.snapshot());
  assert.equal(model.current().item.owner.online, true);
  assert.equal(identity(model.current().item), before);
  assert.equal(model.draft(), 'Draft for this exact local source.');
  assert.equal(model.update(staleSnapshot), false);
  assert.equal(model.snapshot.cards.filter((c) => c.id === card.id).length, 1);
  await assert.rejects(
    f.act({
      ownerId: card.owner.id,
      id: card.id,
      taskKey: card.taskKey,
      sourceId: card.primarySourceId,
      contextRevision: card.contextRevision,
      eventId: crypto.randomUUID(),
      action: 'reply',
      text: 'Do not send',
    }),
    /disabled/,
  );
  assert.deepEqual(fs.readFileSync(f.journal.file), journal);
  assert.deepEqual(f.fixture.commands, []);
  assert.deepEqual(fs.readFileSync(path.join(s.home, 'state_5.sqlite')), s.before);
});
test('different source roots with duplicate raw chat IDs cannot share an owner identity', (t) => {
  const s = source(t),
    other = path.join(s.dir, 'other');
  fs.mkdirSync(other);
  assert.notEqual(sourceIdentity(s.home), sourceIdentity(other));
});

test('a silent live process is replaced and late pipe data from its old generation is ignored', async (t) => {
  const s = source(t),
    children = [];
  let clock = 0;
  const sourceId = sourceIdentity(s.home);
  const watcher = startReadOnlyObserver(
    {
      codexHome: s.home,
      staleMs: 100,
      checkMs: 10,
      retryMs: 10,
      wall: () => 1000000,
      clock: () => clock,
      spawn(_binary, args) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.pid = 90000 + children.length;
        children.push(child);
        child.kill = () => {
          child.emit('exit', 1, null);
          return true;
        };
        child.session = args[args.indexOf('--session') + 1];
        setImmediate(() =>
          child.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                session: child.session,
                sourceId,
                sequence: 1,
                completedAt: 1000,
                ok: true,
                feed: { collectedAt: 1000, threads: [{ id: 'same-raw-id', title: 'current' }] },
              }) + '\n',
            ),
          ),
        );
        return child;
      },
    },
    () => {},
  );
  t.after(() => watcher.close());
  await wait(() => watcher.health().ok);
  clock = 101;
  await wait(() => children.length === 2 && watcher.health().ok);
  assert.equal(watcher.health().generation, 2);
  children[0].stdout.emit(
    'data',
    Buffer.from(
      JSON.stringify({
        session: children[0].session,
        sourceId,
        sequence: 999,
        completedAt: 1000,
        ok: true,
        feed: { collectedAt: 1000, threads: [{ id: 'same-raw-id', title: 'old' }] },
      }) + '\n',
    ),
  );
  assert.equal(watcher.feed.threads[0].title, 'current');
  watcher.pause();
  clock += 200;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(children.length, 2);
  assert.equal(watcher.health().ok, false);
});
