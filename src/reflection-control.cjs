'use strict';
function inspect(store, id) {
  const e = store.entry(id),
    state = store.snapshot();
  return {
    id: e.id,
    researchId: e.researchId,
    phase: e.phase,
    configuration: e.config,
    reviews: e.reviews,
    nextWake: e.nextWake,
    reason: e.reason,
    lastCheckpoint: state.checkpoints.findLast((c) => c.reflectionId === id) || null,
    carriedLeads: state.leads.filter((l) => l.reflectionId === id).slice(-8),
    declinedWork: state.decisions.filter((d) => d.reflectionId === id).slice(-8),
    coverage: {
      exhaustive: false,
      carriedLeadTotal: state.leads.filter((l) => l.reflectionId === id).length,
      declinedTotal: state.decisions.filter((d) => d.reflectionId === id).length,
    },
    capabilities: {
      newSourceReads: false,
      modelInference: false,
      send: false,
      execution: false,
      preferenceWrites: false,
    },
    retention:
      'Only temporary reflection checkpoints. Other retained stores and account history remain separate.',
  };
}
function manage(store, message, control) {
  if (!store) throw new Error('Reflection is unavailable');
  const human = {
    role: 'human',
    authority: 'accepted_human',
    actorId: store.options.policy.actorId,
    messageId: message.id,
    text: message.text,
  };
  let id = control.id;
  if (control.kind === 'list')
    message.answer =
      store.state.entries
        .map(
          (e) =>
            e.id +
            ' · ' +
            e.phase +
            ' · ' +
            e.config.timeZone +
            ' · ' +
            e.reviews +
            '/' +
            e.config.maxReviews,
        )
        .join('\n') || 'No reflection scopes enabled. Cadence is optional and manual by default.';
  else {
    if (control.kind === 'enable') id = store.enable(human, control.researchId, control.config);
    else if (control.kind === 'checkpoint') store.checkpoint(id, human);
    else if (control.kind !== 'inspect')
      store.control(id, control.kind, human, control.suggestionId, control.reason);
    message.reflectionId = id;
    const rendered = JSON.stringify(inspect(store, id), null, 2);
    message.answer =
      rendered.slice(0, 5300) +
      (rendered.length > 5300
        ? '\nInspection truncated; further checkpoint details remain private.'
        : '') +
      '\nWrites are read-back verified. Findings, questions and suggestions remain unverified interpretations unless separately supported. Declining a proposal does not create a permanent preference.';
  }
  message.status = 'completed';
}
module.exports = { manage, inspect };
