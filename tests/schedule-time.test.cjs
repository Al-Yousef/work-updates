'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { nextWake, dueTiming, localKey } = require('../src/schedule-time.cjs');
const at = Date.parse,
  endAt = at('2028-12-31T23:59:59Z');
const daily = (zone, time) => ({ kind: 'daily', timeZone: zone, wallTime: time, endAt });
test('daily wall times follow named timezone DST instead of a fixed UTC offset', () => {
  const spec = daily('America/Toronto', '09:00');
  assert.equal(nextWake(spec, at('2026-03-07T15:00:00Z')), at('2026-03-08T13:00:00Z'));
  assert.equal(nextWake(spec, at('2026-10-31T14:00:00Z')), at('2026-11-01T14:00:00Z'));
  assert.equal(
    nextWake(daily('Australia/Sydney', '09:00'), at('2026-10-03T00:00:00Z')),
    at('2026-10-03T22:00:00Z'),
  );
});
test('nonexistent DST minutes skip their day; repeated minutes never create a second daily run', () => {
  assert.equal(
    nextWake(daily('America/Toronto', '02:30'), at('2026-03-08T00:00:00Z')),
    at('2026-03-09T06:30:00Z'),
  );
  const spec = daily('America/Toronto', '01:30');
  assert.equal(nextWake(spec, at('2026-11-01T00:00:00Z')), at('2026-11-01T05:30:00Z'));
  assert.equal(nextWake(spec, at('2026-11-01T05:30:00Z')), at('2026-11-02T06:30:00Z'));
});
test('fractional timezone offsets and local midnight keep calendar dates correct', () => {
  assert.equal(
    nextWake(daily('Asia/Kathmandu', '09:00'), at('2026-10-06T00:00:00Z')),
    at('2026-10-06T03:15:00Z'),
  );
  assert.equal(
    nextWake(daily('Pacific/Chatham', '09:00'), at('2026-10-06T00:00:00Z')),
    at('2026-10-06T19:15:00Z'),
  );
  assert.equal(localKey(at('2026-10-06T03:00:00Z'), 'America/Toronto'), '2026-10-05');
});
test('weekly schedules survive a nonexistent selected DST day without inventing another weekday', () => {
  const spec = { ...daily('America/Toronto', '02:30'), kind: 'weekly', weekdays: [0] };
  assert.equal(nextWake(spec, at('2026-03-08T00:00:00Z')), at('2026-03-15T06:30:00Z'));
});
test('interval anchors skip missed periods with one bounded catch-up and retain planned versus actual times', () => {
  const anchorAt = at('2026-10-06T00:00:00Z'),
    spec = { kind: 'interval', timeZone: 'America/Toronto', anchorAt, intervalMs: 3600000, endAt };
  const now = anchorAt + 10.5 * 3600000,
    timing = dueTiming(spec, anchorAt, now);
  assert.equal(timing.due, true);
  assert.equal(timing.missed, true);
  assert.equal(timing.plannedAt, anchorAt);
  assert.equal(timing.actualAt, now);
  assert.equal(timing.nextWake, anchorAt + 11 * 3600000);
  assert.equal(nextWake(spec, anchorAt - 1), anchorAt);
  assert.equal(dueTiming(spec, anchorAt, anchorAt - 1).due, false);
});
test('end dates are inclusive for a planned run and refuse late work after expiry', () => {
  const spec = { ...daily('UTC', '09:00'), endAt: at('2026-10-06T09:00:00Z') };
  assert.equal(nextWake(spec, at('2026-10-06T08:00:00Z')), spec.endAt);
  assert.equal(nextWake(spec, spec.endAt), null);
  assert.equal(dueTiming(spec, spec.endAt, spec.endAt + 1).expired, true);
});
test('invalid timezone, impossible time, oversized cadence and missing end date are refused', () => {
  for (const spec of [
    daily('Invalid/Zone', '09:00'),
    daily('+04:00', '09:00'),
    daily('UTC', '24:00'),
    { ...daily('UTC', '09:00'), endAt: null },
    { kind: 'interval', timeZone: 'UTC', anchorAt: 1, intervalMs: 1, endAt },
  ])
    assert.throws(() => nextWake(spec, at('2026-01-01T00:00:00Z')));
});
