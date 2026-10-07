'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  crypto = require('node:crypto'),
  { EventEmitter } = require('node:events'),
  { fixture } = require('./fixtures/triage-profile.cjs'),
  { command } = require('../src/triage-command.cjs'),
  { readStore, atomicJSON } = require('../src/private-store.cjs');
function profile(t) {
  const f = fixture();
  t.after(() => f.close());
  return f;
}
test('notification rules are off by default; literal enabling stores exact self-only scope without source reads, sends or model inference', async (t) => {
  const f = profile(t);
  f.finding();
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries.length, 0);
  assert.equal(command('Please configure notifications'), null);
  assert.equal(command('"/notice pause ' + crypto.randomUUID() + '"'), null);
  const enabled = await f.enable();
  assert.equal(enabled.status, 'completed', enabled.error);
  assert.deepEqual(readStore(f.triage.file).value, f.triage.state);
  assert.equal(f.triage.state.rules[0].binding.sourceId, f.source.id);
  assert.equal(f.reads, 0);
  assert.equal(f.calls, 0);
  assert.equal(f.questions, 0);
});
test('findings, decisions and actual local inbox receipts stay distinct; unchanged source polls do not duplicate the stored update', async (t) => {
  const f = profile(t);
  await f.enable();
  f.finding();
  await f.triage.pump();
  const state = f.triage.state,
    d = state.deliveries[0];
  assert.equal(d.status, 'accepted');
  assert.equal(d.receipt.kind, 'inbox_stored');
  assert.equal(d.receipt.synthetic, false);
  assert.equal(state.findings[0].independentlyVerified, false);
  assert.equal(state.decisions[0].decision, 'notify');
  assert.equal(
    JSON.parse(fs.readFileSync(f.assistant.file)).messages.find((m) => m.id === d.id).answer,
    d.payload.text,
  );
  for (let i = 0; i < 10; i++) await f.triage.pump();
  assert.equal(f.triage.state.deliveries.length, 1);
  assert.equal(f.triage.state.findings.length, 1);
  assert.match(f.triage.state.decisions.at(-1).reason, /already_delivered/);
  assert.equal(f.responsibilities.entry(f.responsibilityId).state, 'waiting_user');
  assert.equal(f.calls, 0);
  assert.equal(f.questions, 0);
});
test('quiet hours defer a changed finding and recheck it after the local minute without needing a new worker run', async (t) => {
  const f = profile(t),
    now = new Date(f.now),
    after = new Date(f.now + 60000);
  await f.enable({
    quietHours: {
      start: now.toISOString().slice(11, 16),
      end: after.toISOString().slice(11, 16),
      timeZone: 'UTC',
    },
  });
  f.finding();
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries.length, 0);
  assert.equal(f.triage.state.decisions.at(-1).reason, 'quiet_hours');
  f.advance(61000);
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries[0].status, 'accepted');
  assert.equal(f.triage.state.findings.length, 1);
});
test('routine preference and global opt-out persist quiet reasons without losing meaningful findings', async (t) => {
  const f = profile(t);
  await f.enable({ routineUpdates: 'changes' });
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries.length, 1);
  f.commitments.preference(f.control('/preference notifications off'), 'notifications', 'off');
  f.finding();
  await f.triage.pump();
  assert.equal(f.triage.state.findings.length, 2);
  assert.equal(f.triage.state.deliveries.length, 1);
  assert.equal(f.triage.state.decisions.at(-1).reason, 'notification_preference_hold');
  f.commitments.preference(
    f.control('/preference notifications important_only'),
    'notifications',
    'important_only',
  );
  f.advance(60000);
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries.length, 2);
});
test('escalation requires explicit manual urgency and user waiting, remains bounded and stops after human acknowledgement', async (t) => {
  const f = profile(t);
  await f.enable();
  f.finding({ urgency: true });
  await f.triage.pump();
  assert.equal(f.triage.state.findings[0].manualUrgency, true);
  f.advance(120001);
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries.length, 2);
  assert.equal(f.triage.state.deliveries[1].level, 1);
  const d = f.triage.state.deliveries[1];
  assert.equal((await f.ask('/notice acknowledge ' + d.id)).status, 'completed');
  f.advance(3600000);
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries.length, 2);
  assert.equal(f.triage.state.decisions.at(-1).reason, 'already_acknowledged');
  assert.equal(f.responsibilities.entry(f.responsibilityId).state, 'waiting_user');
});
test('inferred urgency and uncertain waiting ownership cannot escalate a reminder', async (t) => {
  const f = profile(t);
  await f.enable();
  f.triage.options.snapshot = () => {
    const s = f.snapshot();
    s.cards = s.cards.map((c) => ({ ...c, waitingOn: { kind: 'unknown', name: '' } }));
    return s;
  };
  f.finding({ state: 'blocked', status: 'failed', urgency: true });
  await f.triage.pump();
  assert.equal(f.triage.state.findings[0].waitingOn, 'unknown');
  assert.match(f.triage.state.findings[0].text, /ownership is not established/);
  f.advance(3600000);
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries.length, 1);
});
test('minimum interval and attempt expiry bound changed findings rather than resetting on pause or resume', async (t) => {
  const f = profile(t),
    enabled = await f.enable({ maxAttempts: 1 });
  f.finding();
  await f.triage.pump();
  await f.ask('/notice pause ' + enabled.notificationRuleId);
  await f.ask('/notice resume ' + enabled.notificationRuleId);
  f.finding({ state: 'blocked', status: 'failed' });
  f.advance(60000);
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries.length, 1);
  assert.equal(f.triage.state.decisions.at(-1).reason, 'notification_attempt_limit');
  f.advance(3 * 86400000);
  await f.triage.pump();
  assert.equal(f.triage.state.decisions.at(-1).reason, 'rule_expired');
});
test('a lost inbox receipt is recovered from actual destination bytes after restart, with no duplicate delivery', async (t) => {
  const f = profile(t);
  await f.enable();
  f.finding();
  const deliver = f.destination.deliver;
  let sends = 0;
  f.destination.deliver = async (d) => {
    sends++;
    await deliver(d);
    return null;
  };
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries[0].status, 'unknown');
  const messageId = f.triage.state.deliveries[0].id;
  f.restart();
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries[0].status, 'accepted');
  assert.equal(f.triage.state.deliveries[0].reason, 'destination_receipt_recovered');
  assert.equal(sends, 1);
  assert.equal(
    JSON.parse(fs.readFileSync(f.assistant.file)).messages.filter((m) => m.id === messageId).length,
    1,
  );
});
test('unknown or mismatched destination receipts remain unknown across restart and cannot cause an automatic duplicate', async (t) => {
  const f = profile(t);
  await f.enable();
  f.finding();
  let sends = 0;
  f.destination.deliver = async (d) => {
    sends++;
    return {
      deliveryId: d.id,
      payloadHash: d.payloadHash,
      destinationKey: 'f'.repeat(64),
      kind: 'inbox_stored',
      at: f.now,
      synthetic: false,
    };
  };
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries[0].status, 'unknown');
  f.restart();
  f.advance(3600000);
  await f.triage.pump();
  assert.equal(sends, 1);
  assert.equal(f.triage.state.deliveries.length, 1);
  assert.equal(f.triage.state.decisions.at(-1).reason, 'delivery_unconfirmed_no_resend');
});

test('changing notification configuration cannot clear a prior unknown receipt or replay an unchanged delivered finding', async (t) => {
  for (const unknown of [false, true]) {
    const f = profile(t);
    await f.enable();
    f.finding();
    let sends = 0;
    const deliver = f.destination.deliver;
    f.destination.deliver = async (d) => {
      sends++;
      return unknown ? null : deliver(d);
    };
    await f.triage.pump();
    await f.enable({ minIntervalSeconds: 120 });
    f.advance(120001);
    await f.triage.pump();
    assert.equal(sends, 1);
    assert.equal(f.triage.state.deliveries.length, 1);
    assert.equal(
      f.triage.state.decisions.at(-1).reason,
      unknown ? 'delivery_unconfirmed_no_resend' : 'unchanged_finding_already_delivered',
    );
  }
});
test('changed ownership, offline sources and pauses fence a prepared notification before reaching its destination', async (t) => {
  for (const kind of ['owner', 'offline', 'pause', 'maintenance']) {
    const f = profile(t),
      enabled = await f.enable();
    f.finding();
    f.triage.observe(f.snapshot());
    assert.equal(f.triage.state.deliveries[0].status, 'prepared');
    let sends = 0;
    f.destination.deliver = async () => {
      sends++;
    };
    if (kind === 'pause') await f.ask('/notice pause ' + enabled.notificationRuleId);
    else if (kind === 'maintenance') f.triage.options.maintenance = () => true;
    else
      f.triage.options.snapshot = () => {
        const s = f.snapshot();
        s.cards = s.cards.map((c) => ({
          ...c,
          owner: {
            ...c.owner,
            id: kind === 'owner' ? 'other-owner' : c.owner.id,
            online: kind !== 'offline',
          },
        }));
        return s;
      };
    await f.triage.pump();
    assert.equal(sends, 0, kind);
    assert.equal(f.calls, 0);
  }
});
test('unverified journal write before delivery prevents the side effect; restart does not resend a prepared uncertain intent', async (t) => {
  const f = profile(t);
  await f.enable();
  f.finding();
  let sends = 0;
  f.destination.deliver = async () => {
    sends++;
  };
  f.triage.options.write = (file, value) => {
    if (value.deliveries.some((d) => d.status === 'sending')) return;
    atomicJSON(file, value);
  };
  await assert.rejects(f.triage.pump(), /original file is preserved/);
  assert.equal(sends, 0);
  delete f.triage.options.write;
  f.restart();
  await f.triage.pump();
  assert.equal(sends, 0);
  assert.equal(f.triage.state.deliveries[0].status, 'unknown');
});
test('failed journal completion after an actual inbox write recovers the exact receipt instead of performing the notification again', async (t) => {
  const f = profile(t);
  await f.enable();
  f.finding();
  const deliver = f.destination.deliver;
  let sends = 0;
  f.destination.deliver = async (d) => {
    sends++;
    return deliver(d);
  };
  f.triage.options.write = (file, value) => {
    if (value.deliveries.some((d) => d.status === 'accepted'))
      throw new Error('Synthetic completion write failure');
    atomicJSON(file, value);
  };
  await assert.rejects(f.triage.pump(), /original file is preserved/);
  assert.equal(sends, 1);
  delete f.triage.options.write;
  f.restart();
  await f.triage.pump();
  assert.equal(sends, 1);
  assert.equal(f.triage.state.deliveries[0].status, 'accepted');
});
test('system notification acceptance needs an OS show event and synthetic event fixtures stay labelled', async (t) => {
  const f = profile(t),
    { destination } = require('../src/notification-destination.cjs');
  class SyntheticNotification extends EventEmitter {
    static isSupported() {
      return true;
    }
    show() {
      this.emit('show', {});
    }
  }
  f.triage.options.destination = destination({
    assistant: f.assistant,
    deviceId: f.deviceId,
    Notification: SyntheticNotification,
    now: () => f.now,
    syntheticSystem: true,
  });
  await f.enable({ destination: { kind: 'system', deviceId: f.deviceId, audience: 'self' } });
  f.finding();
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries[0].receipt.kind, 'os_shown');
  assert.equal(f.triage.state.deliveries[0].receipt.synthetic, true);
});
test('system creation without a show receipt is unknown, not delivered or retried', async (t) => {
  const f = profile(t),
    { destination } = require('../src/notification-destination.cjs');
  let shows = 0;
  class SilentNotification extends EventEmitter {
    static isSupported() {
      return true;
    }
    show() {
      shows++;
    }
  }
  f.triage.options.destination = destination({
    assistant: f.assistant,
    deviceId: f.deviceId,
    Notification: SilentNotification,
    now: () => f.now,
    timeoutMs: 15,
    syntheticSystem: true,
  });
  await f.enable({ destination: { kind: 'system', deviceId: f.deviceId, audience: 'self' } });
  f.finding();
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries[0].status, 'unknown');
  f.restart();
  await f.triage.pump();
  assert.equal(shows, 1);
});
test('unsupported recipients, quoted settings, source commands and behavior questions cannot configure permissions or notification rules', async (t) => {
  const f = profile(t);
  for (const patch of [
    { destination: { kind: 'inbox', deviceId: f.deviceId, audience: 'everyone' } },
    { destination: { kind: 'phone', deviceId: f.deviceId, audience: 'self' } },
    { destination: { kind: 'inbox', deviceId: 'other-device', audience: 'self' } },
    { until: '2030-01-01T00:00:00Z' },
    { maxAttempts: 65 },
    { maxReminders: 4 },
    { quietHours: { start: '10:00', end: '10:00', timeZone: 'UTC' } },
    { extra: true },
  ])
    assert.equal((await f.enable(patch)).status, 'failed', JSON.stringify(patch));
  const before = JSON.stringify(f.triage.state),
    policy = JSON.stringify(f.policy.state);
  await f.ask('How do notifications work?');
  assert.equal(JSON.stringify(f.triage.state), before);
  assert.equal(JSON.stringify(f.policy.state), policy);
  const literal = '/notice configure ' + f.responsibilityId + ': ' + JSON.stringify(f.config());
  assert.throws(
    () =>
      f.triage.configure({ ...f.control(literal), role: 'source' }, f.responsibilityId, f.config()),
    /accepted human/,
  );
});
test('configured scope suppresses legacy generic card alerts so quiet rules are respected without hiding direct delivery receipts', async (t) => {
  const f = profile(t);
  await f.enable();
  f.assistant.observe(f.snapshot());
  f.source.summary = 'A changed synthetic source finding';
  f.assistant.observe(f.snapshot());
  assert.equal(f.assistant.state.messages.filter((m) => m.kind === 'update').length, 0);
  assert.equal(f.triage.managedCard(f.snapshot().cards[0]), true);
});
test('corrupt and future notification journals preserve bytes and refuse to report saved or delivered', async (t) => {
  const f = profile(t);
  await f.enable();
  f.finding();
  await f.triage.pump();
  const good = fs.readFileSync(f.triage.file, 'utf8');
  for (const bad of ['{broken', JSON.stringify({ ...JSON.parse(good), version: 99 })]) {
    fs.writeFileSync(f.triage.file, bad);
    assert.throws(() => f.restart(), /original file is preserved/);
    assert.equal(fs.readFileSync(f.triage.file, 'utf8'), bad);
  }
  fs.writeFileSync(f.triage.file, good);
  f.restart();
});

test('reported source waiting on you is qualified and cannot escalate without the responsibility itself waiting for human input', async (t) => {
  const f = profile(t);
  await f.enable();
  f.finding({ state: 'blocked', status: 'failed', urgency: true });
  await f.triage.pump();
  const finding = f.triage.state.findings[0];
  assert.equal(finding.waitingOn, 'you');
  assert.equal(finding.signals.needs_user, false);
  assert.match(finding.text, /ownership remains unverified/);
  f.advance(3600000);
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries.length, 1);
});
test('an urgent-only condition also matches urgent findings that primarily need human review', async (t) => {
  const f = profile(t);
  await f.enable({ conditions: ['urgent'] });
  f.finding({ urgency: true });
  await f.triage.pump();
  assert.equal(f.triage.state.findings[0].kind, 'needs_user');
  assert.equal(f.triage.state.deliveries[0].status, 'accepted');
});
test('returning to an earlier finding supersedes a prepared intermediate alert and never delivers its stale payload', async (t) => {
  const f = profile(t);
  await f.enable();
  f.finding();
  f.triage.observe(f.snapshot());
  const a = f.triage.state.deliveries[0];
  f.advance(60001);
  f.finding({ state: 'blocked', status: 'failed' });
  f.triage.observe(f.snapshot());
  const b = f.triage.state.deliveries[1];
  assert.ok(b);
  f.finding();
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries.find((d) => d.id === a.id).status, 'accepted');
  assert.equal(f.triage.state.deliveries.find((d) => d.id === b.id).status, 'not_sent');
  assert.equal(
    readStore(f.assistant.file).value.messages.some((m) => m.id === b.id),
    false,
  );
  assert.equal(f.triage.state.findings.at(-1).hash, a.findingHash);
});
test('important-only opt-out after preparing a routine update holds it until explicit preference permits routine delivery', async (t) => {
  const f = profile(t);
  await f.enable({ routineUpdates: 'changes' });
  f.triage.observe(f.snapshot());
  const d = f.triage.state.deliveries[0];
  f.commitments.preference(
    f.control('/preference notifications important_only'),
    'notifications',
    'important_only',
  );
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries[0].status, 'prepared');
  assert.equal(
    readStore(f.assistant.file).value.messages.some((m) => m.id === d.id),
    false,
  );
  f.commitments.preference(f.control('/preference notifications all'), 'notifications', 'all');
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries[0].status, 'accepted');
});
test('explicit pause and restart keep a notification held until a current human resumes the same scope', async (t) => {
  const f = profile(t),
    e = await f.enable();
  f.finding();
  f.triage.observe(f.snapshot());
  await f.ask('/notice pause ' + e.notificationRuleId);
  f.restart();
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries[0].status, 'unknown');
  await f.ask('/notice resume ' + e.notificationRuleId);
  await f.triage.pump();
  assert.equal(f.triage.state.deliveries[0].status, 'unknown');
  assert.equal(f.triage.state.decisions.at(-1).reason, 'delivery_unconfirmed_no_resend');
});
