'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { atomicJSON, readStore } = require('./private-store.cjs');
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = (value) => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value || '');
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const active = (entry) => ['reserved', 'running', 'unknown'].includes(entry.status);
const defaults = Object.freeze({
  runs: 256,
  tokens: 300000,
  costMicros: null,
  concurrency: 4,
  readsPerHour: 64,
});
function limits(value) {
  if (
    !value ||
    Object.keys(value).sort().join() !== Object.keys(defaults).sort().join() ||
    ![value.runs, value.tokens, value.concurrency, value.readsPerHour].every(integer) ||
    value.runs > 10000 ||
    value.tokens > 100000000 ||
    value.concurrency > 32 ||
    value.readsPerHour > 10000 ||
    (value.costMicros !== null && (!integer(value.costMicros) || value.costMicros > 1000000000))
  )
    throw new Error('Use exact finite run, token, costMicros, concurrency and readsPerHour limits');
  return structuredClone(value);
}
function usage(value) {
  const keys = [
    'totalTokens',
    'inputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
    'outputTokens',
    'reasoningOutputTokens',
  ];
  if (
    !value ||
    keys.some((k) => !integer(value[k])) ||
    value.totalTokens !== value.inputTokens + value.outputTokens ||
    value.cachedInputTokens > value.inputTokens ||
    value.cacheWriteInputTokens > value.inputTokens ||
    value.reasoningOutputTokens > value.outputTokens
  )
    throw new Error('Invalid reported token usage');
  return Object.fromEntries(keys.map((k) => [k, value[k]]));
}
function validate(state) {
  if (
    state?.version !== 1 ||
    !Array.isArray(state.entries) ||
    state.entries.length > 2048 ||
    !state.policies ||
    Array.isArray(state.policies) ||
    Object.keys(state.policies).length > 129 ||
    !state.connectors ||
    Array.isArray(state.connectors) ||
    Object.keys(state.connectors).length > 128
  )
    throw new Error('Invalid budget journal');
  const ids = new Set();
  for (const [scope, p] of Object.entries(state.policies)) {
    if (scope !== 'global' && !uuid(scope)) throw new Error('Invalid budget scope');
    limits(p.limits);
    if (
      !integer(p.until) ||
      !uuid(p.origin?.messageId) ||
      p.origin.role !== 'human' ||
      p.origin.authority !== 'accepted_human' ||
      typeof p.origin.actorId !== 'string' ||
      typeof p.origin.text !== 'string' ||
      p.origin.text.length > 4000
    )
      throw new Error('Invalid budget policy provenance');
  }
  for (const e of state.entries) {
    if (
      !uuid(e.id) ||
      ids.has(e.id) ||
      !/^[a-f0-9]{64}$/.test(e.binding) ||
      !['model', 'read', 'worker'].includes(e.kind) ||
      !['reserved', 'running', 'unknown', 'settled', 'not_started'].includes(e.status) ||
      !Array.isArray(e.scopes) ||
      e.scopes.length > 129 ||
      e.scopes.some((s) => s !== 'global' && !uuid(s)) ||
      !integer(e.at) ||
      !integer(e.estimate?.tokens) ||
      (e.estimate.costMicros !== null && !integer(e.estimate.costMicros)) ||
      (e.actual !== null &&
        (!integer(e.actual.tokens) ||
          (e.actual.costMicros !== null && !integer(e.actual.costMicros)))) ||
      (e.durationMs !== null && !integer(e.durationMs)) ||
      e.provider.length > 100 ||
      e.model.length > 100 ||
      (e.turnId !== null && typeof e.turnId !== 'string')
    )
      throw new Error('Invalid budget reservation');
    ids.add(e.id);
    if (e.usage !== null) usage(e.usage);
  }
  for (const [key, c] of Object.entries(state.connectors))
    if (
      !/^[a-f0-9]{64}$/.test(key) ||
      !integer(c.nextAt) ||
      !integer(c.unchanged) ||
      c.unchanged > 10 ||
      (c.fingerprint !== null && !/^[a-f0-9]{64}$/.test(c.fingerprint))
    )
      throw new Error('Invalid connector backoff');
  return state;
}
class ResourceBudgets {
  constructor(options) {
    this.options = options;
    this.file = path.join(options.directory, 'budgets.json');
    this.closed = false;
    this.failed = false;
    this.state = readStore(this.file, {
      missing: { version: 1, policies: {}, entries: [], connectors: {} },
    }).value;
    validate(this.state);
    this.diskHash = fs.existsSync(this.file) ? digest(fs.readFileSync(this.file).toString()) : null;
    if (this.state.entries.some((e) => ['reserved', 'running'].includes(e.status)))
      this.change((next) => {
        for (const e of next.entries)
          if (['reserved', 'running'].includes(e.status)) e.status = 'unknown';
      });
  }
  now() {
    return this.options.now?.() ?? Date.now();
  }
  change(fn) {
    if (this.closed || this.failed) throw new Error('Budget storage requires recovery');
    const current = fs.existsSync(this.file) ? digest(fs.readFileSync(this.file).toString()) : null;
    if (current !== this.diskHash) {
      this.failed = true;
      throw new Error('Budget journal changed outside its owner');
    }
    const next = structuredClone(this.state),
      result = fn(next);
    validate(next);
    try {
      (this.options.write || atomicJSON)(this.file, next);
      const bytes = fs.readFileSync(this.file).toString();
      if (digest(JSON.parse(bytes)) !== digest(next))
        throw new Error('Budget write was not confirmed');
      this.diskHash = digest(bytes);
      this.state = next;
      return result;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
  configure(origin, scope, config) {
    if (
      origin?.role !== 'human' ||
      origin.authority !== 'accepted_human' ||
      origin.actorId !== this.options.actorId ||
      !uuid(origin.messageId)
    )
      throw new Error('Budget changes need a current accepted human control');
    const command = require('./budget-command.cjs').command(origin.text);
    if (
      command?.scope !== scope ||
      command.kind !== 'configure' ||
      digest(command.config) !== digest(config)
    )
      throw new Error('Budget control does not match its literal configuration');
    if (scope !== 'global') this.options.responsibilities.entry(scope);
    const checked = limits(config.limits),
      until = Date.parse(config.until);
    if (
      Object.keys(config).sort().join() !== 'limits,until' ||
      !integer(until) ||
      until <= this.now() ||
      until - this.now() > 30 * 86400000
    )
      throw new Error('Choose a budget expiry within thirty days');
    this.change((next) => {
      next.policies[scope] = { limits: checked, until, origin: structuredClone(origin) };
    });
  }
  scopeIds(input) {
    return [...new Set(['global', ...(this.options.scopes?.(input.id, input) || [])])];
  }
  policy(scope) {
    const p = this.state.policies[scope];
    return p?.limits || (scope === 'global' ? defaults : null);
  }
  accounting(scope) {
    const day = Math.floor(this.now() / 86400000),
      entries = this.state.entries.filter((e) => e.scopes.includes(scope));
    const current = entries.filter(
      (e) => Math.floor(e.at / 86400000) === day && e.status !== 'not_started',
    );
    return {
      runs: current.length,
      tokens: current.reduce((n, e) => n + Math.max(e.estimate.tokens, e.actual?.tokens || 0), 0),
      costMicros: current.reduce(
        (n, e) => n + Math.max(e.estimate.costMicros || 0, e.actual?.costMicros || 0),
        0,
      ),
      unknownCost: current.filter(
        (e) => e.estimate.costMicros === null && e.actual?.costMicros == null,
      ).length,
      unknownUsage: current.filter((e) => e.actual === null).length,
      concurrency: entries.filter(active).length,
      readsPerHour: entries.filter(
        (e) => e.kind === 'read' && e.status !== 'not_started' && this.now() - e.at < 3600000,
      ).length,
    };
  }
  reserve(input) {
    const { id, kind } = input;
    if (
      !uuid(id) ||
      !['model', 'read', 'worker'].includes(kind) ||
      !integer(input.estimate?.tokens) ||
      (input.estimate.costMicros !== null && !integer(input.estimate.costMicros))
    )
      throw new Error('Invalid resource request');
    const binding = digest(input),
      prior = this.state.entries.find((e) => e.id === id);
    if (prior)
      throw Object.assign(
        new Error(
          prior.binding === binding
            ? 'This resource request is already recorded; reconcile it before retrying.'
            : 'Resource identity belongs to another operation',
        ),
        { code: 'RESOURCE_PENDING', delivery: 'not-sent' },
      );
    const scopes = this.scopeIds(input);
    for (const scope of scopes) {
      if (this.state.policies[scope] && this.now() > this.state.policies[scope].until)
        throw Object.assign(new Error('Budget scope expired. Review its limits.'), {
          code: 'RESOURCE_BUDGET',
          delivery: 'not-sent',
        });
      const p = this.policy(scope);
      if (!p) continue;
      const a = this.accounting(scope);
      if (
        a.runs + 1 > p.runs ||
        a.tokens + input.estimate.tokens > p.tokens ||
        a.concurrency + 1 > p.concurrency ||
        (kind === 'read' && a.readsPerHour + 1 > p.readsPerHour) ||
        (p.costMicros !== null &&
          (input.estimate.costMicros === null ||
            a.unknownCost > 0 ||
            a.costMicros + input.estimate.costMicros > p.costMicros))
      )
        throw Object.assign(
          new Error(
            'Resource budget reached for ' + scope + '. Review /budget inspect before continuing.',
          ),
          { code: 'RESOURCE_BUDGET', delivery: 'not-sent' },
        );
    }
    if (this.state.entries.length >= 2048)
      throw new Error('Budget journal is full; retain and review it before continuing');
    this.change((next) =>
      next.entries.push({
        id,
        kind,
        binding,
        scopes,
        at: this.now(),
        status: 'reserved',
        estimate: input.estimate,
        actual: null,
        usage: null,
        durationMs: null,
        provider: input.provider || 'unknown',
        model: input.model || 'unknown',
        sourceId: input.sourceId || null,
        taskKey: input.taskKey || null,
        turnId: null,
      }),
    );
    return id;
  }
  update(id, fn) {
    this.change((next) => {
      const e = next.entries.find((e) => e.id === id);
      if (!e) throw new Error('Unknown budget reservation');
      fn(e);
    });
  }
  started(id, turnId = null) {
    this.update(id, (e) => {
      e.status = 'running';
      e.turnId = turnId;
    });
  }
  finish(id, { status = 'settled', reported = null, costMicros = null, turnId = null } = {}) {
    this.update(id, (e) => {
      if (!active(e)) throw new Error('Budget reservation is already final');
      if (reported && (!turnId || e.turnId !== turnId))
        throw new Error('Usage needs the exact accepted turn');
      const u = reported ? usage(reported) : null;
      e.status = status;
      e.usage = u || e.usage;
      e.actual = u
        ? { tokens: u.totalTokens, costMicros }
        : (e.kind === 'read' ||
              (e.kind === 'worker' && e.provider === 'local-private-text' && e.model === 'none')) &&
            status === 'settled'
          ? { tokens: 0, costMicros: 0 }
          : e.actual;
      e.durationMs = Math.max(0, this.now() - e.at);
    });
  }
  workerAccepted(id, turnId) {
    if (typeof turnId !== 'string' || !turnId)
      throw new Error('Worker acceptance needs a turn receipt');
    this.started(id, turnId);
  }
  reportTokens(id, turnId, tokens) {
    if (!integer(tokens)) throw new Error('Invalid reported token total');
    this.update(id, (e) => {
      if (!active(e) || !turnId || e.turnId !== turnId || (e.actual?.tokens || 0) > tokens)
        throw new Error('Usage needs the current accepted resource identity and monotonic total');
      e.actual = { tokens, costMicros: null };
    });
  }
  tokenLimitReached(id) {
    const entry = this.state.entries.find((e) => e.id === id);
    if (!entry) throw new Error('Unknown budget reservation');
    return entry.scopes.some(
      (scope) => this.policy(scope) && this.accounting(scope).tokens >= this.policy(scope).tokens,
    );
  }
  reconcile(snapshot) {
    if (
      !snapshot.health?.ok ||
      !Number.isFinite(snapshot.collectedAt) ||
      Math.abs(snapshot.collectedAt * 1000 - this.now()) > 30000
    )
      return;
    for (const e of this.state.entries.filter(
      (e) => e.kind === 'worker' && active(e) && e.turnId,
    )) {
      const card = [...(snapshot.cards || []), ...(snapshot.done || [])].find(
        (c) => c.taskKey === e.taskKey && c.owner?.local && c.owner.online !== false,
      );
      const s = card?.sources?.find(
        (s) =>
          s.id === e.sourceId &&
          s.turnId === e.turnId &&
          ['completed', 'failed', 'interrupted'].includes(s.turnOutcome),
      );
      if (s) this.finish(e.id);
    }
  }
  reader(reader) {
    return {
      ...reader,
      read: async (input) => {
        const key = digest([input.storeId, input.scope.sourceId]),
          c = this.state.connectors[key];
        if (c && this.now() < c.nextAt)
          throw Object.assign(new Error('Connector is backing off'), {
            code: 'RESEARCH_RATE_LIMITED',
            retryAfterMs: c.nextAt - this.now(),
          });
        const id = crypto.randomUUID();
        this.reserve({
          id,
          kind: 'read',
          provider: 'local-source-reader',
          estimate: { tokens: 0, costMicros: 0 },
          sourceId: input.scope.sourceId,
        });
        this.started(id);
        try {
          const result = await reader.read(input);
          this.finish(id);
          const fingerprint = digest(result.records),
            unchanged = c?.fingerprint === fingerprint ? Math.min(10, (c?.unchanged || 0) + 1) : 0;
          this.change((next) => {
            next.connectors[key] = {
              fingerprint,
              unchanged,
              nextAt: this.now() + Math.min(86400000, 60000 * 2 ** unchanged),
            };
          });
          return result;
        } catch (error) {
          const e = this.state.entries.find((e) => e.id === id);
          if (active(e)) this.finish(id, { status: 'unknown' });
          if (error.code === 'RESEARCH_RATE_LIMITED')
            this.change((next) => {
              next.connectors[key] = {
                fingerprint: c?.fingerprint || null,
                unchanged: c?.unchanged || 0,
                nextAt:
                  this.now() + Math.max(60000, Math.min(86400000, error.retryAfterMs || 300000)),
              };
            });
          throw error;
        }
      },
    };
  }
  inspect() {
    return {
      provider: 'Codex app-server',
      planEntitlements: 'unknown',
      hardExecutionTokenCap: false,
      hardProviderCostCap: false,
      scopes: [...new Set(['global', ...Object.keys(this.state.policies)])].map((scope) => {
        const policy = this.policy(scope),
          accounting = this.accounting(scope),
          expired = this.state.policies[scope]
            ? this.now() > this.state.policies[scope].until
            : false,
          remaining = Object.fromEntries(
            ['runs', 'tokens', 'concurrency', 'readsPerHour'].map((key) => [
              key,
              Math.max(0, policy[key] - accounting[key]),
            ]),
          );
        remaining.costMicros =
          policy.costMicros === null || accounting.unknownCost > 0
            ? null
            : Math.max(0, policy.costMicros - accounting.costMicros);
        return {
          scope,
          limits: policy,
          expired,
          usage: accounting,
          remaining,
          limitsReached: Object.keys(remaining).filter((key) => remaining[key] === 0),
          unpricedCostHeld: policy.costMicros !== null && accounting.unknownCost > 0,
          newModelCostRequiresPricing: policy.costMicros !== null,
        };
      }),
      unresolved: this.state.entries.filter(active).slice(-16),
      recent: this.state.entries.slice(-8),
      connectorBackoffs: Object.values(this.state.connectors).filter((c) => c.nextAt > this.now())
        .length,
      coverage:
        'Budgets govern admission. Estimates remain conservative accounting reservations; the provider may report higher actual usage. Missing usage or pricing is unknown. Accepted source work cannot be hard capped by this client.',
    };
  }
  close() {
    this.closed = true;
  }
}
module.exports = { ResourceBudgets, validate, limits, usage, defaults };
