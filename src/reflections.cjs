'use strict';
const path = require('node:path'),
  crypto = require('node:crypto'),
  { EventEmitter } = require('node:events'),
  timing = require('./schedule-time.cjs'),
  { command } = require('./reflection-command.cjs');
const hash = (value) =>
    crypto
      .createHash('sha256')
      .update(JSON.stringify(value ?? null))
      .digest('hex'),
  uuid = (value) =>
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value),
  text = (value, max) =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= max;
function configuration(raw, now, sourceEnd) {
  const keys = [
    'timeZone',
    'cadence',
    'wallTime',
    'weekdays',
    'until',
    'maxReviews',
    'retentionDays',
    'recordLimit',
    'characterBudget',
    'commitmentLimit',
  ];
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((k) => !keys.includes(k)) ||
    !text(raw.timeZone, 100) ||
    !['manual', 'daily', 'weekly'].includes(raw.cadence) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(raw.until || '')
  )
    throw new Error('Choose a finite explicit reflection configuration');
  const endAt = Date.parse(raw.until);
  if (
    !Number.isFinite(endAt) ||
    new Date(endAt).toISOString().replace('.000Z', 'Z') !== raw.until ||
    endAt <= now ||
    endAt > sourceEnd ||
    endAt > now + 30 * 86400000
  )
    throw new Error('Reflection must end within the enabled research scope');
  timing.parts(now, raw.timeZone);
  for (const [key, min, max] of [
    ['maxReviews', 1, 64],
    ['retentionDays', 1, 365],
    ['recordLimit', 1, 16],
    ['characterBudget', 2000, 16000],
    ['commitmentLimit', 1, 16],
  ])
    if (!Number.isSafeInteger(raw[key]) || raw[key] < min || raw[key] > max)
      throw new Error('Invalid reflection ' + key);
  if (
    !Array.isArray(raw.weekdays) ||
    raw.weekdays.length > 7 ||
    (raw.cadence !== 'weekly' && raw.weekdays.length) ||
    (raw.cadence === 'manual' && raw.wallTime !== null)
  )
    throw new Error('Choose weekdays only for a weekly cadence and no manual wall time');
  const schedule =
    raw.cadence === 'manual'
      ? null
      : timing.validate({
          kind: raw.cadence,
          timeZone: raw.timeZone,
          wallTime: raw.wallTime,
          ...(raw.cadence === 'weekly' ? { weekdays: raw.weekdays } : {}),
          endAt,
        });
  return { ...structuredClone(raw), endAt, schedule };
}
function human(origin, actorId) {
  return (
    origin?.role === 'human' &&
    origin.authority === 'accepted_human' &&
    text(origin.actorId, 200) &&
    origin.actorId === actorId &&
    uuid(origin.messageId) &&
    text(origin.text, 4000)
  );
}
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
  count = (value, max = Number.MAX_SAFE_INTEGER) =>
    Number.isSafeInteger(value) && value >= 0 && value <= max,
  instant = (value) => Number.isSafeInteger(value) && value > 0,
  object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  leadValid = (l) =>
    object(l) &&
    digest(l.id) &&
    text(l.text, 1000) &&
    (l.recordId === null || digest(l.recordId)) &&
    l.independentlyVerified === false;
function contextValid(x, e) {
  if (
    !object(x) ||
    !object(x.source) ||
    x.source.researchId !== e.researchId ||
    x.source.sourceId !== e.binding.sourceId ||
    x.source.ownerId !== e.binding.ownerId ||
    !text(x.source.topic, 200) ||
    (x.source.cursor !== null &&
      (!instant(x.source.cursor?.at) ||
        !text(x.source.cursor.sourceRevision, 512) ||
        !Number.isFinite(x.source.cursor.maxRecordAt))) ||
    !Array.isArray(x.checkedSources) ||
    x.checkedSources.length > 1 ||
    x.checkedSources.some(
      (s) =>
        s.sourceId !== e.binding.sourceId ||
        !uuid(s.scanId) ||
        !instant(s.originalReadAt) ||
        s.reusedRetainedContext !== true,
    ) ||
    (x.latestAttempt !== null &&
      (!uuid(x.latestAttempt?.id) ||
        !instant(x.latestAttempt.at) ||
        !text(x.latestAttempt.status, 200))) ||
    !object(x.coverage) ||
    x.coverage.exhaustive !== false ||
    x.coverage.recordLimit !== e.config.recordLimit ||
    x.coverage.characterBudget !== e.config.characterBudget ||
    !['retainedRecords', 'omittedRecords', 'omittedCommitments'].every((k) =>
      count(x.coverage[k]),
    ) ||
    !Array.isArray(x.records) ||
    x.records.length > e.config.recordLimit ||
    x.records.some(
      (r) =>
        !digest(r.id) ||
        !['user', 'assistant'].includes(r.role) ||
        !text(r.text, 600) ||
        !Number.isFinite(r.at) ||
        r.at <= 0 ||
        typeof r.truncated !== 'boolean' ||
        r.provenance !== 'retained_original_record',
    ) ||
    new Set(x.records.map((r) => r.id)).size !== x.records.length ||
    x.coverage.omittedRecords !== x.coverage.retainedRecords - x.records.length ||
    !Array.isArray(x.commitments) ||
    x.commitments.length > e.config.commitmentLimit ||
    x.commitments.some(
      (c) =>
        !uuid(c.id) ||
        !instant(c.revision) ||
        !text(c.title, 200) ||
        !text(c.status, 40) ||
        !text(c.owner, 200) ||
        !['human_reported', 'uncertain', 'human_verified'].includes(c.confidence) ||
        !text(c.meaning, 200) ||
        (c.deadline !== null &&
          (!object(c.deadline) ||
            !Number.isFinite(Date.parse(c.deadline.at)) ||
            !text(c.deadline.timeZone, 100))),
    ) ||
    !text(x.interpretation, 500)
  )
    return false;
  const original = x.coverage.originalCoverage;
  return original === null
    ? x.checkedSources.length === 0
    : object(original) &&
        x.checkedSources.length === 1 &&
        original.byteLimit === 4194304 &&
        ['includedRecords', 'skippedRecords', 'omittedGaps'].every((k) => count(original[k])) &&
        Array.isArray(original.gaps) &&
        original.gaps.length <= 3 &&
        original.gaps.every((g) => text(g, 140));
}
function suggestionValid(s, context) {
  if (
    !object(s) ||
    !['priority_review', 'preference_review'].includes(s.kind) ||
    !digest(s.id) ||
    !text(s.reason, 1000) ||
    s.requiresHumanConfirmation !== true ||
    !['proposed', 'declined_for_this_evidence'].includes(s.disposition) ||
    !Array.isArray(s.evidence) ||
    s.evidence.length !== 1
  )
    return false;
  const evidence = s.evidence[0];
  return s.kind === 'priority_review'
    ? evidence.kind === 'human_ledger_statement' &&
        context.commitments.some((c) => c.id === evidence.id && c.revision === evidence.revision) &&
        s.proposedPreference === undefined
    : evidence.kind === 'original_source_statement' &&
        context.records.some((r) => r.id === evidence.id && r.role === 'user') &&
        s.proposedPreference?.key === 'answer_style' &&
        ['concise', 'detailed'].includes(s.proposedPreference.value);
}
function validate(value) {
  if (
    value?.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > 32 ||
    !Array.isArray(value.checkpoints) ||
    value.checkpoints.length > 256 ||
    !Array.isArray(value.leads) ||
    value.leads.length > 256 ||
    !Array.isArray(value.decisions) ||
    value.decisions.length > 256 ||
    !value.receipts ||
    typeof value.receipts !== 'object' ||
    Array.isArray(value.receipts) ||
    Object.keys(value.receipts).length > 5000
  )
    throw new Error('Invalid reflection journal');
  const ids = new Set();
  for (const e of value.entries) {
    const intent = command(e.origin?.text);
    if (
      !uuid(e.id) ||
      ids.has(e.id) ||
      !uuid(e.researchId) ||
      !human(e.origin, e.origin?.actorId) ||
      intent?.kind !== 'enable' ||
      intent.researchId !== e.researchId ||
      hash(intent.config) !== hash(e.rawConfig) ||
      !['sourceId', 'ownerId', 'deviceId', 'taskKey', 'storeId'].every((k) =>
        text(e.binding?.[k], 512),
      ) ||
      !Number.isSafeInteger(e.createdAt) ||
      e.createdAt <= 0 ||
      !Number.isSafeInteger(e.sourceEnd) ||
      hash(configuration(e.rawConfig, e.createdAt, e.sourceEnd)) !== hash(e.config) ||
      !['active', 'paused', 'expired', 'blocked'].includes(e.phase) ||
      !Number.isSafeInteger(e.reviews) ||
      e.reviews < 0 ||
      e.reviews > e.config.maxReviews ||
      !text(e.reason, 200) ||
      (e.nextWake !== null && !Number.isSafeInteger(e.nextWake)) ||
      !Array.isArray(e.changes) ||
      e.changes.length > 64 ||
      e.changes.some(
        (c) =>
          !['pause', 'resume'].includes(c.kind) ||
          !human(c.origin, e.origin.actorId) ||
          command(c.origin.text)?.kind !== c.kind ||
          command(c.origin.text)?.id !== e.id ||
          !instant(c.at),
      )
    )
      throw new Error('Invalid reflection scope or provenance');
    ids.add(e.id);
  }
  const checkpoints = new Set();
  for (const c of value.checkpoints) {
    const e = value.entries.find((e) => e.id === c.reflectionId);
    if (
      !uuid(c.id) ||
      checkpoints.has(c.id) ||
      !e ||
      !Number.isSafeInteger(c.at) ||
      c.at <= 0 ||
      c.at < e.createdAt ||
      c.at > e.config.endAt ||
      c.independentlyVerified !== false ||
      !digest(c.fingerprint) ||
      !['manual', 'cadence'].includes(c.trigger) ||
      !human(c.origin, e.origin.actorId) ||
      (c.trigger === 'manual' &&
        (command(c.origin.text)?.kind !== 'checkpoint' || command(c.origin.text)?.id !== e.id)) ||
      (c.trigger === 'cadence' && hash(c.origin) !== hash(e.origin)) ||
      !Array.isArray(c.recordIds) ||
      c.recordIds.length > 64 ||
      c.recordIds.some((id) => !/^[a-f0-9]{64}$/.test(id)) ||
      !contextValid(c.context, e) ||
      JSON.stringify(c.context).length > e.config.characterBudget ||
      !Array.isArray(c.suggestions) ||
      c.suggestions.length > 16 ||
      c.suggestions.some((s) => !suggestionValid(s, c.context)) ||
      new Set(c.suggestions.map((s) => s.id)).size !== c.suggestions.length ||
      !object(c.changed) ||
      !count(c.changed.newOriginalRecords, 64) ||
      !count(c.changed.changedCommitments, 16) ||
      typeof c.changed.laterRepliesMayChangeInterpretation !== 'boolean' ||
      typeof c.changed.coverageChanged !== 'boolean' ||
      !Array.isArray(c.reportedQuestions) ||
      c.reportedQuestions.length > 4 ||
      c.reportedQuestions.some(
        (q) =>
          !c.context.records.some((r) => r.id === q.recordId) ||
          !text(q.text, 300) ||
          q.resolution !== 'unknown' ||
          typeof q.truncated !== 'boolean' ||
          q.provenance !== 'reported_original_question',
      ) ||
      !Array.isArray(c.reportedFindings) ||
      c.reportedFindings.length > 4 ||
      c.reportedFindings.some(
        (f) =>
          !c.context.records.some(
            (r) => r.id === f.recordId && r.role === f.role && r.text.slice(0, 300) === f.text,
          ) ||
          typeof f.truncated !== 'boolean' ||
          f.provenance !== 'reported_original_statement' ||
          f.independentlyVerified !== false,
      ) ||
      !Array.isArray(c.usefulLeads) ||
      c.usefulLeads.length > 4 ||
      !c.usefulLeads.length ||
      c.usefulLeads.some((l) => !leadValid(l)) ||
      hash(c.nextUsefulLead) !== hash(c.usefulLeads[0]) ||
      !Array.isArray(c.commitmentRevisions) ||
      c.commitmentRevisions.length > 16 ||
      c.commitmentRevisions.some((x) => !uuid(x.id) || !instant(x.revision)) ||
      hash(c.commitmentRevisions) !==
        hash(c.context.commitments.map((x) => ({ id: x.id, revision: x.revision })))
    )
      throw new Error('Invalid reflection checkpoint');
    checkpoints.add(c.id);
  }
  for (const lead of value.leads)
    if (
      !ids.has(lead.reflectionId) ||
      !leadValid(lead) ||
      !uuid(lead.fromCheckpoint) ||
      !instant(lead.checkpointAt) ||
      lead.checkpointAt > lead.carriedAt ||
      !instant(lead.carriedAt)
    )
      throw new Error('Invalid carried-forward lead');
  for (const d of value.decisions) {
    const e = value.entries.find((e) => e.id === d.reflectionId),
      intent = command(d.origin?.text);
    if (
      !e ||
      !uuid(d.id) ||
      !instant(d.at) ||
      !/^[a-f0-9]{64}$/.test(d.suggestionId) ||
      !text(d.reason, 500) ||
      d.permanentPreference !== false ||
      !human(d.origin, e.origin.actorId) ||
      intent?.kind !== 'decline' ||
      intent.id !== e.id ||
      intent.suggestionId !== d.suggestionId ||
      intent.reason !== d.reason
    )
      throw new Error('Invalid declined-work provenance');
  }
  if (
    new Set(value.leads.map((l) => l.id)).size !== value.leads.length ||
    new Set(value.decisions.map((d) => d.id)).size !== value.decisions.length
  )
    throw new Error('Duplicate reflection provenance');
  for (const [messageId, r] of Object.entries(value.receipts))
    if (!uuid(messageId) || !ids.has(r.id) || !/^[a-f0-9]{64}$/.test(r.hash))
      throw new Error('Invalid reflection replay receipt');
  return value;
}
class Reflections extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.file = path.join(options.directory, 'reflections.json');
    this.closed = false;
    this.pumping = false;
    this.state = require('./private-store.cjs').readStore(this.file, {
      missing: () => ({
        version: 1,
        entries: [],
        checkpoints: [],
        leads: [],
        decisions: [],
        receipts: {},
      }),
    }).value;
  }
  now() {
    return this.options.now?.() || Date.now();
  }
  snapshot() {
    return structuredClone(this.state);
  }
  context() {
    const result = {
      scopes: [],
      coverage: { exhaustive: false, omittedScopes: 0 },
      authority:
        'Retained checkpoint data and unconfirmed review suggestions; no authority to act or change preferences.',
    };
    const scopes = this.state.entries.filter((e) => this.gate(e).allowed);
    for (const e of scopes.slice(-4)) {
      const checkpoint = this.state.checkpoints.findLast((c) => c.reflectionId === e.id);
      if (!checkpoint) continue;
      result.scopes.push({
        reflectionId: e.id,
        researchId: e.researchId,
        checkpointAt: checkpoint.at,
        trigger: checkpoint.trigger,
        source: checkpoint.context.source,
        checkedSources: checkpoint.context.checkedSources,
        coverage: checkpoint.context.coverage,
        changed: checkpoint.changed,
        selection: {
          omittedOriginalStatements: Math.max(0, checkpoint.context.records.length - 4),
          omittedQuestions: Math.max(0, checkpoint.reportedQuestions.length - 2),
          omittedFindings: Math.max(0, checkpoint.reportedFindings.length - 3),
          omittedSuggestions: Math.max(0, checkpoint.suggestions.length - 4),
        },
        reportedQuestions: checkpoint.reportedQuestions.slice(-2),
        reportedFindings: checkpoint.reportedFindings.slice(-3),
        originalStatements: checkpoint.context.records.slice(-4).map((r) => ({
          ...r,
          text: r.text.slice(0, 300),
          truncated: r.truncated || r.text.length > 300,
        })),
        suggestions: checkpoint.suggestions.slice(-4).map((s) => ({
          ...s,
          reason: s.reason.slice(0, 400),
          disposition: this.state.decisions.some(
            (d) => d.reflectionId === e.id && d.suggestionId === s.id,
          )
            ? 'declined_for_this_evidence'
            : 'proposed',
        })),
        nextUsefulLead: checkpoint.nextUsefulLead,
        independentlyVerified: false,
      });
    }
    while (JSON.stringify(result).length > 7900 && result.scopes.length) result.scopes.shift();
    result.coverage.omittedScopes = scopes.length - result.scopes.length;
    result.coverage.selectedCharacters = JSON.stringify(result).length;
    return result;
  }
  change(fn) {
    if (this.closed) throw new Error('Reflection recovery or shutdown is required');
    const next = structuredClone(this.state),
      result = fn(next);
    validate(next);
    if (Buffer.byteLength(JSON.stringify(next)) > 32 * 1024 * 1024)
      throw new Error('Reflection journal is full');
    const store = require('./private-store.cjs');
    try {
      const current = store.readStore(this.file, {
        missing: () => ({
          version: 1,
          entries: [],
          checkpoints: [],
          leads: [],
          decisions: [],
          receipts: {},
        }),
      }).value;
      if (hash(current) !== hash(this.state))
        throw new Error('The reflection journal changed independently');
      (this.options.write || store.atomicJSON)(this.file, next);
      const actual = (this.options.read || store.readStore)(this.file).value;
      if (!actual || hash(actual) !== hash(next))
        throw new Error('The reflection write was not verified');
      this.state = actual;
    } catch {
      this.closed = true;
      throw new Error(
        'The reflection journal could not be verified. Its file is preserved; inspect a copy before recovery.',
      );
    }
    this.emit('change');
    return result;
  }
  accept(input) {
    if (!human(input, this.options.policy.actorId))
      throw new Error('Only the current accepted human can control reflection');
    return structuredClone(input);
  }
  entry(id) {
    const e = this.state.entries.find((e) => e.id === id);
    if (!e) throw new Error('Reflection scope unavailable');
    return e;
  }
  binding(source) {
    return {
      sourceId: source.scope.sourceId,
      ownerId: source.scope.ownerId,
      deviceId: source.scope.deviceId,
      taskKey: source.scope.taskKey,
      storeId: source.storeId,
    };
  }
  gate(e, { background = false } = {}) {
    if (
      this.closed ||
      this.options.maintenance?.() ||
      e.phase === 'paused' ||
      this.now() > e.config.endAt ||
      e.origin.actorId !== this.options.policy.actorId
    )
      return { allowed: false, reason: 'reflection_paused_expired_or_unavailable' };
    const preference = this.options.commitments?.preferenceSnapshot().research?.value;
    if (preference === 'off' || (background && preference === 'manual_only'))
      return { allowed: false, reason: 'reflection_preference_hold' };
    let source, access;
    try {
      source = this.options.research.entry(e.researchId);
      if (hash(this.binding(source)) !== hash(e.binding))
        return { allowed: false, reason: 'research_binding_changed' };
      access = this.options.research.gate(source, crypto.randomUUID(), { manual: true });
    } catch {
      return { allowed: false, reason: 'research_scope_unavailable' };
    }
    return ['act', 'ask'].includes(access.decision) || access.reason === 'grant_limit_reached'
      ? { allowed: true, source }
      : { allowed: false, reason: access.reason || 'research_scope_unavailable' };
  }
  enable(input, researchId, rawConfig) {
    const origin = this.accept(input),
      intent = command(origin.text),
      key = hash([origin, researchId, rawConfig]),
      prior = this.state.receipts[origin.messageId];
    if (
      intent?.kind !== 'enable' ||
      intent.researchId !== researchId ||
      hash(intent.config) !== hash(rawConfig)
    )
      throw new Error('Reflection must retain its literal human source and configuration');
    if (prior) {
      if (prior.hash !== key) throw new Error('Reflection message identity belongs to other text');
      return prior.id;
    }
    const source = this.options.research.entry(researchId),
      config = configuration(rawConfig, this.now(), source.config.endAt);
    const id = crypto.randomUUID(),
      at = this.now(),
      entry = {
        id,
        researchId,
        binding: this.binding(source),
        sourceEnd: source.config.endAt,
        origin,
        rawConfig: structuredClone(rawConfig),
        config,
        createdAt: at,
        phase: 'active',
        reviews: 0,
        reason: 'human_enabled',
        changes: [],
        nextWake: config.schedule ? timing.nextWake(config.schedule, at) : null,
      };
    if (!this.gate(entry).allowed)
      throw new Error('The exact research scope is unavailable for reflection');
    this.change((next) => {
      next.entries.push(entry);
      next.receipts[origin.messageId] = { id, hash: key };
    });
    return id;
  }
  contextFor(e) {
    const source = this.gate(e).source;
    if (!source) throw new Error('The source scope is unavailable');
    const ledger = this.options.commitments?.snapshot() || [],
      related = ledger.filter(
        (c) =>
          !['cancelled', 'superseded'].includes(c.status) &&
          !c.supersededBy &&
          c.evidence.some(
            (x) =>
              x.source?.sourceId === e.binding.sourceId && x.source?.ownerId === e.binding.ownerId,
          ),
      ),
      chosen = related.slice(-e.config.commitmentLimit),
      lastScan = source.scans.at(-1),
      lastSuccess = source.scans.findLast((s) => s.status === 'bounded_original_records');
    const context = {
      source: {
        researchId: source.id,
        sourceId: e.binding.sourceId,
        ownerId: e.binding.ownerId,
        topic: source.config.topic,
        cursor: source.cursor,
      },
      checkedSources: lastSuccess
        ? [
            {
              sourceId: e.binding.sourceId,
              scanId: lastSuccess.id,
              originalReadAt: lastSuccess.at,
              reusedRetainedContext: true,
            },
          ]
        : [],
      latestAttempt: lastScan
        ? { id: lastScan.id, at: lastScan.at, status: lastScan.status }
        : null,
      coverage: {
        exhaustive: false,
        retainedRecords: source.records.length,
        recordLimit: e.config.recordLimit,
        characterBudget: e.config.characterBudget,
        originalCoverage: lastSuccess?.coverage
          ? {
              includedRecords: lastSuccess.coverage.includedRecords,
              byteLimit: lastSuccess.coverage.byteLimit,
              skippedRecords: lastSuccess.coverage.skippedRecords,
              gaps: lastSuccess.coverage.gaps.slice(0, 3).map((g) => g.slice(0, 140)),
              omittedGaps: Math.max(0, lastSuccess.coverage.gaps.length - 3),
            }
          : null,
        omittedRecords: 0,
        omittedCommitments: Math.max(0, related.length - chosen.length),
      },
      records: source.records.slice(-e.config.recordLimit).map((r) => ({
        id: r.id,
        role: r.role,
        text: r.text.slice(0, 600),
        at: r.at,
        truncated: r.truncated || r.text.length > 600,
        provenance: 'retained_original_record',
      })),
      commitments: chosen.map((c) => ({
        id: c.id,
        revision: c.revision,
        title: c.title.slice(0, 200),
        status: c.status,
        deadline: c.deadline,
        confidence: c.confidence,
        owner: c.provenance.owner?.kind === 'user_statement' ? c.owner : 'not established',
        meaning: 'Human ledger statement; independent assignment and outcome remain unverified',
      })),
      interpretation:
        'Retained original statements and later replies, reported questions and human ledger claims. No new source read, model inference, verified assignment or verified completion.',
    };
    while (
      JSON.stringify(context).length > e.config.characterBudget &&
      (context.records.length || context.commitments.length)
    ) {
      if (context.records.length >= context.commitments.length) context.records.shift();
      else {
        context.commitments.shift();
        context.coverage.omittedCommitments++;
      }
    }
    context.coverage.omittedRecords = source.records.length - context.records.length;
    if (JSON.stringify(context).length > e.config.characterBudget)
      throw new Error('The required scope metadata exceeds the context budget');
    return { source, context };
  }
  findings(e, context) {
    const suggestions = [];
    for (const c of context.commitments)
      if (c.deadline && Date.parse(c.deadline.at) < this.now() && c.status !== 'completed')
        suggestions.push({
          id: hash([e.id, 'priority', c.id, c.revision, c.deadline]),
          kind: 'priority_review',
          reason:
            'Review the human-recorded deadline for ' +
            c.title +
            '. Ownership, current urgency and completion remain unverified; consider later original replies.',
          evidence: [{ kind: 'human_ledger_statement', id: c.id, revision: c.revision }],
          requiresHumanConfirmation: true,
        });
    const current = this.options.commitments?.preferenceSnapshot().answer_style?.value;
    for (const r of context.records.filter((r) => r.role === 'user')) {
      const match = r.text.match(
        /\b(?:i prefer|please use)\s+(concise|detailed)\s+(?:answers|updates|replies)\b/i,
      );
      if (match && match[1].toLowerCase() !== current)
        suggestions.push({
          id: hash([e.id, 'preference', r.id, match[1].toLowerCase()]),
          kind: 'preference_review',
          reason:
            'A retained user-role source statement mentions ' +
            match[1].toLowerCase() +
            ' replies. Its author and applicability to you are unverified; review whether you want an explicit answer_style change. Later corrections may supersede it.',
          evidence: [{ kind: 'original_source_statement', id: r.id }],
          proposedPreference: { key: 'answer_style', value: match[1].toLowerCase() },
          requiresHumanConfirmation: true,
        });
    }
    return suggestions.slice(-16).map((s) => ({
      ...s,
      disposition: this.state.decisions.some(
        (d) => d.reflectionId === e.id && d.suggestionId === s.id,
      )
        ? 'declined_for_this_evidence'
        : 'proposed',
    }));
  }
  checkpoint(id, input, { cadence = false } = {}) {
    const e = this.entry(id),
      origin = cadence ? e.origin : this.accept(input),
      intent = cadence ? null : command(origin.text);
    if (cadence && (!e.config.schedule || e.nextWake === null || this.now() < e.nextWake))
      throw new Error('No explicitly configured calendar reflection is due');
    if (!cadence && (intent?.kind !== 'checkpoint' || intent.id !== id))
      throw new Error('Use the literal current checkpoint command');
    const key = hash([origin, 'checkpoint', id]);
    if (!cadence && this.state.receipts[origin.messageId]) {
      if (this.state.receipts[origin.messageId].hash !== key)
        throw new Error('Checkpoint identity belongs to another control');
      return (
        this.state.checkpoints.find((c) => c.origin.messageId === origin.messageId)?.id || null
      );
    }
    const gate = this.gate(e, { background: cadence });
    if (!gate.allowed) throw new Error('Reflection is held: ' + gate.reason);
    if (e.reviews >= e.config.maxReviews) throw new Error('Reflection review limit reached');
    const { source, context } = this.contextFor(e),
      prior = this.state.checkpoints.findLast((c) => c.reflectionId === id),
      recordIds = source.records.map((r) => r.id),
      commitmentRevisions = context.commitments.map((c) => ({ id: c.id, revision: c.revision })),
      fingerprint = hash([
        recordIds,
        commitmentRevisions,
        source.cursor?.sourceRevision,
        source.cursor?.maxRecordAt,
        context.latestAttempt?.status,
        context.coverage,
        this.options.commitments?.preferenceSnapshot().answer_style?.value,
        this.state.decisions.filter((d) => d.reflectionId === id).map((d) => d.suggestionId),
      ]);
    const changed = {
      newOriginalRecords: recordIds.filter((x) => !prior?.recordIds.includes(x)).length,
      changedCommitments: commitmentRevisions.filter(
        (c) => !prior?.commitmentRevisions.some((p) => p.id === c.id && p.revision === c.revision),
      ).length,
      laterRepliesMayChangeInterpretation: context.records.some((r) => r.role === 'assistant'),
      coverageChanged: hash(prior?.context.coverage) !== hash(context.coverage),
    };
    const suggestions = this.findings(e, context),
      reportedFindings = context.records.slice(-4).map((r) => ({
        recordId: r.id,
        role: r.role,
        text: r.text.slice(0, 300),
        truncated: r.truncated || r.text.length > 300,
        provenance: 'reported_original_statement',
        independentlyVerified: false,
      })),
      reportedQuestions = context.records
        .filter((r) => r.text.includes('?'))
        .slice(-4)
        .map((r) => ({
          recordId: r.id,
          text: r.text.slice(0, 300),
          truncated: r.truncated || r.text.length > 300,
          resolution: 'unknown',
          provenance: 'reported_original_question',
        })),
      lastLead = context.records.at(-1),
      lastCommitment = context.commitments.findLast((c) => c.status !== 'completed'),
      usefulLeads = lastLead
        ? [
            {
              id: hash([id, 'lead', lastLead.recordId || lastLead.id]),
              text: (
                'Review the later original statement and its unresolved outcome: ' + lastLead.text
              ).slice(0, 1000),
              recordId: lastLead.recordId || lastLead.id,
              independentlyVerified: false,
            },
          ]
        : lastCommitment
          ? [
              {
                id: hash([id, 'commitment-lead', lastCommitment.id, lastCommitment.revision]),
                text: (
                  'Review the human ledger statement and its current outcome: ' +
                  lastCommitment.title +
                  '. Assignment and completion remain unverified.'
                ).slice(0, 1000),
                recordId: null,
                independentlyVerified: false,
              },
            ]
          : [
              {
                id: hash([id, 'missing-originals']),
                text: 'This retained checkpoint includes no checked original records. Inspect its source coverage or explicitly refresh the enabled source before interpreting its work.',
                recordId: null,
                independentlyVerified: false,
              },
            ];
    const checkpointId = crypto.randomUUID(),
      at = this.now();
    this.change((next) => {
      const current = next.entries.find((e) => e.id === id);
      current.reviews++;
      current.nextWake = current.config.schedule
        ? timing.nextWake(current.config.schedule, at)
        : null;
      current.reason =
        cadence && prior?.fingerprint === fingerprint
          ? 'unchanged_retained_context'
          : 'checkpoint_saved';
      if (!(cadence && prior?.fingerprint === fingerprint)) {
        next.checkpoints.push({
          id: checkpointId,
          reflectionId: id,
          at,
          trigger: cadence ? 'cadence' : 'manual',
          origin: structuredClone(origin),
          fingerprint,
          recordIds,
          commitmentRevisions,
          changed,
          context,
          reportedQuestions,
          reportedFindings,
          suggestions,
          usefulLeads,
          nextUsefulLead: usefulLeads[0],
          independentlyVerified: false,
        });
      }
      if (!cadence) next.receipts[origin.messageId] = { id, hash: key };
    });
    return cadence && prior?.fingerprint === fingerprint ? null : checkpointId;
  }
  control(id, kind, input, suggestionId, reason) {
    const origin = this.accept(input),
      intent = command(origin.text),
      e = this.entry(id),
      key = hash([origin, kind, id, suggestionId, reason]),
      prior = this.state.receipts[origin.messageId];
    if (
      intent?.kind !== kind ||
      intent.id !== id ||
      (kind === 'decline' && (intent.suggestionId !== suggestionId || intent.reason !== reason))
    )
      throw new Error('Control must retain its exact current human text');
    if (prior) {
      if (prior.hash !== key) throw new Error('Control identity belongs to other text');
      return;
    }
    if (kind === 'prune') {
      this.prune(id);
      this.change((next) => {
        next.receipts[origin.messageId] = { id, hash: key };
      });
      return;
    }
    if (kind === 'resume' && !this.gate({ ...e, phase: 'active' }).allowed)
      throw new Error('The original research scope cannot be resumed');
    if (
      kind === 'decline' &&
      !this.state.checkpoints.some(
        (c) => c.reflectionId === id && c.suggestions.some((s) => s.id === suggestionId),
      )
    )
      throw new Error('That proposal is not in this scope');
    this.change((next) => {
      const entry = next.entries.find((e) => e.id === id);
      if (kind === 'decline')
        next.decisions.push({
          id: crypto.randomUUID(),
          reflectionId: id,
          suggestionId,
          reason,
          origin,
          permanentPreference: false,
          at: this.now(),
        });
      else if (['pause', 'resume'].includes(kind)) {
        entry.phase = kind === 'pause' ? 'paused' : 'active';
        entry.reason = 'human_' + kind;
        entry.changes.push({ kind, origin, at: this.now() });
        if (kind === 'resume')
          entry.nextWake = entry.config.schedule
            ? timing.nextWake(entry.config.schedule, this.now())
            : null;
      } else throw new Error('Unknown reflection control');
      next.receipts[origin.messageId] = { id, hash: key };
    });
  }
  prune(id) {
    const e = this.entry(id),
      all = this.state.checkpoints.filter((c) => c.reflectionId === id),
      newest = all.at(-1),
      eligible = all.filter(
        (c) => c.id !== newest?.id && c.at < this.now() - e.config.retentionDays * 86400000,
      );
    if (!eligible.length) return 0;
    // Useful leads become durable and read-back verified before old temporary
    // checkpoint text is removed. A crash between writes preserves both.
    this.change((next) => {
      for (const c of eligible)
        for (const lead of c.usefulLeads)
          if (!next.leads.some((l) => l.id === lead.id))
            next.leads.push({
              ...lead,
              reflectionId: id,
              fromCheckpoint: c.id,
              checkpointAt: c.at,
              carriedAt: this.now(),
            });
    });
    const ids = new Set(eligible.map((c) => c.id));
    this.change((next) => {
      next.checkpoints = next.checkpoints.filter((c) => !ids.has(c.id));
    });
    return eligible.length;
  }
  tick() {
    if (this.closed || this.pumping || this.options.maintenance?.()) return;
    this.pumping = true;
    try {
      for (const e of this.state.entries) {
        if (e.origin.actorId !== this.options.policy.actorId || e.phase === 'paused') continue;
        this.prune(e.id);
        if (e.phase !== 'active') continue;
        if (this.now() > e.config.endAt || e.reviews >= e.config.maxReviews) {
          this.change((next) => {
            const current = next.entries.find((x) => x.id === e.id);
            current.phase = 'expired';
            current.reason = 'cadence_limit_reached';
            current.nextWake = null;
          });
          continue;
        }
        if (!e.config.schedule || e.nextWake === null || this.now() < e.nextWake) continue;
        const gate = this.gate(e, { background: true });
        if (!gate.allowed) {
          this.change((next) => {
            const current = next.entries.find((x) => x.id === e.id);
            current.reason = gate.reason;
            current.nextWake = timing.nextWake(current.config.schedule, this.now());
          });
          continue;
        }
        this.checkpoint(e.id, null, { cadence: true });
        this.prune(e.id);
      }
    } finally {
      this.pumping = false;
    }
  }
  close() {
    this.closed = true;
  }
}
module.exports = { Reflections, validate, configuration };
