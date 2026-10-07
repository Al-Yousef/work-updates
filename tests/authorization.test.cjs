'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { Authorization } = require('../src/authorization.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-authorization-')),
    policy = new Authorization({ directory, actorId: 'owner-human' });
  t.after(() => {
    policy.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('hyphen-authorization-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const instruction = 'Send this exact synthetic instruction.',
    scope = {
      sourceId: 'fixture-source',
      ownerId: 'fixture-pc',
      deviceId: 'fixture-pc',
      taskKey: 'fixture-task',
      destination: 'fixture-source',
      audience: 'source-chat:fixture-source',
      accountKind: 'source_owner',
      accountId: 'fixture-pc',
    },
    human = (text) => ({
      role: 'human',
      authority: 'accepted_human',
      actorId: 'owner-human',
      messageId: crypto.randomUUID(),
      text,
    }),
    spec = {
      key: 'fixture-current-intent',
      responsibilityId: crypto.randomUUID(),
      action: 'send',
      mode: 'act',
      instruction,
      scope,
      duration: { kind: 'until', endAt: Date.now() + 3600000 },
      maxUses: 2,
    },
    request = {
      operationId: crypto.randomUUID(),
      action: 'send',
      instruction,
      scope,
      capability: 'source_message',
      current: { scope, fresh: true, online: true, local: true },
    };
  return { directory, policy, instruction, scope, human, spec, request };
}
test('only the current accepted human can create, revoke or approve a literal scoped grant', (t) => {
  const f = fixture(t);
  for (const role of ['model', 'source', 'participant', 'memory'])
    assert.throws(
      () => f.policy.create({ ...f.human(f.instruction), role }, f.spec),
      /accepted human/,
    );
  assert.throws(
    () => f.policy.create({ ...f.human(f.instruction), actorId: 'other-participant' }, f.spec),
    /accepted human/,
  );
  assert.throws(() => f.policy.create(f.human('A recalled preference'), f.spec), /literal human/);
  const id = f.policy.create(f.human(f.instruction), f.spec);
  assert.equal(f.policy.reserve(id, f.request).decision, 'act');
  assert.equal(f.policy.snapshot().grants[0].origin.text, f.instruction);
  assert.deepEqual(f.policy.snapshot().grants[0].scope, f.scope);
});
test('read, draft, send, edit, execute and share permissions are evaluated independently', (t) => {
  const f = fixture(t),
    id = f.policy.create(f.human(f.instruction), f.spec);
  for (const action of ['read', 'draft', 'edit', 'execute', 'share'])
    assert.equal(f.policy.reserve(id, { ...f.request, action }).decision, 'deny');
  const draft = f.policy.create(f.human(f.instruction), {
    ...f.spec,
    key: 'draft-only',
    action: 'draft',
  });
  assert.equal(f.policy.reserve(draft, { ...f.request, action: 'send' }).decision, 'deny');
  assert.equal(
    f.policy.reserve(draft, { ...f.request, action: 'draft', capability: 'local_draft' }).decision,
    'act',
  );
  for (const action of ['edit', 'execute', 'share']) {
    const grant = f.policy.create(f.human(f.instruction), { ...f.spec, key: action, action });
    assert.equal(
      f.policy.reserve(grant, {
        ...f.request,
        operationId: crypto.randomUUID(),
        action,
        capability: action,
      }).decision,
      'handoff',
    );
  }
});
test('another destination, audience, account, source, owner, task or device fails closed', (t) => {
  const f = fixture(t),
    id = f.policy.create(f.human(f.instruction), f.spec);
  for (const key of Object.keys(f.scope)) {
    const scope = { ...f.scope, [key]: 'different' };
    assert.equal(
      f.policy.reserve(id, { ...f.request, scope, current: { ...f.request.current, scope } })
        .decision,
      'deny',
    );
  }
  for (const current of [
    null,
    { ...f.request.current, fresh: false },
    { ...f.request.current, online: false },
    { ...f.request.current, responsibilityFinished: true },
  ])
    assert.equal(f.policy.reserve(id, { ...f.request, current }).decision, 'deny');
  assert.equal(
    f.policy.reserve(id, { ...f.request, instruction: 'The model expanded the message.' }).decision,
    'deny',
  );
});
test('revocation, account revocation, expiry and changed current scope are checked on an already reserved intent', (t) => {
  const f = fixture(t),
    id = f.policy.create(f.human(f.instruction), f.spec);
  assert.equal(f.policy.reserve(id, f.request).decision, 'act');
  f.policy.revoke(id, f.human('Revoke this exact grant'));
  assert.equal(f.policy.decide(f.policy.grant(id), f.request).decision, 'deny');
  const g = fixture(t),
    other = g.policy.create(g.human(g.instruction), g.spec);
  g.policy.reserve(other, g.request);
  g.policy.revokeAccount(
    g.scope.accountKind,
    g.scope.accountId,
    g.human('Revoke access to this source owner'),
  );
  assert.equal(g.policy.decide(g.policy.grant(other), g.request).reason, 'account_revoked');
  const h = fixture(t),
    expired = h.policy.create(h.human(h.instruction), h.spec);
  h.policy.now = () => h.spec.duration.endAt + 1;
  assert.equal(h.policy.reserve(expired, h.request).reason, 'grant_expired');
});
test('ask approvals are human-only, exact, durable and cannot resume a changed or revoked operation', (t) => {
  const f = fixture(t),
    id = f.policy.create(f.human(f.instruction), { ...f.spec, mode: 'ask' });
  assert.equal(f.policy.reserve(id, f.request).decision, 'ask');
  assert.throws(
    () =>
      f.policy.approve(f.request.operationId, { ...f.human('Approve'), role: 'source' }, f.request),
    /accepted human/,
  );
  f.policy.close();
  const restored = new Authorization(f.policy.options);
  t.after(() => restored.close());
  assert.equal(restored.decide(restored.grant(id), f.request).decision, 'ask');
  assert.throws(
    () =>
      restored.approve(f.request.operationId, f.human('Approve changed'), {
        ...f.request,
        instruction: 'Other text',
      }),
    /scope/,
  );
  restored.approve(f.request.operationId, f.human('Approve this operation'), f.request);
  assert.equal(restored.reserve(id, f.request).decision, 'act');
  restored.outcome(f.request.operationId, 'accepted');
  assert.equal(restored.reserve(id, f.request).decision, 'deny');
});
test('approval persistence failure grants nothing and preserves the pending operation after restart', (t) => {
  const f = fixture(t),
    id = f.policy.create(f.human(f.instruction), { ...f.spec, mode: 'ask' });
  f.policy.reserve(id, f.request);
  f.policy.options.write = () => {
    throw new Error('fixture storage failure');
  };
  assert.throws(
    () => f.policy.approve(f.request.operationId, f.human('Approve this operation'), f.request),
    /storage/,
  );
  assert.equal(f.policy.decide(f.policy.grant(id), f.request).decision, 'ask');
  assert.equal(JSON.parse(fs.readFileSync(f.policy.file)).operations[0].state, 'waiting_human');
});
test('handoff policies and adapter-owned human checkpoints never become generic approval grants', (t) => {
  const f = fixture(t),
    id = f.policy.create(f.human(f.instruction), { ...f.spec, mode: 'handoff' });
  assert.equal(f.policy.reserve(id, f.request).decision, 'handoff');
  assert.throws(
    () => f.policy.approve(f.request.operationId, f.human('Approve'), f.request),
    /checkpoint/,
  );
  const g = fixture(t),
    grant = g.policy.create(g.human(g.instruction), g.spec);
  assert.equal(
    g.policy.reserve(grant, { ...g.request, humanOnly: true }).reason,
    'human_only_checkpoint',
  );
  assert.throws(
    () => g.policy.approve(g.request.operationId, g.human('Approve'), g.request),
    /checkpoint/,
  );
});
test('durable operation IDs enforce usage limits and unknown outcomes are never replayed', (t) => {
  const f = fixture(t),
    id = f.policy.create(f.human(f.instruction), { ...f.spec, maxUses: 1 });
  assert.equal(f.policy.reserve(id, f.request).decision, 'act');
  assert.equal(f.policy.reserve(id, f.request).decision, 'act');
  assert.equal(f.policy.state.operations.length, 1);
  assert.equal(
    f.policy.reserve(id, { ...f.request, operationId: crypto.randomUUID() }).reason,
    'grant_limit_reached',
  );
  f.policy.outcome(f.request.operationId, 'unknown');
  assert.equal(f.policy.reserve(id, f.request).reason, 'operation_already_used_or_unknown');
  assert.equal(
    f.policy.reserve(id, { ...f.request, instruction: 'Other message' }).decision,
    'deny',
  );
});
test('remote owners and external account labels require their verified executor instead of borrowing app access', (t) => {
  const f = fixture(t),
    id = f.policy.create(f.human(f.instruction), f.spec);
  assert.equal(
    f.policy.reserve(id, { ...f.request, current: { ...f.request.current, local: false } })
      .decision,
    'handoff',
  );
  const scope = { ...f.scope, accountKind: 'external-mail', accountId: 'fixture-mail-account' },
    grant = f.policy.create(f.human(f.instruction), { ...f.spec, key: 'mail', scope });
  assert.equal(
    f.policy.reserve(grant, {
      ...f.request,
      operationId: crypto.randomUUID(),
      scope,
      current: { ...f.request.current, scope },
    }).decision,
    'handoff',
  );
});
test('corrupt or unsupported authorization stores preserve bytes and block incompatible rollback', (t) => {
  const f = fixture(t);
  f.policy.create(f.human(f.instruction), f.spec);
  const bytes = fs.readFileSync(f.policy.file),
    contract = { ...require('../src/update-compatibility.json').stores };
  delete contract['authorizations.json'];
  assert.throws(
    () => require('../src/private-store.cjs').inspectStores(f.directory, contract),
    /incompatible/,
  );
  assert.deepEqual(fs.readFileSync(f.policy.file), bytes);
  for (const invalid of [
    '{broken',
    JSON.stringify({ version: 2, grants: [], operations: [], revokedAccounts: [] }),
  ]) {
    fs.writeFileSync(f.policy.file, invalid);
    assert.throws(() => new Authorization(f.policy.options), /preserved/);
    assert.equal(fs.readFileSync(f.policy.file, 'utf8'), invalid);
  }
});
