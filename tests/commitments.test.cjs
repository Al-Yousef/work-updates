'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { Commitments } = require('../src/commitments.cjs'),
  { inspectStores, atomicJSON } = require('../src/private-store.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-commitment-test-'));
  const store = new Commitments({ directory, humanActorId: 'human-fixture' }),
    human = (text) => ({
      role: 'human',
      authority: 'accepted_human',
      actorId: 'human-fixture',
      messageId: crypto.randomUUID(),
      text,
    });
  t.after(() => {
    store.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('hyphen-commitment-test-'));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return {
    directory,
    store,
    human,
    add: (title) => store.add(human('/commitment add: ' + title), title),
  };
}
test('task identity, defaults, field provenance and explicit corrections survive actual disk read-back and restart', (t) => {
  const f = fixture(t),
    id = f.add('Prepare the synthetic report'),
    patch = {
      owner: 'Synthetic reviewer',
      status: 'blocked',
      deadline: { at: '2026-10-08T17:00:00Z', timeZone: 'America/Toronto' },
      blockers: ['Awaiting fixture input'],
      confidence: 'uncertain',
    },
    literal = JSON.stringify(patch, null, 1),
    h = f.human('/commitment correct ' + id + ': ' + literal);
  assert.equal(f.store.entry(id).provenance.owner.kind, 'local_default');
  f.store.correct(h, id, patch, literal);
  const restarted = new Commitments(f.store.options);
  t.after(() => restarted.close());
  const e = restarted.entry(id);
  assert.equal(e.owner, patch.owner);
  assert.deepEqual(e.deadline, patch.deadline);
  assert.equal(e.provenance.owner.kind, 'user_statement');
  assert.equal(e.provenance.owner.origin.messageId, h.messageId);
  assert.equal(e.history.at(-1).action, 'correct');
  assert.equal(e.confidence, 'uncertain');
});
test('only current accepted human decisions can create, correct, delete or verify obligations', (t) => {
  const f = fixture(t),
    h = f.human('Literal synthetic commitment');
  for (const role of ['assistant', 'source', 'participant', 'memory'])
    assert.throws(() => f.store.add({ ...h, role }, h.text), /accepted human/);
  assert.throws(() => f.store.add({ ...h, actorId: 'other-human' }, h.text), /accepted human/);
  assert.throws(() => f.store.add({ ...h, authority: 'generated' }, h.text), /accepted human/);
  assert.throws(() => f.store.add(h, 'Invented obligation'), /literal human/);
  assert.equal(f.store.snapshot().length, 0);
});
test('original records, suggestions, summaries and human outcomes retain distinct authority', (t) => {
  const f = fixture(t),
    id = f.add('Review the synthetic result');
  for (const kind of ['inferred_suggestion', 'assistant_summary'])
    f.store.attach(f.human('Attach labelled evidence'), id, {
      kind,
      text: 'Maybe this worker completed the goal',
      origin: { role: 'assistant' },
      authority: 'non_authoritative',
    });
  f.store.attach(f.human('Capture original source evidence'), id, {
    kind: 'source_record',
    text: 'Worker said completed',
    origin: { role: 'source' },
    source: {
      sourceId: 'source-fixture',
      ownerId: 'fixture-pc',
      taskKey: 'task-fixture',
      revision: 'revision-fixture',
    },
    coverage: {
      state: 'partial_excerpt',
      collectedAt: Math.floor(Date.now() / 1000),
      exhaustive: false,
      truncated: false,
      gaps: ['Later replies unavailable'],
    },
  });
  assert.equal(f.store.entry(id).status, 'planned');
  assert.equal(f.store.entry(id).confidence, 'human_reported');
  assert.throws(
    () =>
      f.store.attach(f.human('Attach untrusted proof'), id, {
        kind: 'verified_outcome',
        text: 'The source declared success',
        origin: { role: 'source' },
      }),
    /labelled source/,
  );
  f.store.verify(
    f.human('I reviewed the result artifact against my request'),
    id,
    'I reviewed the result artifact against my request',
  );
  const e = f.store.entry(id);
  assert.deepEqual(
    new Set(e.evidence.map((x) => x.kind)),
    new Set([
      'user_statement',
      'source_record',
      'inferred_suggestion',
      'assistant_summary',
      'verified_outcome',
    ]),
  );
  assert.equal(e.confidence, 'human_verified');
  assert.equal(e.evidence.at(-1).verification, 'human_review');
});
test('corrections invalidate earlier verification and reject invented or generated patches', (t) => {
  const f = fixture(t),
    id = f.add('Synthetic task');
  f.store.verify(f.human('Reviewed first result'), id, 'Reviewed first result');
  const patch = { title: 'Changed synthetic task', status: 'planned' },
    h = f.human('Correction: ' + JSON.stringify(patch));
  f.store.correct(h, id, patch);
  assert.equal(f.store.entry(id).verifiedEvidenceId, null);
  assert.equal(f.store.entry(id).confidence, 'human_reported');
  assert.equal(f.store.entry(id).status, 'planned');
  assert.throws(
    () => f.store.correct(f.human('Just a question'), id, { status: 'completed' }),
    /literal JSON/,
  );
  assert.throws(() => f.store.correct(h, id, { confidence: 'human_verified' }), /separate verify/);
  assert.throws(() => f.store.correct(h, id, { permission: 'send' }), /Correct title/);
});
test('scoped deletion removes ledger text and history while preserving other records and replay protection', (t) => {
  const f = fixture(t),
    h = f.human('Private synthetic old-title-marker'),
    id = f.store.add(h, h.text),
    other = f.add('Other synthetic task');
  f.store.delete(f.human('/commitment delete ' + id), id);
  assert.throws(() => f.store.entry(id), /deleted/);
  assert.equal(f.store.entry(other).title, 'Other synthetic task');
  assert.equal(fs.readFileSync(f.store.file, 'utf8').includes('old-title-marker'), false);
  assert.equal(f.store.add(h, h.text), id);
  assert.equal(f.store.snapshot().length, 1);
  assert.throws(() => f.store.add({ ...h, text: 'Different' }, 'Different'), /another decision/);
});
test('superseding retains the old decision and explicitly identifies its replacement', (t) => {
  const f = fixture(t),
    id = f.add('Old synthetic decision'),
    replacement = f.store.supersede(
      f.human('Use the new synthetic decision'),
      id,
      'new synthetic decision',
    );
  assert.equal(f.store.entry(id).status, 'superseded');
  assert.equal(f.store.entry(id).supersededBy, replacement);
  assert.equal(f.store.entry(replacement).status, 'planned');
  assert.equal(f.store.entry(replacement).title, 'new synthetic decision');
  assert.throws(
    () => f.store.verify(f.human('Reviewed'), id, 'Reviewed'),
    /superseding commitment/,
  );
});
test('atomic storage failure confirms no decision and preserves earlier disk and memory state', (t) => {
  const f = fixture(t),
    id = f.add('Original synthetic title'),
    before = fs.readFileSync(f.store.file),
    patch = { owner: 'Fixture reviewer' };
  f.store.options.write = () => {
    throw new Error('write fixture failed');
  };
  assert.throws(() => f.store.correct(f.human(JSON.stringify(patch)), id, patch), /write fixture/);
  assert.deepEqual(fs.readFileSync(f.store.file), before);
  assert.equal(f.store.entry(id).owner, 'you');
});
test('read-back failure reports an unconfirmed write and stops further ledger mutation', (t) => {
  const f = fixture(t);
  f.store.options.read = () => {
    throw new Error('read fixture failed');
  };
  assert.throws(() => f.add('Actual persisted synthetic title'), /could not be read back/);
  assert.equal(f.store.closed, true);
  assert.equal(JSON.parse(fs.readFileSync(f.store.file)).entries.length, 1);
  assert.throws(() => f.add('Second task'), /unavailable/);
});
test('corrupt, unsupported and old rollback contracts preserve the new ledger bytes', (t) => {
  const f = fixture(t);
  f.add('Synthetic task');
  const before = fs.readFileSync(f.store.file),
    old = { ...require('../src/update-compatibility.json').stores };
  delete old['commitments.json'];
  assert.throws(() => inspectStores(f.directory, old), /incompatible/);
  assert.deepEqual(fs.readFileSync(f.store.file), before);
  for (const contents of ['{invalid', JSON.stringify({ version: 99, entries: [] })]) {
    fs.writeFileSync(f.store.file, contents);
    assert.throws(() => new Commitments(f.store.options), /preserved/);
    assert.equal(fs.readFileSync(f.store.file, 'utf8'), contents);
  }
});
test('preferences are explicit scoped decisions; deletion restores inherited attention behavior', (t) => {
  const f = fixture(t),
    event = { status: 'ready' };
  assert.equal(f.store.attention(event), false);
  f.store.preference(f.human('/PREFERENCE SET NOTIFICATIONS ALL'), 'notifications', 'all');
  assert.equal(f.store.attention(event), true);
  f.store.preference(f.human('/preference set notifications off'), 'notifications', 'off');
  assert.equal(f.store.attention({ status: 'needs', urgent: true }), false);
  f.store.deletePreference(f.human('/preference delete notifications'), 'notifications');
  assert.equal(f.store.attention(event), false);
  assert.throws(
    () => f.store.preference(f.human('How do notifications work?'), 'notifications', 'off'),
    /explicit/,
  );
  assert.throws(
    () => f.store.preference(f.human('/preference set authorization all'), 'authorization', 'all'),
    /separate scoped grants/,
  );
});
test('read-only context is bounded, labelled and never returns deleted content', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 16; i++) f.add('Synthetic record ' + i + ' ' + '.'.repeat(500));
  const id = f.add('Deleted synthetic marker');
  f.store.delete(f.human('/commitment delete ' + id), id);
  const before = fs.readFileSync(f.store.file),
    context = f.store.context();
  assert.ok(context.entries.length <= 8);
  assert.ok(context.coverage.selectedCharacters <= 8000);
  assert.equal(context.coverage.exhaustive, false);
  assert.equal(JSON.stringify(context).includes('Deleted synthetic marker'), false);
  assert.deepEqual(fs.readFileSync(f.store.file), before);
});
test('finite history, evidence, records and deletion caps refuse changes without evicting obligations', (t) => {
  const f = fixture(t),
    id = f.add('Synthetic bounded task'),
    copy = structuredClone(f.store.state),
    e = copy.entries[0];
  while (e.history.length < 64) e.history.push(structuredClone(e.history[0]));
  atomicJSON(f.store.file, copy);
  f.store.state = copy;
  assert.throws(
    () => f.store.correct(f.human('{"status":"blocked"}'), id, { status: 'blocked' }),
    /history is full/,
  );
  assert.equal(f.store.entry(id).status, 'planned');
});

test('deadline corrections require a real calendar instant and a valid named timezone', (t) => {
  const f = fixture(t),
    id = f.add('Synthetic deadline');
  for (const d of [
    { at: '2026-02-30T12:00:00Z', timeZone: 'America/Toronto' },
    { at: '2026-10-08T17:00:00', timeZone: 'America/Toronto' },
    { at: '2026-10-08T17:00:00Z', timeZone: 'Invalid/Zone' },
  ]) {
    const patch = { deadline: d };
    assert.throws(
      () => f.store.correct(f.human(JSON.stringify(patch)), id, patch),
      /Invalid commitment/,
    );
  }
  const patch = { deadline: { at: '2026-10-08T13:00:00-04:00', timeZone: 'America/Toronto' } };
  f.store.correct(f.human(JSON.stringify(patch)), id, patch);
  assert.deepEqual(f.store.entry(id).deadline, patch.deadline);
});

test('full record, deletion and evidence journals refuse mutation without evicting saved tasks', (t) => {
  const f = fixture(t),
    id = f.add('Keep the original synthetic task'),
    base = structuredClone(f.store.state);
  function reopen(state) {
    atomicJSON(f.store.file, state);
    const store = new Commitments(f.store.options);
    t.after(() => store.close());
    return store;
  }
  const records = structuredClone(base);
  while (records.entries.length < 256)
    records.entries.push({ ...structuredClone(records.entries[0]), id: crypto.randomUUID() });
  const full = reopen(records),
    before = fs.readFileSync(full.file);
  assert.throws(
    () => full.add(f.human('Another synthetic task'), 'Another synthetic task'),
    /Invalid commitment journal/,
  );
  assert.equal(full.snapshot().length, 256);
  assert.deepEqual(fs.readFileSync(full.file), before);
  const deletions = structuredClone(base);
  for (let i = 0; i < 256; i++)
    deletions.deleted.push({ id: crypto.randomUUID(), deletedAt: Date.now() });
  const deleted = reopen(deletions);
  assert.throws(
    () => deleted.delete(f.human('/commitment delete ' + id), id),
    /Invalid commitment journal/,
  );
  assert.equal(deleted.entry(id).title, 'Keep the original synthetic task');
  const evidence = structuredClone(base);
  while (evidence.entries[0].evidence.length < 64)
    evidence.entries[0].evidence.push({
      ...structuredClone(evidence.entries[0].evidence[0]),
      id: crypto.randomUUID(),
    });
  const populated = reopen(evidence);
  assert.throws(
    () =>
      populated.attach(f.human('Retain generated suggestion'), id, {
        kind: 'inferred_suggestion',
        text: 'Generated fixture suggestion',
        origin: { role: 'assistant' },
        authority: 'non_authoritative',
      }),
    /evidence is full/,
  );
  assert.equal(populated.entry(id).evidence.length, 64);
});
