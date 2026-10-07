'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  crypto = require('node:crypto');
const { Privacy } = require('../src/privacy.cjs'),
  { retainedAdapters } = require('../src/privacy-retained-adapters.cjs');
async function fixture(t) {
  const f = require('./fixtures/reflection-profile.cjs').fixture();
  t.after(() => f.close());
  f.records[0].text = 'I prefer concise updates. The synthetic deadline needs a human review.';
  const enabled = await f.enableReflection();
  assert.equal(enabled.status, 'completed', enabled.answer);
  await f.research.read(f.researchId, { manual: true });
  const checkpoint = await f.ask('/reflection checkpoint ' + enabled.reflectionId);
  assert.equal(checkpoint.status, 'completed', checkpoint.answer);
  const original = f.reflections.state.checkpoints.at(-1),
    suggestion = original.suggestions[0];
  assert.ok(suggestion);
  const decline = await f.ask(
    '/reflection decline ' +
      enabled.reflectionId +
      ' ' +
      suggestion.id +
      ': Review this after the next update.',
  );
  assert.equal(decline.status, 'completed', decline.answer);
  f.reflections.change((next) =>
    next.leads.push({
      ...original.nextUsefulLead,
      reflectionId: enabled.reflectionId,
      fromCheckpoint: original.id,
      checkpointAt: original.at,
      carriedAt: f.now,
    }),
  );
  const input = (text) => ({
    role: 'human',
    authority: 'accepted_human',
    actorId: f.policy.actorId,
    messageId: crypto.randomUUID(),
    text,
  });
  const options = {
    directory: f.directory,
    actorId: f.policy.actorId,
    now: () => f.now,
    localSource: (id) => id === f.source.id,
    adapters: retainedAdapters({
      directory: f.directory,
      assistant: () => f.assistant,
      research: () => f.research,
      reflections: () => f.reflections,
    }),
  };
  const privacy = new Privacy(options);
  f.assistant.options.privacy = privacy;
  f.research.options.admission = (scope) =>
    privacy.disconnected(scope.sourceId) || privacy.activeRemoval ? 'deny' : 'allow';
  return {
    ...f,
    get reflections() {
      return f.reflections;
    },
    privacy,
    options,
    input,
    original,
    reflectionId: enabled.reflectionId,
  };
}
test('exact human removal clears source reflection text and carried decisions, preserves scopes and replay fences, then permits a separate extract removal', async (t) => {
  const f = await fixture(t),
    before = structuredClone(f.reflections.state);
  assert.throws(
    () =>
      f.privacy.preview(
        f.input('/privacy preview source-reflections ' + f.source.id),
        'source-reflections',
        f.source.id,
      ),
    /Disconnect/,
  );
  await f.privacy.disconnect(f.input('/privacy disconnect ' + f.source.id), f.source.id);
  const blocked = f.privacy.preview(
    f.input('/privacy preview source-extracts ' + f.source.id),
    'source-extracts',
    f.source.id,
  );
  assert.ok(blocked.dependencies.some((d) => d.includes('Reflection')));
  const result = await f.ask('/privacy preview source-reflections ' + f.source.id);
  assert.equal(result.status, 'completed', result.answer);
  const preview = JSON.parse(result.answer);
  assert.deepEqual(preview.affected, { scopes: 1, checkpoints: 1, carriedLeads: 1, decisions: 1 });
  const exported = f.privacy.export(
    f.input('/privacy export source-reflections ' + f.source.id),
    'source-reflections',
    f.source.id,
  );
  assert.ok(fs.readFileSync(exported.file, 'utf8').includes('I prefer concise updates'));
  const confirmation = f.input('/privacy delete ' + preview.previewId);
  assert.equal((await f.privacy.remove(confirmation, preview.previewId)).status, 'completed');
  assert.deepEqual(f.reflections.state.checkpoints, []);
  assert.deepEqual(f.reflections.state.leads, []);
  assert.deepEqual(f.reflections.state.decisions, []);
  assert.deepEqual(f.reflections.state.entries, before.entries);
  assert.deepEqual(f.reflections.state.receipts, before.receipts);
  assert.ok(f.research.entry(f.researchId).records.length);
  f.restartReflection();
  assert.equal(f.reflections.checkpoint(f.reflectionId, f.original.origin), null);
  const restarted = new Privacy(f.options);
  assert.deepEqual(await restarted.remove(confirmation, preview.previewId), {
    status: 'completed',
    noRetry: true,
  });
  const extracts = f.privacy.preview(
    f.input('/privacy preview source-extracts ' + f.source.id),
    'source-extracts',
    f.source.id,
  );
  assert.deepEqual(extracts.dependencies, []);
  await f.privacy.remove(f.input('/privacy delete ' + extracts.previewId), extracts.previewId);
  assert.deepEqual(f.research.entry(f.researchId).records, []);
  assert.equal(await f.research.read(f.researchId, { manual: true }), false);
  assert.equal(f.calls, 0);
});
test('reflection removal preserves another owner and holds active reviews or an independently replaced journal', async (t) => {
  const f = await fixture(t),
    foreign = structuredClone(f.reflections.entry(f.reflectionId)),
    foreignCheckpoint = structuredClone(f.original);
  foreign.id = crypto.randomUUID();
  foreign.origin.actorId = 'human:another-owner';
  foreign.origin.messageId = crypto.randomUUID();
  foreignCheckpoint.id = crypto.randomUUID();
  foreignCheckpoint.reflectionId = foreign.id;
  foreignCheckpoint.origin = {
    ...foreignCheckpoint.origin,
    actorId: foreign.origin.actorId,
    messageId: crypto.randomUUID(),
    text: '/reflection checkpoint ' + foreign.id,
  };
  f.reflections.change((next) => {
    next.entries.push(foreign);
    next.checkpoints.push(foreignCheckpoint);
  });
  await f.privacy.disconnect(f.input('/privacy disconnect ' + f.source.id), f.source.id);
  const preview = () =>
    f.privacy.preview(
      f.input('/privacy preview source-reflections ' + f.source.id),
      'source-reflections',
      f.source.id,
    );
  const p = preview();
  f.reflections.pumping = true;
  await assert.rejects(
    f.privacy.remove(f.input('/privacy delete ' + p.previewId), p.previewId),
    /dependencies changed/,
  );
  f.reflections.pumping = false;
  await f.privacy.remove(f.input('/privacy delete ' + p.previewId), p.previewId);
  assert.deepEqual(f.reflections.state.checkpoints, [foreignCheckpoint]);
  assert.ok(f.reflections.state.entries.some((e) => e.id === foreign.id));
  const changed = structuredClone(f.reflections.state);
  changed.entries[0].reason = 'independent valid change';
  const bytes = JSON.stringify(changed);
  fs.writeFileSync(f.reflections.file, bytes);
  assert.throws(preview, /changed independently/);
  assert.equal(fs.readFileSync(f.reflections.file, 'utf8'), bytes);
});
