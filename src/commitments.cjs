'use strict';
const path = require('node:path'),
  crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const uuid = (v) =>
  typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const text = (v, max = 2000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const statuses = new Set([
  'planned',
  'running',
  'waiting_user',
  'waiting_external',
  'blocked',
  'completed',
  'cancelled',
  'superseded',
]);
const confidences = new Set(['human_reported', 'uncertain', 'human_verified']);
const kinds = new Set([
  'user_statement',
  'source_record',
  'inferred_suggestion',
  'assistant_summary',
  'verified_outcome',
]);
const preferences = Object.freeze({
  notifications: ['inherit', 'off', 'important_only', 'all'],
  research: ['manual_only', 'off'],
  answer_style: ['concise', 'detailed'],
});
const fields = [
  'title',
  'owner',
  'status',
  'deadline',
  'blockers',
  'confidence',
  'responsibilityId',
];
function deadline(v) {
  if (v === null) return true;
  if (
    !object(v) ||
    typeof v.at !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(v.at) ||
    !Number.isFinite(Date.parse(v.at)) ||
    !text(v.timeZone, 100)
  )
    return false;
  const parts = v.at.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,3}))?)?/),
    wall = new Date(v.at.replace(/(?:Z|[+-]\d\d:\d\d)$/, 'Z'));
  if (
    !parts ||
    wall.getUTCFullYear() !== Number(parts[1]) ||
    wall.getUTCMonth() + 1 !== Number(parts[2]) ||
    wall.getUTCDate() !== Number(parts[3]) ||
    wall.getUTCHours() !== Number(parts[4]) ||
    wall.getUTCMinutes() !== Number(parts[5]) ||
    wall.getUTCSeconds() !== Number(parts[6] || 0)
  )
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: v.timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}
function human(v) {
  return (
    v?.role === 'human' &&
    v.authority === 'accepted_human' &&
    text(v.actorId, 200) &&
    uuid(v.messageId) &&
    text(v.text, 4000)
  );
}
function source(v) {
  return object(v) && ['sourceId', 'ownerId', 'taskKey', 'revision'].every((k) => text(v[k], 512));
}
function evidence(v) {
  if (
    !uuid(v?.id) ||
    !kinds.has(v.kind) ||
    !text(v.text, 4000) ||
    !Number.isFinite(v.at) ||
    v.at <= 0
  )
    return false;
  if (v.kind === 'user_statement' || v.kind === 'verified_outcome')
    return (
      human(v.origin) &&
      v.origin.text.includes(v.text) &&
      (v.kind !== 'verified_outcome' || v.verification === 'human_review')
    );
  if (v.kind === 'source_record')
    return (
      v.origin?.role === 'source' &&
      source(v.source) &&
      object(v.coverage) &&
      ['bounded_original_records', 'partial_excerpt'].includes(v.coverage.state) &&
      v.coverage.exhaustive === false &&
      Number.isSafeInteger(v.coverage.collectedAt) &&
      v.coverage.collectedAt > 0 &&
      typeof v.coverage.truncated === 'boolean' &&
      Array.isArray(v.coverage.gaps) &&
      v.coverage.gaps.every((g) => text(g, 200))
    );
  return v.origin?.role === 'assistant' && v.authority === 'non_authoritative';
}
function validate(v) {
  if (
    v?.version !== 1 ||
    !Array.isArray(v.entries) ||
    v.entries.length > 256 ||
    !Array.isArray(v.deleted) ||
    v.deleted.length > 256 ||
    !object(v.receipts) ||
    Object.keys(v.receipts).length > 5000 ||
    !object(v.preferences) ||
    Object.keys(v.preferences).length > Object.keys(preferences).length
  )
    throw new Error('Invalid commitment journal');
  const ids = new Set();
  for (const e of v.entries) {
    if (
      !uuid(e.id) ||
      ids.has(e.id) ||
      !text(e.title, 1000) ||
      !text(e.owner, 200) ||
      !statuses.has(e.status) ||
      !deadline(e.deadline) ||
      !Array.isArray(e.blockers) ||
      e.blockers.length > 16 ||
      e.blockers.some((b) => !text(b, 500)) ||
      !confidences.has(e.confidence) ||
      (e.responsibilityId !== null && !uuid(e.responsibilityId)) ||
      !Number.isSafeInteger(e.revision) ||
      e.revision < 1 ||
      !human(e.origin) ||
      !e.origin.text.includes(e.originalTitle) ||
      !text(e.originalTitle, 1000) ||
      !Array.isArray(e.evidence) ||
      e.evidence.length > 64 ||
      e.evidence.some((x) => !evidence(x)) ||
      !Array.isArray(e.history) ||
      e.history.length > 64 ||
      !object(e.provenance) ||
      fields.some(
        (k) =>
          !human(e.provenance[k]?.origin) ||
          !['user_statement', 'local_default', 'human_review'].includes(e.provenance[k].kind),
      ) ||
      ![e.createdAt, e.updatedAt].every((n) => Number.isFinite(n) && n > 0) ||
      (e.supersededBy !== null && !uuid(e.supersededBy))
    )
      throw new Error('Invalid commitment record');
    if (
      new Set(e.evidence.map((x) => x.id)).size !== e.evidence.length ||
      e.history.some(
        (h) =>
          !text(h.action, 100) ||
          !human(h.origin) ||
          !Array.isArray(h.fields) ||
          h.fields.some((f) => !fields.includes(f)) ||
          !Number.isSafeInteger(h.revision) ||
          h.revision < 1 ||
          h.revision > e.revision ||
          !Number.isFinite(h.at),
      )
    )
      throw new Error('Invalid commitment history');
    if (
      e.confidence === 'human_verified' &&
      !e.evidence.some((x) => x.kind === 'verified_outcome' && x.id === e.verifiedEvidenceId)
    )
      throw new Error('Missing human verification');
    if (e.status === 'superseded' && !e.supersededBy)
      throw new Error('Missing superseding decision');
    ids.add(e.id);
  }
  for (const e of v.deleted) {
    if (!uuid(e.id) || ids.has(e.id) || !Number.isFinite(e.deletedAt) || e.deletedAt <= 0)
      throw new Error('Invalid deletion tombstone');
    ids.add(e.id);
  }
  for (const [id, r] of Object.entries(v.receipts))
    if (
      !uuid(id) ||
      !/^[a-f0-9]{64}$/.test(r?.hash) ||
      !text(r.action, 100) ||
      (r.id !== null && !ids.has(r.id))
    )
      throw new Error('Invalid commitment receipt');
  for (const [key, p] of Object.entries(v.preferences))
    if (
      !preferences[key]?.includes(p.value) ||
      !human(p.origin) ||
      !Array.isArray(p.history) ||
      p.history.length > 64 ||
      p.history.some((h) => !human(h.origin) || !preferences[key].includes(h.value)) ||
      !Number.isFinite(p.updatedAt)
    )
      throw new Error('Invalid explicit preference');
  return v;
}
class Commitments extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.closed = false;
    this.file = path.join(options.directory, 'commitments.json');
    if (!text(options.humanActorId, 200)) throw new Error('A local human principal is required');
    this.state = require('./private-store.cjs').readStore(this.file, {
      missing: () => ({ version: 1, entries: [], deleted: [], receipts: {}, preferences: {} }),
    }).value;
  }
  accept(input) {
    if (!human(input) || input.actorId !== this.options.humanActorId)
      throw new Error('A current accepted human instruction is required');
    return structuredClone(input);
  }
  entry(id) {
    const entry = this.state.entries.find((e) => e.id === id);
    if (!entry)
      throw new Error(
        this.state.deleted.some((e) => e.id === id)
          ? 'That commitment was deleted'
          : 'That commitment is unavailable',
      );
    return structuredClone(entry);
  }
  snapshot() {
    return structuredClone(this.state.entries);
  }
  change(fn) {
    if (this.closed) throw new Error('The commitment ledger is unavailable');
    const next = structuredClone(this.state),
      result = fn(next);
    validate(next);
    if (Buffer.byteLength(JSON.stringify(next)) > 32 * 1024 * 1024)
      throw new Error('The commitment journal is full');
    (this.options.write || require('./private-store.cjs').atomicJSON)(this.file, next);
    try {
      const read = (this.options.read || require('./private-store.cjs').readStore)(this.file).value;
      if (hash(read) !== hash(next)) throw new Error();
      this.state = read;
    } catch {
      this.closed = true;
      throw new Error(
        'The commitment write could not be read back. Close Hyphen and inspect a copy before retrying.',
      );
    }
    this.emit('change');
    return result;
  }
  mutate(input, action, id, payload, fn) {
    const origin = this.accept(input),
      digest = hash([origin, action, id, payload]),
      prior = this.state.receipts[origin.messageId];
    if (prior) {
      if (prior.hash !== digest)
        throw new Error('That human message identity belongs to another decision');
      return prior.id;
    }
    return this.change((next) => {
      if (Object.keys(next.receipts).length >= 5000)
        throw new Error('Commitment replay protection is full');
      const result = fn(next, origin);
      next.receipts[origin.messageId] = { hash: digest, action, id: result ?? null };
      return result;
    });
  }
  record(title, origin) {
    if (!text(title, 1000) || !origin.text.includes(title))
      throw new Error('Use a literal human title of up to 1,000 characters');
    const id = crypto.randomUUID(),
      at = Date.now();
    return {
      id,
      title,
      originalTitle: title,
      origin,
      owner: 'you',
      status: 'planned',
      deadline: null,
      blockers: [],
      confidence: 'human_reported',
      responsibilityId: null,
      revision: 1,
      supersededBy: null,
      verifiedEvidenceId: null,
      provenance: Object.fromEntries(
        fields.map((k) => [
          k,
          { kind: k === 'title' ? 'user_statement' : 'local_default', origin },
        ]),
      ),
      evidence: [{ id: crypto.randomUUID(), kind: 'user_statement', text: title, origin, at }],
      history: [{ action: 'create', origin, fields, revision: 1, at }],
      createdAt: at,
      updatedAt: at,
    };
  }
  add(input, title) {
    return this.mutate(input, 'add', null, title, (next, origin) => {
      const entry = this.record(title, origin);
      next.entries.push(entry);
      return entry.id;
    });
  }
  edit(next, id) {
    const e = next.entries.find((x) => x.id === id);
    if (!e) throw new Error('That commitment is unavailable');
    if (e.status === 'superseded')
      throw new Error('Inspect the superseding commitment before changing it');
    if (e.history.length >= 64) throw new Error('Commitment history is full');
    return e;
  }
  history(e, action, origin, changed) {
    e.revision++;
    e.updatedAt = Date.now();
    e.history.push({ action, origin, fields: changed, revision: e.revision, at: e.updatedAt });
    for (const k of changed)
      e.provenance[k] = { kind: action === 'verify' ? 'human_review' : 'user_statement', origin };
  }
  correct(input, id, patch, literal = JSON.stringify(patch)) {
    if (
      !object(patch) ||
      !Object.keys(patch).length ||
      Object.keys(patch).some((k) => !fields.includes(k)) ||
      patch.status === 'superseded' ||
      patch.confidence === 'human_verified'
    )
      throw new Error(
        'Correct title, owner, status, deadline, blockers, confidence (human_reported or uncertain), or responsibilityId. Use separate verify and supersede commands.',
      );
    // The structured patch itself must occur in the accepted human message.
    if (!input?.text?.includes(literal) || hash(JSON.parse(literal)) !== hash(patch))
      throw new Error('The correction must be the literal JSON from the human instruction');
    return this.mutate(input, 'correct', id, patch, (next, origin) => {
      const e = this.edit(next, id);
      Object.assign(e, structuredClone(patch));
      e.confidence = patch.confidence || 'human_reported';
      e.verifiedEvidenceId = null;
      this.history(e, 'correct', origin, [...new Set([...Object.keys(patch), 'confidence'])]);
      return id;
    });
  }
  verify(input, id, description) {
    if (!text(description, 2000) || !input?.text?.includes(description))
      throw new Error('Describe the result you personally reviewed');
    return this.mutate(input, 'verify', id, description, (next, origin) => {
      const e = this.edit(next, id);
      if (e.evidence.length >= 64) throw new Error('Commitment evidence is full');
      const proof = {
        id: crypto.randomUUID(),
        kind: 'verified_outcome',
        text: description,
        origin,
        verification: 'human_review',
        at: Date.now(),
      };
      e.evidence.push(proof);
      e.verifiedEvidenceId = proof.id;
      e.status = 'completed';
      e.confidence = 'human_verified';
      this.history(e, 'verify', origin, ['status', 'confidence']);
      return id;
    });
  }
  supersede(input, id, title) {
    return this.mutate(input, 'supersede', id, title, (next, origin) => {
      const old = this.edit(next, id),
        replacement = this.record(title, origin);
      next.entries.push(replacement);
      old.status = 'superseded';
      old.supersededBy = replacement.id;
      this.history(old, 'supersede', origin, ['status']);
      return replacement.id;
    });
  }
  delete(input, id) {
    return this.mutate(input, 'delete', id, null, (next) => {
      if (!next.entries.some((e) => e.id === id)) throw new Error('That commitment is unavailable');
      next.entries = next.entries.filter((e) => e.id !== id);
      next.deleted.push({ id, deletedAt: Date.now() });
      return id;
    });
  }
  attach(input, id, item) {
    if (
      !evidence({ ...item, id: crypto.randomUUID(), at: Date.now() }) ||
      item.kind === 'verified_outcome' ||
      item.kind === 'user_statement'
    )
      throw new Error(
        'Attach explicitly labelled source records, inferred suggestions or assistant summaries',
      );
    return this.mutate(input, 'attach', id, item, (next, origin) => {
      const e = this.edit(next, id);
      if (e.evidence.length >= 64) throw new Error('Commitment evidence is full');
      e.evidence.push({ ...structuredClone(item), id: crypto.randomUUID(), at: Date.now() });
      this.history(e, 'attach', origin, []);
      return id;
    });
  }
  preference(input, key, value) {
    if (!Object.hasOwn(preferences, key) || !preferences[key].includes(value))
      throw new Error(
        'Use notifications inherit|off|important_only|all, research manual_only|off, or answer_style concise|detailed. Authorization uses separate scoped grants.',
      );
    if (!input?.text?.toLowerCase().includes(key + ' ' + value))
      throw new Error('The preference must be explicit in the human instruction');
    return this.mutate(input, 'preference', null, { key, value }, (next, origin) => {
      const prior = next.preferences[key],
        history = prior?.history || [];
      if (history.length >= 64) throw new Error('Preference history is full');
      next.preferences[key] = {
        value,
        origin,
        history: [...history, { value, origin }],
        updatedAt: Date.now(),
      };
      return null;
    });
  }
  deletePreference(input, key) {
    if (!Object.hasOwn(preferences, key)) throw new Error('That preference is unavailable');
    return this.mutate(input, 'delete_preference', null, key, (next) => {
      delete next.preferences[key];
      return null;
    });
  }
  preferenceSnapshot() {
    if (this.closed) throw new Error('The commitment ledger is unavailable');
    return structuredClone(this.state.preferences);
  }
  attention(event) {
    if (this.closed) return false;
    const mode = this.state.preferences.notifications?.value || 'inherit';
    return (
      mode !== 'off' &&
      (mode === 'all' ||
        event.status === 'needs' ||
        event.urgent ||
        (event.status === 'blocked' && event.waitingOn?.kind !== 'other') ||
        event.waitingOn?.kind === 'you')
    );
  }
  context() {
    if (this.closed)
      return {
        available: false,
        entries: [],
        preferences: {},
        coverage: { exhaustive: false },
        reason: 'Ledger recovery or shutdown required',
      };
    const entries = [];
    let remaining = 8000;
    for (const e of this.snapshot().slice(-8).reverse()) {
      const item = {
        id: e.id,
        title: e.title.slice(0, 500),
        owner: e.owner,
        status: e.status,
        deadline: e.deadline,
        blockers: e.blockers.slice(0, 4).map((b) => b.slice(0, 100)),
        confidence: e.confidence,
        revision: e.revision,
        provenance: Object.fromEntries(
          Object.entries(e.provenance).map(([k, v]) => [
            k,
            { kind: v.kind, messageId: v.origin.messageId },
          ]),
        ),
        supersededBy: e.supersededBy,
        responsibilityId: e.responsibilityId,
        evidence: e.evidence.slice(-4).map((x) => ({
          kind: x.kind,
          text: x.text.slice(0, 300),
          source: x.source,
          coverage: x.coverage,
          verification: x.verification,
          truncated: x.text.length > 300,
        })),
        coverage: {
          evidenceIncluded: Math.min(e.evidence.length, 4),
          evidenceTotal: e.evidence.length,
          historyTotal: e.history.length,
          truncated: true,
        },
      };
      const size = JSON.stringify(item).length;
      if (size > remaining) continue;
      remaining -= size;
      entries.unshift(item);
    }
    return {
      entries,
      preferences: Object.fromEntries(
        Object.entries(this.state.preferences).map(([k, v]) => [
          k,
          {
            value: v.value,
            provenance: 'explicit_human_preference',
            messageId: v.origin.messageId,
          },
        ]),
      ),
      coverage: {
        included: entries.length,
        total: this.state.entries.length,
        evidencePerEntry: 4,
        selectedCharacters: 8000 - remaining,
        characterBudget: 8000,
        exhaustive: false,
      },
      meaning:
        'Human-reported tasks and preferences. Source records, generated suggestions and summaries do not create obligations, permissions or verified results. Human verification means human review, not independent executor proof.',
    };
  }
  close() {
    this.closed = true;
  }
}
module.exports = { Commitments, validate, preferences };
