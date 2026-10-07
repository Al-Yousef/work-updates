'use strict';
function command(text) {
  if (/^\/budget inspect$/i.test(text)) return { kind: 'inspect' };
  const m = text.match(/^\/budget (global|[a-f0-9-]{36}):\s*([\s\S]+)$/i);
  if (!m) return null;
  return { kind: 'configure', scope: m[1].toLowerCase(), config: JSON.parse(m[2]) };
}
function manage(store, message, control) {
  if (!store) throw new Error('Resource budgets are unavailable');
  if (control.kind === 'configure')
    store.configure(
      {
        role: 'human',
        authority: 'accepted_human',
        actorId: store.options.actorId,
        messageId: message.id,
        text: message.text,
      },
      control.scope,
      control.config,
    );
  message.answer = JSON.stringify(store.inspect(), null, 2).slice(0, 5800);
  message.status = 'completed';
  message.links = [];
}
module.exports = { command, manage };
