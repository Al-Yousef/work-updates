'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inferAttention, statusLabel, priorityRank } = require('../src/attention.cjs');
const { statusFromText } = require('../src/controller.cjs');
test('waiting ownership follows explicit user, named person, or team evidence', () => {
  for (const text of [
    'Waiting on you to approve.',
    'Still blocked on your decision.',
    'Need your choice.',
  ]) {
    assert.equal(inferAttention(text).waitingOn.kind, 'you');
    assert.equal(statusFromText(text), 'needs');
  }
  assert.deepEqual(inferAttention('Waiting for Alex\u2019s response.').waitingOn, {
    kind: 'other',
    name: 'Alex',
  });
  assert.deepEqual(inferAttention('Waiting on the support team to respond.').waitingOn, {
    kind: 'other',
    name: 'support team',
  });
  assert.equal(
    statusLabel('waiting', inferAttention('Waiting for a response.').waitingOn),
    'Waiting · owner unclear',
  );
  assert.equal(inferAttention('No longer waiting on you.').waitingOn.kind, 'unknown');
  assert.equal(inferAttention('This is not urgent.').urgent, false);
});
test('waiting on you comes before urgency and external waits come after review', () => {
  const cards = [
    { id: 'other', status: 'waiting', waitingOn: { kind: 'other', name: 'reviewer' } },
    { id: 'ready', status: 'ready', readyForReview: true },
    {
      id: 'urgent',
      status: 'waiting',
      urgent: true,
      waitingOn: { kind: 'other', name: 'reviewer' },
    },
    { id: 'you', status: 'blocked', waitingOn: { kind: 'you' } },
  ];
  assert.deepEqual(
    cards.sort((a, b) => priorityRank(a) - priorityRank(b)).map((c) => c.id),
    ['you', 'urgent', 'ready', 'other'],
  );
});
