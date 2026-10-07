'use strict';
const path = require('node:path'),
  crypto = require('node:crypto'),
  { EventEmitter } = require('node:events'),
  { command } = require('./triage-command.cjs'),
  timing = require('./schedule-time.cjs'),
  target = require('./responsibility-target.cjs'),
  { sourceFor, fresh } = require('./assistant-coordination.cjs'),
  { quiet } = require('./notification-flow.cjs');
const hash = (v) =>
    crypto
      .createHash('sha256')
      .update(JSON.stringify(v ?? null))
      .digest('hex'),
  object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  text = (v, n) => typeof v === 'string' && v.trim().length > 0 && v.length <= n,
  uuid = (v) =>
    typeof v === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v),
  digest = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),
  instant = (v) => Number.isSafeInteger(v) && v > 0,
  kinds = ['needs_user', 'ready', 'blocked', 'failure', 'urgent', 'routine'];
function configuration(raw, now, deviceId) {
  const keys = [
    'destination',
    'conditions',
    'quietHours',
    'routineUpdates',
    'escalateAfterSeconds',
    'minIntervalSeconds',
    'maxReminders',
    'until',
    'maxAttempts',
  ];
  if (
    !object(raw) ||
    Object.keys(raw).some((k) => !keys.includes(k)) ||
    !object(raw.destination) ||
    Object.keys(raw.destination).some((k) => !['kind', 'deviceId', 'audience'].includes(k)) ||
    !['inbox', 'system'].includes(raw.destination.kind) ||
    raw.destination.deviceId !== deviceId ||
    raw.destination.audience !== 'self' ||
    !Array.isArray(raw.conditions) ||
    !raw.conditions.length ||
    raw.conditions.length > 5 ||
    raw.conditions.some((k) => !kinds.slice(0, 5).includes(k)) ||
    new Set(raw.conditions).size !== raw.conditions.length ||
    !['off', 'changes'].includes(raw.routineUpdates) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(raw.until || '')
  )
    throw new Error('Choose exact self-only local destination and bounded notification conditions');
  const endAt = Date.parse(raw.until);
  if (
    !instant(endAt) ||
    new Date(endAt).toISOString().replace('.000Z', 'Z') !== raw.until ||
    endAt <= now ||
    endAt > now + 30 * 86400000
  )
    throw new Error('Notification rules need a finite expiry within thirty days');
  for (const [key, min, max] of [
    ['minIntervalSeconds', 60, 604800],
    ['maxReminders', 0, 3],
    ['maxAttempts', 1, 64],
  ])
    if (!Number.isSafeInteger(raw[key]) || raw[key] < min || raw[key] > max)
      throw new Error('Invalid notification ' + key);
  if (
    !Number.isSafeInteger(raw.escalateAfterSeconds) ||
    !(
      raw.escalateAfterSeconds === 0 ||
      (raw.escalateAfterSeconds >= 60 && raw.escalateAfterSeconds <= 604800)
    ) ||
    (raw.maxReminders > 0 && raw.escalateAfterSeconds === 0)
  )
    throw new Error('Choose an explicit bounded escalation delay');
  if (raw.quietHours !== null) {
    const q = raw.quietHours;
    if (
      !object(q) ||
      Object.keys(q).some((k) => !['start', 'end', 'timeZone'].includes(k)) ||
      ![q.start, q.end].every(
        (t) => typeof t === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t),
      ) ||
      q.start === q.end ||
      !text(q.timeZone, 100)
    )
      throw new Error('Choose explicit named-timezone quiet hours');
    timing.parts(now, q.timeZone);
  }
  return { ...structuredClone(raw), endAt };
}
function human(h, actor) {
  return (
    h?.role === 'human' &&
    h.authority === 'accepted_human' &&
    text(h.actorId, 200) &&
    h.actorId === actor &&
    uuid(h.messageId) &&
    text(h.text, 4000)
  );
}
const empty = () => ({
  version: 1,
  rules: [],
  findings: [],
  decisions: [],
  deliveries: [],
  controls: [],
  receipts: {},
  droppedFindings: 0,
  droppedDecisions: 0,
});
function validate(v) {
  if (
    v?.version !== 1 ||
    !object(v.receipts) ||
    Object.keys(v.receipts).length > 5000 ||
    ![
      ['rules', 32],
      ['findings', 256],
      ['decisions', 512],
      ['deliveries', 256],
      ['controls', 512],
    ].every(([k, n]) => Array.isArray(v[k]) && v[k].length <= n) ||
    ![v.droppedFindings, v.droppedDecisions].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    throw new Error('Invalid notification journal');
  const rules = new Map();
  for (const r of v.rules) {
    const intent = command(r.origin?.text);
    if (
      !uuid(r.id) ||
      rules.has(r.id) ||
      !uuid(r.responsibilityId) ||
      !human(r.origin, r.origin?.actorId) ||
      intent?.kind !== 'configure' ||
      intent.responsibilityId !== r.responsibilityId ||
      hash(intent.config) !== hash(r.rawConfig) ||
      !instant(r.createdAt) ||
      !['sourceId', 'ownerId', 'deviceId', 'taskKey'].every((k) => text(r.binding?.[k], 512)) ||
      hash(configuration(r.rawConfig, r.createdAt, r.config?.destination?.deviceId)) !==
        hash(r.config) ||
      !['active', 'paused'].includes(r.phase)
    )
      throw new Error('Invalid notification scope or human provenance');
    rules.set(r.id, r);
  }
  const findings = new Set(),
    deliveries = new Set(),
    dedup = new Set();
  for (const f of v.findings) {
    const r = rules.get(f.ruleId);
    if (
      !r ||
      !uuid(f.id) ||
      findings.has(f.id) ||
      !digest(f.hash) ||
      !instant(f.at) ||
      !kinds.includes(f.kind) ||
      !object(f.signals) ||
      kinds.some((k) => typeof f.signals[k] !== 'boolean') ||
      !text(f.text, 1600) ||
      !['you', 'other', 'unknown'].includes(f.waitingOn) ||
      typeof f.manualUrgency !== 'boolean' ||
      f.independentlyVerified !== false ||
      !object(f.source) ||
      hash(f.source.binding) !== hash(r.binding) ||
      !text(f.source.revision, 512) ||
      !instant(f.responsibilityRevision) ||
      !uuid(f.stepId) ||
      !text(f.workerStatus, 40) ||
      f.coverage?.exhaustive !== false ||
      !Number.isFinite(f.coverage.snapshotCollectedAt) ||
      !Array.isArray(f.originalStatements) ||
      f.originalStatements.length > 3 ||
      f.originalStatements.some(
        (s) =>
          !digest(s.id) ||
          !['user', 'assistant'].includes(s.role) ||
          !text(s.text, 300) ||
          typeof s.truncated !== 'boolean' ||
          s.provenance !== 'retained_original_record',
      )
    )
      throw new Error('Invalid worker finding or coverage');
    findings.add(f.id);
  }
  for (const d of v.deliveries) {
    const r = rules.get(d.ruleId);
    if (
      !r ||
      !uuid(d.id) ||
      deliveries.has(d.id) ||
      !digest(d.findingHash) ||
      !digest(d.dedupKey) ||
      dedup.has(d.dedupKey) ||
      !uuid(d.findingId) ||
      !instant(d.preparedAt) ||
      !Number.isInteger(d.level) ||
      d.level < 0 ||
      d.level > r.config.maxReminders ||
      !['prepared', 'sending', 'unknown', 'accepted', 'acknowledged', 'not_sent'].includes(
        d.status,
      ) ||
      !object(d.payload) ||
      !text(d.payload.text, 2000) ||
      d.payload.independentlyVerified !== false ||
      d.payload.findingHash !== d.findingHash ||
      hash(d.payload.source?.binding) !== hash(r.binding) ||
      hash(d.payload) !== d.payloadHash ||
      hash(d.destination) !== hash(r.config.destination) ||
      !text(d.reason, 200) ||
      d.synthetic !== false ||
      (d.receipt !== null && !receiptValid(d.receipt, d))
    )
      throw new Error('Invalid notification delivery');
    if (['accepted', 'acknowledged'].includes(d.status) && d.receipt === null)
      throw new Error('Notification acceptance needs a destination receipt');
    deliveries.add(d.id);
    dedup.add(d.dedupKey);
  }
  for (const d of v.decisions)
    if (
      !uuid(d.id) ||
      !rules.has(d.ruleId) ||
      !instant(d.at) ||
      !text(d.reason, 200) ||
      !['quiet', 'notify'].includes(d.decision) ||
      !digest(d.key) ||
      (d.findingHash !== null && !digest(d.findingHash))
    )
      throw new Error('Invalid notification decision');
  for (const c of v.controls) {
    const r = rules.get(c.ruleId),
      intent = command(c.origin?.text);
    if (
      !r ||
      !instant(c.at) ||
      !human(c.origin, r.origin.actorId) ||
      !['pause', 'resume', 'acknowledge'].includes(c.kind) ||
      intent?.kind !== c.kind ||
      intent.id !== c.subjectId ||
      (c.kind === 'acknowledge' ? !deliveries.has(c.subjectId) : c.subjectId !== r.id)
    )
      throw new Error('Invalid notification control provenance');
  }
  for (const [id, r] of Object.entries(v.receipts))
    if (!uuid(id) || !rules.has(r.ruleId) || !digest(r.hash))
      throw new Error('Invalid notification replay receipt');
  return v;
}
function receiptValid(r, d) {
  return (
    object(r) &&
    r.deliveryId === d.id &&
    r.payloadHash === d.payloadHash &&
    r.destinationKey === hash(d.destination) &&
    instant(r.at) &&
    r.at >= d.preparedAt &&
    typeof r.synthetic === 'boolean' &&
    ['inbox_stored', 'os_shown'].includes(r.kind) &&
    (d.destination.kind === 'inbox' ? r.kind === 'inbox_stored' : r.kind === 'os_shown')
  );
}
class Triage extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.file = path.join(options.directory, 'triage.json');
    this.closed = false;
    this.pending = new Set();
    this.state = require('./private-store.cjs').readStore(this.file, { missing: empty }).value;
    if (this.state.deliveries.some((d) => ['prepared', 'sending'].includes(d.status)))
      this.change((next) => {
        for (const d of next.deliveries)
          if (['prepared', 'sending'].includes(d.status)) {
            d.status = 'unknown';
            d.reason = 'restart_delivery_unconfirmed';
          }
      });
  }
  now() {
    return this.options.now?.() ?? Date.now();
  }
  change(fn) {
    if (this.closed) throw new Error('Notification recovery or shutdown is required');
    const next = structuredClone(this.state),
      result = fn(next);
    if (next.findings.length > 256) {
      next.droppedFindings += next.findings.length - 256;
      next.findings = next.findings.slice(-256);
    }
    if (next.decisions.length > 512) {
      next.droppedDecisions += next.decisions.length - 512;
      next.decisions = next.decisions.slice(-512);
    }
    validate(next);
    if (Buffer.byteLength(JSON.stringify(next)) > 32 * 1024 * 1024)
      throw new Error('Notification journal is full');
    const store = require('./private-store.cjs');
    try {
      if (hash(store.readStore(this.file, { missing: empty }).value) !== hash(this.state))
        throw new Error('Journal changed independently');
      (this.options.write || store.atomicJSON)(this.file, next);
      const actual = (this.options.read || store.readStore)(this.file).value;
      if (hash(actual) !== hash(next)) throw new Error('Write not verified');
      this.state = actual;
    } catch {
      this.closed = true;
      throw new Error(
        'Notification storage could not be verified. The original file is preserved; inspect a copy before recovery.',
      );
    }
    this.emit('change');
    return result;
  }
  accept(h) {
    if (!human(h, this.options.policy.actorId))
      throw new Error('Only the current accepted human can configure notifications');
    return structuredClone(h);
  }
  rule(id) {
    const r = this.state.rules.find((r) => r.id === id);
    if (!r) throw new Error('Notification rule unavailable');
    return r;
  }
  binding(r) {
    return Object.fromEntries(
      ['sourceId', 'ownerId', 'deviceId', 'taskKey'].map((k) => [k, r.scope[k]]),
    );
  }
  configure(input, responsibilityId, raw) {
    const origin = this.accept(input),
      intent = command(origin.text),
      key = hash([origin, responsibilityId, raw]),
      prior = this.state.receipts[origin.messageId];
    if (
      intent?.kind !== 'configure' ||
      intent.responsibilityId !== responsibilityId ||
      hash(intent.config) !== hash(raw)
    )
      throw new Error('Retain the literal current configuration');
    if (prior) {
      if (prior.hash !== key) throw new Error('Notification identity belongs to other text');
      return prior.ruleId;
    }
    const r = this.options.responsibilities.entry(responsibilityId),
      at = this.now(),
      config = configuration(raw, at, this.options.deviceId);
    if (!this.options.destination.supports(config.destination))
      throw new Error('That exact local destination is unsupported');
    const rule = {
      id: crypto.randomUUID(),
      responsibilityId,
      binding: this.binding(r),
      origin,
      rawConfig: structuredClone(raw),
      config,
      createdAt: at,
      phase: 'active',
    };
    const gate = this.gate(rule, this.options.snapshot());
    if (!gate.allowed) throw new Error('Notification scope is unavailable: ' + gate.reason);
    this.change((next) => {
      for (const old of next.rules)
        if (old.responsibilityId === responsibilityId) old.phase = 'paused';
      next.rules.push(rule);
      next.receipts[origin.messageId] = { ruleId: rule.id, hash: key };
    });
    return rule.id;
  }
  gate(rule, snapshot) {
    if (this.closed || this.options.maintenance?.())
      return { allowed: false, reason: 'storage_or_maintenance_hold' };
    if (rule.phase !== 'active') return { allowed: false, reason: 'human_paused' };
    if (rule.origin.actorId !== this.options.policy.actorId)
      return { allowed: false, reason: 'actor_changed' };
    if (this.now() > rule.config.endAt) return { allowed: false, reason: 'rule_expired' };
    try {
      const r = this.options.responsibilities.entry(rule.responsibilityId);
      if (hash(this.binding(r)) !== hash(rule.binding))
        return { allowed: false, reason: 'responsibility_binding_changed' };
      const admission = this.options.admission?.(r);
      if ((admission && admission !== 'allow') || ['sleeping', 'cancelled'].includes(r.state))
        return { allowed: false, reason: 'responsibility_held' };
      if (!fresh(snapshot)) return { allowed: false, reason: 'source_stale' };
      const current = target.currentScope(r.scope, snapshot);
      if (
        hash(Object.fromEntries(Object.keys(rule.binding).map((k) => [k, current[k]]))) !==
        hash(rule.binding)
      )
        return { allowed: false, reason: 'source_binding_changed' };
      if (!this.options.destination.supports(rule.config.destination))
        return { allowed: false, reason: 'destination_unavailable' };
      return { allowed: true, responsibility: r, current, match: sourceFor(snapshot, r.scope) };
    } catch {
      return { allowed: false, reason: 'source_missing_offline_or_inaccessible' };
    }
  }
  managedCard(card) {
    return this.state.rules.some(
      (r) =>
        r.binding.ownerId === (card.owner?.id || 'local') &&
        card.sources?.some((s) => s.id === r.binding.sourceId),
    );
  }
  managedEvent(event, snapshot) {
    const card = (snapshot.cards || []).find(
      (c) => c.id === event.cardId || c.sources?.some((s) => s.id === event.sourceId),
    );
    return !!card && this.managedCard(card);
  }
  finding(rule, gate, snapshot) {
    const r = gate.responsibility,
      card = gate.match.card,
      p = r.currentStep,
      manualUrgency = card.priority === 'urgent',
      needs = ['waiting_user', 'waiting_approval'].includes(r.state) || p.status === 'unconfirmed',
      kind = needs
        ? 'needs_user'
        : p.status === 'failed'
          ? 'failure'
          : p.status === 'completed'
            ? 'ready'
            : r.state === 'blocked'
              ? 'blocked'
              : manualUrgency
                ? 'urgent'
                : 'routine',
      waitingOn = needs
        ? 'you'
        : ['you', 'other'].includes(card.waitingOn?.kind)
          ? card.waitingOn.kind
          : 'unknown';
    const retained = this.options.research
      ?.context()
      .entries.find(
        (e) =>
          e.sourceId === rule.binding.sourceId &&
          e.ownerId === rule.binding.ownerId &&
          e.recordCoverage.state === 'bounded_retained_originals',
      );
    const statements = (retained?.records || []).slice(-3).map((s) => ({
      id: s.id,
      role: s.role,
      text: s.text.slice(0, 300),
      truncated: s.truncated || s.text.length > 300,
      provenance: 'retained_original_record',
    }));
    const identity = hash([
      r.revision,
      r.state,
      p.id,
      p.status,
      p.turnId || null,
      r.wakeReason,
      gate.current.taskRevision,
      manualUrgency,
      waitingOn,
      statements.map((s) => s.id),
    ]);
    const old = this.state.findings.findLast((f) => f.ruleId === rule.id);
    if (old?.hash === identity) return old;
    return {
      id: crypto.randomUUID(),
      ruleId: rule.id,
      hash: identity,
      at: this.now(),
      kind,
      signals: {
        needs_user: needs,
        ready: p.status === 'completed',
        blocked: r.state === 'blocked',
        failure: p.status === 'failed',
        urgent: manualUrgency,
        routine: kind === 'routine',
      },
      waitingOn,
      manualUrgency,
      text: (
        'Reported update for ' +
        r.scope.chatName +
        ': ' +
        r.state +
        '; source step ' +
        p.status +
        '. ' +
        (waitingOn === 'unknown'
          ? 'Waiting ownership is not established. '
          : waitingOn === 'other'
            ? 'Reported waiting is on someone else. '
            : needs
              ? 'This responsibility is waiting for your review. '
              : 'The source reports waiting on you; ownership remains unverified. ') +
        'Source-pass status and requested goal verification remain separate. ' +
        String(card.summary || '').slice(0, 400)
      ).slice(0, 1600),
      source: { binding: structuredClone(rule.binding), revision: gate.current.taskRevision },
      responsibilityRevision: r.revision,
      stepId: p.id,
      workerStatus: p.status,
      originalStatements: statements,
      independentlyVerified: false,
      coverage: {
        exhaustive: false,
        snapshotCollectedAt: snapshot.collectedAt,
        originalReadAt: retained?.cursor?.at || null,
        originalContextReused: !!retained?.cursor,
        gaps: retained?.coverage?.coverage?.gaps?.slice(0, 3) || [
          'No original-reader coverage is established for this finding.',
        ],
      },
    };
  }
  decision(rule, finding, reason, decision = 'quiet', level = 0) {
    const key = hash([finding?.hash || null, reason, decision, level]);
    const prior = this.state.decisions.findLast((d) => d.ruleId === rule.id);
    if (prior?.key === key) return;
    this.change((next) =>
      next.decisions.push({
        id: crypto.randomUUID(),
        ruleId: rule.id,
        findingHash: finding?.hash || null,
        at: this.now(),
        reason,
        decision,
        level,
        key,
      }),
    );
  }
  observe(snapshot) {
    if (this.closed || this.options.maintenance?.()) return;
    for (const rule of this.state.rules) {
      const gate = this.gate(rule, snapshot);
      if (!gate.allowed) {
        this.decision(rule, null, gate.reason);
        continue;
      }
      const finding = this.finding(rule, gate, snapshot);
      if (!this.state.findings.some((f) => f.id === finding.id))
        this.change((next) => next.findings.push(finding));
      this.consider(rule, finding);
    }
  }
  consider(rule, finding) {
    const at = this.now(),
      pref = this.options.preferences?.().notifications?.value;
    if (pref === 'off' || (pref === 'important_only' && finding.kind === 'routine')) {
      this.decision(rule, finding, 'notification_preference_hold');
      return;
    }
    if (!(
      rule.config.conditions.some((k) => finding.signals[k]) ||
      (finding.kind === 'routine' && rule.config.routineUpdates === 'changes')
    )) {
      this.decision(rule, finding, 'condition_not_enabled');
      return;
    }
    if (quiet(at, rule.config.quietHours)) {
      this.decision(rule, finding, 'quiet_hours');
      return;
    }
    const attempts = this.state.deliveries.filter((d) => {
        const priorRule = this.rule(d.ruleId);
        return (
          priorRule.responsibilityId === rule.responsibilityId &&
          priorRule.origin.actorId === rule.origin.actorId &&
          hash(priorRule.binding) === hash(rule.binding)
        );
      }),
      same = attempts.filter((d) => d.findingHash === finding.hash),
      prior = same.at(-1);
    if (same.some((d) => ['prepared', 'sending', 'unknown'].includes(d.status))) {
      this.decision(rule, finding, 'delivery_unconfirmed_no_resend');
      return;
    }
    if (same.some((d) => d.status === 'acknowledged')) {
      this.decision(rule, finding, 'already_acknowledged');
      return;
    }
    let level = 0;
    if (prior) {
      if (prior.status === 'not_sent') {
        this.decision(rule, finding, 'attempt_closed_no_automatic_retry');
        return;
      }
      if (
        !rule.config.escalateAfterSeconds ||
        !finding.manualUrgency ||
        !finding.signals.needs_user ||
        finding.waitingOn !== 'you' ||
        prior.level >= rule.config.maxReminders
      ) {
        this.decision(rule, finding, 'unchanged_finding_already_delivered');
        return;
      }
      if (at - prior.receipt.at < rule.config.escalateAfterSeconds * 1000) {
        this.decision(rule, finding, 'escalation_not_due');
        return;
      }
      level = prior.level + 1;
    }
    const last = attempts.at(-1);
    if (attempts.length >= rule.config.maxAttempts) {
      this.decision(rule, finding, 'notification_attempt_limit');
      return;
    }
    if (last && at - last.preparedAt < rule.config.minIntervalSeconds * 1000) {
      this.decision(rule, finding, 'minimum_interval');
      return;
    }
    const dedupKey = hash([
      rule.responsibilityId,
      rule.binding,
      rule.origin.actorId,
      finding.hash,
      level,
    ]);
    if (this.state.deliveries.some((d) => d.dedupKey === dedupKey)) {
      this.decision(rule, finding, 'same_delivery_identity');
      return;
    }
    this.decision(
      rule,
      finding,
      level ? 'explicit_urgent_escalation' : 'meaningful_enabled_change',
      'notify',
      level,
    );
    const payload = {
        text: (level ? 'Reminder ' + level + ': ' : '') + finding.text,
        source: structuredClone(finding.source),
        findingHash: finding.hash,
        independentlyVerified: false,
      },
      delivery = {
        id: crypto.randomUUID(),
        ruleId: rule.id,
        findingId: finding.id,
        findingHash: finding.hash,
        dedupKey,
        level,
        payload,
        payloadHash: hash(payload),
        destination: structuredClone(rule.config.destination),
        preparedAt: at,
        status: 'prepared',
        reason: 'prepared_before_delivery',
        receipt: null,
        synthetic: false,
      };
    this.change((next) => next.deliveries.push(delivery));
  }
  async recover() {
    const unknown = this.state.deliveries.filter((d) => d.status === 'unknown'),
      start = (this.recoveryCursor || 0) % Math.max(1, unknown.length),
      selected = unknown.slice(start).concat(unknown.slice(0, start)).slice(0, 8);
    this.recoveryCursor = (start + selected.length) % Math.max(1, unknown.length);
    for (const d of selected) {
      if (this.closed || this.options.maintenance?.()) return;
      const r = this.rule(d.ruleId);
      if (r.origin.actorId !== this.options.policy.actorId) continue;
      let receipt;
      try {
        receipt = await this.options.destination.probe(d);
      } catch {
        continue;
      }
      if (this.closed || this.options.maintenance?.()) return;
      if (receiptValid(receipt, d))
        this.change((next) => {
          const x = next.deliveries.find((x) => x.id === d.id);
          x.status = 'accepted';
          x.reason = 'destination_receipt_recovered';
          x.receipt = receipt;
        });
    }
  }
  async pump() {
    if (this.closed || this.pumping || this.options.maintenance?.()) return;
    this.pumping = true;
    try {
      await this.recover();
      if (this.closed || this.options.maintenance?.()) return;
      this.observe(this.options.snapshot());
      for (const saved of this.state.deliveries
        .filter((d) => d.status === 'prepared')
        .slice(0, 8)) {
        const r = this.rule(saved.ruleId),
          gate = this.gate(r, this.options.snapshot()),
          latest = this.state.findings.findLast((f) => f.ruleId === r.id);
        const preference = this.options.preferences?.().notifications?.value;
        if (
          latest?.hash !== saved.findingHash ||
          (!gate.allowed &&
            [
              'actor_changed',
              'rule_expired',
              'source_binding_changed',
              'responsibility_binding_changed',
            ].includes(gate.reason))
        ) {
          this.change((next) => {
            const d = next.deliveries.find((d) => d.id === saved.id);
            d.status = 'not_sent';
            d.reason = 'scope_or_condition_changed_before_delivery';
          });
          continue;
        }
        if (
          !gate.allowed ||
          quiet(this.now(), r.config.quietHours) ||
          preference === 'off' ||
          (preference === 'important_only' && latest?.kind === 'routine')
        )
          continue;
        this.change((next) => {
          const d = next.deliveries.find((d) => d.id === saved.id);
          d.status = 'sending';
          d.reason = 'awaiting_destination_receipt';
        });
        this.pending.add(saved.id);
        let receipt;
        try {
          receipt = await this.options.destination.deliver(saved);
        } catch {
        } finally {
          this.pending.delete(saved.id);
        }
        if (this.closed) return;
        this.change((next) => {
          const d = next.deliveries.find((d) => d.id === saved.id);
          if (receiptValid(receipt, saved)) {
            d.status = 'accepted';
            d.reason = 'destination_receipt';
            d.receipt = receipt;
          } else {
            d.status = 'unknown';
            d.reason = 'delivery_unconfirmed_no_resend';
          }
        });
      }
    } finally {
      this.pumping = false;
    }
  }
  control(input, id, kind) {
    const origin = this.accept(input),
      intent = command(origin.text),
      key = hash([origin, id, kind]),
      prior = this.state.receipts[origin.messageId];
    if (intent?.kind !== kind || intent.id !== id)
      throw new Error('Retain the exact current notification control');
    if (prior) {
      if (prior.hash !== key) throw new Error('Control identity belongs to other text');
      return;
    }
    const delivery = kind === 'acknowledge' ? this.state.deliveries.find((d) => d.id === id) : null,
      rule = kind === 'acknowledge' ? this.rule(delivery?.ruleId) : this.rule(id);
    if (kind === 'acknowledge' && !['accepted', 'acknowledged'].includes(delivery.status))
      throw new Error('There is no confirmed notification receipt to acknowledge');
    if (
      kind === 'resume' &&
      !this.gate({ ...rule, phase: 'active' }, this.options.snapshot()).allowed
    )
      throw new Error('The original notification scope cannot resume');
    if (!['pause', 'resume', 'acknowledge'].includes(kind))
      throw new Error('Unknown notification control');
    this.change((next) => {
      if (delivery) next.deliveries.find((d) => d.id === id).status = 'acknowledged';
      else next.rules.find((r) => r.id === id).phase = kind === 'pause' ? 'paused' : 'active';
      next.controls.push({ ruleId: rule.id, subjectId: id, kind, origin, at: this.now() });
      next.receipts[origin.messageId] = { ruleId: rule.id, hash: key };
    });
  }
  snapshot() {
    return structuredClone(this.state);
  }
  context() {
    const snapshot = this.options.snapshot(),
      rules = this.state.rules.filter((r) => r.origin.actorId === this.options.policy.actorId),
      result = {
        rules: [],
        coverage: {
          exhaustive: false,
          droppedFindings: this.state.droppedFindings,
          droppedDecisions: this.state.droppedDecisions,
        },
        authority:
          'Notification receipt and acknowledgement do not verify a goal. No new source access, source dispatch, phone or email capability is granted.',
      };
    for (const r of rules.slice(-4)) {
      const gate = this.gate(r, snapshot),
        last = this.state.deliveries.findLast((d) => d.ruleId === r.id),
        decision = this.state.decisions.findLast((d) => d.ruleId === r.id);
      result.rules.push({
        responsibilityId: r.responsibilityId,
        phase: r.phase,
        configuration: r.config,
        currentHold: gate.allowed ? null : gate.reason,
        lastDecision: decision
          ? { at: decision.at, reason: decision.reason, decision: decision.decision }
          : null,
        lastDelivery: last
          ? {
              preparedAt: last.preparedAt,
              status: last.status,
              reason: last.reason,
              receipt: last.receipt
                ? {
                    kind: last.receipt.kind,
                    at: last.receipt.at,
                    synthetic: last.receipt.synthetic,
                  }
                : null,
            }
          : null,
      });
    }
    while (JSON.stringify(result).length > 7900 && result.rules.length) result.rules.shift();
    result.coverage.omittedRules = rules.length - result.rules.length;
    return result;
  }
  close() {
    this.closed = true;
  }
}
module.exports = { Triage, configuration, validate, receiptValid, hash };
