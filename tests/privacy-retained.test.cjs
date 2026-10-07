'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  os = require('node:os');
const { Privacy } = require('../src/privacy.cjs');
const { retainedAdapters } = require('../src/privacy-retained-adapters.cjs');
const { DiagnosticLog } = require('../src/diagnostics.cjs');
const { Attachments } = require('../src/attachments.cjs');
const { Documents } = require('../src/documents.cjs');
const { BrowserVault } = require('../src/browser-vault.cjs');
const { BrowserSessions } = require('../src/browser-sessions.cjs');
test('legacy privacy journals preserve original bytes until a human change and newer retention schema refuses unsafe rollback', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-privacy-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'privacy.json'),
    sourceId = crypto.randomUUID();
  const bytes = JSON.stringify({
    version: 1,
    disconnected: [sourceId],
    previews: [],
    operations: [],
  });
  fs.writeFileSync(file, bytes);
  const privacy = new Privacy({
    directory,
    actorId: 'human:local',
    adapters: { notes: { read: () => [] } },
  });
  assert.equal(privacy.state.version, 3);
  assert.equal(privacy.disconnected(sourceId), true);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  privacy.preview(
    {
      role: 'human',
      authority: 'accepted_human',
      actorId: 'human:local',
      messageId: crypto.randomUUID(),
      text: '/privacy preview notes',
    },
    'notes',
  );
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 3);
  const { inspectStores } = require('../src/private-store.cjs');
  const old = { ...require('../src/update-compatibility.json').stores, 'privacy.json': [1,2] };
  assert.throws(() => inspectStores(directory, old), {
    code: 'PRIVATE_STORE_RECOVERY',
    store: 'privacy.json',
  });
});
function fixture(t) {
  const f = require('./fixtures/research-profile.cjs').fixture();
  t.after(() => f.close());
  const voice = { live: null },
    attachments = new Attachments(f.directory);
  const diagnostics = new DiagnosticLog(path.join(f.directory, 'logs'));
  const documents = new Documents({
    directory: f.directory,
    actorId: f.policy.actorId,
    admission: () => 'allow',
  });
  const browserVault = new BrowserVault({
    directory: f.directory,
    available: () => true,
    encrypt: (value) => Buffer.from('synthetic-cipher:' + value),
    decrypt: (bytes) => bytes.toString().slice('synthetic-cipher:'.length),
  });
  const browsers = new BrowserSessions({
    directory: f.directory,
    actorId: f.policy.actorId,
    vault: browserVault,
    admission: () => 'allow',
    verifyBinding: async () => assert.fail('Retention must not open an executor'),
    create: () => assert.fail('Retention must not open a browser'),
  });
  const derived = { state: { checkpoints: [] } };
  const options = {
    directory: f.directory,
    actorId: f.policy.actorId,
    localSource: (id) => id === f.source.id,
    adapters: retainedAdapters({
      directory: f.directory,
      assistant: () => f.assistant,
      research: () => f.research,
      reflections: () => derived,
      messages: () => f.messages,
      attachments,
      voice: () => voice,
      diagnostics: () => diagnostics,
      documents: () => documents,
      browsers: () => browsers,
      browserVault,
    }),
  };
  let privacy = new Privacy(options);
  f.assistant.options.privacy = privacy;
  f.research.options.admission = (scope) =>
    privacy.disconnected(scope.sourceId) || privacy.activeRemoval ? 'deny' : 'allow';
  const input = (text) => ({
    role: 'human',
    authority: 'accepted_human',
    actorId: f.policy.actorId,
    messageId: crypto.randomUUID(),
    text,
  });
  return {
    ...f,
    voice,
    documents,
    browsers,
    browserVault,
    attachments,
    diagnostics,
    derived,
    input,
    get research() {
      return f.research;
    },
    get privacy() {
      return privacy;
    },
    preview: (kind) => privacy.preview(input('/privacy preview ' + kind), kind),
    remove: (preview) =>
      privacy.remove(input('/privacy delete ' + preview.previewId), preview.previewId),
    restartPrivacy() {
      privacy = new Privacy(options);
      f.assistant.options.privacy = privacy;
    },
    seed(relative, bytes) {
      const file = path.join(f.directory, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      return file;
    },
  };
}
test('literal source-extract removal uses owned original records and retains grants, seen/cursor and replay evidence across restart', async (t) => {
  const f = fixture(t),
    enabled = await f.enable(),
    id = enabled.researchId;
  await f.research.read(id, { manual: true });
  const before = f.research.entry(id),
    receipts = structuredClone(f.research.state.receipts);
  assert.ok(before.records.length);
  assert.throws(
    () =>
      f.privacy.preview(
        f.input('/privacy preview source-extracts ' + f.source.id),
        'source-extracts',
        f.source.id,
      ),
    /Disconnect/,
  );
  await f.privacy.disconnect(f.input('/privacy disconnect ' + f.source.id), f.source.id);
  assert.equal(await f.research.read(id, { manual: true }), false);
  const result = await f.ask('/privacy preview source-extracts ' + f.source.id);
  assert.equal(result.status, 'completed', result.answer);
  const preview = JSON.parse(result.answer);
  const exported = f.privacy.export(
    f.input('/privacy export source-extracts ' + f.source.id),
    'source-extracts',
    f.source.id,
  );
  assert.ok(fs.readFileSync(exported.file, 'utf8').includes(before.records[0].text));
  const confirmation = f.input('/privacy delete ' + preview.previewId);
  assert.equal((await f.privacy.remove(confirmation, preview.previewId)).status, 'completed');
  const after = f.research.entry(id);
  assert.deepEqual(after.records, []);
  assert.equal(after.grantId, before.grantId);
  assert.deepEqual(after.seen, before.seen);
  assert.deepEqual(after.cursor, before.cursor);
  assert.deepEqual(f.research.state.receipts, receipts);
  f.restart();
  f.restartPrivacy();
  assert.deepEqual(f.research.entry(id).records, []);
  assert.equal(f.privacy.disconnected(f.source.id), true);
  assert.deepEqual(await f.privacy.remove(confirmation, preview.previewId), {
    status: 'completed',
    noRetry: true,
  });
  assert.equal(f.calls, 0);
});
test('source extracts hold for pending reads, retained reflection derivatives or an independently changed journal', async (t) => {
  const f = fixture(t),
    { researchId: id } = await f.enable();
  await f.research.read(id, { manual: true });
  await f.privacy.disconnect(f.input('/privacy disconnect ' + f.source.id), f.source.id);
  const preview = () =>
    f.privacy.preview(
      f.input('/privacy preview source-extracts ' + f.source.id),
      'source-extracts',
      f.source.id,
    );
  const p = preview();
  f.research.pending.add(id);
  await assert.rejects(f.remove(p), /dependencies changed/);
  f.research.pending.delete(id);
  f.derived.state.checkpoints = [
    {
      context: {
        source: { researchId: id, sourceId: f.source.id },
        records: [{ text: 'Retained derivative' }],
      },
    },
  ];
  assert.ok(preview().dependencies.some((d) => d.includes('Reflection')));
  await assert.rejects(f.remove(p), /dependencies changed/);
  f.derived.state.checkpoints = [];
  const bytes = fs.readFileSync(f.research.file, 'utf8');
  fs.writeFileSync(f.research.file, bytes.replace('synthetic result', 'changed result'));
  assert.throws(preview);
  assert.ok(f.research.entry(id).records.length);
});
test('orphan image deletion preserves draft/history/receipt references and images imported or read in the live session', async (t) => {
  const f = fixture(t),
    names = Array.from({ length: 4 }, () => crypto.randomBytes(32).toString('hex') + '.png');
  names.forEach((name) => f.seed('attachments/' + name, 'owned synthetic bytes'));
  f.assistant.state.messages.push({
    id: 'history',
    text: 'Synthetic',
    answer: 'Kept',
    status: 'completed',
    at: 1,
    links: [],
    images: [{ id: names[0], path: path.join(f.directory, 'attachments', names[0]) }],
  });
  f.assistant.save();
  f.seed(
    'drafts.json',
    JSON.stringify({
      version: 3,
      drafts: {},
      intentIds: {},
      attachments: {
        draft: [{ id: names[1], path: path.join(f.directory, 'attachments', names[1]) }],
      },
    }),
  );
  f.attachments.liveReferences.add(names[2]);
  const p = f.preview('orphan-attachments');
  assert.equal(p.dependencies.length, 0);
  assert.equal((await f.remove(p)).status, 'completed');
  assert.deepEqual(fs.readdirSync(f.attachments.directory).sort(), names.slice(0, 3).sort());
  assert.throws(
    () => f.privacy.export(f.input('/privacy export orphan-attachments'), 'orphan-attachments'),
    /excluded/,
  );
});
test('new live image references, active sends and redirected attachment directories hold deletion', async (t) => {
  const f = fixture(t),
    name = crypto.randomBytes(32).toString('hex') + '.png';
  f.seed('attachments/' + name, 'Owned bytes');
  const p = f.preview('orphan-attachments');
  f.attachments.liveReferences.add(name);
  await assert.rejects(f.remove(p), /dependencies changed/);
  f.attachments.liveReferences.clear();
  f.messages.active.add(f.source.id);
  await assert.rejects(f.remove(p), /dependencies changed/);
  f.messages.active.clear();
  fs.unlinkSync(path.join(f.attachments.directory, name));
  fs.rmdirSync(f.attachments.directory);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-unselected-attachments-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, name), 'Unselected bytes');
  fs.symlinkSync(
    outside,
    f.attachments.directory,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(() => f.preview('orphan-attachments'), /escaped|recovery/);
  assert.equal(fs.readFileSync(path.join(outside, name), 'utf8'), 'Unselected bytes');
});
test('diagnostic backup cleanup removes only exact rotated files and leaves active/future redacted diagnostics', async (t) => {
  const f = fixture(t);
  f.seed('logs/app.log.1', 'Old synthetic diagnostic');
  f.seed('logs/app.log.2', 'Older synthetic diagnostic');
  const active = f.seed('logs/app.log', 'Active synthetic diagnostic\n');
  const unrelated = f.seed('logs/another.log.1', 'Other logger');
  const p = f.preview('diagnostic-backups');
  assert.equal((await f.remove(p)).status, 'completed');
  assert.ok(!fs.existsSync(active + '.1') && !fs.existsSync(active + '.2'));
  assert.ok(fs.readFileSync(active, 'utf8').includes('Active synthetic'));
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'Other logger');
  f.diagnostics.write('test', { password: 'synthetic-sensitive-text', text: 'Private prose' });
  assert.ok(!fs.readFileSync(active, 'utf8').includes('synthetic-sensitive-text'));
  const fresh = f.preview('diagnostic-backups');
  f.seed('logs/app.log.1', 'New rotated bytes');
  await assert.rejects(f.remove(fresh), /dependencies changed/);
});
test('voice key preview exposes only file metadata, requires end before removal and leaves session/action receipts', async (t) => {
  const f = fixture(t),
    keyFile = f.seed('voice-provider.enc', 'Synthetic encrypted key bytes');
  const p = f.preview('voice-configuration');
  assert.ok(!JSON.stringify(p).includes('encrypted key bytes'));
  f.voice.live = { id: crypto.randomUUID() };
  await assert.rejects(f.remove(p), /dependencies changed/);
  assert.ok(fs.existsSync(keyFile));
  f.voice.live = null;
  const foreign = { ...f.input('/privacy delete ' + p.previewId), actorId: 'human:another-owner' };
  await assert.rejects(f.privacy.remove(foreign, p.previewId), /current human/);
  assert.throws(
    () => f.privacy.export(f.input('/privacy export voice-configuration'), 'voice-configuration'),
    /excluded/,
  );
  assert.equal((await f.remove(p)).status, 'completed');
  assert.ok(!fs.existsSync(keyFile));
  assert.ok(f.privacy.inspect().removals.some((o) => o.status === 'completed'));
  f.restartPrivacy();
  assert.equal(f.privacy.options.adapters['voice-configuration'].read(), null);
});

test('document copy preview gives exact file bytes and names, holds active schedules, then removes copies while preserving imports and receipts', async (t) => {
  const f = fixture(t),
    original = f.seed('input.md', 'Synthetic private output\n');
  const spec = { file: original, title: 'Chosen synthetic copy' };
  const imported = f.documents.import(f.input('/document import ' + JSON.stringify(spec)), spec);
  const id = imported.id,
    document = f.documents.read(id);
  const schedule = {
    revision: document.revision,
    everySeconds: 60,
    until: Date.now() + 360000,
    maxRuns: 2,
    append: '\nBounded output',
  };
  const rule = f.documents.schedule(
    f.input('/document schedule ' + id + ': ' + JSON.stringify(schedule)),
    id,
    schedule,
  );
  const p = f.preview('document-copies');
  assert.equal(p.retainedBytes, fs.statSync(document.file).size);
  assert.equal(p.affected.files[0].title, spec.title);
  await assert.rejects(f.remove(p), /dependencies changed/);
  f.documents.cancel(f.input('/document cancel ' + rule.scheduleId), rule.scheduleId);
  assert.equal((await f.remove(f.preview('document-copies'))).status, 'completed');
  assert.ok(!fs.existsSync(document.file));
  assert.equal(fs.readFileSync(original, 'utf8'), 'Synthetic private output\n');
  assert.equal(f.documents.state.documents[0].id, id);
  const restarted = new Documents(f.documents.options);
  assert.throws(() => restarted.read(id));
  restarted.tick();
  assert.ok(!fs.existsSync(document.file));
  assert.throws(
    () => f.privacy.export(f.input('/privacy export document-copies'), 'document-copies'),
    /excluded/,
  );
  const alternate = path.join(f.directory, 'unselected-document-copies');
  fs.renameSync(f.documents.library, alternate);
  fs.symlinkSync(alternate, f.documents.library, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.preview('document-copies'), /recovery/);
});
test('saved login preview selects the exact human owner without cookie values and holds live browsers, changed keys and redirected vaults', async (t) => {
  const f = fixture(t),
    origin = 'https://example.test';
  const own = f.browserVault.save(f.policy.actorId, origin, [
    { name: 'session', value: 'synthetic-cookie-value' },
  ]);
  const other = f.browserVault.save('human:unselected', origin, [
    { name: 'session', value: 'unselected-cookie-value' },
  ]);
  const unselected = path.join(f.browserVault.directory, other + '.enc'),
    before = fs.readFileSync(unselected);
  const p = f.preview('browser-logins');
  assert.equal(p.affected.files.length, 1);
  assert.equal(p.affected.files[0].origin, origin);
  assert.ok(!JSON.stringify(p).includes('cookie-value'));
  f.browsers.live.set('fixture', { pending: false });
  await assert.rejects(f.remove(p), /dependencies changed/);
  f.browsers.live.clear();
  const ownFile = path.join(f.browserVault.directory, own + '.enc'),
    bytes = fs.readFileSync(ownFile);
  fs.appendFileSync(ownFile, ' ');
  await assert.rejects(f.remove(p), /dependencies changed/);
  fs.writeFileSync(ownFile, bytes);
  assert.equal((await f.remove(f.preview('browser-logins'))).status, 'completed');
  assert.ok(!fs.existsSync(ownFile));
  assert.deepEqual(fs.readFileSync(unselected), before);
  assert.throws(
    () => f.privacy.export(f.input('/privacy export browser-logins'), 'browser-logins'),
    /excluded/,
  );
  fs.unlinkSync(unselected);
  fs.rmdirSync(f.browserVault.directory);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-unselected-vault-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(
    outside,
    f.browserVault.directory,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(() => f.preview('browser-logins'), /recovery/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('large affected-file previews stay readable through the actual Assistant and retain their confirmation and omission counts', async (t) => {
  const f = fixture(t),
    file = f.seed('input.md', 'Owned output');
  for (let index = 0; index < 18; index++) {
    const spec = { file, title: ('Synthetic copy ' + index + ' ').padEnd(160, 'x') };
    f.documents.import(f.input('/document import ' + JSON.stringify(spec)), spec);
  }
  const answer = await f.ask('/privacy preview document-copies');
  assert.equal(answer.status, 'completed', answer.answer);
  const preview = JSON.parse(answer.answer);
  assert.equal(preview.affected.selectedFiles, 18);
  assert.ok(preview.affected.omittedFiles > 0);
  assert.equal(preview.confirmation, '/privacy delete ' + preview.previewId);
  assert.equal(preview.retainedBytes, 18 * Buffer.byteLength('Owned output'));
  assert.equal(f.documents.state.documents.length, 18);
  assert.equal(f.calls, 0);
});
