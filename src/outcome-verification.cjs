'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { atomicJSON, readStore } = require('./private-store.cjs');
const uuid = (x) =>
  typeof x === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(x);
const text = (x, n = 1000) => typeof x === 'string' && x.trim().length > 0 && x.length <= n;
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const hash = (x) =>
  crypto
    .createHash('sha256')
    .update(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x))
    .digest('hex');
const stages = new Set([
  'prepared',
  'saved',
  'accepted',
  'completed',
  'merged',
  'deployed',
  'delivered',
]);
const statuses = new Set([
  'awaiting_proof',
  'verified',
  'human_reviewed',
  'missing',
  'stale',
  'changed',
  'inaccessible',
  'partial',
  'unsupported',
  'not_satisfied',
  'rate_limited',
]);
function spec(value) {
  if (
    !object(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          'kind',
          'stage',
          'description',
          'target',
          'targetRevision',
          'maxAgeSeconds',
          'until',
          'root',
          'file',
          'fields',
          'sha256',
          'baseRef',
        ].includes(k),
    ) ||
    !['artifact', 'source_pass', 'manual', 'github_pr'].includes(value.kind) ||
    !stages.has(value.stage) ||
    !text(value.description) ||
    !text(value.target, 512) ||
    !text(value.targetRevision, 200) ||
    !Number.isSafeInteger(value.maxAgeSeconds) ||
    value.maxAgeSeconds < 1 ||
    value.maxAgeSeconds > 86400 ||
    !Number.isSafeInteger(value.until) ||
    value.until <= 0
  )
    throw new Error(
      'Use a finite outcome scope with kind, stage, description, target, targetRevision, maxAgeSeconds and until (UTC milliseconds).',
    );
  if (value.kind === 'artifact') {
    if (
      !['prepared', 'saved'].includes(value.stage) ||
      !text(value.root, 32768) ||
      !path.isAbsolute(value.root) ||
      !text(value.file, 200) ||
      path.isAbsolute(value.file) ||
      value.file.includes(':') ||
      value.file.includes('\0') ||
      value.file.split(/[\\/]/).some((x) => !x || x === '.' || x === '..') ||
      !object(value.fields) ||
      !Object.keys(value.fields).length ||
      Object.keys(value.fields).length > 16 ||
      Object.entries(value.fields).some(
        ([k, v]) =>
          !text(k, 100) ||
          !['string', 'number', 'boolean'].includes(typeof v) ||
          (typeof v === 'string' && v.length > 1000) ||
          (typeof v === 'number' && !Number.isFinite(v)),
      ) ||
      (value.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.sha256))
    )
      throw new Error(
        'Artifact proof requires one relative JSON file, bounded scalar fields and an optional exact SHA-256. It proves prepared or saved only.',
      );
  } else if (['root', 'file', 'fields', 'sha256'].some((k) => Object.hasOwn(value, k)))
    throw new Error('File access belongs only to an explicit artifact outcome.');
  if (value.kind === 'source_pass' && !['accepted', 'completed'].includes(value.stage))
    throw new Error(
      'A source receipt can prove acceptance or a completed pass, not merge, deployment or delivery.',
    );
  if (value.kind === 'github_pr') {
    if (value.stage !== 'merged')
      throw new Error('A GitHub PR read proves only its requested merge.');
    require('./outcome-github.cjs').target(value);
  } else if (Object.hasOwn(value, 'baseRef'))
    throw new Error('A target branch belongs only to GitHub merge proof.');
  return structuredClone(value);
}
function binding(entry) {
  return hash([
    entry.id,
    entry.revision,
    entry.instruction,
    entry.scope.sourceId,
    entry.scope.ownerId,
    entry.scope.deviceId,
    entry.scope.taskRevision,
    entry.currentStep.id,
  ]);
}
function validate(value) {
  if (
    value?.version !== 2 ||
    !Array.isArray(value.entries) ||
    value.entries.length > 128 ||
    !object(value.receipts) ||
    Object.keys(value.receipts).length > 4096
  )
    throw new Error('Invalid outcome journal');
  const ids = new Set();
  for (const e of value.entries) {
    if (
      !uuid(e.id) ||
      ids.has(e.id) ||
      !uuid(e.origin?.messageId) ||
      !text(e.origin.text, 4000) ||
      !text(e.origin.actorId, 200) ||
      !/^[a-f0-9]{64}$/.test(e.binding) ||
      !Number.isSafeInteger(e.revision) ||
      e.revision < 1 ||
      !Array.isArray(e.history) ||
      e.history.length > 32 ||
      !statuses.has(e.result?.status) ||
      !Number.isFinite(e.result.checkedAt) ||
      e.result.checkedAt < 0 ||
      e.history.some(
        (h) =>
          !uuid(h.messageId) ||
          !text(h.actorId, 200) ||
          !text(h.operation, 30) ||
          !Number.isFinite(h.at) ||
          h.at <= 0,
      )
    )
      throw new Error('Invalid outcome entry');
    spec(e.spec);
    if (
      e.connector !== undefined &&
      (!object(e.connector) ||
        Object.keys(e.connector).sort().join(',') !== 'fingerprint,nextAt,unchanged' ||
        !(e.connector.fingerprint === null || /^[a-f0-9]{64}$/.test(e.connector.fingerprint)) ||
        !Number.isInteger(e.connector.unchanged) ||
        e.connector.unchanged < 0 ||
        e.connector.unchanged > 10 ||
        !Number.isSafeInteger(e.connector.nextAt) ||
        e.connector.nextAt < 0 ||
        e.spec.kind !== 'github_pr')
    )
      throw new Error('Invalid destination backoff');
    if (
      e.result.reason !== undefined &&
      (typeof e.result.reason !== 'string' || e.result.reason.length > 60)
    )
      throw new Error('Invalid outcome reason');
    if (
      e.result.retryAfterMs !== undefined &&
      (!Number.isSafeInteger(e.result.retryAfterMs) ||
        e.result.retryAfterMs < 60000 ||
        e.result.retryAfterMs > 86400000)
    )
      throw new Error('Invalid destination delay');
    if (e.result.observation !== undefined) {
      if (e.spec.kind !== 'github_pr' || e.result.status !== 'not_satisfied')
        throw new Error('Invalid negative destination evidence');
      githubEvidence(e.result.observation, e.spec, false);
    }
    if (e.result.status === 'not_satisfied' && !e.result.observation)
      throw new Error('A negative outcome needs original destination evidence');
    ids.add(e.id);
    const prefix = '/outcome require ' + e.id + ': ';
    if (!e.origin.text.startsWith(prefix)) throw new Error('Outcome lost human provenance');
    const literal = spec(JSON.parse(e.origin.text.slice(prefix.length))),
      normalized = structuredClone(e.spec);
    if (literal.kind === 'artifact') normalized.root = literal.root;
    if (hash(literal) !== hash(normalized))
      throw new Error('Outcome scope changed without human provenance');
    if (
      (e.result.status === 'verified' && !e.result.proof) ||
      (e.result.status === 'human_reviewed' && e.spec.kind !== 'manual')
    )
      throw new Error('Invalid outcome evidence kind');
    if (
      e.result.proof !== undefined &&
      (!object(e.result.proof) ||
        Object.keys(e.result.proof).some(
          (k) =>
            ![
              'stage',
              'targetRevision',
              'sha256',
              'turnId',
              'mtimeMs',
              'bytes',
              'sourceRevision',
              'provider',
              'target',
              'headSha',
              'baseRef',
              'responseSha256',
              'observedAt',
              'merged',
              'mergeSha',
            ].includes(k),
        ) ||
        e.result.proof.stage !== e.spec.stage ||
        e.result.proof.targetRevision !== e.spec.targetRevision)
    )
      throw new Error('Invalid outcome proof');
    if (e.result.proof) {
      const p = e.result.proof;
      if (e.spec.kind === 'github_pr') githubEvidence(p, e.spec, true);
      else if (
        Object.keys(p).some(
          (key) =>
            ![
              'stage',
              'targetRevision',
              'sha256',
              'turnId',
              'mtimeMs',
              'bytes',
              'sourceRevision',
            ].includes(key),
        )
      )
        throw new Error('Unexpected destination evidence on a local outcome');
      if (
        (e.spec.kind === 'artifact' &&
          (!/^[a-f0-9]{64}$/.test(p.sha256) ||
            !Number.isFinite(p.mtimeMs) ||
            p.mtimeMs <= 0 ||
            !Number.isSafeInteger(p.bytes) ||
            p.bytes < 1 ||
            p.bytes > 1024 * 1024)) ||
        (e.spec.kind === 'source_pass' && (!text(p.turnId, 512) || !text(p.sourceRevision, 512))) ||
        e.spec.kind === 'manual'
      )
        throw new Error('Invalid typed outcome proof');
    }
  }
  if (
    Object.entries(value.receipts).some(
      ([id, r]) => !uuid(id) || !object(r) || !ids.has(r.id) || !/^[a-f0-9]{64}$/.test(r.hash),
    )
  )
    throw new Error('Invalid outcome receipts');
  return value;
}
function githubEvidence(value, criterion, merged) {
  const allowed = [
    'provider',
    'target',
    'headSha',
    'baseRef',
    'responseSha256',
    'observedAt',
    'merged',
    ...(merged ? ['stage', 'targetRevision', 'mergeSha'] : []),
  ];
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== allowed.sort().join(',') ||
    value.provider !== 'public-github' ||
    value.target !== criterion.target ||
    value.headSha !== criterion.targetRevision ||
    value.baseRef !== criterion.baseRef ||
    !/^[a-f0-9]{64}$/.test(value.responseSha256) ||
    !Number.isFinite(value.observedAt) ||
    value.observedAt <= 0 ||
    value.merged !== merged ||
    (merged && !/^[a-f0-9]{40}$/.test(value.mergeSha))
  )
    throw new Error('Invalid exact GitHub destination evidence');
}
function regularTree(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) throw new Error('Linked artifact scope is unavailable');
    if (path.dirname(current) === current) break;
  }
}
class OutcomeVerification extends EventEmitter {
  constructor(options) {
    super();
    if (!text(options.actorId, 200)) throw new Error('An outcome owner is required');
    this.options = options;
    this.closed = false;
    this.unconfirmed = false;
    this.pending = new Set();
    this.file = path.join(options.directory, 'outcomes.json');
    this.state = readStore(this.file, {
      missing: () => ({ version: 2, entries: [], receipts: {} }),
    }).value;
  }
  now() {
    return this.options.now?.() ?? Date.now();
  }
  human(input) {
    if (
      input?.role !== 'human' ||
      !uuid(input.messageId) ||
      !text(input.text, 4000) ||
      (input.actorId !== undefined && input.actorId !== this.options.actorId)
    )
      throw new Error('A current human outcome control is required');
    return { ...input, actorId: this.options.actorId };
  }
  change(fn) {
    if (this.closed) throw new Error('Hyphen is closing');
    if (this.unconfirmed) throw new Error('Outcome storage needs recovery');
    const previous = readStore(this.file, {
      missing: () => ({ version: 2, entries: [], receipts: {} }),
    }).value;
    if (hash(previous) !== hash(this.state)) {
      this.unconfirmed = true;
      throw new Error('Outcome storage changed; recovery is required');
    }
    const next = structuredClone(this.state),
      result = fn(next);
    validate(next);
    if (Buffer.byteLength(JSON.stringify(next)) > 2 * 1024 * 1024)
      throw new Error('Outcome history is full');
    const write = this.options.write || atomicJSON;
    write(this.file, next);
    let actual;
    try {
      actual = readStore(this.file).value;
      if (!actual || hash(actual) !== hash(next)) throw new Error();
    } catch {
      this.unconfirmed = true;
      throw new Error('Outcome save is unconfirmed; recovery is required');
    }
    this.state = actual;
    this.emit('change');
    return result;
  }
  entry(id) {
    return this.state.entries.find((e) => e.id === id);
  }
  require(id, value, input) {
    const human = this.human(input),
      criterion = spec(value),
      entry = this.options.responsibilities.entry(id),
      now = this.now();
    if (
      !human.text.startsWith('/outcome require ' + id + ': ') ||
      hash(spec(JSON.parse(human.text.slice(('/outcome require ' + id + ': ').length)))) !==
        hash(criterion)
    )
      throw new Error('Outcome scope must be literal current human text');
    if (
      ['completed', 'cancelled'].includes(entry.state) ||
      criterion.until <= now ||
      criterion.until > now + 86400000
    )
      throw new Error(
        'Choose an unfinished responsibility and an outcome scope expiring within one day',
      );
    if (criterion.kind === 'artifact') {
      const rootInfo = fs.lstatSync(criterion.root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
        throw new Error('Choose an existing unlinked artifact directory');
      criterion.root = fs.realpathSync.native(criterion.root);
      regularTree(criterion.root);
    }
    const digest = hash([id, criterion, human.text]),
      prior = this.state.receipts[human.messageId];
    if (prior) {
      if (prior.hash !== digest) throw new Error('Outcome identity belongs to different text');
      return this.entry(id);
    }
    this.change((next) => {
      if (Object.keys(next.receipts).length >= 4096)
        throw new Error('Outcome identity history is full');
      let record = next.entries.find((e) => e.id === id);
      if (!record) {
        if (next.entries.length === 128) throw new Error('Outcome capacity is full');
        record = { id, revision: 0, history: [] };
        next.entries.push(record);
      }
      if (record.history.length === 32) throw new Error('Outcome history is full');
      record.revision++;
      record.origin = { messageId: human.messageId, text: human.text, actorId: human.actorId };
      record.spec = criterion;
      record.binding = binding(entry);
      record.result = { status: 'awaiting_proof', checkedAt: 0 };
      delete record.connector;
      record.history.push({
        messageId: human.messageId,
        actorId: human.actorId,
        operation: 'require',
        at: now,
      });
      next.receipts[human.messageId] = { id, hash: digest };
    });
    return this.entry(id);
  }
  scoped(record, entry) {
    if (this.closed || this.unconfirmed) return 'inaccessible';
    if (record.origin.actorId !== this.options.actorId || record.binding !== binding(entry))
      return 'changed';
    if (record.spec.until <= this.now()) return 'stale';
    try {
      if (
        this.options.maintenance?.() ||
        (this.options.admission && this.options.admission(entry) !== 'allow')
      )
        return 'inaccessible';
      this.options.responsibilities.refreshScope(entry, this.options.snapshot());
    } catch {
      return 'inaccessible';
    }
    return null;
  }
  artifact(record) {
    const s = record.spec,
      file = path.resolve(s.root, s.file);
    if (!file.startsWith(s.root + path.sep)) return { status: 'inaccessible' };
    let fd;
    try {
      regularTree(file);
      if (fs.realpathSync.native(s.root) !== s.root) return { status: 'changed' };
      const before = fs.lstatSync(file);
      if (!before.isFile() || before.size > 1024 * 1024) return { status: 'partial' };
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
        return { status: 'changed' };
      // Never read beyond the declared bound even if the file grows concurrently.
      regularTree(file);
      const currentBeforeRead = fs.lstatSync(file),
        canonical = fs.realpathSync.native(file),
        prefix = s.root + path.sep;
      if (
        currentBeforeRead.dev !== opened.dev ||
        currentBeforeRead.ino !== opened.ino ||
        !(process.platform === 'win32'
          ? canonical.toLowerCase().startsWith(prefix.toLowerCase())
          : canonical.startsWith(prefix))
      )
        return { status: 'changed' };
      const buffer = Buffer.alloc(opened.size + 1),
        count = fs.readSync(fd, buffer, 0, buffer.length, 0),
        after = fs.fstatSync(fd);
      if (
        count !== opened.size ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs
      )
        return { status: 'changed' };
      regularTree(file);
      const current = fs.lstatSync(file);
      if (current.isSymbolicLink() || current.ino !== opened.ino || current.dev !== opened.dev)
        return { status: 'changed' };
      if (
        opened.mtimeMs > this.now() + 1000 ||
        this.now() - opened.mtimeMs > s.maxAgeSeconds * 1000
      )
        return { status: 'stale' };
      const bytes = buffer.subarray(0, count),
        digest = hash(bytes),
        value = JSON.parse(bytes.toString('utf8'));
      if (
        !object(value) ||
        Object.entries(s.fields).some(([k, v]) => !Object.hasOwn(value, k) || value[k] !== v) ||
        (s.sha256 && s.sha256 !== digest)
      )
        return { status: 'partial' };
      return {
        status: 'verified',
        proof: {
          stage: s.stage,
          targetRevision: s.targetRevision,
          sha256: digest,
          mtimeMs: opened.mtimeMs,
          bytes: count,
        },
      };
    } catch (error) {
      return {
        status:
          error.code === 'ENOENT'
            ? 'missing'
            : error instanceof SyntaxError
              ? 'partial'
              : 'inaccessible',
      };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  check(id, input) {
    const human = this.human(input),
      entry = this.options.responsibilities.entry(id),
      record = this.entry(id);
    if (!record) throw new Error('Set the expected outcome first');
    if (!['/outcome check ' + id, '/responsibility verify ' + id].includes(human.text))
      throw new Error('Use a literal current human outcome check');
    if (this.unconfirmed || hash(readStore(this.file).value) !== hash(this.state)) {
      this.unconfirmed = true;
      throw new Error('Outcome storage changed; recovery is required');
    }
    const gate = this.scoped(record, entry);
    if (record.spec.kind === 'github_pr') return this.destinationCheck(record, entry, human, gate);
    let result = { status: gate || 'unsupported' };
    if (!gate && record.spec.kind === 'artifact') result = this.artifact(record);
    if (!gate && record.spec.kind === 'source_pass') {
      const match = require('./assistant-coordination.cjs').sourceFor(
          this.options.snapshot(),
          entry.scope,
        ),
        source = match?.source;
      const receipt = source?.deliveryOutcomes?.find(
        (r) =>
          r.messageId === entry.currentStep.messageId &&
          r.turnId === entry.currentStep.turnId &&
          r.sourceId === entry.scope.sourceId &&
          r.status === 'sent',
      );
      const terminal =
        source?.turnId === entry.currentStep.turnId && source.turnOutcome === 'completed';
      const recent =
        receipt &&
        Number.isFinite(receipt.acceptedAt) &&
        receipt.acceptedAt <= this.now() + 1000 &&
        this.now() - receipt.acceptedAt <= record.spec.maxAgeSeconds * 1000;
      result =
        receipt && !recent
          ? { status: 'stale' }
          : receipt && (record.spec.stage === 'accepted' || terminal)
            ? {
                status: 'verified',
                proof: {
                  stage: record.spec.stage,
                  targetRevision: record.spec.targetRevision,
                  turnId: entry.currentStep.turnId,
                  sourceRevision: entry.scope.taskRevision,
                },
              }
            : { status: 'awaiting_proof' };
    }
    if (!gate && record.spec.kind === 'manual')
      result = {
        status: human.text === '/responsibility verify ' + id ? 'human_reviewed' : 'awaiting_proof',
      };
    // Re-check ownership and current human steering after evidence access.
    const changed = this.scoped(record, this.options.responsibilities.entry(id));
    if (changed) result = { status: changed };
    this.change((next) => {
      const current = next.entries.find((e) => e.id === id);
      if (current.history.length === 32) throw new Error('Outcome history is full');
      current.result = { ...result, checkedAt: this.now() };
      current.history.push({
        messageId: human.messageId,
        actorId: human.actorId,
        operation: 'check',
        at: this.now(),
      });
    });
    return this.entry(id).result;
  }
  async destinationCheck(record, entry, human, gate) {
    const id = record.id,
      original = hash(record),
      receiptHash = hash([id, record.revision, human.text, 'github-check']),
      prior = this.state.receipts[human.messageId];
    if (prior) {
      if (prior.hash !== receiptHash)
        throw new Error('Outcome identity belongs to another operation.');
      return gate || this.freshness(record) ? { status: gate || 'stale' } : record.result;
    }
    if (this.pending.has(id)) throw new Error('This destination check is already pending.');
    if (record.history.length >= 32 || Object.keys(this.state.receipts).length >= 4096)
      throw new Error('Outcome history is full; no destination was read.');
    const unchangedRecord = () => {
      if (this.unconfirmed || hash(readStore(this.file).value) !== hash(this.state)) {
        this.unconfirmed = true;
        throw new Error('Outcome storage changed; response discarded.');
      }
      if (hash(this.entry(id)) !== original)
        throw new Error('Outcome changed while checking; response discarded.');
    };
    const beforeRead = () => {
      unchangedRecord();
      const blocked = this.scoped(record, this.options.responsibilities.entry(id));
      if (blocked) throw new Error('Destination scope is ' + blocked + '.');
    };
    this.pending.add(id);
    let attempted = false,
      result = { status: gate || 'unsupported' };
    try {
      if (!gate && record.connector?.nextAt > this.now())
        result = { status: 'rate_limited', reason: 'connector_backoff' };
      else if (!gate && this.options.github) {
        attempted = true;
        try {
          result = await this.options.github.read(record.spec, {
            beforeRead,
            sourceId: entry.scope.sourceId,
            responsibilityId: id,
          });
        } catch (error) {
          result = {
            status: 'inaccessible',
            reason:
              error.code === 'RESOURCE_BUDGET' ? 'resource_budget' : 'destination_read_failed',
          };
        }
      }
      unchangedRecord();
      const currentGate = this.scoped(record, this.options.responsibilities.entry(id));
      if (currentGate) result = { status: currentGate };
      this.change((next) => {
        const current = next.entries.find((e) => e.id === id);
        current.result = { ...result, checkedAt: this.now() };
        current.history.push({
          messageId: human.messageId,
          actorId: human.actorId,
          operation: 'check',
          at: this.now(),
        });
        next.receipts[human.messageId] = { id, hash: receiptHash };
        if (attempted) {
          const fingerprint =
              result.proof?.responseSha256 || result.observation?.responseSha256 || null,
            unchanged =
              fingerprint && record.connector?.fingerprint === fingerprint
                ? Math.min(10, record.connector.unchanged + 1)
                : 0;
          current.connector = {
            fingerprint,
            unchanged,
            nextAt:
              this.now() + (result.retryAfterMs || Math.min(86400000, 60000 * 2 ** unchanged)),
          };
        }
      });
      return this.entry(id).result;
    } finally {
      this.pending.delete(id);
    }
  }
  required(entry) {
    return !!this.entry(entry.id);
  }
  admission(entry, input) {
    if (!this.required(entry)) return true;
    const result = this.check(entry.id, input);
    if (result?.then) return result.then((r) => r.status === 'verified');
    return ['verified', 'human_reviewed'].includes(result.status);
  }
  inspect(id) {
    const r = this.entry(id);
    if (!r) throw new Error('That expected outcome is unavailable');
    const current = this.options.responsibilities.entry(id),
      gate = this.scoped(r, current) || this.freshness(r);
    return {
      ...structuredClone(r),
      result: gate ? { status: gate, checkedAt: r.result.checkedAt } : r.result,
    };
  }
  freshness(record) {
    return record.result.checkedAt &&
      (record.result.checkedAt > this.now() + 1000 ||
        this.now() - record.result.checkedAt > record.spec.maxAgeSeconds * 1000)
      ? 'stale'
      : null;
  }
  context() {
    const records = this.state.entries.slice(-8).map((r) => {
      const e = this.options.responsibilities.state.entries.find((x) => x.id === r.id),
        gate = e ? this.scoped(r, e) : 'missing';
      const status = gate || this.freshness(r) || r.result.status;
      return {
        responsibilityId: r.id,
        expectedStage: r.spec.stage,
        proofKind: r.spec.kind,
        description: r.spec.description,
        status,
        checkedAt: r.result.checkedAt,
        independent: status === 'verified',
        targetRevision: r.spec.targetRevision,
      };
    });
    return {
      coverage:
        'Bounded retained outcome checks; no automatic source refresh or exhaustive outcome coverage.',
      records,
    };
  }
  close() {
    this.closed = true;
    this.options.github?.close();
  }
}
module.exports = { OutcomeVerification, validate, spec, binding };
