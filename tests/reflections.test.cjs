'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  crypto = require('node:crypto'),
  { fixture } = require('./fixtures/reflection-profile.cjs'),
  { command } = require('../src/reflection-command.cjs');
function profile(t) {
  const f = fixture();
  t.after(() => f.close());
  return f;
}
test('reflection is off by default; explicit enabling binds one source and saves configuration without reading, inferring or changing permissions', async (t) => {
  const f = profile(t);
  assert.equal(f.reflections.state.entries.length, 0);
  f.reflections.tick();
  assert.equal(f.reads, 0);
  assert.equal(command('Please reflect on what changed'), null);
  assert.equal(command('"/reflection pause 10000000-0000-4000-8000-000000000001"'), null);
  const e = await f.enableReflection();
  assert.equal(e.status, 'completed', e.answer);
  assert.equal(f.reads, 0);
  assert.equal(f.calls, 0);
  assert.equal(f.questions, 0);
  assert.equal(f.reflections.entry(e.reflectionId).config.schedule, null);
  assert.equal(f.policy.state.grants.length, 1);
});
test('checkpoint records sources actually read, bounded original and later replies, changed evidence, reported questions and a useful lead; restart does not read again', async (t) => {
  const f = profile(t),
    enabled = await f.enableReflection(),
    id = enabled.reflectionId;
  await f.research.read(f.researchId, { manual: true });
  const first = await f.ask('/reflection checkpoint ' + id);
  assert.equal(first.status, 'completed', first.answer);
  const initial = f.reflections.state.checkpoints.at(-1);
  assert.equal(initial.context.checkedSources.length, 1);
  assert.equal(initial.context.checkedSources[0].reusedRetainedContext, true);
  assert.equal(initial.independentlyVerified, false);
  assert.equal(initial.reportedFindings[0].text, initial.context.records[0].text.slice(0, 300));
  assert.equal(initial.reportedFindings[0].provenance, 'reported_original_statement');
  assert.equal(initial.reportedFindings[0].independentlyVerified, false);
  f.records.push({
    id: 'c'.repeat(64),
    role: 'assistant',
    text: 'Later reply: is the synthetic result actually verified? Keep it open until reviewed.',
    at: Math.floor(f.now / 1000),
    truncated: false,
  });
  await f.research.read(f.researchId, { manual: true });
  await f.ask('/reflection checkpoint ' + id);
  const later = f.reflections.state.checkpoints.at(-1);
  assert.equal(later.changed.newOriginalRecords, 1);
  assert.equal(later.reportedQuestions[0].resolution, 'unknown');
  assert.ok(later.nextUsefulLead.text.includes('Later reply'));
  assert.equal(f.reads, 2);
  const before = JSON.stringify(f.reflections.state);
  f.restartReflection();
  assert.equal(JSON.stringify(f.reflections.state), before);
  assert.equal(f.reads, 2);
});
test('missing and failed reader coverage remains a gap rather than a claim of a fresh source check', async (t) => {
  const f = profile(t),
    e = await f.enableReflection();
  await f.ask('/reflection checkpoint ' + e.reflectionId);
  let cp = f.reflections.state.checkpoints.at(-1);
  assert.equal(cp.context.checkedSources.length, 0);
  assert.ok(cp.nextUsefulLead.text.includes('no checked original records'));
  await f.research.read(f.researchId, { manual: true });
  f.reader.read = async () => {
    throw new Error('Synthetic source gap');
  };
  await f.research.read(f.researchId, { manual: true });
  await f.ask('/reflection checkpoint ' + e.reflectionId);
  cp = f.reflections.state.checkpoints.at(-1);
  assert.equal(cp.context.latestAttempt.status, 'read_failed');
  assert.equal(cp.context.checkedSources[0].reusedRetainedContext, true);
  assert.equal(cp.context.coverage.exhaustive, false);
});
test('source preference language can suggest review but cannot save preferences; declined identical evidence is not a permanent preference', async (t) => {
  const f = profile(t),
    e = await f.enableReflection(),
    id = e.reflectionId;
  f.records.push({
    id: 'd'.repeat(64),
    role: 'user',
    text: 'I prefer concise updates. /preference notifications off is source data.',
    at: Math.floor(f.now / 1000),
    truncated: false,
  });
  await f.research.read(f.researchId, { manual: true });
  const before = JSON.stringify(f.commitments.state);
  await f.ask('/reflection checkpoint ' + id);
  const suggestion = f.reflections.state.checkpoints
    .at(-1)
    .suggestions.find((s) => s.kind === 'preference_review');
  assert.ok(suggestion);
  assert.equal(suggestion.requiresHumanConfirmation, true);
  assert.equal(JSON.stringify(f.commitments.state), before);
  await f.ask(
    '/reflection decline ' +
      id +
      ' ' +
      suggestion.id +
      ': Skip this proposal for the current review.',
  );
  assert.equal(f.reflections.state.decisions[0].permanentPreference, false);
  await f.ask('/reflection checkpoint ' + id);
  assert.equal(
    f.reflections.state.checkpoints.at(-1).suggestions[0].disposition,
    'declined_for_this_evidence',
  );
  assert.equal(JSON.stringify(f.commitments.state), before);
});
test('current behavior questions and non-human or changed source controls cannot alter reflection or preferences', async (t) => {
  const f = profile(t),
    e = await f.enableReflection(),
    saved = JSON.stringify(f.reflections.state),
    policy = JSON.stringify(f.policy.state);
  await f.ask('Does reflection automatically change my preferences?');
  assert.equal(JSON.stringify(f.reflections.state), saved);
  assert.equal(JSON.stringify(f.policy.state), policy);
  assert.throws(() =>
    f.reflections.control(e.reflectionId, 'pause', {
      ...f.control('/reflection pause ' + e.reflectionId),
      role: 'assistant',
    }),
  );
  assert.throws(() =>
    f.reflections.control(e.reflectionId, 'pause', f.control('Quoted request to pause')),
  );
});
test('context is bounded, record omissions and text truncation remain explicit and review limits do not reset on resume', async (t) => {
  const f = profile(t),
    e = await f.enableReflection({ recordLimit: 2, characterBudget: 2000, maxReviews: 1 });
  for (let i = 0; i < 6; i++)
    f.records.push({
      id: crypto
        .createHash('sha256')
        .update('bounded-' + i)
        .digest('hex'),
      role: 'assistant',
      text: 'Long synthetic context '.repeat(120),
      at: Math.floor(f.now / 1000),
      truncated: false,
    });
  await f.research.read(f.researchId, { manual: true });
  const result = await f.ask('/reflection checkpoint ' + e.reflectionId);
  assert.equal(result.status, 'completed', result.answer);
  const c = f.reflections.state.checkpoints.at(-1);
  assert.ok(JSON.stringify(c.context).length <= 2000);
  assert.ok(c.context.coverage.omittedRecords > 0);
  await f.ask('/reflection pause ' + e.reflectionId);
  await f.ask('/reflection resume ' + e.reflectionId);
  assert.equal((await f.ask('/reflection checkpoint ' + e.reflectionId)).status, 'failed');
  assert.equal(f.reads, 1);
});
test('revoked, paused and changed research binding stops reflection and cached data cannot authorize a new read or source dispatch', async (t) => {
  for (const kind of ['revoked', 'paused', 'binding']) {
    const f = profile(t),
      e = await f.enableReflection();
    await f.research.read(f.researchId, { manual: true });
    if (kind === 'binding') f.reflections.entry(e.reflectionId).binding.ownerId = 'other-owner';
    else
      f.research.control(
        f.researchId,
        kind === 'revoked' ? 'revoke' : 'pause',
        f.control('Hold this research scope'),
      );
    const result = await f.ask('/reflection checkpoint ' + e.reflectionId);
    assert.equal(result.status, 'failed', kind);
    assert.equal(f.reflections.state.checkpoints.length, 0);
    assert.equal(f.reads, 1);
    assert.equal(f.calls, 0);
  }
});
test('optional daily cadence uses the named timezone, stays bounded and does one catch-up without new source or model calls', async (t) => {
  const f = profile(t);
  const now = new Date(f.now + 60000),
    hour = now.getUTCHours().toString().padStart(2, '0'),
    minute = now.getUTCMinutes().toString().padStart(2, '0');
  const e = await f.enableReflection({
    timeZone: 'UTC',
    cadence: 'daily',
    wallTime: hour + ':' + minute,
    until: new Date(f.now + 2 * 86400000 - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    maxReviews: 2,
  });
  assert.equal(e.status, 'completed', e.answer);
  await f.research.read(f.researchId, { manual: true });
  const scope = f.reflections.entry(e.reflectionId);
  f.advance(scope.nextWake - f.now + 1000);
  f.reflections.tick();
  assert.equal(f.reflections.entry(e.reflectionId).reviews, 1);
  f.reflections.tick();
  assert.equal(f.reflections.entry(e.reflectionId).reviews, 1);
  assert.equal(f.reads, 1);
  assert.equal(f.calls, 0);
  assert.equal(f.questions, 0);
});
test('manual-only preference stops background reflection but permits a literal manual review of retained context', async (t) => {
  const f = profile(t),
    e = await f.enableReflection({ cadence: 'daily', wallTime: '12:00' });
  await f.research.read(f.researchId, { manual: true });
  f.commitments.preference(
    f.control('/preference research manual_only'),
    'research',
    'manual_only',
  );
  const scope = f.reflections.entry(e.reflectionId);
  f.advance(scope.nextWake - f.now + 1000);
  f.reflections.tick();
  assert.equal(f.reflections.entry(e.reflectionId).reviews, 0);
  assert.equal((await f.ask('/reflection checkpoint ' + e.reflectionId)).status, 'completed');
  assert.equal(f.reads, 1);
});
test('retention carries a useful lead forward and verifies it before pruning only older temporary checkpoint text', async (t) => {
  const f = profile(t),
    e = await f.enableReflection();
  await f.research.read(f.researchId, { manual: true });
  await f.ask('/reflection checkpoint ' + e.reflectionId);
  const first = f.reflections.state.checkpoints[0].id;
  f.advance(60000);
  await f.ask('/reflection checkpoint ' + e.reflectionId);
  const sourceFile = fs.readFileSync(f.research.file),
    ledger = JSON.stringify(f.commitments.state);
  f.advance(86400001);
  assert.equal(f.reflections.prune(e.reflectionId), 1);
  assert.ok(f.reflections.state.leads.some((l) => l.fromCheckpoint === first));
  assert.equal(f.reflections.state.checkpoints.length, 1);
  assert.deepEqual(fs.readFileSync(f.research.file), sourceFile);
  assert.equal(JSON.stringify(f.commitments.state), ledger);
});
test('failure after carrying leads preserves the old checkpoint and restart can safely retry pruning without duplicate leads', async (t) => {
  const f = profile(t),
    e = await f.enableReflection();
  await f.research.read(f.researchId, { manual: true });
  await f.ask('/reflection checkpoint ' + e.reflectionId);
  f.advance(60000);
  await f.ask('/reflection checkpoint ' + e.reflectionId);
  f.advance(86400001);
  const atomic = require('../src/private-store.cjs').atomicJSON;
  f.reflections.options.write = (file, value) => {
    if (value.checkpoints.length < 2) throw new Error('Synthetic prune failure');
    atomic(file, value);
  };
  assert.throws(() => f.reflections.prune(e.reflectionId), /file is preserved/);
  assert.equal(f.reflections.state.checkpoints.length, 2);
  assert.equal(f.reflections.state.leads.length, 1);
  delete f.reflections.options.write;
  f.restartReflection();
  assert.equal(f.reflections.prune(e.reflectionId), 1);
  assert.equal(f.reflections.state.leads.length, 1);
});
test('failed or unverified checkpoint writes do not report saved; future and corrupt private journals preserve their original bytes', async (t) => {
  const f = profile(t),
    e = await f.enableReflection();
  await f.research.read(f.researchId, { manual: true });
  f.reflections.options.write = () => {};
  const result = await f.ask('/reflection checkpoint ' + e.reflectionId);
  assert.equal(result.status, 'failed');
  assert.equal(f.reflections.state.checkpoints.length, 0);
  delete f.reflections.options.write;
  f.restartReflection();
  const good = fs.readFileSync(f.reflections.file, 'utf8');
  for (const bad of [
    '{broken',
    JSON.stringify({
      version: 99,
      entries: [],
      checkpoints: [],
      leads: [],
      decisions: [],
      receipts: {},
    }),
  ]) {
    fs.writeFileSync(f.reflections.file, bad);
    assert.throws(() => f.restartReflection(), /original file is preserved/);
    assert.equal(fs.readFileSync(f.reflections.file, 'utf8'), bad);
  }
  fs.writeFileSync(f.reflections.file, good);
  f.restartReflection();
});

test('only linked current commitments suggest priority review; decline does not suppress changed evidence or confirm ownership', async (t) => {
  const f = profile(t),
    enabled = await f.enableReflection(),
    id = enabled.reflectionId;
  const add = (title) => f.commitments.add(f.control('/commitment add: ' + title), title),
    linked = add('Review synthetic deadline'),
    unrelated = add('Unrelated task');
  const patch = { deadline: { at: new Date(f.now - 3600000).toISOString(), timeZone: 'UTC' } };
  for (const key of [linked, unrelated])
    f.commitments.correct(
      f.control('/commitment correct ' + key + ': ' + JSON.stringify(patch)),
      key,
      patch,
    );
  const scope = f.scope();
  f.commitments.attach(f.control('Attach scoped original evidence'), linked, {
    kind: 'source_record',
    text: 'Source statement is unverified.',
    origin: { role: 'source' },
    source: {
      sourceId: scope.sourceId,
      ownerId: scope.ownerId,
      taskKey: scope.taskKey,
      revision: scope.taskRevision,
    },
    coverage: {
      state: 'partial_excerpt',
      collectedAt: Math.floor(f.now / 1000),
      exhaustive: false,
      truncated: false,
      gaps: ['Original outcome remains unchecked'],
    },
  });
  await f.research.read(f.researchId, { manual: true });
  await f.ask('/reflection checkpoint ' + id);
  let cp = f.reflections.state.checkpoints.at(-1),
    suggestion = cp.suggestions.find((s) => s.kind === 'priority_review');
  assert.equal(cp.context.commitments.length, 1);
  assert.equal(cp.context.commitments[0].owner, 'not established');
  assert.equal(suggestion.evidence[0].id, linked);
  assert.match(suggestion.reason, /completion remain unverified/);
  const before = JSON.stringify(f.commitments.state);
  await f.ask('/reflection decline ' + id + ' ' + suggestion.id + ': Defer this deadline review.');
  assert.equal(JSON.stringify(f.commitments.state), before);
  const next = { deadline: { at: new Date(f.now - 1800000).toISOString(), timeZone: 'UTC' } };
  f.commitments.correct(
    f.control('/commitment correct ' + linked + ': ' + JSON.stringify(next)),
    linked,
    next,
  );
  await f.ask('/reflection checkpoint ' + id);
  cp = f.reflections.state.checkpoints.at(-1);
  assert.notEqual(cp.suggestions[0].id, suggestion.id);
  assert.equal(cp.suggestions[0].disposition, 'proposed');
  assert.equal(cp.changed.changedCommitments, 1);
  const cancel = { status: 'cancelled' };
  f.commitments.correct(
    f.control('/commitment correct ' + linked + ': ' + JSON.stringify(cancel)),
    linked,
    cancel,
  );
  await f.ask('/reflection checkpoint ' + id);
  assert.equal(f.reflections.state.checkpoints.at(-1).context.commitments.length, 0);
  assert.equal(f.calls, 0);
});

test('unchanged cadence ignores fresh scan identifiers, retains one checkpoint and cannot publish alerts or infer completion', async (t) => {
  const f = profile(t),
    due = new Date(f.now + 60000),
    enabled = await f.enableReflection({
      cadence: 'daily',
      timeZone: 'UTC',
      wallTime: due.toISOString().slice(11, 16),
    }),
    id = enabled.reflectionId;
  await f.research.read(f.researchId, { manual: true });
  const scope = f.reflections.entry(id);
  assert.throws(
    () => f.reflections.checkpoint(id, null, { cadence: true }),
    /calendar reflection is due/,
  );
  const first = f.reflections.checkpoint(id, f.control('/reflection checkpoint ' + id));
  assert.ok(first);
  f.advance(f.reflections.entry(id).nextWake - f.now + 1000);
  await f.research.read(f.researchId, { manual: true });
  assert.equal(f.reflections.checkpoint(id, null, { cadence: true }), null);
  assert.equal(f.reflections.state.checkpoints.length, 1);
  assert.equal(f.reflections.entry(id).reason, 'unchanged_retained_context');
  assert.equal(scope.reviews, 0); // previous snapshots are never mutated by writes
  assert.equal(f.reflections.entry(id).reviews, 2);
  assert.equal(f.reads, 2);
  assert.equal(f.calls, 0);
  assert.equal(f.questions, 0);
  assert.ok(JSON.stringify(f.reflections.context()).length <= 8000);
  await f.ask('/research revoke ' + f.researchId);
  assert.equal(f.reflections.context().scopes.length, 0);
});

test('later correction stays visible beside the preference proposal, decline survives restart, and explicit preference acceptance suppresses it', async (t) => {
  const f = profile(t),
    enabled = await f.enableReflection(),
    id = enabled.reflectionId;
  f.records.push(
    {
      id: 'e'.repeat(64),
      role: 'user',
      text: 'I prefer detailed answers.',
      at: Math.floor(f.now / 1000),
      truncated: false,
    },
    {
      id: 'f'.repeat(64),
      role: 'assistant',
      text: 'Later correction: that earlier statement may describe another person; is it applicable?',
      at: Math.floor(f.now / 1000),
      truncated: false,
    },
  );
  await f.research.read(f.researchId, { manual: true });
  await f.ask('/reflection checkpoint ' + id);
  const cp = f.reflections.state.checkpoints.at(-1),
    suggestion = cp.suggestions.find((s) => s.kind === 'preference_review');
  assert.match(suggestion.reason, /author and applicability to you are unverified/);
  assert.equal(cp.changed.laterRepliesMayChangeInterpretation, true);
  assert.match(cp.reportedQuestions[0].text, /another person/);
  await f.ask('/reflection decline ' + id + ' ' + suggestion.id + ': This statement was not mine.');
  f.restartReflection();
  assert.equal(
    f.reflections.context().scopes[0].suggestions[0].disposition,
    'declined_for_this_evidence',
  );
  assert.equal(f.commitments.preferenceSnapshot().answer_style, undefined);
  f.commitments.preference(
    f.control('/preference answer_style detailed'),
    'answer_style',
    'detailed',
  );
  await f.ask('/reflection checkpoint ' + id);
  assert.equal(f.reflections.state.checkpoints.at(-1).suggestions.length, 0);
});

test('expired limits, missing timezone, unknown controls and widened source end are rejected; identical enable replay never creates a second scope', async (t) => {
  const f = profile(t),
    enabled = await f.enableReflection(),
    e = f.reflections.entry(enabled.reflectionId);
  for (const patch of [
    { timeZone: undefined },
    { cadence: 'hourly' },
    { retentionDays: 0 },
    { maxReviews: 65 },
    { extra: true },
    { until: new Date(f.now + 3 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z') },
    { cadence: 'weekly', wallTime: '10:00', weekdays: [1, 1] },
  ]) {
    assert.equal((await f.enableReflection(patch)).status, 'failed', JSON.stringify(patch));
  }
  f.advance(3 * 86400000);
  assert.equal(f.reflections.enable(e.origin, e.researchId, e.rawConfig), e.id);
  assert.equal(f.reflections.state.entries.length, 1);
  assert.equal((await f.ask('/reflection checkpoint ' + e.id)).status, 'failed');
  assert.equal(f.reads, 0);
});

test('reflection cadence inherits calendar DST and weekly rules without replaying a repeated minute', () => {
  const { configuration } = require('../src/reflections.cjs'),
    timing = require('../src/schedule-time.cjs');
  const raw = {
    timeZone: 'America/Toronto',
    cadence: 'daily',
    wallTime: '01:30',
    weekdays: [],
    until: '2026-11-03T00:00:00Z',
    maxReviews: 3,
    retentionDays: 7,
    recordLimit: 4,
    characterBudget: 4000,
    commitmentLimit: 4,
  };
  const start = Date.parse('2026-10-31T12:00:00Z'),
    schedule = configuration(raw, start, Date.parse(raw.until)).schedule;
  assert.equal(
    new Date(timing.nextWake(schedule, start)).toISOString(),
    '2026-11-01T05:30:00.000Z',
  );
  assert.equal(
    new Date(timing.nextWake(schedule, Date.parse('2026-11-01T05:45:00Z'))).toISOString(),
    '2026-11-02T06:30:00.000Z',
  );
  const spring = { ...raw, wallTime: '02:30', until: '2026-03-11T00:00:00Z' },
    springStart = Date.parse('2026-03-07T12:00:00Z');
  assert.equal(
    new Date(
      timing.nextWake(
        configuration(spring, springStart, Date.parse(spring.until)).schedule,
        springStart,
      ),
    ).toISOString(),
    '2026-03-09T06:30:00.000Z',
  );
  const weekly = { ...raw, cadence: 'weekly', weekdays: [1], wallTime: '10:00' };
  assert.equal(
    new Date(
      timing.nextWake(configuration(weekly, start, Date.parse(weekly.until)).schedule, start),
    ).toISOString(),
    '2026-11-02T15:00:00.000Z',
  );
});

test('a second writer is detected before overwriting its saved journal; malformed provenance remains preserved on restart', async (t) => {
  const f = profile(t),
    enabled = await f.enableReflection(),
    id = enabled.reflectionId,
    { Reflections } = require('../src/reflections.cjs'),
    other = new Reflections(f.reflections.options);
  t.after(() => other.close());
  other.control(id, 'pause', f.control('/reflection pause ' + id));
  const saved = fs.readFileSync(f.reflections.file);
  assert.throws(
    () => f.reflections.checkpoint(id, f.control('/reflection checkpoint ' + id)),
    /file is preserved/,
  );
  assert.deepEqual(fs.readFileSync(f.reflections.file), saved);
  f.restartReflection();
  await f.ask('/reflection resume ' + id);
  await f.research.read(f.researchId, { manual: true });
  await f.ask('/reflection checkpoint ' + id);
  const good = fs.readFileSync(f.reflections.file, 'utf8');
  for (const mutate of [
    (v) => {
      v.checkpoints[0].independentlyVerified = true;
    },
    (v) => {
      v.checkpoints[0].context.coverage.exhaustive = true;
    },
    (v) => {
      v.checkpoints[0].context.source.ownerId = 'another-owner';
    },
    (v) => {
      v.checkpoints[0].usefulLeads[0].independentlyVerified = true;
    },
  ]) {
    const value = JSON.parse(good);
    mutate(value);
    const bad = JSON.stringify(value);
    fs.writeFileSync(f.reflections.file, bad);
    assert.throws(() => f.restartReflection(), /original file is preserved/);
    assert.equal(fs.readFileSync(f.reflections.file, 'utf8'), bad);
  }
  fs.writeFileSync(f.reflections.file, good);
  f.restartReflection();
});

test('maintenance blocks writes and cadence and a paused scope stays paused after restart', async (t) => {
  const f = profile(t),
    enabled = await f.enableReflection(),
    id = enabled.reflectionId;
  f.reflections.options.maintenance = () => true;
  assert.equal((await f.ask('/reflection checkpoint ' + id)).status, 'failed');
  f.reflections.tick();
  assert.equal(f.reflections.state.checkpoints.length, 0);
  delete f.reflections.options.maintenance;
  await f.ask('/reflection pause ' + id);
  f.restartReflection();
  f.reflections.tick();
  assert.equal(f.reflections.entry(id).phase, 'paused');
  assert.equal(f.reads, 0);
});
