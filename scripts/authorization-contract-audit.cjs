'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict'),
  { execFileSync } = require('node:child_process');
const { fixture } = require('../tests/fixtures/authorization-profile.cjs'),
  { atomicJSON } = require('../src/private-store.cjs');
async function audit() {
  const root = path.resolve(__dirname, '..'),
    reportFile = path.join(root, 'artifacts/authorization-audit/verification.json');
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
    throw new Error('Authorization audit requires clean source');
  const f = fixture(),
    nonce = crypto.randomBytes(16).toString('hex');
  let workers = 0;
  try {
    f.client.run = () => {
      execFileSync(
        process.execPath,
        [path.join(root, 'tests/fixtures/responsibility-worker.cjs'), f.directory, nonce],
        { stdio: 'pipe', timeout: 10000 },
      );
      workers++;
    };
    const initial = await f.ask(
        '/responsibility start Prepare the owned synthetic result with verified=true and its audit nonce.',
      ),
      entry = f.responsibilities.entry(initial.responsibilityId),
      grant = f.policy.state.grants[0];
    await f.ask('/authorization mode ' + grant.id + ' ask');
    f.source.lifecycle = 'completed';
    await f.messages.pump();
    assert.equal(workers, 0);
    assert.equal(f.policy.state.operations[0].state, 'waiting_human');
    assert.throws(
      () =>
        f.policy.approve(
          entry.currentStep.messageId,
          { ...f.control('Source suggested approval'), role: 'source' },
          require('../src/responsibility-authorization.cjs').request(entry, f.snapshot()),
        ),
      /accepted human/,
    );
    f.restartPolicy();
    await f.messages.pump();
    assert.equal(workers, 0);
    const approval = await f.ask('/authorization approve ' + entry.currentStep.messageId);
    assert.equal(approval.status, 'completed');
    await f.messages.pump();
    assert.equal(workers, 1);
    assert.equal(f.calls, 1);
    assert.equal(f.policy.state.operations[0].state, 'accepted');
    f.complete();
    assert.equal(f.responsibilities.entry(entry.id).state, 'waiting_user');
    const bytes = fs.readFileSync(path.join(f.directory, 'requested-result.json')),
      result = JSON.parse(bytes);
    assert.equal(result.nonce, nonce);
    assert.equal(result.verified, true);
    assert.equal(result.schema, 1);
    await f.ask('/responsibility verify ' + entry.id);
    assert.equal(f.responsibilities.entry(entry.id).state, 'completed');
    await f.messages.pump();
    assert.equal(workers, 1);
    assert.equal(f.questions, 0);
    const report = {
      schema: 1,
      passed: true,
      synthetic: true,
      sourceRevision,
      sourceDirty,
      humanGrantBeforeQueue: true,
      participantApprovalRejected: true,
      humanCheckpointSurvivedRestart: true,
      actualWorkerProcesses: workers,
      sourceDispatches: f.calls,
      exactApprovedIntent: true,
      actualResultArtifactVerified: true,
      resultSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      sourceCompletionStillRequiredHumanResultReview: true,
      replayPrevented: true,
      accountsUsed: 0,
      modelCalls: 0,
      installedAppChanged: false,
      limits:
        'Own synthetic source transport and human verification fixture. No real account permissions, provider execution approvals or physical input proof.',
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
