'use strict';
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
function command(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (/^\/work(?:\s+list)?$/i.test(value)) return { kind: 'list' };
  if (/^\/work\s+inspect$/i.test(value)) return { kind: 'inspect' };
  const all = value.match(/^\/work\s+(stop-all|resume-all)$/i);
  if (all) return { kind: all[1].toLowerCase(), target: 'all' };
  const scoped = value.match(
    new RegExp(
      '^/work\\s+(pause-main|resume-main|stop-child|disable-schedule|resume-schedule)\\s+(' +
        uuid +
        ')$',
      'i',
    ),
  );
  if (scoped) return { kind: scoped[1].toLowerCase(), target: scoped[2] };
  const executor = value.match(/^\/work\s+revoke-executor\s+([a-z0-9_.:-]{1,200})$/i);
  return executor ? { kind: 'revoke-executor', target: executor[1] } : null;
}
module.exports = { command };
