'use strict';
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
function command(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\/notice(?:\s+list)?$/i.test(text)) return { kind: 'list' };
  const enable = text.match(new RegExp('^/notice configure (' + uuid + '): ([\\s\\S]+)$', 'i'));
  if (enable) {
    let config;
    try {
      config = JSON.parse(enable[2]);
    } catch {
      throw new Error('Use an explicit JSON notification configuration');
    }
    return { kind: 'configure', responsibilityId: enable[1], config };
  }
  const control = text.match(
    new RegExp('^/notice (inspect|pause|resume|acknowledge) (' + uuid + ')$', 'i'),
  );
  return control ? { kind: control[1].toLowerCase(), id: control[2] } : null;
}
module.exports = { command };
