'use strict';
function inspect(store, id) {
  const r = store.rule(id),
    state = store.snapshot();
  return {
    rule: r,
    lastFinding: state.findings.findLast((f) => f.ruleId === id) || null,
    decisions: state.decisions.filter((d) => d.ruleId === id).slice(-8),
    deliveries: state.deliveries.filter((d) => d.ruleId === id).slice(-8),
    coverage: {
      exhaustive: false,
      droppedFindings: state.droppedFindings,
      droppedDecisions: state.droppedDecisions,
    },
    meaning:
      'Findings, local notification acceptance, user acknowledgement and independent goal verification remain separate. Inbox stored does not mean seen; system show does not mean read. Unknown delivery is never automatically resent.',
  };
}
function manage(store, message, c) {
  if (!store) throw new Error('Proactive notification controls are unavailable');
  const human = {
    role: 'human',
    authority: 'accepted_human',
    actorId: store.options.policy.actorId,
    messageId: message.id,
    text: message.text,
  };
  let id = c.id;
  if (c.kind === 'list')
    message.answer =
      store.state.rules
        .map(
          (r) =>
            r.id +
            ' · ' +
            r.phase +
            ' · ' +
            r.config.destination.kind +
            ' · ' +
            r.config.destination.audience,
        )
        .join('\n') || 'No responsibility notification rules configured.';
  else {
    if (c.kind === 'configure') id = store.configure(human, c.responsibilityId, c.config);
    else if (c.kind !== 'inspect') {
      store.control(human, id, c.kind);
      if (c.kind === 'acknowledge') id = store.state.deliveries.find((d) => d.id === id).ruleId;
    }
    message.notificationRuleId = id;
    const value = JSON.stringify(inspect(store, id), null, 2);
    message.answer =
      value.slice(0, 5400) +
      (value.length > 5400
        ? '\nInspection truncated; remaining detail is retained privately.'
        : '');
  }
  message.status = 'completed';
}
module.exports = { manage, inspect };
