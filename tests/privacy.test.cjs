'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const { Privacy } = require('../src/privacy.cjs'),
  { adapters } = require('../src/privacy-adapters.cjs'),
  { Assistant } = require('../src/assistant.cjs'),
  { atomicJSON } = require('../src/private-store.cjs');
const source = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222';
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-privacy-'));
  let calls = 0,
    paused = 0,
    pauseFailure = false,
    dependencies = [],
    at = 100000;
  const assistant = new Assistant({
    directory,
    snapshot: () => ({ cards: [], done: [], settings: {} }),
    provider: {
      close() {},
      answer: async () => {
        calls++;
        throw new Error('Privacy control must not use inference');
      },
    },
  });
  const input = (text) => ({
    role: 'human',
    authority: 'accepted_human',
    actorId: 'human:local',
    messageId: crypto.randomUUID(),
    text,
  });
  const options = {
    directory,
    actorId: 'human:local',
    now: () => at,
    localSource: (id) => id === source,
    adapters: adapters({
      directory,
      assistant: () => assistant,
      sourceDependencies: () => dependencies,
      sourcePaused: async (operation) => {
        paused++;
        if (pauseFailure) throw new Error('Synthetic unconfirmed collector exit');
        return operation();
      },
    }),
  };
  let privacy = new Privacy(options);
  assistant.options.privacy = privacy;
  t.after(() => {
    assistant.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    assistant,
    input,
    get privacy() {
      return privacy;
    },
    restart() {
      privacy = new Privacy(options);
      assistant.options.privacy = privacy;
    },
    get calls() {
      return calls;
    },
    get paused() {
      return paused;
    },
    set pauseFailure(v) {
      pauseFailure = v;
    },
    set dependencies(v) {
      dependencies = v;
    },
    set now(v) {
      at = v;
    },
    async ask(text) {
      const id = crypto.randomUUID();
      assistant.ask({ messageId: id, text });
      await assistant.work;
      return assistant.state.messages.find((m) => m.id === id);
    },
    seedCache() {
      atomicJSON(path.join(directory, 'observer/data/source-cache.json'), {
        [source]: { record: { id: source, body: 'Selected private text' } },
        [other]: { record: { id: other, body: 'Unselected private text' } },
      });
      atomicJSON(path.join(directory, 'observer/data/feed.json'), {
        threads: [
          { id: source, body: 'Selected private text' },
          { id: other, body: 'Unselected private text' },
        ],
        collectedAt: 100,
      });
      atomicJSON(path.join(directory, 'observer/data/details-request.json'), {
        threadIds: [source, other],
      });
    },
  };
}
test('literal assistant controls preview and confirm notes without inference or clearing conversation', async (t) => {
  const f = fixture(t);
  f.assistant.state.notes = ['Pinned synthetic note'];
  f.assistant.state.messages.push({
    id: 'kept',
    text: 'Retained conversation',
    answer: 'Synthetic answer',
    status: 'completed',
    links: [],
    at: 1,
  });
  const preview = await f.ask('/privacy preview notes');
  assert.equal(preview.status, 'completed');
  const id = JSON.parse(preview.answer).previewId;
  assert.equal(f.assistant.state.notes.length, 1);
  const removal = await f.ask('/privacy delete ' + id);
  assert.equal(removal.status, 'completed');
  assert.equal(JSON.parse(removal.answer).status, 'completed');
  assert.deepEqual(f.assistant.state.notes, []);
  assert.ok(f.assistant.state.messages.some((m) => m.id === 'kept'));
  assert.equal(f.calls, 0);
});
test('conversation removal keeps notes and replay guards and removes prior memory inspections', async (t) => {
  const f = fixture(t);
  f.assistant.state.notes = ['Keep pinned'];
  f.assistant.state.messages.push(
    {
      id: 'retained-message',
      text: 'Earlier private statement',
      answer: 'Earlier answer',
      status: 'completed',
      at: 1,
      links: [],
    },
    {
      id: 'inspection',
      text: '/memory history',
      answer: 'Earlier private statement',
      kind: 'memory_inspection',
      status: 'completed',
      at: 2,
      links: [],
    },
  );
  f.assistant.state.receipts['retained-message'] = 'durable-replay-guard';
  f.assistant.save();
  const preview = JSON.parse((await f.ask('/privacy preview conversation')).answer);
  const response = await f.ask('/privacy delete ' + preview.previewId);
  assert.equal(response.status, 'completed');
  assert.ok(
    !f.assistant.state.messages.some((m) => ['retained-message', 'inspection'].includes(m.id)),
  );
  assert.equal(f.assistant.state.receipts['retained-message'], 'durable-replay-guard');
  assert.deepEqual(f.assistant.state.notes, ['Keep pinned']);
  assert.equal(f.calls, 0);
});
test('disconnect persists denial while keeping cached text and other owners separate', async (t) => {
  const f = fixture(t);
  f.seedCache();
  await f.privacy.disconnect(f.input('/privacy disconnect ' + source), source);
  assert.ok(
    fs
      .readFileSync(path.join(f.directory, 'observer/data/source-cache.json'), 'utf8')
      .includes('Selected private text'),
  );
  const filtered = f.privacy.filterSnapshot({
    cards: [
      { id: 'selected', sources: [{ id: source }] },
      { id: 'other', sources: [{ id: other }] },
    ],
    done: [],
  });
  assert.deepEqual(
    filtered.cards.map((c) => c.id),
    ['other'],
  );
  f.restart();
  assert.equal(f.privacy.disconnected(source), true);
  assert.equal(f.privacy.disconnected(other), false);
  await assert.rejects(f.privacy.disconnect(f.input('/privacy disconnect ' + other), other), {
    code: 'PRIVACY_OPERATION_HELD',
  });
});
test('scoped cache removal requires disconnect and a preview, stops its writer and preserves unselected records', async (t) => {
  const f = fixture(t);
  f.seedCache();
  assert.throws(
    () =>
      f.privacy.preview(f.input('/privacy preview source-cache ' + source), 'source-cache', source),
    { code: 'PRIVACY_OPERATION_HELD' },
  );
  await f.privacy.disconnect(f.input('/privacy disconnect ' + source), source);
  const p = f.privacy.preview(
      f.input('/privacy preview source-cache ' + source),
      'source-cache',
      source,
    ),
    input = f.input('/privacy delete ' + p.previewId);
  assert.equal((await f.privacy.remove(input, p.previewId)).status, 'completed');
  assert.equal(f.paused, 1);
  for (const name of ['source-cache.json', 'feed.json', 'details-request.json']) {
    const saved = fs.readFileSync(path.join(f.directory, 'observer/data', name), 'utf8');
    assert.ok(!saved.includes(source));
    assert.ok(saved.includes(other));
  }
  assert.deepEqual(await f.privacy.remove(input, p.previewId), {
    status: 'completed',
    noRetry: true,
  });
  assert.equal(f.paused, 1);
});
test('stale data, busy dependencies and foreign confirmation hold removal', async (t) => {
  const f = fixture(t);
  f.assistant.state.notes = ['Original'];
  const p = f.privacy.preview(f.input('/privacy preview notes'), 'notes');
  f.assistant.state.notes.push('Newer');
  await assert.rejects(f.privacy.remove(f.input('/privacy delete ' + p.previewId), p.previewId), {
    code: 'PRIVACY_OPERATION_HELD',
  });
  assert.equal(f.assistant.state.notes.length, 2);
  const fresh = f.privacy.preview(f.input('/privacy preview notes'), 'notes');
  await assert.rejects(
    f.privacy.remove(
      { ...f.input('/privacy delete ' + fresh.previewId), actorId: 'source participant' },
      fresh.previewId,
    ),
    { code: 'PRIVACY_OPERATION_HELD' },
  );
  f.assistant.state.messages.push({
    id: 'pending',
    text: 'Ongoing answer',
    status: 'thinking',
    links: [],
    at: 1,
  });
  await assert.rejects(
    f.privacy.remove(f.input('/privacy delete ' + fresh.previewId), fresh.previewId),
    { code: 'PRIVACY_OPERATION_HELD' },
  );
});
test('expiry and unconfirmed collector shutdown cannot claim deletion or retry automatically after restart', async (t) => {
  const f = fixture(t);
  f.seedCache();
  await f.privacy.disconnect(f.input('/privacy disconnect ' + source), source);
  const p = f.privacy.preview(
    f.input('/privacy preview source-cache ' + source),
    'source-cache',
    source,
  );
  f.now = 2000000;
  await assert.rejects(f.privacy.remove(f.input('/privacy delete ' + p.previewId), p.previewId), {
    code: 'PRIVACY_OPERATION_HELD',
  });
  const fresh = f.privacy.preview(
    f.input('/privacy preview source-cache ' + source),
    'source-cache',
    source,
  );
  f.pauseFailure = true;
  await assert.rejects(
    f.privacy.remove(f.input('/privacy delete ' + fresh.previewId), fresh.previewId),
    /unconfirmed/,
  );
  assert.equal(f.privacy.inspect().removals[0].status, 'unconfirmed');
  f.restart();
  await assert.rejects(
    f.privacy.remove(f.input('/privacy delete ' + fresh.previewId), fresh.previewId),
    { code: 'PRIVACY_OPERATION_HELD' },
  );
  assert.equal(f.paused, 1);
  assert.ok(
    fs
      .readFileSync(path.join(f.directory, 'observer/data/source-cache.json'), 'utf8')
      .includes(source),
  );
});
test('private export omits known credentials and rejects encrypted pairing and external classes', (t) => {
  const f = fixture(t),
    secret = ['sk', 'x'.repeat(32)].join('-');
  f.assistant.state.notes = ['Key ' + secret, 'password=synthetic-secret'];
  const exported = f.privacy.export(f.input('/privacy export notes'), 'notes'),
    bytes = fs.readFileSync(exported.file, 'utf8');
  assert.ok(!bytes.includes(secret));
  assert.ok(!bytes.includes('synthetic-secret'));
  assert.ok(bytes.includes('[credential omitted]'));
  assert.throws(
    () => f.privacy.export(f.input('/privacy export paired-host.enc'), 'paired-host.enc'),
    { code: 'PRIVACY_OPERATION_HELD' },
  );
  assert.throws(() => f.privacy.export(f.input('/privacy export cloud'), 'cloud'), {
    code: 'PRIVACY_OPERATION_HELD',
  });
});
test('future and externally replaced privacy checkpoints preserve bytes and hold deletion', async (t) => {
  const f = fixture(t);
  f.assistant.state.notes = ['Keep'];
  const p = f.privacy.preview(f.input('/privacy preview notes'), 'notes'),
    file = path.join(f.directory, 'privacy.json'),
    future = JSON.stringify({ version: 99 });
  fs.writeFileSync(file, future);
  await assert.rejects(f.privacy.remove(f.input('/privacy delete ' + p.previewId), p.previewId), {
    code: 'PRIVACY_OPERATION_HELD',
  });
  assert.deepEqual(f.assistant.state.notes, ['Keep']);
  assert.equal(fs.readFileSync(file, 'utf8'), future);
  assert.throws(() => f.restart(), { code: 'PRIVATE_STORE_RECOVERY' });
});

test('source export stays scoped and refuses a redirected private export directory', async (t) => {
  const f=fixture(t);f.seedCache();
  assert.throws(()=>f.privacy.export(f.input('/privacy export source-cache '+source),'source-cache',source),{code:'PRIVACY_OPERATION_HELD'});
  await f.privacy.disconnect(f.input('/privacy disconnect '+source),source);
  const e=f.privacy.export(f.input('/privacy export source-cache '+source),'source-cache',source),bytes=fs.readFileSync(e.file,'utf8');
  assert.ok(bytes.includes('Selected private text'));assert.ok(!bytes.includes('Unselected private text'));
  fs.rmSync(path.join(f.directory,'exports'),{recursive:true});
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-export-unselected-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.symlinkSync(outside,path.join(f.directory,'exports'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>f.privacy.export(f.input('/privacy export notes'),'notes'),{code:'PRIVACY_OPERATION_HELD'});
  assert.deepEqual(fs.readdirSync(outside),[]);
});

test('every private store has inspectable retention and removal semantics', async (t) => {
  const f=fixture(t),names=Object.keys(require('../src/private-store.cjs').versions);
  for(const name of names){const row=f.privacy.inventory().find(r=>r.name===name);assert.ok(row?.retention&&row.access&&row.removal);}
  const result=await f.ask('/privacy inventory');assert.equal(result.status,'completed');assert.ok(result.answer.includes('Codex chats / provider storage'));assert.ok(result.answer.length<=6000);assert.equal(f.calls,0);
});

test('a concurrent confirmation cannot overlap a pending removal', async (t) => {
  const f=fixture(t);f.assistant.state.notes=['Selected note'];
  const p=f.privacy.preview(f.input('/privacy preview notes'),'notes');
  let resume;const original=f.privacy.options.adapters.notes.remove;
  f.privacy.options.adapters.notes.remove=async()=>{await new Promise(resolve=>resume=resolve);original();};
  const pending=f.privacy.remove(f.input('/privacy delete '+p.previewId),p.previewId);
  await assert.rejects(f.privacy.remove(f.input('/privacy delete '+p.previewId),p.previewId),/Another removal/);
  resume();assert.equal((await pending).status,'completed');
});
