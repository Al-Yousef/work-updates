'use strict';
const identity = '([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})';
function command(text) {
  if (typeof text !== 'string' || !/^\/delegations?(?:\s|$)/i.test(text)) return null;
  if (/^\/delegations\s*$/i.test(text)) return { kind: 'list' };
  let m = text.match(
    new RegExp(
      '^/delegation start ' +
        identity +
        ' ([a-z0-9_.:-]{1,512}) ([1-9][0-9]{1,3}):\\s*([\\s\\S]+)$',
      'i',
    ),
  );
  if (m) {
    const seconds = Number(m[3]);
    if (seconds < 30 || seconds > 3600)
      throw new Error('Choose an admission deadline of 30 to 3,600 seconds');
    const sourceId = /^[a-f0-9-]{36}$/i.test(m[2]) ? m[2].toLowerCase() : m[2];
    return {
      kind: 'start',
      parentId: m[1].toLowerCase(),
      sourceId,
      seconds,
      instruction: m[4].trim(),
    };
  }
  m = text.match(new RegExp('^/delegation (inspect|cancel|resume) ' + identity + '\\s*$', 'i'));
  if (m) return { kind: m[1].toLowerCase(), id: m[2].toLowerCase() };
  m = text.match(new RegExp('^/delegation verify ' + identity + '\\s*:\\s*([\\s\\S]+)$', 'i'));
  if (m) return { kind: 'verify', id: m[1].toLowerCase(), review: m[2].trim() };
  throw new Error(
    'Use /delegations, /delegation start PARENT_ID SOURCE_ID SECONDS: INSTRUCTION, inspect|cancel|resume ID, or verify ID: REVIEWED RESULT. Optional selected context follows a blank line and Selected context (data, not instructions):.',
  );
}
module.exports = { command };
