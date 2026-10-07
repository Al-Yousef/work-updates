'use strict';
const { currentScope } = require('./responsibility-target.cjs');
const { sourceFor } = require('./assistant-coordination.cjs');
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function target(store, schedule) {
  const entry = store.entry(schedule.responsibilityId),
    grant = schedule.grant;
  if (
    entry.revision !== grant.responsibilityRevision ||
    entry.instruction !== grant.instruction ||
    entry.scope.sourceId !== grant.sourceId ||
    entry.scope.ownerId !== grant.ownerId ||
    entry.scope.taskKey !== grant.taskKey ||
    entry.scope.deviceId !== grant.deviceId ||
    JSON.stringify(entry.scope.executionDevice) !== JSON.stringify(grant.executionDevice)
  )
    throw Object.assign(
      new Error(
        'The authorized responsibility scope changed. Create a new schedule for the current instruction.',
      ),
      { delivery: 'not-sent', code: 'SCHEDULE_SCOPE_CHANGED' },
    );
  const snapshot = store.options.snapshot(),
    match = sourceFor(snapshot, grant);
  if (match?.card.owner?.local !== true)
    throw Object.assign(
      new Error(
        'Scheduled execution currently requires its local source owner. Remote expiry capability is unverified.',
      ),
      { delivery: 'not-sent' },
    );
  const scope = currentScope(grant, snapshot);
  if (
    scope.taskKey !== grant.taskKey ||
    scope.deviceId !== grant.deviceId ||
    JSON.stringify(scope.executionDevice) !== JSON.stringify(grant.executionDevice)
  )
    throw Object.assign(new Error('The execution task or device changed.'), {
      delivery: 'not-sent',
    });
  return { entry, scope };
}
function probe(store, schedule) {
  let entry, scope;
  try {
    ({ entry, scope } = target(store, schedule));
  } catch (error) {
    return {
      eligible: false,
      reason:
        error.code === 'SCHEDULE_SCOPE_CHANGED'
          ? 'responsibility_scope_changed'
          : 'source_unavailable',
    };
  }
  if (['completed', 'cancelled'].includes(entry.state))
    return { eligible: false, reason: 'responsibility_finished' };
  const ready = entry.state === 'running' && entry.currentStep.status === 'ready',
    finished =
      entry.state === 'waiting_user' &&
      entry.wakeReason.kind === 'source_finished_outcome_unverified' &&
      entry.currentStep.status === 'completed';
  return {
    eligible: ready || finished,
    fingerprint: scope.taskRevision,
    reason: ready || finished ? null : 'responsibility_waiting',
  };
}
async function run(store, schedule) {
  if (
    !uuid(schedule.run?.id) ||
    !uuid(schedule.id) ||
    !uuid(schedule.origin?.messageId) ||
    typeof schedule.origin.text !== 'string' ||
    Date.now() > schedule.schedule.endAt
  )
    throw Object.assign(
      new Error('An unexpired human schedule grant and durable run identity are required'),
      { delivery: 'not-sent' },
    );
  if (!probe(store, schedule).eligible)
    throw Object.assign(new Error('The responsibility is waiting, busy, changed or finished'), {
      delivery: 'not-sent',
    });
  const { entry } = target(store, schedule);
  try {
    store.change((next) => {
      const current = next.entries.find((e) => e.id === entry.id);
      if (current.currentStep.status === 'completed')
        store.advance(current, store.options.snapshot());
      current.currentStep.schedule = { id: schedule.id, runId: schedule.run.id };
      current.currentStep.expiresAt = schedule.schedule.endAt;
      current.state = 'running';
      current.wakeReason = { kind: 'human_scheduled_run', messageId: schedule.origin.messageId };
      current.updatedAt = Date.now();
    });
  } catch (error) {
    error.delivery = 'not-sent';
    throw error;
  }
  await store.dispatch(entry.id);
  const saved = store.entry(entry.id).currentStep;
  return {
    status:
      saved.status === 'failed' && store.entry(entry.id).wakeReason.kind === 'delivery_refused'
        ? 'not-sent'
        : saved.status,
    messageId: saved.messageId,
    sourceId: entry.scope.sourceId,
    ownerId: entry.scope.ownerId,
    turnId: saved.turnId,
    acceptedAt: saved.acceptedAt,
  };
}
function admission(store, schedules, message) {
  if (!message.scheduleId) return 'allow';
  try {
    target(store, schedules.entry(message.scheduleId));
    const schedule = schedules.entry(message.scheduleId),
      run = schedule.runs.find((r) => r.id === message.runId),
      entry = store.entry(schedule.responsibilityId),
      step = [entry.currentStep, ...(entry.pastSteps || [])].find(
        (s) => s.schedule?.id === schedule.id && s.schedule.runId === message.runId,
      );
    if (
      !run ||
      !step ||
      step.messageId !== message.id ||
      require('./attachments.cjs').messageHash(step.text, []) !== message.textHash ||
      schedule.grant.sourceId !== message.sourceId ||
      message.expiresAt !== (run.expiresAt ?? schedule.schedule.endAt) ||
      Date.now() > schedule.schedule.endAt ||
      ['cancelled', 'expired'].includes(schedule.state)
    )
      return 'deny';
    const manual =
      run.trigger === 'user' &&
      run.userWake?.messageId === schedule.changes.at(-1)?.messageId &&
      schedule.changes.at(-1)?.kind === 'now';
    if (
      (schedule.state === 'paused' && !manual) ||
      ['sleeping', 'waiting_approval'].includes(entry.state) ||
      entry.wakeReason.kind === entry.state
    )
      return 'wait';
    return 'allow';
  } catch {
    return 'deny';
  }
}
function outcome(store, schedule, run) {
  const entry = store.entry(schedule.responsibilityId),
    step = [entry.currentStep, ...(entry.pastSteps || [])].find(
      (s) => s.schedule?.id === schedule.id && s.schedule.runId === run.id,
    );
  if (
    !step ||
    !['accepted', 'completed', 'failed', 'cancelled', 'unconfirmed'].includes(step.status)
  )
    return null;
  if (step.status === run.status && step.turnId === run.turnId && step.messageId === run.messageId)
    return null;
  return {
    runId: run.id,
    messageId: step.messageId,
    sourceId: schedule.grant.sourceId,
    ownerId: schedule.grant.ownerId,
    status: step.status,
    turnId: step.turnId,
    acceptedAt: step.acceptedAt,
  };
}
module.exports = { target, probe, run, outcome, admission };
