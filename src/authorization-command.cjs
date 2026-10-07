'use strict';
const id = '([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})';
function command(text) {
  if (/^\/authorizations$/i.test(text)) return { kind: 'list' };
  let m = text.match(new RegExp('^/authorization (revoke|approve|inspect) ' + id + '$', 'i'));
  if (m) return { kind: m[1].toLowerCase(), id: m[2] };
  m = text.match(new RegExp('^/authorization mode ' + id + ' (act|ask|handoff)$', 'i'));
  if (m) return { kind: 'mode', id: m[1], mode: m[2].toLowerCase() };
  m = text.match(/^\/authorization (revoke|restore)-account (source_owner) ([a-z0-9:_-]{1,512})$/i);
  if (m)
    return { kind: 'account', operation: m[1].toLowerCase(), accountKind: m[2], accountId: m[3] };
  return null;
}
module.exports = { command };
