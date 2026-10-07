'use strict';
const path = require('node:path'),
  crypto = require('node:crypto'),
  { EventEmitter } = require('node:events');
const { command } = require('./work-command.cjs'),
  coordination = require('./assistant-coordination.cjs');
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = (value) => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const text = (value, max = 512) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const kinds = new Set([
  'pause-main',
  'resume-main',
  'stop-child',
  'disable-schedule',
  'resume-schedule',
  'revoke-executor',
  'stop-all',
  'resume-all',
]);
const statuses = new Set([
  'prepared',
  'held',
  'cancelled_unsent',
  'interrupt_requested',
  'unknown',
  'handoff',
  'terminal_completed',
  'terminal_failed',
  'terminal_interrupted',
  'running_verified',
  'checkpoint_verified',
  'released',
  'partial',
]);
function validate(value) {
  if (
    value?.version !== 1 ||
    !Array.isArray(value.holds) ||
    value.holds.length > 256 ||
    !Array.isArray(value.actions) ||
    value.actions.length > 256
  )
    throw new Error('Invalid work control journal');
  const ids = new Set();
  for (const action of value.actions) {
    const parsed = command(action.origin?.text);
    if (
      !uuid(action.id) ||
      ids.has(action.id) ||
      action.id !== action.origin?.messageId ||
      action.origin?.role !== 'human' ||
      action.origin.authority !== 'accepted_human' ||
      !text(action.origin.actorId, 200) ||
      !text(action.origin.text, 4000) ||
      !kinds.has(action.kind) ||
      parsed?.kind !== action.kind ||
      parsed.target !== action.target ||
      !text(action.target, 200) ||
      !statuses.has(action.status) ||
      !Number.isSafeInteger(action.at) ||
      action.at <= 0 ||
      !Array.isArray(action.resources) ||
      action.resources.length > 512
    )
      throw new Error('Invalid work control provenance');
    ids.add(action.id);
    for (const r of action.resources) {
      if (
        !['responsibility', 'message', 'schedule', 'research', 'delegation'].includes(r.kind) ||
        !text(r.id, 512) ||
        !statuses.has(r.status) ||
        !text(r.sourceId, 512) ||
        !text(r.ownerId, 200)
      )
        throw new Error('Invalid work checkpoint');
      if (
        ['responsibility', 'message'].includes(r.kind) &&
        (!uuid(r.messageId) ||
          !text(r.taskKey, 512) ||
          !text(r.deviceId, 200) ||
          !text(r.stepStatus, 100) ||
          (r.turnId !== null && !text(r.turnId, 512)) ||
          !Number.isSafeInteger(r.revision) ||
          r.revision < 1 ||
          !/^[a-f0-9]{64}$/.test(r.payloadHash))
      )
        throw new Error('Invalid committed action checkpoint');
    }
  }
  const keys = new Set();
  for (const hold of value.holds) {
    if (
      !['main', 'child', 'schedule', 'executor', 'all'].includes(hold.kind) ||
      !text(hold.target, 200) ||
      typeof hold.active !== 'boolean' ||
      !ids.has(hold.actionId) ||
      keys.has(hold.kind + ':' + hold.target)
    )
      throw new Error('Invalid work hold');
    const action = value.actions.find((a) => a.id === hold.actionId),
      expected = {
        main: 'pause-main',
        child: 'stop-child',
        schedule: 'disable-schedule',
        executor: 'revoke-executor',
        all: 'stop-all',
      }[hold.kind];
    if (action.kind !== expected || action.target !== hold.target)
      throw new Error('Work hold lost its original scope');
    keys.add(hold.kind + ':' + hold.target);
  }
  return value;
}
class WorkControls extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.file = path.join(options.directory, 'work-controls.json');
    this.closed = false;
    this.storageFailed = false;
    this.pending = new Set();
    this.state = require('./private-store.cjs').readStore(this.file, {
      missing: () => ({ version: 1, holds: [], actions: [] }),
    }).value;
    // A prepared stop remains a fence after restart. Reconciliation reads
    // receipts; it never reissues an interrupt or a delivery mutation.
  }
  change(fn) {
    if (this.closed) throw new Error('Hyphen is closing');
    const next = structuredClone(this.state),
      result = fn(next);
    validate(next);
    if (Buffer.byteLength(JSON.stringify(next)) > 32 * 1024 * 1024)
      throw new Error('Work control journal is full');
    try {
      const store = require('./private-store.cjs'),
        current = store.readStore(this.file, {
          missing: () => ({ version: 1, holds: [], actions: [] }),
        }).value;
      if (digest(current) !== digest(this.state))
        throw new Error('The work journal changed independently. Its original file is preserved.');
      (this.options.write || store.atomicJSON)(this.file, next);
      const actual = store.readStore(this.file).value;
      if (!actual || digest(actual) !== digest(next))
        throw new Error('The work hold was not verified on disk. No new dispatch is admitted.');
      this.storageFailed = false;
    } catch (error) {
      this.storageFailed = true;
      throw error;
    }
    this.state = next;
    this.emit('change');
    return result;
  }
  snapshot() {
    return structuredClone(this.state);
  }
  action(id) {
    const a = this.state.actions.find((x) => x.id === id);
    if (!a) throw new Error('Work checkpoint unavailable');
    return a;
  }
  human(input, kind, target) {
    const human = this.options.policy.human(input),
      parsed = command(human.text);
    if (parsed?.kind !== kind || parsed.target !== target)
      throw new Error('The control must be the literal current human command');
    return { ...human, role: 'human', authority: 'accepted_human' };
  }
  active(kind, target) {
    return this.state.holds.find((h) => h.kind === kind && h.target === target && h.active);
  }
  ancestors(entry) {
    const ids = new Set([entry.id]);
    let current = entry;
    for (let i = 0; i < 128; i++) {
      const child = this.options.delegations?.state.entries.find((c) => c.childId === current.id);
      if (!child) return ids;
      if (ids.has(child.parentId)) throw new Error('Invalid delegation ancestry');
      ids.add(child.parentId);
      current = this.options.responsibilities.state.entries.find((r) => r.id === child.parentId);
      if (!current) return ids;
    }
    throw new Error('Delegation ancestry exceeded its bound');
  }
  responsibilityAdmission(entry) {
    if (this.closed || this.storageFailed) return 'wait';
    if (this.active('all', 'all')) return 'wait';
    if (this.active('executor', entry.scope.ownerId)) return 'deny';
    if (entry.delegationId && this.active('child', entry.delegationId)) return 'deny';
    const ids = this.ancestors(entry);
    return this.state.holds.some((h) => h.active && h.kind === 'main' && ids.has(h.target))
      ? 'wait'
      : 'allow';
  }
  scheduleAdmission(entry) {
    if (this.closed || this.storageFailed) return 'wait';
    if (this.active('schedule', entry.id)) return 'wait';
    const r = this.options.responsibilities.state.entries.find(
      (r) => r.id === entry.responsibilityId,
    );
    return r ? this.responsibilityAdmission(r) : 'deny';
  }
  sourceOwner(sourceId) {
    const choices = [
      ...(this.options.snapshot().cards || []),
      ...(this.options.snapshot().done || []),
    ].filter((c) => c.sources?.some((s) => s.id === sourceId));
    return choices.length === 1 ? choices[0].owner?.id : null;
  }
  messageAdmission(message) {
    if (this.closed || this.storageFailed || this.active('all', 'all')) return 'wait';
    const r = this.options.responsibilities.state.entries.find((r) =>
      [r.currentStep, ...(r.pastSteps || [])].some(
        (s) => s.messageId === (message.messageId || message.id),
      ),
    );
    if (r) return this.responsibilityAdmission(r);
    const owner = this.sourceOwner(message.sourceId);
    if (owner && this.active('executor', owner)) return 'deny';
    return !owner && this.state.holds.some((h) => h.active && h.kind === 'executor')
      ? 'wait'
      : 'allow';
  }
  readAdmission(scope) {
    if (this.closed || this.storageFailed || this.active('all', 'all')) return 'wait';
    if (this.active('executor', scope.ownerId)) return 'deny';
    const related = this.options.responsibilities.state.entries.filter(
      (r) => r.scope.sourceId === scope.sourceId && r.scope.ownerId === scope.ownerId,
    );
    return related.some((r) => this.responsibilityAdmission(r) !== 'allow') ? 'wait' : 'allow';
  }
  resource(entry) {
    const s = entry.currentStep;
    return {
      kind: 'responsibility',
      id: entry.id,
      sourceId: entry.scope.sourceId,
      ownerId: entry.scope.ownerId,
      deviceId: entry.scope.deviceId,
      taskKey: entry.scope.taskKey,
      revision: entry.revision,
      messageId: s.messageId,
      stepStatus: s.status,
      turnId: s.turnId || null,
      payloadHash: digest(s.text),
      status: 'prepared',
    };
  }
  collect(kind, target) {
    const R = this.options.responsibilities,
      S = this.options.schedules,
      C = this.options.delegations,
      resources = [];
    let selected = [];
    if (kind === 'pause-main') {
      const root = R.entry(target);
      selected = R.state.entries.filter((r) => this.ancestors(r).has(root.id));
    } else if (kind === 'stop-child') {
      const child = C?.entry(target);
      if (!child) throw new Error('Child unavailable');
      const r = C.child(child);
      if (r) selected = [r];
      else
        resources.push({
          kind: 'delegation',
          id: child.id,
          sourceId: child.scope.sourceId,
          ownerId: child.scope.ownerId,
          status: 'prepared',
        });
    } else if (kind === 'disable-schedule') {
      const s = S.entry(target);
      if (['cancelled', 'expired'].includes(s.state)) throw new Error('This schedule has ended');
      resources.push({
        kind: 'schedule',
        id: s.id,
        sourceId: s.grant.sourceId,
        ownerId: s.grant.ownerId,
        status: 'prepared',
      });
    } else if (kind === 'revoke-executor') {
      const known =
        R.state.entries.some((r) => r.scope.ownerId === target) ||
        this.options.policy.state.grants.some(
          (g) => g.scope.accountKind === 'source_owner' && g.scope.accountId === target,
        ) ||
        [...(this.options.snapshot().cards || [])].some(
          (c) => c.owner?.local && c.owner.id === target,
        );
      if (!known) throw new Error('Choose a known exact source executor owner');
      selected = R.state.entries.filter((r) => r.scope.ownerId === target);
    } else if (kind === 'stop-all') selected = R.state.entries;
    selected
      .filter((r) => !['completed', 'cancelled'].includes(r.state))
      .forEach((r) => resources.push(this.resource(r)));
    if (['stop-all', 'revoke-executor'].includes(kind) && C)
      for (const child of C.state.entries)
        if (
          !C.child(child) &&
          !['cancelled', 'failed', 'completed_run'].includes(child.phase) &&
          (kind === 'stop-all' || child.scope.ownerId === target)
        )
          resources.push({
            kind: 'delegation',
            id: child.id,
            sourceId: child.scope.sourceId,
            ownerId: child.scope.ownerId,
            status: 'prepared',
          });
    const selectedIds = new Set(selected.map((r) => r.id));
    if (kind !== 'disable-schedule')
      for (const s of S.state.entries)
        if (
          !['cancelled', 'expired'].includes(s.state) &&
          (kind === 'stop-all' || selectedIds.has(s.responsibilityId))
        )
          resources.push({
            kind: 'schedule',
            id: s.id,
            sourceId: s.grant.sourceId,
            ownerId: s.grant.ownerId,
            status: 'prepared',
          });
    const reader = this.options.research?.();
    if (reader)
      for (const r of reader.state.entries)
        if (
          !['revoked', 'expired', 'exhausted'].includes(r.phase) &&
          (kind === 'stop-all' ||
            (kind === 'revoke-executor' && r.scope.ownerId === target) ||
            (kind === 'pause-main' &&
              selected.some(
                (e) => e.scope.sourceId === r.scope.sourceId && e.scope.ownerId === r.scope.ownerId,
              )))
        )
          resources.push({
            kind: 'research',
            id: r.id,
            sourceId: r.scope.sourceId,
            ownerId: r.scope.ownerId,
            status: 'prepared',
          });
    if (['stop-all', 'revoke-executor'].includes(kind))
      for (const m of this.options.messages.state.entries)
        if (
          ['queued', 'sending', 'uncertain'].includes(m.status) &&
          !resources.some((r) => r.messageId === m.id)
        ) {
          const owner = this.sourceOwner(m.sourceId);
          if (kind === 'revoke-executor' && owner !== target) continue;
          const match =
            owner &&
            coordination.sourceFor(this.options.snapshot(), {
              sourceId: m.sourceId,
              ownerId: owner,
            });
          resources.push({
            kind: 'message',
            id: m.id,
            messageId: m.id,
            sourceId: m.sourceId,
            ownerId: owner || 'unestablished',
            deviceId: owner || 'unestablished',
            taskKey: match?.card.taskKey || 'unestablished',
            revision: 1,
            stepStatus: m.status === 'queued' ? 'queued' : 'unconfirmed',
            turnId: m.turnId || null,
            payloadHash: digest(m.text || ''),
            status: 'prepared',
          });
        }
    if (resources.length > 512)
      throw new Error('This control exceeds 512 checkpoints. Stop smaller exact scopes first.');
    return resources;
  }
  record(actionId, index, fields) {
    this.change((next) =>
      Object.assign(next.actions.find((a) => a.id === actionId).resources[index], fields),
    );
  }
  async control(kind, target, input) {
    const origin = this.human(input, kind, target),
      prior = this.state.actions.find((a) => a.id === origin.messageId);
    if (prior) {
      if (digest(prior.origin) !== digest(origin))
        throw new Error('Control identity belongs to different text');
      return structuredClone(prior);
    }
    if (this.pending.size)
      throw new Error('A work control is being checkpointed. Wait for its receipt.');
    if (kind.startsWith('resume-')) return this.resume(kind, target, origin);
    const resources = this.collect(kind, target),
      holdKind = {
        'pause-main': 'main',
        'stop-child': 'child',
        'disable-schedule': 'schedule',
        'revoke-executor': 'executor',
        'stop-all': 'all',
      }[kind];
    if (!holdKind) throw new Error('Unsupported work control');
    this.change((next) => {
      if (next.actions.length >= 256) throw new Error('Work control history is full');
      next.actions.push({
        id: origin.messageId,
        kind,
        target,
        origin,
        at: Date.now(),
        status: 'prepared',
        resources,
      });
      const h = next.holds.find((h) => h.kind === holdKind && h.target === target);
      if (h) {
        h.active = true;
        h.actionId = origin.messageId;
      } else next.holds.push({ kind: holdKind, target, active: true, actionId: origin.messageId });
    });
    this.pending.add(origin.messageId);
    try {
      if (kind === 'revoke-executor')
        this.options.policy.revokeAccount('source_owner', target, origin);
      if (kind === 'stop-child') await this.options.delegations.cancel(target, origin);
      for (let i = 0; i < resources.length; i++) {
        const r = resources[i];
        try {
          if (r.kind === 'schedule') {
            const s = this.options.schedules.entry(r.id);
            if (['stop-all', 'revoke-executor', 'stop-child'].includes(kind))
              this.options.schedules.control(r.id, 'pause', origin);
            else if (kind === 'disable-schedule')
              this.options.schedules.control(r.id, 'pause', origin);
            this.record(origin.messageId, i, { status: 'held' });
          } else if (r.kind === 'delegation') {
            await this.options.delegations.cancel(r.id, origin);
            this.record(origin.messageId, i, {
              status:
                this.options.delegations.entry(r.id).phase === 'cancelled'
                  ? 'cancelled_unsent'
                  : 'handoff',
            });
          } else if (r.kind === 'research') {
            // The read adapter checks the durable fence before and after I/O.
            this.record(origin.messageId, i, { status: 'held' });
          } else if (kind === 'pause-main') this.record(origin.messageId, i, { status: 'held' });
          else await this.stopResource(origin.messageId, i, r, origin);
        } catch {
          this.record(origin.messageId, i, { status: 'partial' });
        }
      }
      this.change((next) => {
        const a = next.actions.find((a) => a.id === origin.messageId);
        a.status = a.resources.some((r) => ['partial', 'unknown', 'handoff'].includes(r.status))
          ? 'partial'
          : 'held';
      });
    } catch {
      this.change((next) => {
        next.actions.find((a) => a.id === origin.messageId).status = 'partial';
      });
    } finally {
      this.pending.delete(origin.messageId);
    }
    return structuredClone(this.action(origin.messageId));
  }
  async stopResource(actionId, index, r, origin) {
    const R = this.options.responsibilities,
      m = this.options.messages.state.entries.find((m) => m.id === r.messageId);
    if (r.kind === 'responsibility' && R.entry(r.id).delegationId) {
      const child = this.options.delegations.entry(R.entry(r.id).delegationId);
      if (!child.cancelRequested) await this.options.delegations.cancel(child.id, origin);
    }
    if (r.kind === 'responsibility' && R.entry(r.id).currentStep.status === 'ready') {
      await R.cancel(r.id, origin);
      this.record(actionId, index, { status: 'cancelled_unsent' });
      return;
    }
    if (m?.status === 'queued') {
      const receipt = await this.options.messages.cancel(r.messageId, r.sourceId);
      if (
        receipt.delivery !== 'cancelled' ||
        receipt.messageId !== r.messageId ||
        receipt.sourceId !== r.sourceId
      )
        throw new Error('Queue cancellation is unconfirmed');
      R.observe(this.options.snapshot());
      this.record(actionId, index, { status: 'cancelled_unsent' });
      return;
    }
    const observed = this.checkpoint(r);
    if (observed.status.startsWith('terminal_') || observed.status === 'cancelled_unsent') {
      this.record(actionId, index, observed);
      return;
    }
    if (observed.status !== 'running_verified' || !this.options.interrupt) {
      this.record(actionId, index, {
        status: r.stepStatus === 'unconfirmed' ? 'unknown' : 'handoff',
      });
      return;
    }
    const turnId = observed.turnId;
    // Save the exact turn before any interrupt RPC. A timeout remains unknown
    // and restart cannot issue that mutation again.
    this.record(actionId, index, { status: 'unknown', turnId });
    try {
      const receipt = await this.options.interrupt({ ...r, turnId });
      if (
        receipt?.sourceId !== r.sourceId ||
        receipt.turnId !== turnId ||
        receipt.delivery !== 'interrupt_requested'
      )
        throw new Error('Interrupt acknowledgement is unconfirmed');
      this.record(actionId, index, { status: 'interrupt_requested', turnId });
    } catch (error) {
      this.record(actionId, index, {
        status: error.delivery === 'not-sent' ? 'handoff' : 'unknown',
        turnId,
      });
    }
  }
  checkpoint(r) {
    const m =
      this.options.messages.state.entries.find((m) => m.id === r.messageId) ||
      this.options.messages.state.receipts[r.messageId];
    if (m && m.sourceId !== r.sourceId) return { status: 'unknown' };
    if (r.kind === 'responsibility') {
      const entry = this.options.responsibilities.state.entries.find((e) => e.id === r.id),
        step =
          entry &&
          [entry.currentStep, ...(entry.pastSteps || [])].find((s) => s.messageId === r.messageId);
      if (
        !entry ||
        !step ||
        entry.scope.ownerId !== r.ownerId ||
        entry.scope.deviceId !== r.deviceId ||
        entry.scope.taskKey !== r.taskKey ||
        entry.revision !== r.revision ||
        digest(step.text) !== r.payloadHash
      )
        return { status: 'unknown' };
      if (m?.status === 'cancelled') return { status: 'cancelled_unsent' };
      if (step.status === 'cancelled') return { status: 'cancelled_unsent' };
      if (step.status === 'ready' && r.stepStatus === 'ready')
        return this.scopeCurrent(r) ? { status: 'checkpoint_verified' } : { status: 'unknown' };
      if (
        step.status === 'queued' &&
        m?.status === 'queued' &&
        digest(m.text || '') === r.payloadHash
      )
        return this.scopeCurrent(r) ? { status: 'checkpoint_verified' } : { status: 'unknown' };
    } else {
      if (m?.status === 'cancelled') return { status: 'cancelled_unsent' };
      if (m?.status === 'queued' && digest(m.text || '') === r.payloadHash)
        return this.scopeCurrent(r) ? { status: 'checkpoint_verified' } : { status: 'unknown' };
    }
    const snapshot = this.options.snapshot(),
      match = coordination.sourceFor(snapshot, r);
    if (
      !coordination.fresh(snapshot) ||
      !match ||
      match.card.owner?.local !== true ||
      match.card.owner.online === false ||
      match.card.taskKey !== r.taskKey ||
      (match.card.owner.id || 'local') !== r.deviceId
    )
      return { status: 'unknown' };
    const delivery = match.source.deliveryOutcomes?.find(
        (d) => d.messageId === r.messageId && d.sourceId === r.sourceId && d.status === 'sent',
      ),
      turnId = r.turnId || delivery?.turnId;
    if (!turnId || match.source.turnId !== turnId) return { status: 'unknown' };
    if (['completed', 'failed', 'interrupted'].includes(match.source.turnOutcome))
      return { status: 'terminal_' + match.source.turnOutcome, turnId };
    return match.source.lifecycle === 'working'
      ? { status: 'running_verified', turnId }
      : { status: 'unknown', turnId };
  }
  reconcile() {
    const updates = [];
    for (const a of this.state.actions)
      for (const [i, r] of a.resources.entries())
        if (
          ['responsibility', 'message'].includes(r.kind) &&
          !['cancelled_unsent', 'released'].includes(r.status)
        ) {
          const proof = this.checkpoint(r);
          if (proof.status.startsWith('terminal_') || proof.status === 'cancelled_unsent')
            if (r.status !== proof.status || (r.turnId !== proof.turnId && proof.turnId))
              updates.push({ actionId: a.id, index: i, proof });
        }
    if (updates.length)
      this.change((next) => {
        for (const u of updates)
          Object.assign(next.actions.find((a) => a.id === u.actionId).resources[u.index], u.proof);
      });
  }
  scopeCurrent(r) {
    const snapshot = this.options.snapshot(),
      match = coordination.sourceFor(snapshot, r);
    return (
      coordination.fresh(snapshot) &&
      !!match &&
      match.card.owner?.local === true &&
      match.card.owner.online !== false &&
      match.card.taskKey === r.taskKey &&
      match.card.owner.id === r.deviceId
    );
  }
  resume(kind, target, origin) {
    const holdKind = { 'resume-main': 'main', 'resume-schedule': 'schedule', 'resume-all': 'all' }[
        kind
      ],
      hold = this.active(holdKind, target);
    if (!hold) throw new Error('No matching active pause is available');
    const stopped = this.action(hold.actionId),
      resources = structuredClone(stopped.resources);
    for (const r of resources) {
      if (['responsibility', 'message'].includes(r.kind)) {
        const proof = this.checkpoint(r);
        if (proof.status === 'unknown')
          throw new Error(
            'A committed action lacks a matching checkpoint. Open its source to reconcile before resuming.',
          );
        Object.assign(r, proof);
      } else if (r.kind === 'delegation') {
        if (this.options.delegations.entry(r.id).phase !== 'cancelled')
          throw new Error('An unmaterialized child lacks its cancellation checkpoint');
        r.status = 'cancelled_unsent';
      } else if (r.kind === 'research') {
        const reader = this.options.research?.(),
          entry = reader?.entry(r.id);
        if (
          !entry ||
          entry.scope.sourceId !== r.sourceId ||
          entry.scope.ownerId !== r.ownerId ||
          entry.pending ||
          reader.pending?.has(r.id)
        )
          throw new Error('The read checkpoint is still pending or unavailable');
        r.status = 'checkpoint_verified';
      } else r.status = 'checkpoint_verified';
    }
    // Releasing a pause does not revive cancelled messages, child grants or
    // executor accounts, or issue an interrupt/send as a side effect.
    this.change((next) => {
      if (next.actions.length >= 256) throw new Error('Work control history is full');
      next.actions.push({
        id: origin.messageId,
        kind,
        target,
        origin,
        at: Date.now(),
        status: 'prepared',
        resources,
      });
    });
    if (kind === 'resume-schedule') this.options.schedules.control(target, 'resume', origin);
    this.change((next) => {
      next.actions.find((a) => a.id === origin.messageId).status = 'released';
      next.holds.find((h) => h.kind === holdKind && h.target === target).active = false;
    });
    return structuredClone(this.action(origin.messageId));
  }
  close() {
    this.closed = true;
  }
}
module.exports = { WorkControls, validate };
