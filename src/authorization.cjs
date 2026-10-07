'use strict';
const crypto = require('node:crypto'),
  path = require('node:path'),
  { EventEmitter } = require('node:events');
const actions = new Set(['read', 'draft', 'send', 'edit', 'execute', 'share']);
const modes = new Set(['act', 'ask', 'handoff']);
const uuid = (v) =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const text = (v, max = 4000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const payload = (request) => hash([request.instruction, request.attachmentIds || []]);
function scopeKey(scope) {
  if (
    !scope ||
    [
      'sourceId',
      'ownerId',
      'deviceId',
      'taskKey',
      'destination',
      'audience',
      'accountId',
      'accountKind',
    ].some((k) => !text(scope[k], 512))
  )
    throw new Error('An exact source, account, destination and audience are required');
  return hash(
    [
      'sourceId',
      'ownerId',
      'deviceId',
      'taskKey',
      'destination',
      'audience',
      'accountId',
      'accountKind',
    ].map((k) => scope[k]),
  );
}
function validate(value) {
  if (
    value?.version !== 1 ||
    !Array.isArray(value.grants) ||
    value.grants.length > 256 ||
    !Array.isArray(value.operations) ||
    value.operations.length > 2048 ||
    !Array.isArray(value.revokedAccounts) ||
    value.revokedAccounts.length > 256
  )
    throw new Error('Invalid authorization journal');
  const grants = new Set(),
    operations = new Set();
  for (const grant of value.grants) {
    if (
      !uuid(grant.id) ||
      grants.has(grant.id) ||
      !text(grant.key, 512) ||
      !uuid(grant.origin?.messageId) ||
      !text(grant.origin.text, 12000) ||
      !text(grant.origin.actorId, 200) ||
      !actions.has(grant.action) ||
      !modes.has(grant.mode) ||
      typeof grant.instruction !== 'string' ||
      grant.instruction.length > 12000 ||
      !Array.isArray(grant.attachmentIds) ||
      grant.attachmentIds.length > 4 ||
      grant.attachmentIds.some((id) => !text(id, 512)) ||
      (!grant.instruction.trim() && !grant.attachmentIds.length) ||
      !/^[a-f0-9]{64}$/.test(grant.payloadHash) ||
      !Number.isInteger(grant.maxUses) ||
      grant.maxUses < 1 ||
      grant.maxUses > 64 ||
      !['active', 'revoked'].includes(grant.state) ||
      !['until', 'responsibility'].includes(grant.duration?.kind) ||
      (grant.duration.kind === 'until' &&
        (!Number.isSafeInteger(grant.duration.endAt) ||
          grant.duration.endAt <= 0 ||
          grant.duration.endAt > 8640000000000000)) ||
      (grant.duration.kind === 'responsibility' && !uuid(grant.responsibilityId)) ||
      !Number.isSafeInteger(grant.createdAt) ||
      !Array.isArray(grant.changes) ||
      grant.changes.length > 64 ||
      grant.changes.some(
        (c) =>
          !uuid(c.messageId) ||
          !text(c.text) ||
          !text(c.actorId, 200) ||
          !['revoke', 'mode'].includes(c.kind) ||
          !Number.isSafeInteger(c.at),
      )
    )
      throw new Error('Invalid authorization grant');
    scopeKey(grant.scope);
    if (grant.payloadHash !== payload(grant)) throw new Error('Authorization payload changed');
    grants.add(grant.id);
  }
  for (const op of value.operations) {
    if (
      !uuid(op.id) ||
      operations.has(op.id) ||
      !grants.has(op.grantId) ||
      !actions.has(op.action) ||
      ![
        'reserved',
        'waiting_human',
        'approved',
        'accepted',
        'unknown',
        'cancelled',
        'handoff',
      ].includes(op.state) ||
      !/^[a-f0-9]{64}$/.test(op.payloadHash) ||
      !/^[a-f0-9]{64}$/.test(op.scopeHash) ||
      !Number.isSafeInteger(op.createdAt) ||
      (op.approval !== undefined &&
        (!uuid(op.approval.messageId) ||
          !text(op.approval.text) ||
          !text(op.approval.actorId, 200) ||
          !Number.isSafeInteger(op.approval.at)))
    )
      throw new Error('Invalid authorization operation');
    operations.add(op.id);
  }
  for (const account of value.revokedAccounts)
    if (
      !text(account.id, 512) ||
      !text(account.kind, 512) ||
      !uuid(account.human?.messageId) ||
      !text(account.human.text) ||
      !text(account.human.actorId, 200)
    )
      throw new Error('Invalid revoked account');
  if (new Set(value.grants.map((g) => g.key)).size !== value.grants.length)
    throw new Error('Duplicate authorization key');
  return value;
}
class Authorization extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.actorId = options.actorId;
    this.now = options.now || Date.now;
    this.closed = false;
    this.file = path.join(options.directory, 'authorizations.json');
    this.state = require('./private-store.cjs').readStore(this.file, {
      missing: () => ({ version: 1, grants: [], operations: [], revokedAccounts: [] }),
    }).value;
  }
  human(input) {
    if (
      input?.role !== 'human' ||
      input.authority !== 'accepted_human' ||
      input.actorId !== this.actorId ||
      !text(this.actorId, 200) ||
      !uuid(input.messageId) ||
      !text(input.text, 12000)
    )
      throw new Error('Only the accepted human can authorize an action');
    return { messageId: input.messageId, text: input.text, actorId: input.actorId };
  }
  change(fn) {
    if (this.closed) throw new Error('Hyphen is closing');
    const next = structuredClone(this.state),
      result = fn(next);
    validate(next);
    if (Buffer.byteLength(JSON.stringify(next)) > 32 * 1024 * 1024)
      throw new Error('Authorization journal is full');
    (this.options.write || require('./private-store.cjs').atomicJSON)(this.file, next);
    this.state = next;
    this.emit('change');
    return result;
  }
  snapshot() {
    return structuredClone(this.state);
  }
  grant(id) {
    const grant = this.state.grants.find((g) => g.id === id);
    if (!grant) throw new Error('Authorization unavailable');
    return grant;
  }
  create(input, spec) {
    const origin = this.human(input);
    scopeKey(spec.scope);
    if (
      !actions.has(spec.action) ||
      !modes.has(spec.mode) ||
      !text(spec.key, 512) ||
      typeof spec.instruction !== 'string' ||
      spec.instruction.length > 12000 ||
      (!spec.instruction.trim() && !(spec.attachmentIds || []).length) ||
      !origin.text.includes(spec.instruction)
    )
      throw new Error('Permission requires literal human instruction and an explicit action');
    const requestHash = hash([origin, spec]),
      prior = this.state.grants.find((g) => g.key === spec.key);
    if (prior) {
      if (prior.requestHash !== requestHash)
        throw new Error('Authorization identity belongs to a different instruction');
      return prior.id;
    }
    const id = crypto.randomUUID();
    this.change((next) =>
      next.grants.push({
        id,
        ...structuredClone(spec),
        origin,
        requestHash,
        payloadHash: payload(spec),
        attachmentIds: spec.attachmentIds || [],
        state: 'active',
        changes: [],
        createdAt: this.now(),
      }),
    );
    return id;
  }
  revoke(id, input) {
    const human = this.human(input);
    this.grant(id);
    this.change((next) => {
      const grant = next.grants.find((g) => g.id === id);
      if (grant.state === 'revoked') return;
      grant.state = 'revoked';
      grant.changes.push({ ...human, kind: 'revoke', at: this.now() });
    });
  }
  setMode(id, mode, input) {
    const human = this.human(input);
    if (!modes.has(mode)) throw new Error('Choose act, ask or handoff');
    this.grant(id);
    this.change((next) => {
      const grant = next.grants.find((g) => g.id === id);
      if (grant.state !== 'active')
        throw new Error('A revoked grant cannot be restored by changing its mode');
      grant.mode = mode;
      grant.changes.push({ ...human, kind: 'mode', mode, at: this.now() });
    });
  }
  revokeAccount(kind, id, input) {
    const human = this.human(input);
    if (!text(kind, 512) || !text(id, 512)) throw new Error('Choose an exact account');
    this.change((next) => {
      if (!next.revokedAccounts.some((a) => a.kind === kind && a.id === id))
        next.revokedAccounts.push({ kind, id, human, at: this.now() });
    });
  }
  decide(grant, request) {
    if (!grant || grant.state !== 'active')
      return { decision: 'deny', reason: 'grant_revoked_or_missing' };
    let key;
    try {
      key = scopeKey(request.scope);
    } catch {
      return { decision: 'deny', reason: 'scope_unestablished' };
    }
    if (
      request.action !== grant.action ||
      payload(request) !== grant.payloadHash ||
      key !== scopeKey(grant.scope)
    )
      return { decision: 'deny', reason: 'action_or_scope_changed' };
    let currentKey;
    try {
      currentKey = request.current && scopeKey(request.current.scope);
    } catch {
      return { decision: 'deny', reason: 'current_scope_unavailable' };
    }
    if (
      !request.current ||
      request.current.online !== true ||
      request.current.fresh !== true ||
      currentKey !== key ||
      request.current.responsibilityFinished
    )
      return { decision: 'deny', reason: 'current_scope_unavailable' };
    if (grant.duration.kind === 'until' && this.now() > grant.duration.endAt)
      return { decision: 'deny', reason: 'grant_expired' };
    if (
      this.state.revokedAccounts.some(
        (a) => a.kind === grant.scope.accountKind && a.id === grant.scope.accountId,
      )
    )
      return { decision: 'deny', reason: 'account_revoked' };
    if (request.humanOnly) return { decision: 'handoff', reason: 'human_only_checkpoint' };
    const supported =
      grant.scope.accountKind === 'source_owner' &&
      request.current.local === true &&
      ((request.action === 'send' && request.capability === 'source_message') ||
        (request.action === 'read' && request.capability === 'source_read') ||
        (request.action === 'draft' && request.capability === 'local_draft'));
    if (!supported) return { decision: 'handoff', reason: 'executor_or_account_unverified' };
    if (grant.mode === 'handoff') return { decision: 'handoff', reason: 'human_handoff_policy' };
    const existing = this.state.operations.find((o) => o.id === request.operationId);
    if (
      existing &&
      (existing.grantId !== grant.id ||
        existing.action !== request.action ||
        existing.payloadHash !== grant.payloadHash ||
        existing.scopeHash !== key)
    )
      return { decision: 'deny', reason: 'operation_identity_changed' };
    if (existing && ['accepted', 'unknown', 'cancelled'].includes(existing.state))
      return { decision: 'deny', reason: 'operation_already_used_or_unknown' };
    if (
      !existing &&
      this.state.operations.filter((o) => o.grantId === grant.id).length >= grant.maxUses
    )
      return { decision: 'deny', reason: 'grant_limit_reached' };
    if (grant.mode === 'ask' && existing?.state !== 'approved')
      return {
        decision: 'ask',
        reason: 'human_approval_required',
        operationId: request.operationId,
      };
    return { decision: 'act', reason: 'exact_human_grant', operationId: request.operationId };
  }
  reserve(id, request) {
    if (!uuid(request.operationId)) throw new Error('A durable operation identity is required');
    const grant = this.grant(id),
      decision = this.decide(grant, request);
    if (decision.decision === 'deny') return decision;
    const previous = this.state.operations.find((o) => o.id === request.operationId);
    if (!previous)
      this.change((next) =>
        next.operations.push({
          id: request.operationId,
          grantId: id,
          action: request.action,
          payloadHash: payload(request),
          scopeHash: scopeKey(request.scope),
          state:
            decision.decision === 'ask'
              ? 'waiting_human'
              : decision.decision === 'handoff'
                ? 'handoff'
                : 'reserved',
          humanOnly: !!request.humanOnly,
          createdAt: this.now(),
        }),
      );
    else if (decision.decision === 'ask' && previous.state !== 'waiting_human')
      this.change((next) => {
        next.operations.find((o) => o.id === request.operationId).state = 'waiting_human';
      });
    return decision;
  }
  approve(id, input, request) {
    const human = this.human(input),
      op = this.state.operations.find((o) => o.id === id);
    if (!op || op.state !== 'waiting_human' || op.humanOnly)
      throw new Error('This operation requires its owning human checkpoint');
    const decision = this.decide(this.grant(op.grantId), request);
    if (decision.decision !== 'ask' || request.operationId !== id)
      throw new Error('The approval scope expired, changed or was revoked');
    this.change((next) => {
      const operation = next.operations.find((o) => o.id === id);
      operation.state = 'approved';
      operation.approval = { ...human, at: this.now() };
    });
  }
  outcome(id, state) {
    if (!['accepted', 'unknown', 'cancelled'].includes(state))
      throw new Error('Invalid authorization outcome');
    const op = this.state.operations.find((o) => o.id === id);
    if (!op || op.state === state || ['accepted', 'unknown', 'cancelled'].includes(op.state))
      return;
    this.change((next) => {
      next.operations.find((o) => o.id === id).state = state;
    });
  }
  close() {
    this.closed = true;
  }
}
module.exports = { Authorization, validate, scopeKey, hash, actions, modes };
