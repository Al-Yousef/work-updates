'use strict';
function command(text) {
  if (!/^\/browser(?:\s|$)/.test(text)) return null;
  if (text === '/browser inspect') return { kind: 'inspect' };
  let m = text.match(/^\/browser open (\{[\s\S]+\})$/);
  if (m) return { kind: 'open', spec: JSON.parse(m[1]) };
  m = text.match(/^\/browser (takeover|return|close|read|save-login) ([a-f0-9-]{36})$/);
  if (m) return { kind: m[1], id: m[2] };
  m = text.match(/^\/browser navigate ([a-f0-9-]{36}) (https?:\/\/\S+)$/);
  if (m) return { kind: 'navigate', id: m[1], url: m[2] };
  m = text.match(/^\/browser reuse-login ([a-f0-9-]{36}) ([a-f0-9-]{36})$/);
  if (m) return { kind: 'reuse-login', id: m[1], vaultId: m[2] };
  throw new Error(
    'Use browser inspect, open JSON, takeover|return|close|read|save-login ID, navigate ID URL or reuse-login ID VAULT_ID.',
  );
}
async function manage(store, message, intent) {
  if (!store) throw new Error('Browser controls are unavailable.');
  const input = {
    role: 'human',
    authority: 'accepted_human',
    actorId: store.actorId,
    messageId: message.id,
    text: message.text,
  };
  let result;
  if (intent.kind === 'inspect') result = store.inspect();
  else if (intent.kind === 'open') result = await store.open(input, intent.spec);
  else if (intent.kind === 'return') result = await store.returnControl(input, intent.id);
  else if (intent.kind === 'save-login') result = await store.saveLogin(input, intent.id);
  else if (intent.kind === 'reuse-login')
    result = await store.reuseLogin(input, intent.id, intent.vaultId);
  else if (['read', 'navigate'].includes(intent.kind)) {
    store.human(input, message.text);
    result = await store[intent.kind](store.lease(intent.id), intent.url);
  } else result = await store[intent.kind](input, intent.id);
  const output = JSON.stringify(result, null, 2);
  message.answer =
    output.length > 6000
      ? JSON.stringify(
          { ...result, text: String(result.text || '').slice(0, 4800), truncated: true },
          null,
          2,
        ).slice(0, 6000)
      : output;
  message.status = 'completed';
}
module.exports = { command, manage };
