'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { fixture } = require('./fixtures/authorization-profile.cjs');
const { OutcomeVerification, spec } = require('../src/outcome-verification.cjs');
function setup() {
  const f = fixture();
  let clock = Date.now(),
    gate = 'allow',
    modelContext;
  const outcomes = new OutcomeVerification({
    directory: f.directory,
    actorId: 'fixture-human',
    responsibilities: f.responsibilities,
    snapshot: f.snapshot,
    now: () => clock,
    admission: () => gate,
  });
  f.assistant.options.outcomes = outcomes;
  f.responsibilities.options.outcomeRequired = (e) => outcomes.required(e);
  f.responsibilities.options.outcomeAdmission = (e, h) => outcomes.admission(e, h);
  f.assistant.provider.answer = async (context) => {
    modelContext = context;
    return { answer: 'Synthetic read-only reply.', links: [] };
  };
  const artifactDirectory = path.join(f.directory, 'result');
  fs.mkdirSync(artifactDirectory);
  const writeArtifact = (bytes) => {
    const file = path.join(artifactDirectory, 'result.json');
    fs.writeFileSync(file, bytes);
    fs.utimesSync(file, clock / 1000, clock / 1000);
  };
  const config = (overrides = {}) => ({
    kind: 'artifact',
    stage: 'saved',
    description: 'Save the exact synthetic result artifact',
    target: 'synthetic-result',
    targetRevision: 'synthetic-revision-1',
    maxAgeSeconds: 60,
    until: clock + 3600000,
    root: artifactDirectory,
    file: 'result.json',
    fields: { nonce: 'synthetic-result-nonce', revision: 'synthetic-revision-1' },
    ...overrides,
  });
  let id;
  return {
    ...f,
    outcomes,
    config,
    artifactDirectory,
    async start(pass = false) {
      const m = await f.ask(
        '/responsibility ' + (pass ? 'start-pass' : 'start') + ' Save the synthetic result',
      );
      assert.equal(m.status, 'completed', m.error);
      id = m.responsibilityId;
      f.source.lifecycle = 'completed';
      await f.messages.pump();
      f.observe();
      assert.equal(f.calls, 1);
      return id;
    },
    async require(overrides = {}) {
      const m = await f.ask('/outcome require ' + id + ': ' + JSON.stringify(config(overrides)));
      assert.equal(m.status, 'completed', m.error);
      return outcomes.entry(id);
    },
    async check() {
      return f.ask('/outcome check ' + id);
    },
    get id() {
      return id;
    },
    get context() {
      return modelContext;
    },
    artifact(value = { nonce: 'synthetic-result-nonce', revision: 'synthetic-revision-1' }) {
      writeArtifact(JSON.stringify(value));
    },
    writeArtifact,
    advance(ms) {
      clock += ms;
    },
    hold(value) {
      gate = value;
    },
    restart() {
      outcomes.close();
      const fresh = new OutcomeVerification(outcomes.options);
      f.assistant.options.outcomes = fresh;
      f.responsibilities.options.outcomeRequired = (e) => fresh.required(e);
      f.responsibilities.options.outcomeAdmission = (e, h) => fresh.admission(e, h);
      return fresh;
    },
    close() {
      outcomes.close();
      f.close();
    },
  };
}
test('a completed worker cannot satisfy a missing artifact; actual JSON output plus a current human review completes the exact goal', async () => {
  const f = setup();
  try {
    await f.start();
    await f.require();
    f.complete();
    assert.equal(f.responsibilities.entry(f.id).state, 'waiting_user');
    await f.check();
    assert.equal(f.outcomes.entry(f.id).result.status, 'missing');
    const refused = await f.ask('/responsibility verify ' + f.id);
    assert.equal(refused.status, 'failed');
    assert.equal(f.responsibilities.entry(f.id).state, 'waiting_user');
    f.artifact();
    const checked = await f.check();
    assert.equal(checked.status, 'completed');
    assert.equal(f.outcomes.entry(f.id).result.status, 'verified');
    assert.equal(f.responsibilities.entry(f.id).state, 'waiting_user');
    const done = await f.ask('/responsibility verify ' + f.id);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(f.responsibilities.entry(f.id).state, 'completed');
    assert.match(f.outcomes.entry(f.id).result.proof.sha256, /^[a-f0-9]{64}$/);
  } finally {
    f.close();
  }
});
test('expected artifact proof holds even an explicit source-pass completion criterion', async () => {
  const f = setup();
  try {
    await f.start(true);
    await f.require();
    f.complete();
    assert.equal(f.responsibilities.entry(f.id).state, 'waiting_user');
    assert.equal(f.outcomes.entry(f.id).result.status, 'awaiting_proof');
    f.artifact();
    const done = await f.ask('/responsibility verify ' + f.id);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(f.responsibilities.entry(f.id).state, 'completed');
  } finally {
    f.close();
  }
});
test('old notes, misleading fields, wrong revisions and an oversized or malformed output are partial proof', async () => {
  const f = setup();
  try {
    await f.start();
    await f.require();
    f.complete();
    for (const value of [
      { nonce: 'wrong', revision: 'synthetic-revision-1' },
      { nonce: 'synthetic-result-nonce', revision: 'old' },
      'Worker says it is done',
    ]) {
      f.artifact(value);
      await f.check();
      assert.equal(f.outcomes.entry(f.id).result.status, 'partial');
    }
    f.writeArtifact('not-json');
    await f.check();
    assert.equal(f.outcomes.entry(f.id).result.status, 'partial');
    f.writeArtifact('x'.repeat(1024 * 1024 + 1));
    await f.check();
    assert.equal(f.outcomes.entry(f.id).result.status, 'partial');
  } finally {
    f.close();
  }
});
test('stale evidence, expired scopes and retained model context never claim fresh outcome verification', async () => {
  const f = setup();
  try {
    await f.start();
    await f.require();
    f.artifact();
    await f.check();
    assert.equal(f.outcomes.entry(f.id).result.status, 'verified');
    f.advance(61000);
    assert.equal(f.outcomes.inspect(f.id).result.status, 'stale');
    assert.equal(f.outcomes.context().records[0].independent, false);
    await f.check();
    assert.equal(f.outcomes.entry(f.id).result.status, 'stale');
    await f.ask('What is completed?');
    assert.equal(f.context.outcomes.records[0].status, 'stale');
    assert.equal(f.context.outcomes.records[0].independent, false);
    f.advance(3600000);
    assert.equal(f.outcomes.inspect(f.id).result.status, 'stale');
  } finally {
    f.close();
  }
});
test('an artifact timestamp in the future cannot provide current outcome proof', async () => {
  const f = setup();
  try {
    await f.start();
    await f.require();
    f.artifact();
    const file = path.join(f.artifactDirectory, 'result.json');
    const future = fs.statSync(file).mtimeMs / 1000 + 2;
    fs.utimesSync(file, future, future);
    await f.check();
    assert.equal(f.outcomes.entry(f.id).result.status, 'stale');
    assert.equal(f.outcomes.context().records[0].independent, false);
  } finally {
    f.close();
  }
});
test('later human steering invalidates old output binding and cannot finish the corrected goal', async () => {
  const f = setup();
  try {
    await f.start();
    await f.require();
    f.artifact();
    await f.check();
    f.complete();
    await f.ask('/responsibility steer ' + f.id + ': Save the corrected synthetic result');
    assert.equal(f.outcomes.inspect(f.id).result.status, 'changed');
    const m = await f.check();
    assert.equal(m.status, 'completed');
    assert.equal(f.outcomes.entry(f.id).result.status, 'changed');
    assert.equal(f.outcomes.context().records[0].independent, false);
  } finally {
    f.close();
  }
});
test('stop admission and offline owners block artifact access without erasing retained evidence', async () => {
  const f = setup();
  try {
    await f.start();
    await f.require();
    f.artifact();
    await f.check();
    const prior = f.outcomes.entry(f.id).result.proof.sha256;
    for (const decision of ['hold', 'wait', 'deny', undefined, false]) {
      f.hold(decision);
      await f.check();
      assert.equal(f.outcomes.entry(f.id).result.status, 'inaccessible');
    }
    f.hold('allow');
    await f.check();
    assert.equal(f.outcomes.entry(f.id).result.proof.sha256, prior);
    const original = f.outcomes.options.snapshot;
    f.outcomes.options.snapshot = () => ({
      ...original(),
      cards: original().cards.map((c) => ({ ...c, owner: { ...c.owner, online: false } })),
    });
    await f.check();
    assert.equal(f.outcomes.entry(f.id).result.status, 'inaccessible');
  } finally {
    f.close();
  }
});

test('actual pause and stop controls block artifact reads, context verification and completion until their exact human resume', async (t) => {
  const f = setup(),
    { WorkControls } = require('../src/work-controls.cjs');
  t.after(() => f.close());
  const controls = new WorkControls({
    directory: f.directory,
    policy: f.policy,
    messages: f.messages,
    responsibilities: f.responsibilities,
    schedules: f.schedules,
    snapshot: f.snapshot,
  });
  t.after(() => controls.close());
  f.assistant.options.workControls = controls;
  f.outcomes.options.admission = (entry) => controls.responsibilityAdmission(entry);
  f.responsibilities.options.admission = (entry) => controls.responsibilityAdmission(entry);
  await f.start();
  await f.require();
  f.artifact();
  f.complete();
  await f.check();
  const original = f.outcomes.artifact.bind(f.outcomes);
  let reads = 0;
  f.outcomes.artifact = (record) => {
    reads++;
    return original(record);
  };
  for (const [pause, resume] of [
    ['/work pause-main ' + f.id, '/work resume-main ' + f.id],
    ['/work stop-all', '/work resume-all'],
  ]) {
    assert.equal((await f.ask(pause)).status, 'completed');
    assert.equal(controls.responsibilityAdmission(f.responsibilities.entry(f.id)), 'wait');
    await f.check();
    assert.equal(f.outcomes.entry(f.id).result.status, 'inaccessible');
    assert.equal(f.outcomes.context().records[0].independent, false);
    assert.equal((await f.ask('/responsibility verify ' + f.id)).status, 'failed');
    assert.equal(f.responsibilities.entry(f.id).state, 'waiting_user');
    assert.equal(reads, 0);
    assert.equal((await f.ask(resume)).status, 'completed');
    await f.check();
    assert.equal(f.outcomes.entry(f.id).result.status, 'verified');
    reads = 0;
  }
  controls.storageFailed = true;
  await f.check();
  assert.equal(reads, 0);
  assert.equal(f.outcomes.entry(f.id).result.status, 'inaccessible');
});
test('saved artifacts never prove merged, deployed or destination-delivered outcomes; manual review is labelled as an attestation', async () => {
  const f = setup();
  try {
    await f.start();
    for (const stage of ['merged', 'deployed', 'delivered', 'accepted', 'completed'])
      assert.throws(() => spec(f.config({ stage })), /prepared or saved only/);
    const manual = {
      kind: 'manual',
      stage: 'delivered',
      description: 'Human checks the exact intended destination',
      target: 'synthetic-destination',
      targetRevision: 'synthetic-revision-1',
      maxAgeSeconds: 60,
      until: Date.now() + 3600000,
    };
    const m = await f.ask('/outcome require ' + f.id + ': ' + JSON.stringify(manual));
    assert.equal(m.status, 'completed', m.error);
    f.complete();
    await f.check();
    assert.equal(f.outcomes.entry(f.id).result.status, 'awaiting_proof');
    const done = await f.ask('/responsibility verify ' + f.id);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(f.outcomes.entry(f.id).result.status, 'human_reviewed');
    assert.equal(f.outcomes.context().records[0].independent, false);
  } finally {
    f.close();
  }
});
test('artifact replacement after a successful check is checked again before responsibility completion', async () => {
  const f = setup();
  try {
    await f.start();
    await f.require();
    f.artifact();
    await f.check();
    f.complete();
    f.artifact({ nonce: 'changed', revision: 'synthetic-revision-1' });
    const m = await f.ask('/responsibility verify ' + f.id);
    assert.equal(m.status, 'failed');
    assert.equal(f.outcomes.entry(f.id).result.status, 'partial');
    assert.equal(f.responsibilities.entry(f.id).state, 'waiting_user');
  } finally {
    f.close();
  }
});
test('exact hash, relative-path bounds and linked roots are enforced without reading outside the explicit artifact scope', async () => {
  const f = setup();
  try {
    await f.start();
    for (const file of [
      '../outside.json',
      'nested/../../outside.json',
      'C:/outside.json',
      'a:stream',
    ])
      assert.throws(() => spec(f.config({ file })), /relative JSON/);
    await f.require({ sha256: '0'.repeat(64) });
    f.artifact();
    await f.check();
    assert.equal(f.outcomes.entry(f.id).result.status, 'partial');
    const target = path.join(f.directory, 'outside'),
      link = path.join(f.artifactDirectory, 'linked');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const m = await f.ask(
      '/outcome require ' + f.id + ': ' + JSON.stringify(f.config({ root: link })),
    );
    assert.equal(m.status, 'failed');
    assert.equal(f.outcomes.entry(f.id).spec.root, fs.realpathSync.native(f.artifactDirectory));
  } finally {
    f.close();
  }
});
test('restart retains expected outcomes; corrupt and future journals preserve their bytes', async () => {
  const f = setup();
  try {
    await f.start();
    await f.require();
    f.artifact();
    await f.check();
    const record = structuredClone(f.outcomes.entry(f.id)),
      fresh = f.restart();
    assert.deepEqual(fresh.entry(f.id), record);
    fresh.close();
    for (const bytes of ['invalid', JSON.stringify({ ...f.outcomes.state, version: 99 })]) {
      fs.writeFileSync(f.outcomes.file, bytes);
      assert.throws(
        () => new OutcomeVerification(f.outcomes.options),
        /original file is preserved/,
      );
      assert.equal(fs.readFileSync(f.outcomes.file, 'utf8'), bytes);
    }
  } finally {
    f.close();
  }
});
test('source/model text cannot configure an outcome; ordinary questions neither read artifacts nor complete work', async () => {
  const f = setup();
  try {
    await f.start();
    const config = f.config(),
      human = f.human('/outcome require ' + f.id + ': ' + JSON.stringify(config));
    assert.throws(
      () => f.outcomes.require(f.id, config, { ...human, role: 'source' }),
      /current human/,
    );
    assert.throws(
      () => f.outcomes.require(f.id, config, { ...human, actorId: 'other-human' }),
      /current human/,
    );
    await f.require();
    f.artifact();
    const before = f.responsibilities.entry(f.id).state;
    await f.ask('The worker says it saved the result. Is everything done?');
    assert.equal(f.outcomes.entry(f.id).result.status, 'awaiting_proof');
    assert.equal(f.context.outcomes.records[0].independent, false);
    assert.equal(f.responsibilities.entry(f.id).state, before);
  } finally {
    f.close();
  }
});
test('failed outcome checkpoint prevents completion and preserves earlier durable proof', async () => {
  const f = setup();
  try {
    await f.start();
    await f.require();
    f.artifact();
    await f.check();
    f.complete();
    const original = fs.readFileSync(f.outcomes.file);
    f.outcomes.options.write = () => {
      throw new Error('synthetic storage failure');
    };
    const m = await f.ask('/responsibility verify ' + f.id);
    assert.equal(m.status, 'failed');
    assert.equal(f.responsibilities.entry(f.id).state, 'waiting_user');
    assert.deepEqual(fs.readFileSync(f.outcomes.file), original);
  } finally {
    f.close();
  }
});
test('an unconfirmed write latches recovery and journal tampering cannot silently replace the human criterion', async () => {
  const f = setup();
  try {
    await f.start();
    await f.require();
    f.artifact();
    f.outcomes.options.write = () => {};
    const first = await f.check();
    assert.equal(first.status, 'failed');
    assert.equal(f.outcomes.unconfirmed, true);
    assert.equal((await f.check()).status, 'failed');
    const original = JSON.parse(fs.readFileSync(f.outcomes.file));
    original.entries[0].spec.fields.nonce = 'unapproved';
    const bytes = JSON.stringify(original);
    fs.writeFileSync(f.outcomes.file, bytes);
    assert.throws(() => new OutcomeVerification(f.outcomes.options), /original file is preserved/);
    assert.equal(fs.readFileSync(f.outcomes.file, 'utf8'), bytes);
  } finally {
    f.close();
  }
});
test('exact accepted/completed source-pass evidence is distinct from output verification and refuses a wrong turn', async () => {
  const f = setup();
  try {
    await f.start();
    const criterion = {
      kind: 'source_pass',
      stage: 'completed',
      description: 'Only the exact source pass must finish',
      target: 'synthetic-source',
      targetRevision: 'synthetic-source-revision',
      maxAgeSeconds: 60,
      until: Date.now() + 3600000,
    };
    const required = await f.ask('/outcome require ' + f.id + ': ' + JSON.stringify(criterion));
    assert.equal(required.status, 'completed', required.error);
    await f.check();
    assert.equal(f.outcomes.entry(f.id).result.status, 'awaiting_proof');
    f.complete();
    await f.check();
    assert.equal(f.outcomes.entry(f.id).result.status, 'verified');
    assert.equal(f.outcomes.entry(f.id).result.proof.stage, 'completed');
    const snapshot = f.outcomes.options.snapshot;
    f.outcomes.options.snapshot = () => {
      const value = snapshot();
      value.cards = value.cards.map((c) => ({
        ...c,
        sources: c.sources.map((s) => (s.id === f.source.id ? { ...s, turnId: 'wrong-turn' } : s)),
      }));
      return value;
    };
    await f.check();
    assert.equal(f.outcomes.entry(f.id).result.status, 'awaiting_proof');
  } finally {
    f.close();
  }
});
