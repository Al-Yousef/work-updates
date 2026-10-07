'use strict';
const crypto = require('node:crypto'),
  path = require('node:path'),
  { EventEmitter } = require('node:events');
const timing = require('./schedule-time.cjs');
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const text = (value, max = 4000) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const terminal = new Set(['completed', 'failed', 'cancelled', 'not-sent']);
function validate(value) {
  if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 64)
    throw new Error('Invalid schedule journal');
  const ids = new Set(),
    runIds = new Set();
  for (const entry of value.entries) {
    if (
      !uuid(entry.id) ||
      ids.has(entry.id) ||
      !uuid(entry.responsibilityId) ||
      !uuid(entry.origin?.messageId) ||
      !text(entry.origin.text) ||
      !['active', 'paused', 'cancelled', 'expired', 'blocked'].includes(entry.state) ||
      !['scheduled', 'deadline', 'event'].includes(entry.mode) ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 1 ||
      !Number.isInteger(entry.maxRuns) ||
      entry.maxRuns < 1 ||
      entry.maxRuns > 64 ||
      !Number.isInteger(entry.maxChecks) ||
      entry.maxChecks < 1 ||
      entry.maxChecks > 256 ||
      !Number.isInteger(entry.checks) ||
      entry.checks < 0 ||
      !Array.isArray(entry.runs) ||
      entry.runs.length > entry.maxRuns ||
      !Array.isArray(entry.changes) ||
      entry.changes.length > 64 ||
      !entry.grant ||
      !text(entry.grant.instruction) ||
      !text(entry.grant.sourceId, 512) ||
      !text(entry.grant.ownerId, 200) ||
      !text(entry.grant.deviceId, 200) ||
      !text(entry.grant.executionDevice?.kind, 100) ||
      !text(entry.grant.executionDevice?.name, 200) ||
      !text(entry.grant.taskKey, 512) ||
      !Number.isSafeInteger(entry.grant.responsibilityRevision) ||
      entry.grant.responsibilityRevision < 1 ||
      !(entry.nextWake === null || Number.isSafeInteger(entry.nextWake)) ||
      !(entry.lastActualRun === null || Number.isSafeInteger(entry.lastActualRun))
    )
      throw new Error('Invalid schedule journal');
    timing.validate(entry.schedule);
    if (entry.mode !== 'scheduled' && entry.schedule.kind !== 'interval')
      throw new Error('Rechecks need a bounded interval');
    if (
      entry.changes.some(
        (x) =>
          !uuid(x.messageId) ||
          !text(x.text) ||
          !['pause', 'resume', 'cancel', 'reschedule', 'now'].includes(x.kind) ||
          !Number.isSafeInteger(x.at),
      )
    )
      throw new Error('Invalid human schedule changes');
    ids.add(entry.id);
    for (const run of entry.runs) {
      if (
        !uuid(run.id) ||
        runIds.has(run.id) ||
        ![
          'dispatching',
          'queued',
          'accepted',
          'unconfirmed',
          'completed',
          'failed',
          'cancelled',
          'not-sent',
        ].includes(run.status) ||
        !['scheduled', 'deadline', 'event', 'user'].includes(run.trigger) ||
        !Number.isSafeInteger(run.plannedAt) ||
        !Number.isSafeInteger(run.checkpointAt) ||
        (['queued', 'accepted', 'completed'].includes(run.status) && !uuid(run.messageId)) ||
        (['accepted', 'completed'].includes(run.status) && !text(run.turnId, 512))
      )
        throw new Error('Invalid schedule run');
      runIds.add(run.id);
    }
  }
  return value;
}
class Schedules extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.file = options.directory ? path.join(options.directory, 'schedules.json') : null;
    this.read =
      options.read ||
      (() =>
        require('./private-store.cjs').readStore(this.file, {
          missing: () => ({ version: 1, entries: [] }),
        }).value);
    this.write =
      options.write || ((value) => require('./private-store.cjs').atomicJSON(this.file, value));
    this.state = validate(this.read() || { version: 1, entries: [] });
    this.pending = new Set();
    this.pumping = false;
    this.closed = false;
    this.now = options.now || Date.now;
    this.timer = null;
    if (this.state.entries.some((e) => e.runs.some((r) => r.status === 'dispatching')))
      this.change((next) => {
        for (const entry of next.entries) {
          const run = entry.runs.at(-1);
          if (run?.status === 'dispatching') {
            run.status = 'unconfirmed';
            if (!['cancelled', 'paused'].includes(entry.state)) {
              entry.state = 'blocked';
              entry.reason = 'restart_run_unconfirmed';
            }
          }
        }
      });
  }
  snapshot() {
    return structuredClone(this.state.entries);
  }
  entry(id) {
    const entry = this.state.entries.find((e) => e.id === id);
    if (!entry) throw new Error('Schedule unavailable');
    return entry;
  }
  human(input) {
    if (input?.role !== 'human' || !uuid(input.messageId) || !text(input.text))
      throw new Error('A current human schedule instruction is required');
    return { messageId: input.messageId, text: input.text };
  }
  change(fn) {
    if (this.closed) throw new Error('Hyphen is closing');
    const next = structuredClone(this.state),
      result = fn(next);
    validate(next);
    if (Buffer.byteLength(JSON.stringify(next)) > 32 * 1024 * 1024)
      throw new Error('Schedule journal is full');
    (this.options.write || this.write)(next);
    this.state = next;
    this.emit('change');
    return result;
  }
  create(input, responsibility, schedule, limits) {
    const origin = this.human(input);
    timing.validate(schedule);
    if (
      !uuid(responsibility?.id) ||
      !text(responsibility.instruction) ||
      !responsibility.scope ||
      !Number.isSafeInteger(responsibility.revision) ||
      ['completed', 'cancelled'].includes(responsibility.state) ||
      schedule.endAt <= this.now()
    )
      throw new Error('Choose an unfinished responsibility and future end date');
    const mode = limits.mode || 'scheduled',
      requestHash = crypto
        .createHash('sha256')
        .update(
          JSON.stringify([
            origin.text,
            responsibility.id,
            responsibility.revision,
            schedule,
            limits,
          ]),
        )
        .digest('hex');
    const prior = this.state.entries.find((e) => e.origin.messageId === origin.messageId);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new Error('Schedule message identity changed');
      return prior.id;
    }
    const id = crypto.randomUUID(),
      now = this.now();
    this.change((next) =>
      next.entries.push({
        id,
        origin,
        requestHash,
        responsibilityId: responsibility.id,
        grant: {
          instruction: responsibility.instruction,
          responsibilityRevision: responsibility.revision,
          ...structuredClone(responsibility.scope),
        },
        schedule: structuredClone(schedule),
        maxRuns: limits.maxRuns,
        maxChecks: limits.maxChecks ?? 64,
        mode,
        revision: 1,
        state: 'active',
        reason: 'human_schedule',
        nextWake: mode === 'deadline' ? schedule.anchorAt : timing.nextWake(schedule, now - 1),
        lastActualRun: null,
        lastFingerprint: null,
        checks: 0,
        unchangedChecks: 0,
        runs: [],
        changes: [],
        createdAt: now,
        updatedAt: now,
      }),
    );
    return id;
  }
  control(id, kind, input, schedule, limits) {
    const human = this.human(input),
      old = this.entry(id);
    if (!['pause', 'resume', 'cancel', 'reschedule', 'now'].includes(kind))
      throw new Error('Unsupported schedule control');
    if (['cancelled', 'expired'].includes(old.state) && kind !== 'reschedule')
      throw new Error('This schedule has ended');
    if (kind === 'reschedule') {
      timing.validate(schedule);
      if (schedule.endAt <= this.now()) throw new Error('Choose a future end date');
    }
    this.change((next) => {
      const entry = next.entries.find((e) => e.id === id);
      if (entry.changes.length === 64) throw new Error('Schedule history is full');
      entry.changes.push({ ...human, kind, at: this.now() });
      entry.revision++;
      entry.updatedAt = this.now();
      if (kind === 'reschedule' && limits) {
        if (limits.maxRuns < entry.runs.length)
          throw new Error('The new run limit cannot erase earlier runs');
        entry.maxRuns = limits.maxRuns;
        entry.maxChecks = limits.maxChecks;
        entry.mode = limits.mode;
        entry.unchangedChecks = 0;
        entry.lastFingerprint = null;
      }
      if (kind === 'cancel') {
        entry.state = 'cancelled';
        entry.nextWake = null;
        entry.reason = 'human_cancelled';
        delete entry.userWake;
      } else if (kind === 'pause') {
        entry.state = 'paused';
        entry.reason = 'human_paused';
        delete entry.userWake;
      } else {
        if (kind === 'now') entry.resumeAfterUser = entry.state;
        entry.state = 'active';
        entry.reason = 'human_rescheduled';
        if (schedule) entry.schedule = structuredClone(schedule);
        entry.nextWake =
          kind === 'now'
            ? this.now()
            : entry.mode === 'deadline' && kind === 'reschedule'
              ? entry.schedule.anchorAt
              : timing.nextWake(entry.schedule, this.now() - 1);
        if (kind === 'now') entry.userWake = human;
      }
      // Changed timing cannot approve replay of an uncertain or failed source run.
      if (entry.runs.at(-1)?.status === 'unconfirmed' && entry.state !== 'cancelled') {
        entry.state = 'blocked';
        entry.reason = 'source_outcome_unconfirmed';
      }
    });
  }
  observe() {
    if (this.closed) return;
    const updates = [];
    for (const entry of this.state.entries) {
      const run = entry.runs.at(-1);
      if (!run || !['queued', 'accepted', 'unconfirmed'].includes(run.status)) continue;
      const proof = this.options.outcome(entry, run);
      if (proof) updates.push({ id: entry.id, runId: run.id, proof });
    }
    if (!updates.length) return;
    this.change((next) => {
      for (const { id, runId, proof } of updates) {
        const entry = next.entries.find((e) => e.id === id),
          run = entry.runs.find((r) => r.id === runId);
        if (
          proof.sourceId !== entry.grant.sourceId ||
          proof.ownerId !== entry.grant.ownerId ||
          !uuid(proof.messageId)
        )
          continue;
        if (run.messageId ? proof.messageId !== run.messageId : proof.runId !== run.id) continue;
        if (!['accepted', 'completed', 'failed', 'cancelled', 'unconfirmed'].includes(proof.status))
          continue;
        if (['accepted', 'completed'].includes(proof.status) && !text(proof.turnId, 512)) continue;
        if (run.turnId && proof.turnId && run.turnId !== proof.turnId) continue;
        run.messageId = proof.messageId;
        run.status = proof.status;
        if (proof.turnId) run.turnId = proof.turnId;
        if (['accepted', 'completed'].includes(proof.status)) {
          run.observedAcceptedAt ??= this.now();
          if (Number.isSafeInteger(proof.acceptedAt)) run.acceptedAt ??= proof.acceptedAt;
          entry.lastActualRun = run.acceptedAt ?? null;
        }
        if (terminal.has(proof.status)) run.finishedAt = this.now();
        if (
          ['failed', 'unconfirmed'].includes(proof.status) &&
          !['cancelled', 'paused'].includes(entry.state)
        ) {
          entry.state = 'blocked';
          entry.reason = 'source_outcome_requires_review';
        }
        if (proof.status === 'cancelled') {
          entry.state = 'cancelled';
          entry.nextWake = null;
          entry.reason = 'source_cancelled';
        }
        if (
          ['accepted', 'completed'].includes(proof.status) &&
          entry.state === 'blocked' &&
          [
            'restart_run_unconfirmed',
            'source_outcome_unconfirmed',
            'run_delivery_requires_review',
          ].includes(entry.reason)
        ) {
          entry.state = 'active';
          entry.reason = 'exact_run_receipt_recovered';
        }
      }
    });
  }
  async tick() {
    if (this.closed || this.pumping || this.options.maintenance?.()) return;
    this.pumping = true;
    try {
      this.observe();
      for (const entry of this.snapshot()) {
        if (this.closed || this.options.maintenance?.()) break;
        const now = this.now(),
          last = entry.runs.at(-1);
        if (['cancelled', 'expired'].includes(entry.state)) continue;
        if (
          now > entry.schedule.endAt ||
          (entry.runs.length >= entry.maxRuns && (!last || terminal.has(last.status)))
        ) {
          this.change((next) => {
            const current = next.entries.find((e) => e.id === entry.id);
            current.state = 'expired';
            current.reason = 'schedule_limit_reached';
            current.nextWake = null;
          });
          continue;
        }
        if (entry.state !== 'active') continue;
        if (entry.nextWake === null || now < entry.nextWake || (last && !terminal.has(last.status)))
          continue;
        const probe = this.options.probe(entry);
        if (!probe?.eligible) {
          if (probe?.reason && entry.reason !== probe.reason)
            this.change((next) => {
              const current = next.entries.find((e) => e.id === entry.id);
              current.reason = probe.reason;
              if (probe.reason === 'responsibility_scope_changed') current.state = 'blocked';
              if (probe.reason === 'responsibility_finished') {
                current.state = 'cancelled';
                current.nextWake = null;
              }
            });
          continue;
        }
        if (entry.mode === 'event' && !entry.userWake && entry.lastFingerprint === null) {
          this.change((next) => {
            const current = next.entries.find((e) => e.id === entry.id);
            current.lastFingerprint = probe.fingerprint;
            current.nextWake = timing.nextWake(current.schedule, now);
          });
          continue;
        }
        if (
          entry.mode !== 'scheduled' &&
          !entry.userWake &&
          entry.lastFingerprint === probe.fingerprint
        ) {
          this.change((next) => {
            const current = next.entries.find((e) => e.id === entry.id);
            current.checks++;
            current.unchangedChecks++;
            if (current.checks >= current.maxChecks) {
              current.state = 'expired';
              current.nextWake = null;
              current.reason = 'recheck_limit_reached';
            } else
              current.nextWake = Math.min(
                current.schedule.endAt,
                now +
                  Math.min(
                    Math.max(15 * 60000, current.schedule.intervalMs),
                    current.schedule.intervalMs * 2 ** Math.min(current.unchangedChecks, 10),
                  ),
              );
          });
          continue;
        }
        const run = {
          id: crypto.randomUUID(),
          status: 'dispatching',
          trigger: entry.userWake ? 'user' : entry.mode,
          plannedAt: entry.nextWake,
          checkpointAt: now,
          expiresAt: entry.schedule.endAt,
          ...(entry.userWake ? { userWake: entry.userWake } : {}),
        };
        this.change((next) => {
          const current = next.entries.find((e) => e.id === entry.id);
          current.runs.push(run);
          delete current.userWake;
          current.lastFingerprint = probe.fingerprint;
          current.unchangedChecks = 0;
          current.nextWake = timing.nextWake(current.schedule, now);
        });
        this.pending.add(run.id);
        try {
          let receipt;
          try {
            receipt = await this.options.run({ ...entry, run: structuredClone(run) });
          } catch (error) {
            receipt = { status: error?.delivery === 'not-sent' ? 'not-sent' : 'unconfirmed' };
          }
          this.change((next) => {
            const current = next.entries.find((e) => e.id === entry.id),
              saved = current.runs.find((r) => r.id === run.id);
            const matched =
              receipt?.sourceId === entry.grant.sourceId &&
              receipt.ownerId === entry.grant.ownerId &&
              uuid(receipt.messageId) &&
              ['queued', 'accepted'].includes(receipt.status) &&
              (receipt.status !== 'accepted' || text(receipt.turnId, 512));
            saved.status = matched
              ? receipt.status
              : receipt?.status === 'not-sent'
                ? 'not-sent'
                : 'unconfirmed';
            if (matched) {
              saved.messageId = receipt.messageId;
              if (receipt.turnId) saved.turnId = receipt.turnId;
            }
            if (saved.status === 'accepted') {
              saved.acceptedAt = Number.isSafeInteger(receipt.acceptedAt)
                ? receipt.acceptedAt
                : this.now();
              current.lastActualRun = saved.acceptedAt;
            }
            if (!matched && !['cancelled', 'paused'].includes(current.state)) {
              current.state = 'blocked';
              current.reason = 'run_delivery_requires_review';
            }
            if (
              run.userWake &&
              matched &&
              current.state === 'active' &&
              current.resumeAfterUser === 'paused'
            ) {
              current.state = 'paused';
              current.reason = 'human_paused';
            }
            delete current.resumeAfterUser;
          });
        } finally {
          this.pending.delete(run.id);
        }
      }
    } finally {
      this.pumping = false;
    }
  }
  start() {
    if (this.closed || this.timer) return;
    const wake = async () => {
      this.timer = null;
      if (this.closed) return;
      try {
        await this.tick();
      } catch {
        this.options.log?.write('schedule.recovery_failed', {
          code: 'SCHEDULE_RECOVERY_FAILED',
          noResend: true,
        });
      }
      if (!this.closed) {
        this.timer = setTimeout(wake, Math.min(60000, this.options.pollMs || 60000));
        this.timer.unref?.();
      }
    };
    this.timer = setTimeout(wake, 0);
    this.timer.unref?.();
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
module.exports = { Schedules, validate };
