'use strict';
const formatters = new Map();
function formatter(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length > 100 || /^[+-]/.test(timeZone))
    throw new Error('Choose a named timezone');
  if (!formatters.has(timeZone)) {
    const value = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    if (formatters.size >= 128) formatters.clear();
    formatters.set(timeZone, value);
  }
  return formatters.get(timeZone);
}
function parts(at, timeZone) {
  if (!Number.isSafeInteger(at) || Math.abs(at) > 8640000000000000)
    throw new Error('Invalid schedule timestamp');
  return Object.fromEntries(
    formatter(timeZone)
      .formatToParts(at)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  );
}
function wallEpoch(p) {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour || 0, p.minute || 0, p.second || 0);
}
function localKey(at, timeZone) {
  const p = parts(at, timeZone);
  return [p.year, String(p.month).padStart(2, '0'), String(p.day).padStart(2, '0')].join('-');
}
function validate(spec) {
  formatter(spec?.timeZone);
  if (
    !['interval', 'daily', 'weekly'].includes(spec.kind) ||
    !Number.isSafeInteger(spec.endAt) ||
    spec.endAt <= 0 ||
    spec.endAt > 8640000000000000
  )
    throw new Error('Choose a supported schedule and explicit end date');
  if (spec.kind === 'interval') {
    if (
      !Number.isSafeInteger(spec.intervalMs) ||
      spec.intervalMs < 60000 ||
      spec.intervalMs > 30 * 86400000 ||
      !Number.isSafeInteger(spec.anchorAt) ||
      spec.anchorAt <= 0
    )
      throw new Error('Intervals must be from one minute through thirty days with a valid anchor');
  } else {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(spec.wallTime))
      throw new Error('Use a local time as HH:MM');
    if (
      spec.kind === 'weekly' &&
      (!Array.isArray(spec.weekdays) ||
        !spec.weekdays.length ||
        spec.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
        new Set(spec.weekdays).size !== spec.weekdays.length)
    )
      throw new Error('Choose unique weekdays from Sunday 0 through Saturday 6');
  }
  return spec;
}
// Resolve the requested local minute to all exact UTC candidates. A nonexistent
// DST minute is skipped. An ambiguous repeated minute uses its first occurrence,
// even when the caller wakes after that occurrence, so one calendar day cannot
// accidentally produce two runs. Probe offsets on both sides of the date rather
// than applying today's UTC offset to a future date.
function resolveWall(p, timeZone) {
  const naive = wallEpoch(p),
    offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = naive + hours * 3600000;
    offsets.add(wallEpoch(parts(probe, timeZone)) - probe);
  }
  const candidates = [...offsets]
    .map((offset) => naive - offset)
    .filter((at) => wallEpoch(parts(at, timeZone)) === naive);
  return candidates.length ? Math.min(...candidates) : null;
}
function nextWake(spec, after) {
  validate(spec);
  parts(after, spec.timeZone);
  if (after >= spec.endAt) return null;
  if (spec.kind === 'interval') {
    const n = Math.max(0, Math.floor((after - spec.anchorAt) / spec.intervalMs) + 1);
    const at = spec.anchorAt + n * spec.intervalMs;
    return at > after && at <= spec.endAt ? at : null;
  }
  const current = parts(after, spec.timeZone),
    [hour, minute] = spec.wallTime.split(':').map(Number);
  for (let day = 0; day < 16; day++) {
    const date = new Date(Date.UTC(current.year, current.month - 1, current.day + day));
    if (spec.kind === 'weekly' && !spec.weekdays.includes(date.getUTCDay())) continue;
    const at = resolveWall(
      {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour,
        minute,
      },
      spec.timeZone,
    );
    if (at !== null && at > after && at <= spec.endAt) return at;
  }
  return null;
}
function dueTiming(spec, plannedAt, now) {
  validate(spec);
  parts(now, spec.timeZone);
  if (!Number.isSafeInteger(plannedAt) || plannedAt <= 0)
    throw new Error('Invalid planned timestamp');
  if (now < plannedAt) return { due: false, plannedAt, nextWake: plannedAt };
  if (now > spec.endAt) return { due: false, expired: true, plannedAt, nextWake: null };
  // A missed run becomes one catch-up opportunity. Advance from actual time;
  // never replay the backlog of every missed period after restart.
  return {
    due: true,
    plannedAt,
    actualAt: now,
    missed: now > plannedAt,
    nextWake: nextWake(spec, now),
  };
}
module.exports = { validate, parts, localKey, resolveWall, nextWake, dueTiming };
