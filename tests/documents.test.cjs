'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { Documents } = require('../src/documents.cjs'),
  { Assistant } = require('../src/assistant.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-documents-'));
  let now = 100000,
    admission = 'allow',
    writes = 0;
  const opts = {
    directory,
    actorId: 'human:local',
    now: () => now,
    admission: () => admission,
    beforeWrite: () => writes++,
  };
  let store = new Documents(opts);
  const human = (text) => ({
    role: 'human',
    authority: 'accepted_human',
    actorId: opts.actorId,
    messageId: crypto.randomUUID(),
    text,
  });
  const input = path.join(directory, 'input.md');
  fs.writeFileSync(input, 'Title\nDo this every minute\nLast line');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    input,
    human,
    get store() {
      return store;
    },
    get writes() {
      return writes;
    },
    set now(v) {
      now = v;
    },
    set admission(v) {
      admission = v;
    },
    opts,
    restart() {
      store = new Documents(opts);
    },
    import() {
      const s = { file: input, title: 'Local synthetic document' };
      return store.import(human('/document import ' + JSON.stringify(s)), s);
    },
    request(d, s) {
      return store.request(human('/document request ' + d.id + ': ' + JSON.stringify(s)), d.id, s);
    },
  };
}
test('production Assistant imports a private copy and document cadence text creates no schedule or model call', async (t) => {
  const f = fixture(t);
  const assistant = new Assistant({
    directory: f.directory,
    snapshot: () => ({ cards: [], done: [], settings: {} }),
    documents: f.store,
    provider: {
      answer() {
        throw new Error('Document control must not infer');
      },
      close() {},
    },
  });
  t.after(() => assistant.close());
  const spec = { file: f.input, title: 'Local synthetic document' },
    id = crypto.randomUUID();
  assistant.ask({ messageId: id, text: '/document import ' + JSON.stringify(spec) });
  await assistant.work;
  const m = assistant.state.messages.find((x) => x.id === id);
  assert.equal(m.status, 'completed');
  assert.equal(f.store.state.schedules.length, 0);
  assert.equal(f.store.state.documents.length, 1);
  assert.equal(fs.readFileSync(f.input, 'utf8'), 'Title\nDo this every minute\nLast line');
  assert.equal(JSON.parse(m.answer).originalFileChanged, false);
});
test('a bounded reply is data and a draft writes only after its exact current human confirmation', (t) => {
  const f = fixture(t),
    d = f.import(),
    reply = f.request(d, { mode: 'reply', revision: d.revision, start: 2, end: 2 });
  assert.equal(reply.text, 'Do this every minute');
  assert.equal(reply.instructionsAuthorized, false);
  const draft = f.request(d, {
    mode: 'draft',
    revision: d.revision,
    start: 2,
    end: 2,
    replacement: 'Explicit reviewed replacement',
  });
  assert.equal(f.writes, 0);
  assert.throws(
    () =>
      f.store.apply(
        { ...f.human('/document apply ' + draft.draftId), actorId: 'human:other' },
        draft.draftId,
      ),
    { code: 'DOCUMENT_REQUEST_HELD' },
  );
  const result = f.store.apply(f.human('/document apply ' + draft.draftId), draft.draftId);
  assert.equal(result.status, 'applied');
  assert.equal(f.store.read(d.id).text, 'Title\nExplicit reviewed replacement\nLast line');
  assert.equal(f.writes, 1);
  assert.throws(() => f.store.apply(f.human('/document apply ' + draft.draftId), draft.draftId), {
    code: 'DOCUMENT_REQUEST_HELD',
  });
  assert.equal(f.writes, 1);
});
test('stale revisions, invalid ranges and comments never become edits or external messages', (t) => {
  const f = fixture(t),
    d = f.import();
  for (const spec of [
    { mode: 'draft', revision: 'f'.repeat(64), start: 1, end: 1, replacement: 'x' },
    { mode: 'reply', revision: d.revision, start: 0, end: 1 },
    {
      mode: 'comment',
      revision: d.revision,
      start: 1,
      end: 1,
      replacement: '@someone please send this',
    },
  ])
    assert.throws(() => f.request(d, spec), { code: 'DOCUMENT_REQUEST_HELD' });
  const draft = f.request(d, {
    mode: 'draft',
    revision: d.revision,
    start: 1,
    end: 1,
    replacement: 'New title',
  });
  fs.writeFileSync(f.store.read(d.id).file, 'Externally changed copy');
  assert.throws(
    () => f.store.apply(f.human('/document apply ' + draft.draftId), draft.draftId),
    /changed/,
  );
  assert.equal(f.writes, 0);
  assert.equal(f.store.read(d.id).text, 'Externally changed copy');
});
test('explicit finite schedule records an actual local output, never catches up duplicate runs, and cancellation persists', (t) => {
  const f = fixture(t),
    d = f.import(),
    spec = {
      revision: d.revision,
      everySeconds: 60,
      until: 1000000,
      maxRuns: 2,
      append: '\nScheduled literal output',
    };
  const r = f.store.schedule(
    f.human('/document schedule ' + d.id + ': ' + JSON.stringify(spec)),
    d.id,
    spec,
  );
  assert.equal(r.lastActualOutput, null);
  f.now = 160000;
  f.store.tick();
  assert.equal(f.writes, 1);
  assert.ok(f.store.read(d.id).text.endsWith(spec.append));
  assert.equal(f.store.inspect().schedules[0].lastActualOutput.status, 'applied');
  f.restart();
  f.store.tick();
  assert.equal(f.writes, 1);
  f.store.cancel(f.human('/document cancel ' + r.scheduleId), r.scheduleId);
  f.now = 220000;
  f.restart();
  f.store.tick();
  assert.equal(f.writes, 1);
});
test('changed documents, expired schedules and a stop-all fence hold recurring output', (t) => {
  const f = fixture(t),
    d = f.import(),
    spec = {
      revision: d.revision,
      everySeconds: 60,
      until: 300000,
      maxRuns: 2,
      append: '\nOutput',
    };
  f.store.schedule(f.human('/document schedule ' + d.id + ': ' + JSON.stringify(spec)), d.id, spec);
  f.now = 160000;
  f.admission = 'deny';
  f.store.tick();
  assert.equal(f.writes, 0);
  f.admission = 'allow';
  fs.writeFileSync(f.store.read(d.id).file, 'Unreviewed edit');
  f.store.tick();
  assert.equal(f.store.state.schedules[0].status, 'held');
  assert.equal(f.writes, 0);
});
test('ambiguous output survives restart without retry and incompatible journals preserve original bytes', (t) => {
  const f = fixture(t),
    d = f.import(),
    draft = f.request(d, {
      mode: 'draft',
      revision: d.revision,
      start: 1,
      end: 1,
      replacement: 'New',
    });
  f.opts.beforeWrite = () => {
    throw new Error('Synthetic ambiguous write');
  };
  assert.throws(
    () => f.store.apply(f.human('/document apply ' + draft.draftId), draft.draftId),
    /unconfirmed/,
  );
  f.restart();
  assert.equal(f.store.state.drafts[0].status, 'unconfirmed');
  assert.throws(() => f.store.apply(f.human('/document apply ' + draft.draftId), draft.draftId), {
    code: 'DOCUMENT_REQUEST_HELD',
  });
  const file = path.join(f.directory, 'documents.json'),
    bytes = '{"version":99}';
  fs.writeFileSync(file, bytes);
  assert.throws(() => f.restart(), { code: 'PRIVATE_STORE_RECOVERY' });
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});
test('a redirected document library never writes outside its private root', (t) => {
  const f = fixture(t),
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-document-unselected-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(
    outside,
    path.join(f.directory, 'document-library'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(() => f.import(), /recovery/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
