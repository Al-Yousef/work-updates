'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict'),
  { execFileSync } = require('node:child_process');
const { fixture } = require('../tests/fixtures/commitment-profile.cjs'),
  { atomicJSON } = require('../src/private-store.cjs');
async function audit() {
  const root = path.resolve(__dirname, '..'),
    reportFile = path.join(root, 'artifacts/commitment-audit/verification.json');
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
    throw new Error('Commitment audit requires clean source');
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
    const created = await f.ask('/commitment add: Owned synthetic old-title-marker'),
      id = created.commitmentId;
    assert.equal(created.status, 'completed');
    assert.equal(JSON.parse(fs.readFileSync(f.store.file)).entries[0].id, id);
    const started = await f.ask(
        '/responsibility start Prepare the owned synthetic artifact with its nonce and verified=true.',
      ),
      rid = started.responsibilityId;
    const patch = {
      owner: 'Synthetic reviewer',
      status: 'running',
      deadline: { at: '2026-12-01T17:00:00Z', timeZone: 'America/Toronto' },
      blockers: ['Awaiting owned artifact'],
      responsibilityId: rid,
    };
    assert.equal(
      (await f.ask('/commitment correct ' + id + ': ' + JSON.stringify(patch))).status,
      'completed',
    );
    f.restartLedger();
    assert.equal(f.store.entry(id).owner, patch.owner);
    assert.deepEqual(f.store.entry(id).deadline, patch.deadline);
    f.source.lifecycle = 'completed';
    await f.messages.pump();
    assert.equal(workers, 1);
    assert.equal(f.calls, 1);
    f.complete();
    assert.equal(f.store.entry(id).status, 'running');
    assert.equal(f.responsibilities.entry(rid).state, 'waiting_user');
    const bytes = fs.readFileSync(path.join(f.directory, 'requested-result.json')),
      result = JSON.parse(bytes);
    assert.equal(result.nonce, nonce);
    assert.equal(result.verified, true);
    assert.equal(result.schema, 1);
    f.source.contextLoaded = true;
    f.source.conversationLoaded = true;
    f.source.body = 'Original synthetic request';
    f.source.conversation = [
      { role: 'user', text: 'Check the owned artifact against its nonce' },
      { role: 'assistant', text: 'Worker finished; human result review is pending' },
    ];
    assert.equal((await f.ask('/commitment source ' + id)).status, 'completed');
    const evidence = f.store.entry(id).evidence.at(-1);
    assert.equal(evidence.kind, 'source_record');
    assert.ok(evidence.text.includes('human result review is pending'));
    assert.equal(evidence.coverage.exhaustive, false);
    assert.equal(
      (
        await f.ask(
          '/commitment verify ' +
            id +
            ': I independently read the owned artifact and checked its nonce and verified flag.',
        )
      ).status,
      'completed',
    );
    assert.equal(f.store.entry(id).confidence, 'human_verified');
    await f.ask('/preference set research off');
    await f.ask('/preference set notifications off');
    const before = fs.readFileSync(f.store.file),
      policy = structuredClone(f.policy.state);
    await f.ask('How do you decide when to notify me, research, or obtain authorization?');
    assert.deepEqual(fs.readFileSync(f.store.file), before);
    assert.deepEqual(f.policy.state, policy);
    assert.equal(f.reads, 0);
    const newer = await f.ask(
      '/commitment supersede ' + id + ': Review the next owned synthetic result',
    );
    assert.equal(f.store.entry(id).supersededBy, newer.commitmentId);
    assert.equal((await f.ask('/commitment delete ' + id)).status, 'completed');
    assert.throws(() => f.store.entry(id), /deleted/);
    assert.equal(fs.readFileSync(f.store.file, 'utf8').includes('old-title-marker'), false);
    assert.equal(f.store.snapshot().length, 1);
    assert.equal(f.store.entry(newer.commitmentId).status, 'planned');
    const report = {
      schema: 1,
      passed: true,
      synthetic: true,
      sourceRevision,
      sourceDirty,
      actualWorkerProcesses: workers,
      sourceDispatches: f.calls,
      actualResultArtifactVerified: true,
      resultSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      diskWriteReadBack: true,
      correctionSurvivedRestart: true,
      sourceRecordsRetainLaterReplyAndCoverage: true,
      sourceCompletionDidNotCompleteCommitment: true,
      humanReviewLabelledSeparately: true,
      supersedingDecisionLinked: true,
      scopedDeletionRemovedLedgerText: true,
      behaviorQuestionLeftPreferencesAndAuthorizationUnchanged: true,
      newSourceDetailReadsWhileOff: 0,
      fixtureAnswers: 1,
      accountsUsed: 0,
      modelCalls: 0,
      installedAppChanged: false,
      limits:
        'Own synthetic source transport and disposable ledger. Human-review fixture is not independent production executor verification, physical input, account-reader or external delivery proof.',
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
