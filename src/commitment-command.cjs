'use strict';
const identity = '([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})';
function command(text) {
  if (typeof text !== 'string' || !/^\/(?:commitments?|preferences?)(?:\s|$)/i.test(text))
    return null;
  if (/^\/commitments\s*$/i.test(text)) return { kind: 'list' };
  if (/^\/preferences\s*$/i.test(text)) return { kind: 'preferences' };
  let m = text.match(/^\/commitment add\s*:\s*([\s\S]+)$/i);
  if (m) return { kind: 'add', title: m[1].trim() };
  m = text.match(new RegExp('^/commitment (inspect|delete|source) ' + identity + '\\s*$', 'i'));
  if (m) return { kind: m[1].toLowerCase(), id: m[2].toLowerCase() };
  m = text.match(
    new RegExp('^/commitment (history|evidence) ' + identity + ' ([1-9][0-9]?)\\s*$', 'i'),
  );
  if (m) return { kind: m[1].toLowerCase(), id: m[2].toLowerCase(), page: Number(m[3]) };
  m = text.match(
    new RegExp(
      '^/commitment (correct|supersede|verify) ' + identity + '\\s*:\\s*([\\s\\S]+)$',
      'i',
    ),
  );
  if (m) {
    const kind = m[1].toLowerCase(),
      value = m[3].trim();
    if (kind === 'correct') {
      let patch;
      try {
        patch = JSON.parse(value);
      } catch {
        throw new Error('Use a JSON object after the correction colon');
      }
      return { kind, id: m[2].toLowerCase(), patch, literal: value };
    }
    return { kind, id: m[2].toLowerCase(), [kind === 'verify' ? 'description' : 'title']: value };
  }
  m = text.match(
    /^\/preference set (notifications|research|answer_style) (inherit|off|important_only|all|manual_only|concise|detailed)\s*$/i,
  );
  if (m) return { kind: 'preference', key: m[1].toLowerCase(), value: m[2].toLowerCase() };
  m = text.match(/^\/preference delete (notifications|research|answer_style)\s*$/i);
  if (m) return { kind: 'delete_preference', key: m[1].toLowerCase() };
  throw new Error(
    'Use /commitments; /commitment add: TITLE; inspect, delete or source ID; correct ID: JSON; supersede ID: TITLE; verify ID: REVIEWED RESULT. Preferences use /preferences or /preference set NAME VALUE and /preference delete NAME.',
  );
}
module.exports = { command };
