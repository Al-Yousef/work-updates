'use strict';
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
function command(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\/reflection(?:\s+list)?$/i.test(text)) return { kind: 'list' };
  const start = text.match(
    new RegExp('^/reflection\\s+enable\\s+(' + uuid + '): ([\\s\\S]+)$', 'i'),
  );
  if (start) {
    let config;
    try {
      config = JSON.parse(start[2]);
    } catch {
      throw new Error('Use a JSON reflection configuration');
    }
    return { kind: 'enable', researchId: start[1], config };
  }
  const declined = text.match(
    new RegExp(
      '^/reflection\\s+decline\\s+(' + uuid + ')\\s+([a-f0-9]{64}): ([\\s\\S]{1,500})$',
      'i',
    ),
  );
  if (declined)
    return { kind: 'decline', id: declined[1], suggestionId: declined[2], reason: declined[3] };
  const control = text.match(
    new RegExp('^/reflection\\s+(inspect|checkpoint|pause|resume|prune)\\s+(' + uuid + ')$', 'i'),
  );
  return control ? { kind: control[1].toLowerCase(), id: control[2] } : null;
}
module.exports = { command };
