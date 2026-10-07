'use strict';
const identity = '([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})';
function command(text) {
  if (typeof text !== 'string' || !/^\/research(?:\s|$)/i.test(text)) return null;
  if (/^\/research\s*$/i.test(text)) return { kind: 'list' };
  let m = text.match(/^\/research enable ([a-z0-9_.:-]{1,512})\s*:\s*(\{[\s\S]+\})\s*$/i);
  if (m) {
    let config;
    try {
      config = JSON.parse(m[2]);
    } catch {
      throw new Error('Research configuration must be valid JSON');
    }
    const sourceId = /^[a-f0-9-]{36}$/i.test(m[1]) ? m[1].toLowerCase() : m[1];
    return { kind: 'enable', sourceId, config };
  }
  m = text.match(
    new RegExp('^/research (inspect|read|pause|resume|revoke) ' + identity + '\\s*$', 'i'),
  );
  if (m) return { kind: m[1].toLowerCase(), id: m[2].toLowerCase() };
  throw new Error('Use /research, enable SOURCE_ID: JSON, or inspect|read|pause|resume|revoke ID');
}
module.exports = { command };
