'use strict';
const { currentScope } = require('./responsibility-target.cjs');
function inspect(e) {
  return {
    id: e.id,
    parentId: e.parentId,
    parentRevision: e.parentRevision,
    childResponsibilityId: e.childId,
    sourceId: e.scope.sourceId,
    ownerId: e.scope.ownerId,
    device: e.scope.executionDevice,
    sourceRevision: e.scope.taskRevision,
    parentSourceRevision: e.parentScope.taskRevision,
    purpose: e.purpose,
    selectedContext: {
      text: e.selectedContext.slice(0, 800),
      provenance: 'human_selected_data',
      truncated: e.selectedContext.length > 800,
    },
    phase: e.phase,
    cancelRequested: e.cancelRequested,
    writerLeaseHeld: e.leaseHeld,
    limits: e.limits,
    output: e.output
      ? { ...e.output, text: e.output.text.slice(0, 500), truncated: e.output.text.length > 500 }
      : null,
    review: e.review
      ? {
          kind: e.review.kind,
          text: e.review.text.slice(0, 500),
          truncated: e.review.text.length > 500,
          at: e.review.at,
        }
      : null,
    missingEvidence: e.missingEvidence,
    parentGoalVerification: 'Tracked separately on the parent responsibility',
  };
}
async function manage(store, message, command, snapshot) {
  if (!store) throw new Error('Specialist coordination is unavailable');
  const human = {
    role: 'human',
    authority: 'accepted_human',
    actorId: store.options.policy.actorId,
    messageId: message.id,
    text: message.text,
  };
  let id = command.id;
  if (command.kind === 'list')
    message.answer =
      store
        .snapshot()
        .slice(-12)
        .map(
          (e) =>
            e.purpose.slice(0, 150) +
            ' · ' +
            e.phase +
            (e.review ? ' · human reviewed' : ' · result unverified') +
            '\n' +
            e.id,
        )
        .join('\n\n') ||
      'No delegated tasks yet. Start one for an unfinished parent responsibility and an exact local source.';
  else {
    if (command.kind === 'start') {
      const parent = store.options.responsibilities.entry(command.parentId),
        scope = currentScope(
          { sourceId: command.sourceId, ownerId: parent.scope.ownerId },
          snapshot,
        );
      id = store.start(human, command.parentId, scope, command.seconds, command.instruction);
      await store.resume(id, human);
    } else if (command.kind === 'cancel') await store.cancel(id, human);
    else if (command.kind === 'resume') await store.resume(id, human);
    else if (command.kind === 'verify') store.verify(id, human, command.review);
    store.observe();
    message.delegationId = id;
    const entry = store.entry(id),
      child = store.child(entry),
      furtherDispatch = store.parentDecision(entry);
    const rendered = JSON.stringify(
      {
        ...inspect(entry),
        childCheckpoint: child?.wakeReason || { kind: 'preparation_pending' },
        furtherDispatch: {
          decision: furtherDispatch.decision,
          reason: furtherDispatch.reason,
          mode: furtherDispatch.mode,
        },
      },
      null,
      2,
    );
    message.answer =
      rendered.slice(0, 5200) +
      (rendered.length > 5200 ? '\nInspection truncated.' : '') +
      '\nChild run completion, human result review and verification of the parent goal are separate. Accepted work requires its source owner to stop it; cancellation remains pending until matching proof.';
  }
  message.status = 'completed';
}
module.exports = { manage, inspect };
