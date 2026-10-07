'use strict';
const path = require('node:path'),
  crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const states = new Set([
  'running',
  'waiting_user',
  'waiting_approval',
  'waiting_external',
  'sleeping',
  'blocked',
  'completed',
  'cancelled',
]);
const steps = new Set([
  'ready',
  'dispatching',
  'cancelling',
  'queued',
  'accepted',
  'unconfirmed',
  'completed',
  'failed',
  'cancelled',
]);
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const string = (value, max = 4000) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const held = (entry) =>
  ['sleeping', 'waiting_approval'].includes(entry.state) || entry.wakeReason.kind === entry.state;
function validate(value) {
  if (
    value?.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > 128 ||
    !value.receipts ||
    typeof value.receipts !== 'object' ||
    Array.isArray(value.receipts) ||
    Object.keys(value.receipts).length > 5000
  )
    throw new Error('Invalid responsibility journal');
  for (const entry of value.entries) {
    const s = entry.scope,
      p = entry.currentStep;
    if (
      !uuid(entry.id) ||
      !uuid(entry.origin?.messageId) ||
      !string(entry.origin.text) ||
      !states.has(entry.state) ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 1 ||
      !s ||
      !string(s.sourceId, 512) ||
      !string(s.ownerId, 200) ||
      !string(s.deviceId, 200) ||
      !string(s.executionDevice?.kind, 100) ||
      !string(s.executionDevice?.name, 200) ||
      !string(s.taskKey, 512) ||
      !string(s.taskRevision, 200) ||
      !string(s.id, 512) ||
      !string(s.chatName, 180) ||
      entry.ownerId !== s.ownerId ||
      !string(entry.instruction) ||
      !string(entry.completionCriteria?.description, 1000) ||
      !['source_terminal', 'human_verified'].includes(entry.completionCriteria.kind) ||
      !p ||
      !uuid(p.id) ||
      !uuid(p.messageId) ||
      !string(p.text, 12000) ||
      !steps.has(p.status) ||
      (['accepted', 'completed'].includes(p.status) && !string(p.turnId, 512)) ||
      !entry.wakeReason ||
      !string(entry.wakeReason.kind, 100) ||
      !Array.isArray(entry.steering) ||
      entry.steering.length > 64 ||
      entry.steering.some(
        (x) =>
          !uuid(x.messageId) ||
          !string(x.text) ||
          !string(x.instruction) ||
          !x.text.includes(x.instruction) ||
          !Number.isSafeInteger(x.revision) ||
          x.revision < 2 ||
          x.revision > entry.revision,
      ) ||
      (entry.pastSteps !== undefined &&
        (!Array.isArray(entry.pastSteps) ||
          entry.pastSteps.length > 64 ||
          entry.pastSteps.some(
            (x) =>
              !uuid(x.id) || !uuid(x.messageId) || !steps.has(x.status) || !string(x.text, 12000),
          ))) ||
      ![entry.createdAt, entry.updatedAt].every((x) => Number.isFinite(x) && x > 0)
    )
      throw new Error('Invalid responsibility journal');
    if (
      entry.steering.length
        ? entry.instruction !== entry.steering.at(-1).instruction
        : !entry.origin.text.includes(entry.instruction)
    )
      throw new Error('Responsibility instruction lost its human provenance');
    if (
      [p, ...(entry.pastSteps || [])].some(
        (step) =>
          !entry.origin.text.includes(step.text) &&
          !entry.steering.some((x) => x.instruction === step.text),
      )
    )
      throw new Error('Responsibility step lost its human provenance');
  }
  const ids = new Set(value.entries.map((x) => x.id)),
    intents = value.entries
      .flatMap((x) => [x.currentStep, ...(x.pastSteps || [])])
      .map((x) => x.messageId);
  if (
    ids.size !== value.entries.length ||
    new Set(intents).size !== intents.length ||
    Object.entries(value.receipts).some(
      ([id, r]) => !uuid(id) || !ids.has(r.id) || !/^[a-f0-9]{64}$/.test(r.hash),
    ) ||
    value.entries.some((x) => value.receipts[x.origin.messageId]?.id !== x.id)
  )
    throw new Error('Invalid responsibility identities');
  return value;
}
class Responsibilities extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.file = path.join(options.directory, 'responsibilities.json');
    this.state = { version: 1, entries: [], receipts: {} };
    this.closed = false;
    this.pending = new Set();
    this.pumping = false;
    this.state = require('./private-store.cjs').readStore(this.file, {
      missing: () => this.state,
    }).value;
    if (
      this.state.entries.some((x) => ['dispatching', 'cancelling'].includes(x.currentStep.status))
    )
      this.change((next) => {
        for (const entry of next.entries)
          if (['dispatching', 'cancelling'].includes(entry.currentStep.status)) {
            const paused = held(entry);
            entry.currentStep.status = 'unconfirmed';
            if (!paused) {
              entry.state = 'waiting_user';
              entry.wakeReason = { kind: 'restart_delivery_unconfirmed' };
            }
            entry.updatedAt = Date.now();
          }
      });
  }
  snapshot() {
    return structuredClone(this.state.entries);
  }
  change(fn) {
    if (this.closed) throw new Error('Hyphen is closing');
    const next = structuredClone(this.state);
    const result = fn(next);
    validate(next);
    if (Buffer.byteLength(JSON.stringify(next)) > 32 * 1024 * 1024)
      throw new Error('Responsibility journal is full');
    const write = this.options.write || require('./private-store.cjs').atomicJSON;
    write(this.file, next);
    this.state = next;
    this.emit('change');
    return result;
  }
  human(input) {
    if (!uuid(input?.messageId) || !string(input.text) || input.role !== 'human')
      throw new Error('A current human instruction is required');
    return { messageId: input.messageId, text: input.text };
  }
  instruction(input) {
    const human = this.human(input),
      instruction = input.instruction || human.text;
    if (!string(instruction) || !human.text.includes(instruction))
      throw new Error('The step must be literal text from the current human instruction');
    return { human, instruction };
  }
  create(input, scope, criteria) {
    const { human, instruction } = this.instruction(input),
      hash = crypto
        .createHash('sha256')
        .update(JSON.stringify([human.text, instruction, scope, criteria]))
        .digest('hex');
    const prior = this.state.receipts[human.messageId];
    if (prior) {
      if (prior.hash !== hash)
        throw new Error('Human message identity belongs to another instruction');
      return prior.id;
    }
    if (!['source_terminal', 'human_verified'].includes(criteria?.kind))
      throw new Error('Explicit completion criteria are required');
    const id = crypto.randomUUID(),
      now = Date.now();
    this.change((next) => {
      next.entries.push({
        id,
        origin: human,
        instruction,
        scope: structuredClone(scope),
        ownerId: scope.ownerId,
        revision: 1,
        state: 'running',
        currentStep: {
          id: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
          text: instruction,
          status: 'ready',
        },
        pastSteps: [],
        wakeReason: { kind: 'human', messageId: human.messageId },
        completionCriteria: structuredClone(criteria),
        steering: [],
        createdAt: now,
        updatedAt: now,
      });
      next.receipts[human.messageId] = { id, hash };
    });
    return id;
  }
  entry(id) {
    const entry = this.state.entries.find((x) => x.id === id);
    if (!entry) throw new Error('That responsibility is unavailable');
    return entry;
  }
  refreshScope(entry, snapshot) {
    const scope = this.options.currentScope?.(entry.scope, snapshot) || entry.scope;
    if (
      scope.sourceId !== entry.scope.sourceId ||
      scope.ownerId !== entry.scope.ownerId ||
      scope.deviceId !== entry.scope.deviceId ||
      JSON.stringify(scope.executionDevice) !== JSON.stringify(entry.scope.executionDevice)
    )
      throw new Error('Steering cannot change the execution owner, device or source');
    this.options.validateTarget(scope, snapshot);
    return scope;
  }
  advance(entry, snapshot) {
    const scope = this.refreshScope(entry, snapshot);
    entry.pastSteps ??= [];
    if (entry.pastSteps.length === 64) throw new Error('Responsibility step history is full');
    entry.pastSteps.push({ ...entry.currentStep, scope: entry.scope });
    entry.scope = structuredClone(scope);
    entry.currentStep = {
      id: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      text: entry.instruction,
      status: 'ready',
    };
  }
  finishStep(entry, snapshot) {
    const pending = entry.steering.at(-1);
    if (
      pending &&
      pending.instruction === entry.instruction &&
      pending.instruction !== entry.currentStep.text
    ) {
      try {
        this.advance(entry, snapshot);
        entry.state = 'running';
        entry.wakeReason = { kind: 'human_steering_ready', messageId: pending.messageId };
      } catch {
        entry.state = 'blocked';
        entry.wakeReason = { kind: 'steering_source_or_capacity_unavailable' };
      }
    } else {
      entry.state =
        entry.completionCriteria.kind === 'source_terminal' ? 'completed' : 'waiting_user';
      entry.wakeReason = {
        kind:
          entry.state === 'completed'
            ? 'verified_source_terminal'
            : 'source_finished_outcome_unverified',
      };
    }
  }
  steer(id, input) {
    const { human, instruction } = this.instruction(input);
    this.entry(id);
    return this.change((next) => {
      const entry = next.entries.find((x) => x.id === id);
      if (['completed', 'cancelled'].includes(entry.state))
        throw new Error('That responsibility has finished');
      if (entry.steering.some((x) => x.messageId === human.messageId)) {
        const prior = entry.steering.find((x) => x.messageId === human.messageId);
        if (prior.text !== human.text || prior.instruction !== instruction)
          throw new Error('Steering identity belongs to different text');
        return;
      }
      const paused = held(entry);
      if (entry.steering.length === 64) throw new Error('Steering history is full');
      entry.revision++;
      entry.instruction = instruction;
      entry.steering.push({ ...human, instruction, revision: entry.revision });
      if (!paused) entry.wakeReason = { kind: 'human_steering', messageId: human.messageId };
      entry.updatedAt = Date.now();
      // Steering during a dispatch does not erase its identity or authorize a retry.
      if (['ready', 'completed', 'failed'].includes(entry.currentStep.status)) {
        if (entry.currentStep.status === 'ready') entry.currentStep.text = instruction;
        try {
          if (entry.currentStep.status === 'ready')
            entry.scope = structuredClone(this.refreshScope(entry, this.options.snapshot()));
          else this.advance(entry, this.options.snapshot());
          if (!paused) entry.state = 'running';
        } catch {
          if (!paused) {
            entry.state = 'blocked';
            entry.wakeReason = { kind: 'steering_source_or_capacity_unavailable' };
          }
        }
      }
    });
  }
  wait(id, state, reason, input) {
    this.human(input);
    if (
      !['waiting_user', 'waiting_approval', 'waiting_external', 'sleeping', 'blocked'].includes(
        state,
      ) ||
      !string(reason, 1000)
    )
      throw new Error('Choose an explicit waiting reason');
    this.change((next) => {
      const entry = next.entries.find((x) => x.id === id);
      if (!entry || ['completed', 'cancelled'].includes(entry.state))
        throw new Error('That responsibility has finished');
      entry.state = state;
      entry.wakeReason = { kind: state, reason };
      entry.updatedAt = Date.now();
    });
  }
  wake(id, input) {
    const human = this.human(input),
      entry = this.entry(id);
    if (['completed', 'cancelled'].includes(entry.state))
      throw new Error('That responsibility has finished');
    if (entry.state === 'waiting_approval' && input.kind !== 'approval')
      throw new Error('Explicit approval is required');
    if (!['ready', 'queued', 'accepted', 'completed'].includes(entry.currentStep.status))
      throw new Error('Check the existing source outcome; waking cannot replay delivery');
    this.change((next) => {
      const current = next.entries.find((x) => x.id === id);
      current.state = current.currentStep.status === 'ready' ? 'running' : 'waiting_external';
      current.wakeReason = { kind: 'human_wake', messageId: human.messageId };
      if (current.currentStep.status === 'completed')
        this.finishStep(current, this.options.snapshot());
      current.updatedAt = Date.now();
    });
  }
  async cancel(id, input) {
    const human = this.human(input),
      entry = this.entry(id);
    if (['completed', 'cancelled'].includes(entry.state)) return false;
    if (this.closed || this.options.maintenance?.())
      throw new Error('Wait for Hyphen maintenance before cancelling this responsibility');
    if (entry.currentStep.status === 'ready') {
      this.change((next) => {
        const current = next.entries.find((x) => x.id === id);
        current.state = 'cancelled';
        current.currentStep.status = 'cancelled';
        current.wakeReason = { kind: 'human_cancelled', messageId: human.messageId };
        current.updatedAt = Date.now();
      });
      return true;
    }
    if (entry.currentStep.status !== 'queued' || !this.options.cancel)
      throw new Error('Accepted or unconfirmed work must be managed in its source chat');
    this.options.validateTarget(entry.scope, this.options.snapshot());
    const step = structuredClone(entry.currentStep),
      scope = structuredClone(entry.scope);
    this.change((next) => {
      next.entries.find((x) => x.id === id).currentStep.status = 'cancelling';
    });
    let receipt;
    this.pending.add(step.id);
    try {
      try {
        receipt = await this.options.cancel({
          id: scope.id,
          taskKey: scope.taskKey,
          sourceId: scope.sourceId,
          messageId: step.messageId,
        });
      } catch {}
      const confirmed =
        receipt?.messageId === step.messageId &&
        receipt.sourceId === scope.sourceId &&
        receipt.ownerId === scope.ownerId &&
        receipt.delivery === 'cancelled';
      this.change((next) => {
        const current = next.entries.find((x) => x.id === id);
        current.state = confirmed ? 'cancelled' : 'waiting_user';
        current.currentStep.status = confirmed ? 'cancelled' : 'unconfirmed';
        current.wakeReason = {
          kind: confirmed ? 'human_cancelled' : 'cancellation_unconfirmed',
          messageId: human.messageId,
        };
        current.updatedAt = Date.now();
      });
      return confirmed;
    } finally {
      this.pending.delete(step.id);
    }
  }
  async dispatch(id) {
    const entry = this.entry(id);
    if (
      this.closed ||
      this.options.maintenance?.() ||
      entry.state !== 'running' ||
      entry.currentStep.status !== 'ready'
    )
      return false;
    // The host resolves a fresh exact source/owner/device/revision before admission.
    this.options.validateTarget(entry.scope, this.options.snapshot());
    if(this.options.authorize){
      const decision=this.options.authorize(entry);
      if(decision?.decision!=='act'){
        this.change(next=>{const current=next.entries.find(x=>x.id===id);current.state=decision?.decision==='ask'?'waiting_approval':'blocked';current.wakeReason={kind:'authorization_'+(decision?.decision||'deny'),reason:decision?.reason||'authorization_unavailable',operationId:decision?.operationId,grantId:decision?.grantId};current.updatedAt=Date.now();});
        return false;
      }
    }
    const step = structuredClone(entry.currentStep),
      scope = structuredClone(entry.scope);
    this.change((next) => {
      next.entries.find((x) => x.id === id).currentStep.status = 'dispatching';
    });
    this.pending.add(step.id);
    try {
      let receipt;
      try {
        receipt = await this.options.dispatch('queue', {
          id: scope.id,
          taskKey: scope.taskKey,
          sourceId: scope.sourceId,
          messageId: step.messageId,
          text: step.text,
        });
      } catch (error) {
        this.change((next) => {
          const current = next.entries.find((x) => x.id === id),
            paused = held(current),
            refused = error?.delivery === 'not-sent';
          current.currentStep.status = refused ? 'failed' : 'unconfirmed';
          if (!paused) {
            current.state = refused ? 'blocked' : 'waiting_user';
            current.wakeReason = { kind: refused ? 'delivery_refused' : 'delivery_unconfirmed' };
          }
          current.updatedAt = Date.now();
        });
        return false;
      }
      const matched =
        receipt?.messageId === step.messageId &&
        receipt.sourceId === scope.sourceId &&
        receipt.ownerId === scope.ownerId &&
        (receipt.delivery === 'queued' ||
          (receipt.delivery === 'sent' && string(receipt.turnId, 512)));
      this.change((next) => {
        const current = next.entries.find((x) => x.id === id);
        current.currentStep.status = matched
          ? receipt.delivery === 'queued'
            ? 'queued'
            : 'accepted'
          : 'unconfirmed';
        if (matched && receipt.turnId) current.currentStep.turnId = receipt.turnId;
        if (current.state === 'running') {
          current.state = matched ? 'waiting_external' : 'waiting_user';
          current.wakeReason = { kind: matched ? 'source_progress' : 'delivery_unconfirmed' };
        }
        current.updatedAt = Date.now();
      });
      return matched;
    } finally {
      this.pending.delete(step.id);
    }
  }
  async pump() {
    if (this.closed || this.pumping || this.options.maintenance?.()) return;
    this.pumping = true;
    try {
      for (const entry of this.snapshot()) {
        if (this.closed || this.options.maintenance?.()) break;
        if (entry.state !== 'running' || entry.currentStep.status !== 'ready') continue;
        try {
          await this.dispatch(entry.id);
        } catch {
          if (this.closed) break;
          try {
            this.change((next) => {
              const current = next.entries.find((x) => x.id === entry.id);
              if (current.currentStep.status === 'ready') {
                current.state = 'blocked';
                current.wakeReason = { kind: 'source_changed_or_storage_unavailable' };
              }
            });
          } catch {}
        }
      }
    } finally {
      this.pumping = false;
    }
  }
  observe(snapshot) {
    if (this.closed) return;
    const updates = [];
    for (const entry of this.state.entries) {
      if (
        !['queued', 'accepted', 'unconfirmed', 'dispatching', 'cancelling'].includes(
          entry.currentStep.status,
        ) ||
        this.pending.has(entry.currentStep.id) ||
        entry.state === 'cancelled'
      )
        continue;
      const proof = this.options.outcome(snapshot, {
        ...entry.scope,
        ...entry.currentStep,
        status: ['dispatching', 'cancelling'].includes(entry.currentStep.status)
          ? 'unconfirmed'
          : entry.currentStep.status,
      });
      if (proof) updates.push({ id: entry.id, proof });
    }
    if (!updates.length) return;
    try {
      this.change((next) => {
        for (const { id, proof } of updates) {
          const entry = next.entries.find((x) => x.id === id);
          entry.currentStep.status = proof.status;
          entry.currentStep.turnId = proof.turnId;
          const explicitlyWaiting = held(entry);
          if (explicitlyWaiting && proof.status !== 'cancelled') {
            if (proof.status === 'not-sent') entry.currentStep.status = 'failed';
            entry.updatedAt = Date.now();
            continue;
          }
          if (proof.status === 'completed') {
            this.finishStep(entry, snapshot);
          } else if (['failed', 'not-sent', 'cancelled'].includes(proof.status)) {
            entry.state = proof.status === 'cancelled' ? 'cancelled' : 'blocked';
            entry.currentStep.status = proof.status === 'not-sent' ? 'failed' : proof.status;
            entry.wakeReason = {
              kind: proof.status === 'cancelled' ? 'confirmed_queue_cancelled' : 'source_failed',
            };
          } else entry.state = proof.status === 'unconfirmed' ? 'waiting_user' : 'waiting_external';
          entry.updatedAt = Date.now();
        }
      });
      return true;
    } catch {
      this.options.log?.write('responsibility.recovery_failed', {
        code: 'RESPONSIBILITY_STORAGE_FAILED',
        noResend: true,
      });
      return false;
    }
  }
  confirm(id, input) {
    const human = this.human(input),
      entry = this.entry(id);
    if (
      entry.currentStep.status !== 'completed' ||
      entry.completionCriteria.kind !== 'human_verified'
    )
      throw new Error('An exact source outcome is required before verification');
    if (entry.currentStep.text !== entry.instruction)
      throw new Error('The newer human instruction has not completed its source pass');
    this.change((next) => {
      const current = next.entries.find((x) => x.id === id);
      current.state = 'completed';
      current.wakeReason = { kind: 'human_verified', messageId: human.messageId };
      current.updatedAt = Date.now();
    });
  }
  close() {
    this.closed = true;
  }
}
module.exports = { Responsibilities, validate, states };
