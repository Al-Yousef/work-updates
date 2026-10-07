'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict'),
  { execFileSync } = require('node:child_process'),
  { fixture } = require('../tests/fixtures/triage-profile.cjs'),
  { readStore, atomicJSON } = require('../src/private-store.cjs');
async function audit() {
  const root = path.resolve(__dirname, '..'),
    reportFile = path.join(root, 'artifacts/triage-audit/verification.json');
  fs.rmSync(reportFile, { force: true });
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    sourceDirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  if (process.argv.includes('--require-clean') && sourceDirty)
    throw new Error('Triage audit requires clean source');
  const f = fixture(),
    nonce = crypto.randomBytes(16).toString('hex');
  let deliveries = 0;
  try {
    const enabled = await f.enable();
    assert.equal(enabled.status, 'completed', enabled.error || enabled.answer);
    execFileSync(
      process.execPath,
      [path.join(root, 'tests/fixtures/responsibility-worker.cjs'), f.directory, nonce],
      { windowsHide: true, stdio: 'pipe', timeout: 10000 },
    );
    const artifact = fs.readFileSync(path.join(f.directory, 'requested-result.json')),
      result = JSON.parse(artifact);
    assert.equal(result.schema, 1);
    assert.equal(result.nonce, nonce);
    assert.equal(result.verified, true);
    // The transport/state transition is synthetic. The worker file and inbox
    // receipt are independently checked actual local artifacts.
    f.finding();
    const deliver = f.destination.deliver;
    f.destination.deliver = async (d) => {
      deliveries++;
      await deliver(d);
      return null;
    };
    await f.triage.pump();
    const intent = f.triage.state.deliveries[0];
    assert.equal(intent.status, 'unknown');
    const inbox = readStore(f.assistant.file).value.messages.find((m) => m.id === intent.id);
    assert.equal(inbox.answer, intent.payload.text);
    assert.equal(inbox.notification.payloadHash, intent.payloadHash);
    f.restart();
    await f.triage.pump();
    const recovered = f.triage.state.deliveries[0];
    assert.equal(recovered.status, 'accepted');
    assert.equal(recovered.receipt.kind, 'inbox_stored');
    assert.equal(recovered.receipt.synthetic, false);
    assert.equal(recovered.reason, 'destination_receipt_recovered');
    assert.equal(deliveries, 1);
    for (let i = 0; i < 5; i++) await f.triage.pump();
    assert.equal(deliveries, 1);
    await f.enable({ minIntervalSeconds: 120 });
    f.advance(120001);
    await f.triage.pump();
    assert.equal(deliveries, 1);
    const disk = readStore(f.triage.file).value;
    assert.deepEqual(disk, f.triage.state);
    assert.ok(disk.decisions.some((d) => d.decision === 'notify'));
    assert.ok(disk.decisions.some((d) => d.reason === 'unchanged_finding_already_delivered'));
    assert.equal(disk.findings[0].independentlyVerified, false);
    assert.equal(f.responsibilities.entry(f.responsibilityId).state, 'waiting_user');
    assert.equal(f.calls, 0);
    assert.equal(f.questions, 0);
    assert.equal(f.reads, 0);
    const report = {
      schema: 1,
      passed: true,
      synthetic: true,
      sourceRevision,
      sourceDirty,
      actualOwnedWorkerProcesses: 1,
      independentlyCheckedWorkerArtifact: true,
      actualLocalInboxWrites: deliveries,
      inboxReceiptReadBackVerified: true,
      lostReceiptRecoveredAfterRestart: true,
      unknownNeverAutomaticallyResent: true,
      configurationCannotClearDeliveryDeduplication: true,
      workerFindingNotificationDecisionAndGoalVerificationDistinct: true,
      accountsUsed: 0,
      modelCalls: 0,
      sourceDispatches: 0,
      originalReaderCalls: 0,
      actualSystemNotifications: 0,
      installedAppChanged: false,
      resultSha256: crypto.createHash('sha256').update(artifact).digest('hex'),
      limits:
        'Owned disposable worker and Hyphen assistant inbox; source transport is synthetic. Actual inbox storage is acceptance, not display or user reading. OS show events are separate labelled fixtures. No phone/email provider, account, live model inference or independent verification of a broader goal.',
    };
    atomicJSON(reportFile, report);
    console.log(JSON.stringify(report));
    return report;
  } finally {
    f.close();
  }
}
if (require.main === module)
  audit().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
module.exports = { audit };
