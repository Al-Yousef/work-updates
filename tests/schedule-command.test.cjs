'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  { command, timestamp } = require('../src/schedule-command.cjs');
const id = '12345678-1234-1234-1234-123456789abc',
  now = Date.parse('2026-10-06T12:00:00Z'),
  tail = ' zone America/Toronto until 2026-11-01T23:00:00Z runs 4 checks 8';
test('explicit schedule controls retain identity, timezone, end and limits', () => {
  const value = command('/schedule start ' + id + ' daily 09:00' + tail, now);
  assert.equal(value.id, id);
  assert.equal(value.schedule.wallTime, '09:00');
  assert.equal(value.limits.maxRuns, 4);
  assert.equal(value.limits.maxChecks, 8);
  assert.equal(
    command('/schedule start ' + id + ' deadline 2026-10-06T13:00:00Z every 15m' + tail, now).limits
      .mode,
    'deadline',
  );
  assert.equal(
    command('/schedule start ' + id + ' watch every 15m' + tail, now).limits.mode,
    'event',
  );
  assert.equal(command('/schedule now ' + id).kind, 'now');
});
test('questions and quoted commands cannot create schedules, and invalid calendar dates or absent limits fail', () => {
  assert.equal(command('Explain /schedule start ' + id + ' daily 09:00' + tail, now), null);
  assert.equal(command('"/schedule cancel ' + id + '"'), null);
  assert.throws(() => timestamp('2026-02-30T09:00:00Z'), /Invalid schedule date/);
  assert.throws(() => command('/schedule start ' + id + ' every 1m zone UTC', now));
  assert.throws(
    () => command('/schedule start ' + id + ' weekly 1,1 09:00' + tail, now),
    /unique weekdays/,
  );
});
