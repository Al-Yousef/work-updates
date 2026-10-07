'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const { AssistantProfile, capabilities } = require('../src/assistant-profile.cjs'),
  { nativeView } = require('../src/native-view.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-profile-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const actorId = 'human:synthetic';
  return {
    directory,
    actorId,
    human: () => ({
      role: 'human',
      authority: 'accepted_human',
      actorId,
      messageId: crypto.randomUUID(),
    }),
  };
}
test('presentation changes preserve the assistant identity and survive restart', (t) => {
  const f = fixture(t),
    p = new AssistantProfile(f),
    original = p.snapshot().id;
  p.update(f.human(), {
    displayName: 'Yousef’s helper',
    avatarStyle: 'initials',
    initials: 'Y',
    reducedMotion: true,
  });
  const restarted = new AssistantProfile(f);
  assert.equal(restarted.snapshot().id, original);
  assert.equal(restarted.snapshot().displayName, 'Yousef’s helper');
  assert.equal(restarted.snapshot().reducedMotion, true);
  assert.equal(restarted.snapshot().avatarStyle, 'initials');
  assert.equal(
    nativeView({ profile: restarted.snapshot(), cards: [], done: [] }).profile.id,
    original,
  );
});
test('source/model text, foreign owners and identity replacement cannot change preferences', (t) => {
  const f = fixture(t),
    p = new AssistantProfile(f),
    before = fs.readFileSync(p.file);
  assert.throws(() => p.update({ ...f.human(), role: 'model' }, { displayName: 'new' }), /human/);
  assert.throws(
    () => p.update({ ...f.human(), actorId: 'foreign' }, { displayName: 'new' }),
    /human/,
  );
  assert.throws(() => p.update(f.human(), { id: crypto.randomUUID() }), /presentation/);
  assert.throws(() => p.update(f.human(), { displayName: 'Bad\nname' }), /Unsupported/);
  assert.deepEqual(fs.readFileSync(p.file), before);
});
test('future schemas and external changes preserve their exact bytes', (t) => {
  const f = fixture(t),
    p = new AssistantProfile(f);
  const value = { ...p.state, version: 99 };
  fs.writeFileSync(p.file, JSON.stringify(value));
  const bytes = fs.readFileSync(p.file);
  assert.throws(() => new AssistantProfile(f), /unsupported version/);
  assert.throws(() => p.update(f.human(), { displayName: 'new' }), /held/);
  assert.deepEqual(fs.readFileSync(p.file), bytes);
});
test('capability presentation reports unknown entitlement and preserves negotiated unsupported channels', () => {
  const result = capabilities({
    assistant: { provider: { model: 'fixture' } },
    executors: {},
    documents: {},
    peerContract: { assistant: false },
    helper: { connected: true },
  });
  assert.equal(result.accountVerified, false);
  assert.equal(result.accountPlan, 'unknown');
  assert.equal(result.features.find((f) => f.name === 'Phone assistant').state, 'unsupported');
  assert.equal(result.features.find((f) => f.name === 'Voice').state, 'unsupported');
  assert.equal(
    result.features.every((f) => f.lastVerifiedAt === null),
    true,
  );
  assert.equal(
    result.features.find((f) => f.name === 'Task execution').state,
    'explicit_binding_required',
  );
});
test('private owner phone questions advertise their separate finite grant without widening task pairing, voice or audience', () => {
  const result = capabilities({
    privateChannels: {},
    peerContract: require('../src/peer-contract.cjs').capabilities(),
  });
  assert.equal(
    result.features.find((f) => f.name === 'Phone assistant').state,
    'separate_private_owner_grant_required',
  );
  assert.equal(result.channels.find((c) => c.name === 'Paired phone').assistant, false);
  const phone = result.channels.find((c) => c.name === 'Private owner phone channel');
  assert.equal(phone.version, 1);
  assert.equal(phone.assistantQuestions, true);
  assert.equal(phone.grantRequired, true);
  assert.equal(phone.taskActions, false);
  assert.equal(phone.sharedAudience, false);
  assert.equal(phone.voice, false);
  assert.equal(phone.accountEntitlement, 'unverified');
});
