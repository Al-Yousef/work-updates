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
function fixture(t) {
  const f = require('./fixtures/research-profile.cjs').fixture();
  t.after(() => f.close());
  const voice = { live: null },
    attachments = new Attachments(f.directory);
  const diagnostics = new DiagnosticLog(path.join(f.directory, 'logs'));
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
