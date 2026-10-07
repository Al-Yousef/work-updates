'use strict';
const path = require('node:path'),
  crypto = require('node:crypto'),
  { EventEmitter } = require('node:events'),
  bridge = require('./responsibility-authorization.cjs'),
  target = require('./responsibility-target.cjs'),
  coordination = require('./assistant-coordination.cjs');
const uuid = (v) =>
    typeof v === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v),
  hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'),
  text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max,
  human = (v) =>
    v?.role === 'human' &&
    v.authority === 'accepted_human' &&
    text(v.actorId, 200) &&
    uuid(v.messageId) &&
    text(v.text, 4000),
  phases = new Set([
    'enabled',
    'reading',
    'awaiting_approval',
    'paused',
    'revoked',
    'expired',
    'exhausted',
    'rate_limited',
    'gap',
  ]);
function configuration(c, now) {
  const keys = [
    'topic',
    'initialLookbackSeconds',
    'incrementalLookbackSeconds',
    'until',
    'maxReads',
    'maxReadsPerDay',
    'recordLimit',
    'background',
    'intervalSeconds',
  ];
  if (
    !c ||
    Array.isArray(c) ||
    Object.keys(c).some((k) => !keys.includes(k)) ||
    !text(c.topic, 200) ||
    !Number.isSafeInteger(c.initialLookbackSeconds) ||
    c.initialLookbackSeconds < 60 ||
    c.initialLookbackSeconds > 30 * 86400 ||
    !Number.isSafeInteger(c.incrementalLookbackSeconds) ||
    c.incrementalLookbackSeconds < 60 ||
    c.incrementalLookbackSeconds > 86400 ||
    !Number.isSafeInteger(c.maxReads) ||
    c.maxReads < 1 ||
    c.maxReads > 64 ||
    !Number.isSafeInteger(c.maxReadsPerDay) ||
    c.maxReadsPerDay < 1 ||
    c.maxReadsPerDay > 64 ||
    !Number.isSafeInteger(c.recordLimit) ||
    c.recordLimit < 1 ||
    c.recordLimit > 64 ||
    typeof c.background !== 'boolean' ||
    !Number.isSafeInteger(c.intervalSeconds) ||
    (c.background
      ? c.intervalSeconds < 900 || c.intervalSeconds > 86400
      : c.intervalSeconds !== 0) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(c.until || '')
  )
    throw new Error('Use an exact topic, UTC expiry and bounded read configuration');
  const endAt = Date.parse(c.until);
  if (
    !Number.isSafeInteger(endAt) ||
    new Date(endAt).toISOString() !== c.until.replace('Z', '.000Z') ||
    (now !== undefined && (endAt <= now || endAt - now > 30 * 86400000))
  )
    throw new Error('Choose a valid UTC expiry within thirty days');
  return { ...c, endAt };
}
function validate(s) {
  if (
    s?.version !== 1 ||
    !Array.isArray(s.entries) ||
    s.entries.length > 32 ||
    !s.receipts ||
    Array.isArray(s.receipts) ||
    typeof s.receipts !== 'object' ||
    Object.keys(s.receipts).length > 5000
  )
    throw new Error('Invalid research journal');
  const ids = new Set();
  for (const e of s.entries) {
    const { endAt, ...c } = e.config || {};
    const intent = require('./research-command.cjs').command(e.origin?.text);
    if (
      !uuid(e.id) ||
      ids.has(e.id) ||
      !uuid(e.grantId) ||
      !human(e.origin) ||
      hash(e.origin.text) !== e.instructionHash ||
      !/^[a-f0-9]{64}$/.test(e.storeId) ||
      !phases.has(e.phase) ||
      !e.scope ||
      ['id', 'sourceId', 'ownerId', 'deviceId', 'taskKey', 'taskRevision', 'chatName'].some(
        (k) => !text(e.scope[k], 512),
      ) ||
      !text(e.scope.executionDevice?.kind, 100) ||
      !text(e.scope.executionDevice?.name, 200) ||
      configuration(c).endAt !== endAt ||
      intent?.kind !== 'enable' ||
      intent.sourceId !== e.scope.sourceId ||
      hash(intent.config) !== hash(c) ||
      !Array.isArray(e.attempts) ||
      e.attempts.length > 64 ||
      e.attempts.length > e.config.maxReads ||
      new Set(e.attempts.map((a) => a.id)).size !== e.attempts.length ||
      e.attempts.some((a) => !uuid(a.id) || !Number.isSafeInteger(a.at) || a.at <= 0) ||
      !Array.isArray(e.scans) ||
      e.scans.length > 32 ||
      !Array.isArray(e.records) ||
      e.records.length > 64 ||
      new Set(e.records.map((r) => r.id)).size !== e.records.length ||
      e.records.some(
        (r) =>
          !record(r) ||
          typeof r.topicMatch !== 'boolean' ||
          r.provenance !== 'original_source_message',
      ) ||
      !Array.isArray(e.seen) ||
      e.seen.length > 512 ||
      new Set(e.seen).size !== e.seen.length ||
      e.seen.some((id) => !/^[a-f0-9]{64}$/.test(id)) ||
      !Array.isArray(e.changes) ||
      e.changes.length > 32 ||
      e.changes.some(
        (c) =>
          !human(c.origin) ||
          !['pause', 'resume', 'revoke'].includes(c.kind) ||
          !Number.isSafeInteger(c.at),
      ) ||
      ![e.createdAt, e.updatedAt, e.nextReadAt].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      (e.pending !== null &&
        (!uuid(e.pending?.id) || !['reserved', 'reading'].includes(e.pending.state))) ||
      (e.cursor !== null &&
        (!Number.isSafeInteger(e.cursor?.at) ||
          !text(e.cursor.sourceRevision, 512) ||
          !Number.isFinite(e.cursor.maxRecordAt)))
    )
      throw new Error('Invalid research contract');
    for (const scan of e.scans)
      if (
        !uuid(scan.id) ||
        !Number.isSafeInteger(scan.at) ||
        !text(scan.status, 100) ||
        (scan.coverage !== null && !coverage(scan.coverage))
      )
        throw new Error('Invalid research scan');
    ids.add(e.id);
  }
  if (
    Object.entries(s.receipts).some(
      ([id, r]) => !uuid(id) || !ids.has(r?.id) || !/^[a-f0-9]{64}$/.test(r.hash),
    )
  )
    throw new Error('Invalid research replay receipts');
  return s;
}
function record(r) {
  return (
    r &&
    /^[a-f0-9]{64}$/.test(r.id) &&
    ['user', 'assistant'].includes(r.role) &&
    text(r.text, 6000) &&
    Number.isFinite(r.at) &&
    r.at > 0 &&
    typeof r.truncated === 'boolean'
  );
}
function coverage(c) {
  return (
    c &&
    c.exhaustive === false &&
    Array.isArray(c.gaps) &&
    c.gaps.length <= 12 &&
    c.gaps.every((g) => text(g, 300)) &&
    [
      'candidateRecords',
      'includedRecords',
      'bytesRead',
      'byteLimit',
      'recordLimit',
      'skippedRecords',
    ].every((k) => Number.isSafeInteger(c[k]) && c[k] >= 0) &&
    c.bytesRead <= 4194304 &&
    c.byteLimit === 4194304 &&
    c.recordLimit <= 64 &&
    c.includedRecords <= c.recordLimit &&
    c.includedRecords <= c.candidateRecords
  );
}
class Research extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.file = path.join(options.directory, 'research.json');
    this.closed = false;
    this.pending = new Set();
    this.state = require('./private-store.cjs').readStore(this.file, {
      missing: () => ({ version: 1, entries: [], receipts: {} }),
    }).value;
    const interrupted = this.state.entries.filter((e) => e.pending?.state === 'reading');
    if (interrupted.length)
      this.change((next) => {
        for (const e of next.entries)
          if (e.pending?.state === 'reading') {
            options.policy.outcome(e.pending.id, 'unknown');
            e.pending = null;
            e.phase = 'paused';
            e.updatedAt = this.now();
            e.scans.push({
              id: crypto.randomUUID(),
              at: this.now(),
              status: 'restart_read_unconfirmed',
              coverage: null,
            });
            e.scans = e.scans.slice(-32);
          }
      });
  }
  now() {
    return this.options.now?.() || Date.now();
  }
  accept(input) {
    if (!human(input) || input.actorId !== this.options.policy.actorId)
      throw new Error('Research needs a current accepted human instruction');
    return structuredClone(input);
  }
  snapshot() {
    return structuredClone(this.state.entries);
  }
  entry(id) {
    const e = this.state.entries.find((e) => e.id === id);
    if (!e) throw new Error('That research scope is unavailable');
    return structuredClone(e);
  }
  change(fn) {
    if (this.closed) throw new Error('Research is closed');
    const next = structuredClone(this.state),
      result = fn(next);
    validate(next);
    if (Buffer.byteLength(JSON.stringify(next)) > 32 * 1024 * 1024)
      throw new Error('Research journal is full');
    (this.options.write || require('./private-store.cjs').atomicJSON)(this.file, next);
    this.state = next;
    this.emit('change');
    return result;
  }
  enable(input, scope, rawConfig) {
    const origin = this.accept(input),
      config = configuration(rawConfig, this.now()),
      key = hash([origin, scope, rawConfig]),
      prior = this.state.receipts[origin.messageId];
    const intent = require('./research-command.cjs').command(origin.text);
    if (
      intent?.kind !== 'enable' ||
      intent.sourceId !== scope.sourceId ||
      hash(intent.config) !== hash(rawConfig)
    )
      throw new Error('Research must retain the literal human source and configuration');
    if (prior) {
      if (prior.hash !== key) throw new Error('Human message identity belongs to another scope');
      return prior.id;
    }
    target.validateTarget(scope, this.options.snapshot());
    const match = coordination.sourceFor(this.options.snapshot(), scope);
    if (!match?.card.owner?.local || match.card.owner.online === false)
      throw new Error('Research requires the verified local source owner');
    if (this.state.entries.length >= 32 || Object.keys(this.state.receipts).length >= 5000)
      throw new Error('Research scope or replay limit reached');
    const storeId = this.options.reader.storeId();
    if (!/^[a-f0-9]{64}$/.test(storeId)) throw new Error('The exact source store is unavailable');
    const id = crypto.randomUUID(),
      grantId = this.options.policy.create(origin, {
        key: 'research:' + id,
        action: 'read',
        mode: 'act',
        instruction: origin.text,
        scope: bridge.policyScope(scope),
        duration: { kind: 'until', endAt: config.endAt },
        maxUses: config.maxReads,
      }),
      at = this.now();
    return this.change((next) => {
      next.entries.push({
        id,
        grantId,
        scope: structuredClone(scope),
        origin,
        config,
        storeId,
        instructionHash: hash(origin.text),
        phase: 'enabled',
        cursor: null,
        pending: null,
        attempts: [],
        scans: [],
        records: [],
        seen: [],
        changes: [],
        createdAt: at,
        updatedAt: at,
        nextReadAt: at,
      });
      next.receipts[origin.messageId] = { id, hash: key };
      return id;
    });
  }
  request(e, id) {
    let live, match;
    try {
      live = target.currentScope(e.scope, this.options.snapshot());
      match = coordination.sourceFor(this.options.snapshot(), live);
    } catch {}
    return {
      operationId: id,
      action: 'read',
      instruction: e.origin.text,
      scope: bridge.policyScope(e.scope),
      capability: 'source_read',
      current: live
        ? {
            scope: bridge.policyScope(live),
            online: match.card.owner?.online !== false,
            fresh: coordination.fresh(this.options.snapshot()),
            local: match.card.owner?.local === true,
          }
        : null,
    };
  }
  approvalRequest(id) {
    const e = this.state.entries.find((e) => e.pending?.id === id);
    return e ? this.request(e, id) : null;
  }
  gate(e, id, { manual = false } = {}) {
    if(this.options.admission&&this.options.admission(e.scope)!=='allow')return {decision:'deny',reason:'work_control_hold'};
    if (
      this.closed ||
      this.options.maintenance?.() ||
      this.options.preferences?.().research?.value === 'off'
    )
      return { decision: 'deny', reason: 'research_off_or_maintenance' };
    if (!manual && this.options.preferences?.().research?.value === 'manual_only')
      return { decision: 'deny', reason: 'research_manual_only' };
    if (['paused', 'revoked'].includes(e.phase))
      return { decision: 'deny', reason: 'scope_paused_or_revoked' };
    if (this.now() > e.config.endAt) return { decision: 'deny', reason: 'scope_expired' };
    if (this.options.reader.storeId() !== e.storeId)
      return { decision: 'deny', reason: 'source_store_changed' };
    const grant = this.options.policy.state.grants.find((g) => g.id === e.grantId);
    return grant
      ? this.options.policy.decide(grant, this.request(e, id))
      : { decision: 'deny', reason: 'read_grant_missing' };
  }
  control(id, kind, input) {
    const origin = this.accept(input),
      e = this.entry(id);
    if (!['pause', 'resume', 'revoke'].includes(kind) || e.changes.length >= 32)
      throw new Error('Research control is unavailable or full');
    if (kind === 'revoke') this.options.policy.revoke(e.grantId, origin);
    if (kind === 'resume') {
      const current = { ...e, phase: 'enabled' },
        decision = this.gate(current, e.pending?.id || crypto.randomUUID(), { manual: true });
      if (!['act', 'ask'].includes(decision.decision))
        throw new Error(
          'The original read permission or source is unavailable; enable a new explicit scope',
        );
    }
    this.change((next) => {
      const current = next.entries.find((x) => x.id === id);
      current.phase = kind === 'pause' ? 'paused' : kind === 'revoke' ? 'revoked' : 'enabled';
      current.changes.push({ kind, origin, at: this.now() });
      current.updatedAt = this.now();
      if (kind === 'resume') current.nextReadAt = this.now();
    });
  }
  async read(id, { manual = false } = {}) {
    if (this.closed || this.pending.has(id)) return false;
    let e = this.entry(id);
    const preference = this.options.preferences?.().research?.value;
    if (preference === 'off' || (!manual && preference === 'manual_only')) return false;
    if (
      ['paused', 'revoked', 'expired', 'exhausted'].includes(e.phase) ||
      (!manual && !e.config.background) ||
      (this.now() < e.nextReadAt && !manual) ||
      (e.phase === 'rate_limited' && this.now() < e.nextReadAt)
    )
      return false;
    if (this.now() > e.config.endAt) {
      this.change((next) => (next.entries.find((x) => x.id === id).phase = 'expired'));
      return false;
    }
    if (e.attempts.length >= e.config.maxReads) {
      this.change((next) => (next.entries.find((x) => x.id === id).phase = 'exhausted'));
      return false;
    }
    if (e.attempts.filter((a) => this.now() - a.at < 86400000).length >= e.config.maxReadsPerDay) {
      this.change((next) => {
        const current = next.entries.find((x) => x.id === id);
        current.phase = 'rate_limited';
        current.nextReadAt =
          Math.min(
            ...current.attempts.filter((a) => this.now() - a.at < 86400000).map((a) => a.at),
          ) + 86400000;
      });
      return false;
    }
    const operationId = e.pending?.id || crypto.randomUUID();
    this.pending.add(id);
    let started = false;
    try {
      let decision = this.gate(e, operationId, { manual });
      if (!['act', 'ask'].includes(decision.decision)) {
        this.recordGap(id, operationId, decision.reason);
        return false;
      }
      if (!e.pending)
        this.change(
          (next) =>
            (next.entries.find((x) => x.id === id).pending = {
              id: operationId,
              state: 'reserved',
            }),
        );
      decision = this.options.policy.reserve(e.grantId, this.request(e, operationId));
      if (decision.decision !== 'act') {
        this.change(
          (next) =>
            (next.entries.find((x) => x.id === id).phase =
              decision.decision === 'ask' ? 'awaiting_approval' : 'gap'),
        );
        return false;
      }
      const until = Math.floor(this.now() / 1000),
        since = e.cursor
          ? Math.max(
              0,
              until - e.config.incrementalLookbackSeconds,
              Math.floor(e.cursor.at / 1000) - e.config.incrementalLookbackSeconds,
            )
          : Math.max(0, until - e.config.initialLookbackSeconds),
        nonce = crypto.randomBytes(16).toString('hex');
      this.change((next) => {
        const current = next.entries.find((x) => x.id === id);
        current.phase = 'reading';
        current.pending.state = 'reading';
        current.attempts.push({ id: operationId, at: this.now() });
        current.updatedAt = this.now();
      });
      started = true;
      const beforeRead = () => {
        const live = this.entry(id),
          allowed = this.gate(live, operationId, { manual });
        if (allowed.decision !== 'act')
          throw Object.assign(new Error('Read scope was revoked, expired or changed'), {
            code: 'RESEARCH_SCOPE_CHANGED',
          });
      };
      beforeRead();
      const result = await this.options.reader.read({
        scope: e.scope,
        storeId: e.storeId,
        since,
        until,
        limit: e.config.recordLimit,
        nonce,
        beforeRead,
      });
      beforeRead();
      if (
        result?.schema !== 1 ||
        result.threadId !== e.scope.sourceId ||
        result.storeId !== e.storeId ||
        result.requestNonce !== nonce ||
        result.since !== since ||
        result.until !== until ||
        !Number.isFinite(result.capturedAt) ||
        Math.abs(result.capturedAt - this.now() / 1000) > 30 ||
        !Array.isArray(result.records) ||
        result.records.length > e.config.recordLimit ||
        result.records.some((r) => !record(r) || r.at < since || r.at > until) ||
        !coverage(result.coverage) ||
        result.coverage.includedRecords !== result.records.length
      )
        throw Object.assign(new Error('The scoped original reader returned invalid coverage'), {
          code: 'RESEARCH_READ_INVALID',
        });
      this.options.policy.outcome(operationId, 'accepted');
      this.change((next) => {
        const current = next.entries.find((x) => x.id === id),
          terms = current.config.topic.toLowerCase().split(/\s+/).filter(Boolean);
        for (const r of result.records)
          if (!current.seen.includes(r.id)) {
            current.records.push({
              ...r,
              text: r.text.slice(0, 2000),
              truncated: r.truncated || r.text.length > 2000,
              topicMatch: terms.some((t) => r.text.toLowerCase().includes(t)),
              provenance: 'original_source_message',
            });
            current.seen.push(r.id);
          }
        current.records = current.records.slice(-64);
        current.seen = current.seen.slice(-512);
        const gaps = [
          ...result.coverage.gaps,
          'Incremental lookback and deduplication are bounded; older or delayed replies may be missed.',
        ];
        if (e.cursor && since > e.cursor.at / 1000)
          gaps.push('An offline interval exceeded the incremental lookback.');
        current.scans.push({
          id: operationId,
          at: this.now(),
          status: 'bounded_original_records',
          coverage: {
            ...result.coverage,
            gaps,
            requestedSince: since,
            requestedUntil: until,
            oldestRecordAt: result.records.length
              ? Math.min(...result.records.map((r) => r.at))
              : null,
            newestRecordAt: result.records.length
              ? Math.max(...result.records.map((r) => r.at))
              : null,
            retainedRecords: current.records.length,
            retainedTextTruncated: current.records.some((r) => r.truncated),
          },
        });
        current.scans = current.scans.slice(-32);
        current.cursor = {
          at: this.now(),
          sourceRevision: target.currentScope(e.scope, this.options.snapshot()).taskRevision,
          maxRecordAt: Math.max(e.cursor?.maxRecordAt || 0, ...result.records.map((r) => r.at)),
        };
        current.pending = null;
        current.phase = 'enabled';
        current.nextReadAt =
          this.now() + (current.config.background ? current.config.intervalSeconds * 1000 : 0);
        current.updatedAt = this.now();
      });
      return true;
    } catch (error) {
      if (started) this.options.policy.outcome(operationId, 'unknown');
      this.recordGap(
        id,
        operationId,
        error.code === 'RESEARCH_RATE_LIMITED'
          ? 'rate_limited'
          : error.code === 'RESEARCH_SCOPE_CHANGED'
            ? 'scope_changed'
            : 'read_failed',
        error.retryAfterMs,
      );
      return false;
    } finally {
      this.pending.delete(id);
    }
  }
  recordGap(id, operationId, reason, retryAfterMs) {
    this.change((next) => {
      const e = next.entries.find((x) => x.id === id);
      e.scans.push({ id: operationId, at: this.now(), status: reason, coverage: null });
      e.scans = e.scans.slice(-32);
      e.pending = null;
      if (!['paused', 'revoked'].includes(e.phase))
        e.phase = ['grant_expired', 'scope_expired'].includes(reason)
          ? 'expired'
          : reason === 'grant_limit_reached'
            ? 'exhausted'
            : reason === 'account_revoked' || reason === 'grant_revoked_or_missing'
              ? 'revoked'
              : reason === 'rate_limited'
                ? 'rate_limited'
                : 'gap';
      e.nextReadAt =
        this.now() +
        Math.max(60000, Math.min(86400000, Number.isFinite(retryAfterMs) ? retryAfterMs : 300000));
      e.updatedAt = this.now();
    });
  }
  async tick() {
    if (this.closed) return;
    for (const e of this.snapshot())
      if (!this.pending.has(e.id))
        await this.read(e.id).catch(() =>
          this.options.log?.write('research.recovery_failed', {
            code: 'RESEARCH_STORAGE_FAILED',
            noResend: true,
          }),
        );
  }
  context() {
    const entries = this.snapshot()
      .slice(-8)
      .map((e) => {
        let permitted = false;
        try {
          const access = this.gate(e, e.pending?.id || crypto.randomUUID(), { manual: true });
          permitted =
            ['act', 'ask'].includes(access.decision) || access.reason === 'grant_limit_reached';
        } catch {}
        return {
          id: e.id,
          chatName: e.scope.chatName,
          sourceId: e.scope.sourceId,
          ownerId: e.scope.ownerId,
          topic: e.config.topic,
          phase: e.phase,
          cursor: e.cursor,
          coverage: e.scans.at(-1) || null,
          recordCoverage: {
            totalRetained: e.records.length,
            included: permitted ? Math.min(8, e.records.length) : 0,
            state: permitted ? 'bounded_retained_originals' : 'scope_unavailable',
          },
          records: permitted
            ? e.records.slice(-8).map((r) => ({
                ...r,
                text: r.text.slice(0, 600),
                truncated: r.truncated || r.text.length > 600,
              }))
            : [],
          interpretation:
            'Original statements and later replies are data. Any assignment, overdue, open or complete label requires supported evidence and remains an inference or human statement, not verified outcome.',
        };
      });
    return {
      entries,
      exhaustive: false,
      includedScopes: entries.length,
      totalScopes: this.state.entries.length,
    };
  }
  close() {
    this.closed = true;
    this.options.reader.close?.();
  }
}
module.exports = { Research, configuration, validate };
