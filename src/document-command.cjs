'use strict';
function command(text) {
  if (!/^\/document(?:\s|$)/.test(text)) return null;
  if (text === '/document inspect') return { kind: 'inspect' };
  let m = text.match(/^\/document import (\{[\s\S]+\})$/);
  if (m) return { kind: 'import', spec: JSON.parse(m[1]) };
  m = text.match(/^\/document (request|schedule) ([a-f0-9-]{36}): (\{[\s\S]+\})$/);
  if (m) return { kind: m[1], id: m[2], spec: JSON.parse(m[3]) };
  m = text.match(/^\/document (apply|cancel) ([a-f0-9-]{36})$/);
  if (m) return { kind: m[1], id: m[2] };
  throw new Error(
    'Use document inspect, import JSON, request|schedule ID: JSON, or apply|cancel ID.',
  );
}
function manage(store, message, intent) {
  if (!store) throw new Error('Document controls are unavailable.');
  const input = {
    role: 'human',
    authority: 'accepted_human',
    actorId: store.actorId,
    messageId: message.id,
    text: message.text,
  };
  const result =
    intent.kind === 'inspect'
      ? store.inspect()
      : intent.kind === 'import'
        ? store.import(input, intent.spec)
        : intent.kind === 'request'
          ? store.request(input, intent.id, intent.spec)
          : intent.kind === 'schedule'
            ? store.schedule(input, intent.id, intent.spec)
            : store[intent.kind](input, intent.id);
  const text = JSON.stringify(result, null, 2);
  if (text.length > 6000) {
    message.answer =
      'The result is larger than this chat view. Inspect a smaller document range; the complete private document/checkpoint remains on this computer.';
  } else message.answer = text;
  message.status = 'completed';
}
module.exports = { command, manage };
