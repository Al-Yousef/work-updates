'use strict';
async function manage(store, message, command) {
  if (!store) throw new Error('Work controls are unavailable in this session');
  if (['list', 'inspect'].includes(command.kind)) {
    store.reconcile();
    const state = store.snapshot();
    message.answer =
      'Pause main holds its future work and descendants. Stop child cancels its unsent message and requests an interrupt only for an owned matching active turn. Disable schedule holds future runs. Revoke executor blocks its source-owner permissions. Stop all fences all Hyphen-managed dispatch and scoped reads; it cancels tracked unsent work and requests stops for owned active turns. It cannot undo committed external actions or stop unrelated applications.\n\n' +
      (state.holds
        .filter((h) => h.active)
        .map((h) => h.kind + ' ' + h.target)
        .join('\n') || 'No active holds.') +
      '\n\n' +
      state.actions
        .slice(-5)
        .map(
          (a) =>
            a.kind +
            ' · ' +
            a.status +
            '\n' +
            a.resources
              .slice(0, 8)
              .map(
                (r) =>
                  r.kind + ' ' + r.id + ' · ' + r.status + (r.turnId ? ' · turn ' + r.turnId : ''),
              )
              .join('\n') +
            (a.resources.length > 8
              ? '\nAdditional checkpoints are retained in the private journal.'
              : ''),
        )
        .join('\n\n');
  } else {
    const origin = require('./responsibility-authorization.cjs').human(store.options.policy, {
      messageId: message.id,
      text: message.text,
    });
    const result = await store.control(command.kind, command.target, origin);
    message.workControlId = result.id;
    message.answer =
      'Saved ' +
      result.kind +
      ' · ' +
      result.status +
      '.\n' +
      result.resources
        .slice(0, 12)
        .map(
          (r) => r.kind + ' ' + r.id + ' · ' + r.status + (r.turnId ? ' · turn ' + r.turnId : ''),
        )
        .join('\n') +
      '\nAccepted actions retain their original receipts. An interrupt acknowledgement is a request; a matching terminal source event confirms the stop. Resume reconciles existing checkpoints and never resends them.';
  }
  message.answer = message.answer.slice(0, 5700);
  message.status = 'completed';
}
module.exports = { manage };
