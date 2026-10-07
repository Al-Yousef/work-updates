'use strict';
const { currentScope } = require('./responsibility-target.cjs'),
  { fresh, sourceFor } = require('./assistant-coordination.cjs');
function policyScope(scope) {
  return {
    sourceId: scope.sourceId,
    ownerId: scope.ownerId,
    deviceId: scope.deviceId,
    taskKey: scope.taskKey,
    destination: scope.sourceId,
    audience: 'source-chat:' + scope.sourceId,
    accountKind: 'source_owner',
    accountId: scope.ownerId,
  };
}
function human(policy, origin) {
  return { ...origin, role: 'human', authority: 'accepted_human', actorId: policy.actorId };
}
function request(entry, snapshot, operationId = entry.currentStep.messageId) {
  let scope, match;
  try {
    scope = currentScope(entry.scope, snapshot);
    match = sourceFor(snapshot, scope);
  } catch {
    return {
      operationId,
      action: 'send',
      instruction: entry.currentStep.text,
      scope: policyScope(entry.scope),
      capability: 'source_message',
      current: null,
    };
  }
  return {
    operationId,
    action: 'send',
    instruction: entry.currentStep.text,
    scope: policyScope(entry.scope),
    capability: 'source_message',
    current: {
      scope: policyScope(scope),
      online: match.card.owner?.online !== false,
      fresh: fresh(snapshot),
      local: match.card.owner?.local === true,
      responsibilityFinished: ['completed', 'cancelled'].includes(entry.state),
    },
  };
}
function prepare(policy, entry, snapshot, schedule) {
  if(entry.delegationId){const grant=policy.state.grants.find(g=>g.key==='delegation:'+entry.delegationId);return grant?{...policy.reserve(grant.id,request(entry,snapshot)),grantId:grant.id}:{decision:'deny',reason:'delegation_grant_unavailable'};}
  const step = entry.currentStep,
    steer = entry.steering.findLast((s) => s.instruction === step.text),
    origin = steer || entry.origin;
  let key = 'responsibility:' + entry.id + ':' + (steer?.revision || 1),
    duration = { kind: 'responsibility' },
    maxUses = 1;
  if (step.schedule) {
    if (
      !schedule ||
      schedule.id !== step.schedule.id ||
      schedule.grant.instruction !== step.text ||
      schedule.grant.responsibilityRevision !== entry.revision ||
      ['cancelled', 'expired'].includes(schedule.state)
    )
      return { decision: 'deny', reason: 'schedule_grant_unavailable' };
    key = 'schedule:' + schedule.id;
    duration = { kind: 'until', endAt: schedule.schedule.endAt };
    maxUses = schedule.maxRuns;
  }
  let id = policy.state.grants.find((g) => g.key === key)?.id;
  if (!id)
    id = policy.create(human(policy, origin), {
      key,
      responsibilityId: entry.id,
      action: 'send',
      mode: 'act',
      instruction: step.text,
      scope: policyScope(entry.scope),
      duration,
      maxUses,
      ...(schedule
        ? { scheduleOrigin: structuredClone(schedule.origin), scheduleId: schedule.id }
        : {}),
    });
  if (schedule) {
    const grant = policy.grant(id),
      change = schedule.changes.findLast((c) => c.kind === 'reschedule');
    if (
      grant.state === 'active' &&
      change &&
      (grant.duration.endAt !== schedule.schedule.endAt || grant.maxUses !== schedule.maxRuns)
    )
      policy.retime(id, human(policy, change), {
        endAt: schedule.schedule.endAt,
        maxUses: schedule.maxRuns,
      });
  }
  return { ...policy.reserve(id, request(entry, snapshot)), grantId: id };
}
function messageAdmission(policy, responsibilities, snapshot, message, schedules) {
  const entry = responsibilities.state.entries.find((e) =>
    [e.currentStep, ...(e.pastSteps || [])].some((s) => s.messageId === message.id),
  );
  if (!entry) return directAdmission(policy, message, snapshot);
  const step = [entry.currentStep, ...(entry.pastSteps || [])].find(
    (s) => s.messageId === message.id,
  );
  if (
    step !== entry.currentStep ||
    step.text !== message.text ||
    require('./attachments.cjs').messageHash(step.text, []) !== message.textHash ||
    entry.scope.sourceId !== message.sourceId
  )
    return 'deny';
  const schedule = step.schedule ? schedules?.entry(step.schedule.id) : null,
    decision = prepare(policy, entry, snapshot, schedule);
  return decision.decision === 'act' ? 'allow' : decision.decision === 'ask' ? 'wait' : 'deny';
}
function dispatchRequest(input, snapshot) {
  const match = [...(snapshot.cards || []), ...(snapshot.done || [])].filter((c) =>
    c.sources?.some((s) => s.id === input.sourceId),
  );
  if (match.length !== 1) throw new Error('The source execution owner is unavailable or ambiguous');
  const scope = currentScope(
      { sourceId: input.sourceId, ownerId: match[0].owner?.id || 'local' },
      snapshot,
    ),
    bound = policyScope({ ...scope, taskKey: input.taskKey || scope.taskKey });
  return {
    operationId: input.messageId || input.id,
    action: 'send',
    instruction: input.text,
    attachmentIds: input.attachmentIds || [],
    scope: bound,
    capability: 'source_message',
    current: {
      scope: policyScope(scope),
      fresh: fresh(snapshot),
      online: match[0].owner?.online !== false,
      local: match[0].owner?.local === true,
      responsibilityFinished: match[0].done,
    },
  };
}
function authorizeDispatch(policy, input, snapshot) {
  const request = dispatchRequest(input, snapshot),
    prior = policy.state.operations.find((o) => o.id === request.operationId);
  if (prior) return policy.reserve(prior.grantId, request);
  const at = input.createdAt || Date.now(),
    origin = {
      messageId: request.operationId,
      text: input.text || 'Send the selected attachments.',
    },
    id = policy.create(human(policy, origin), {
      key: 'direct:' + request.operationId,
      action: 'send',
      mode: 'act',
      instruction: request.instruction,
      attachmentIds: request.attachmentIds,
      scope: request.scope,
      duration: { kind: 'until', endAt: at + 86400000 },
      maxUses: 1,
    });
  return policy.reserve(id, request);
}
function directAdmission(policy, input, snapshot) {
  const decision = authorizeDispatch(policy, { ...input, messageId: input.id }, snapshot);
  return decision.decision === 'act' ? 'allow' : decision.decision === 'ask' ? 'wait' : 'deny';
}
function observe(policy, messages) {
  for (const message of [...messages.state.entries, ...Object.values(messages.state.receipts)])
    if (['sent', 'uncertain', 'cancelled'].includes(message.status))
      policy.outcome(
        message.id,
        { sent: 'accepted', uncertain: 'unknown', cancelled: 'cancelled' }[message.status],
      );
}
module.exports = {
  policyScope,
  human,
  request,
  prepare,
  messageAdmission,
  observe,
  authorizeDispatch,
  directAdmission,
  dispatchRequest,
};
