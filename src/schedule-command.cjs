'use strict';
const timing = require('./schedule-time.cjs');
const identity = '([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})';
function timestamp(value) {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/,
  );
  if (!match) throw new Error('Use an ISO timestamp with Z or an explicit UTC offset');
  const [year, month, day] = match.slice(1, 4).map(Number),
    at = Date.parse(value);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    !Number.isSafeInteger(at) ||
    at <= 0
  )
    throw new Error('Invalid schedule date');
  return at;
}
function duration(value) {
  const m = value.match(/^(\d{1,5})(m|h|d)$/);
  if (!m) throw new Error('Use a cadence such as 15m, 2h or 1d');
  return Number(m[1]) * { m: 60000, h: 3600000, d: 86400000 }[m[2]];
}
function specification(text, now) {
  const tail = text.match(
    /^([\s\S]+?) zone (\S+) until (\S+) runs (\d{1,2})(?: checks (\d{1,3}))?\s*$/,
  );
  if (!tail) throw new Error('Include zone NAME until ISO_DATE runs LIMIT');
  const [, plan, timeZone, end, runLimit, checkLimit] = tail,
    endAt = timestamp(end),
    limits = {
      maxRuns: Number(runLimit),
      maxChecks: checkLimit ? Number(checkLimit) : 64,
      mode: 'scheduled',
    };
  let schedule;
  let m = plan.match(/^every (\d{1,5}[mhd])$/);
  if (m) {
    const intervalMs = duration(m[1]);
    schedule = { kind: 'interval', timeZone, endAt, intervalMs, anchorAt: now + intervalMs };
  } else if ((m = plan.match(/^daily ((?:[01]\d|2[0-3]):[0-5]\d)$/)))
    schedule = { kind: 'daily', timeZone, endAt, wallTime: m[1] };
  else if ((m = plan.match(/^weekly ([0-6](?:,[0-6])*) ((?:[01]\d|2[0-3]):[0-5]\d)$/)))
    schedule = {
      kind: 'weekly',
      timeZone,
      endAt,
      weekdays: m[1].split(',').map(Number),
      wallTime: m[2],
    };
  else if ((m = plan.match(/^deadline (\S+) every (\d{1,5}[mhd])$/))) {
    limits.mode = 'deadline';
    schedule = {
      kind: 'interval',
      timeZone,
      endAt,
      intervalMs: duration(m[2]),
      anchorAt: timestamp(m[1]),
    };
  } else if ((m = plan.match(/^watch every (\d{1,5}[mhd])$/))) {
    limits.mode = 'event';
    const intervalMs = duration(m[1]);
    schedule = { kind: 'interval', timeZone, endAt, intervalMs, anchorAt: now + intervalMs };
  } else
    throw new Error(
      'Use every CADENCE, daily HH:MM, weekly DAYS HH:MM, deadline ISO_DATE every CADENCE, or watch every CADENCE',
    );
  timing.validate(schedule);
  if (
    endAt <= now ||
    limits.maxRuns < 1 ||
    limits.maxRuns > 64 ||
    limits.maxChecks < 1 ||
    limits.maxChecks > 256
  )
    throw new Error('Choose a future end date, 1–64 runs and 1–256 checks');
  return { schedule, limits };
}
function command(text, now = Date.now()) {
  if (typeof text !== 'string' || !/^\/schedules?(?:\s|$)/i.test(text)) return null;
  if (/^\/schedules\s*$/i.test(text)) return { kind: 'list' };
  let m = text.match(new RegExp('^/schedule (pause|resume|cancel|now) ' + identity + '\\s*$', 'i'));
  if (m) return { kind: m[1].toLowerCase(), id: m[2].toLowerCase() };
  m = text.match(new RegExp('^/schedule (start|reschedule) ' + identity + ' ([\\s\\S]+)$', 'i'));
  if (m) return { kind: m[1].toLowerCase(), id: m[2].toLowerCase(), ...specification(m[3], now) };
  throw new Error(
    'Use /schedules or /schedule start RESPONSIBILITY_ID daily 09:00 zone America/Toronto until ISO_DATE runs 10. Existing schedules use their full ID with pause, resume, cancel, now or reschedule.',
  );
}
module.exports = { command, specification, timestamp };
