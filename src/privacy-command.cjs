'use strict';
function command(text) {
  if (text === '/privacy inventory' || text === '/privacy inspect') return { kind: text.slice(9) };
  let m = text.match(/^\/privacy (disconnect|delete) ([a-f0-9-]{36})$/);
  if (m) return { kind: m[1], id: m[2] };
  m = text.match(/^\/privacy preview (notes|conversation|source-cache)(?: ([a-f0-9-]{36}))?$/);
  if (m) return { kind: 'preview', dataClass: m[1], sourceId: m[2] };
  m = text.match(/^\/privacy export ([a-z-]+(?:\.json)?)(?: ([a-f0-9-]{36}))?$/);
  if (m) return { kind: 'export', dataClass: m[1], sourceId: m[2] };
  return null;
}
async function manage(privacy, message, intent) {
  if (!privacy) throw new Error('Privacy controls are unavailable.');
  const input = {
    role: 'human',
    authority: 'accepted_human',
    actorId: privacy.actorId,
    messageId: message.id,
    text: message.text,
  };
  const result =
    intent.kind === 'inventory'
      ? privacy.inventory()
      : intent.kind === 'inspect'
        ? privacy.inspect()
        : intent.kind === 'disconnect'
          ? await privacy.disconnect(input, intent.id)
          : intent.kind === 'preview'
            ? privacy.preview(input, intent.dataClass, intent.sourceId)
            : intent.kind === 'delete'
              ? await privacy.remove(input, intent.id)
              : privacy.export(input, intent.dataClass, intent.sourceId);
  message.answer =
    intent.kind === 'inventory'
      ? result.map((row) => row.name + ' · ' + row.location + '\n' + row.retention + '. ' + row.removal).join('\n\n')
      : typeof result === 'string'
        ? result
        : JSON.stringify(result, null, 2).slice(0, 6000);
  message.status = 'completed';
}
module.exports = { command, manage };
