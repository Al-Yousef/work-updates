'use strict';
function command(text) {
  if (text === '/privacy inspect') return {kind:'inspect'};
  const inventory=text.match(/^\/privacy inventory(?: (\d{1,2}))?$/);
  if(inventory){const page=Number(inventory[1]||1);if(page<1)throw new Error('Choose an inventory page starting at 1.');return {kind:'inventory',page};}
  let m = text.match(/^\/privacy (disconnect|delete) ([a-f0-9-]{36})$/);
  if (m) return { kind: m[1], id: m[2] };
  m = text.match(/^\/privacy preview (notes|conversation|source-cache|source-extracts|source-reflections|orphan-attachments|diagnostic-backups|voice-configuration|document-copies|browser-logins)(?: ([a-f0-9-]{36}))?$/);
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
  const page=intent.page||1,pages=intent.kind==='inventory'?Math.ceil(result.length/8):0;
  if(intent.kind==='inventory'&&page>pages)throw new Error('That inventory page is unavailable. Start at /privacy inventory.');
  message.answer =
    intent.kind === 'inventory'
      ? result.slice((page-1)*8,page*8).map((row) => row.name + ' · ' + row.location + '\n' + row.retention + '. ' + row.removal).join('\n\n')+'\n\nInventory '+page+' of '+pages+(page<pages?' · Next: /privacy inventory '+(page+1):'')
      : typeof result === 'string'
        ? result
        : JSON.stringify(result, null, 2).slice(0, 6000);
  message.status = 'completed';
}
module.exports = { command, manage };
