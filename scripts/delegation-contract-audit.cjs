'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict'),
  { execFileSync } = require('node:child_process');
const { fixture } = require('../tests/fixtures/delegation-profile.cjs'),
  { atomicJSON } = require('../src/private-store.cjs');
async function audit() {
  const root = path.resolve(__dirname, '..'),
    reportFile = path.join(root, 'artifacts/delegation-audit/verification.json');
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
    throw new Error('Delegation audit requires clean source');
  const f = fixture(),
    nonces = [crypto.randomBytes(16).toString('hex'), crypto.randomBytes(16).toString('hex')],
    workers = [],
    resultHashes = [];
  try {
    const first = await f.start(
        'Prepare the first owned synthetic artifact with its nonce and verified flag.',
      ),
      second = await f.start(
        'Prepare the second owned synthetic artifact with its nonce and verified flag.',
        f.sources[1],
      );
    assert.equal(first.status, 'completed', first.answer);
    assert.equal(second.status, 'completed', second.answer);
    const children = [first, second].map((m) => f.delegations.entry(m.delegationId));
    assert.equal(children[0].parentId, children[1].parentId);
    assert.notEqual(children[0].workspaceKey, children[1].workspaceKey);
    assert.equal(f.calls, 0);
    f.restart();
    assert.deepEqual(f.delegations.snapshot(), children);
    assert.equal(
      (await f.start('Concurrent writer must be refused', f.sources[0])).status,
      'failed',
    );
    f.client.run = ({ thread, text }) => {
      const i = children.findIndex((e) => e.scope.sourceId === thread);
      assert.ok(i >= 0);
      assert.equal(text, children[i].instruction);
      assert.ok(!workers.includes(i));
      execFileSync(
        process.execPath,
        [path.join(root, 'tests/fixtures/delegation-worker.cjs'), f.directory, nonces[i]],
        { stdio: 'pipe', timeout: 10000 },
      );
      workers.push(i);
    };
    for (const [i, e] of children.entries()) {
      f.sources[i].lifecycle = 'completed';
      await f.messages.pump();
      f.observe();
      assert.equal(f.delegations.entry(e.id).phase, 'accepted');
      f.complete(e.id);
      assert.equal(f.delegations.entry(e.id).phase, 'completed_run');
      assert.equal(f.delegations.entry(e.id).review, null);
      assert.ok(f.delegations.entry(e.id).missingEvidence.length);
      assert.notEqual(f.responsibilities.entry(e.parentId).state, 'completed');
      const bytes = fs.readFileSync(path.join(f.directory, 'child-' + nonces[i] + '.json')),
        result = JSON.parse(bytes);
      assert.deepEqual(result, { schema: 1, nonce: nonces[i], verified: true });
      resultHashes.push(crypto.createHash('sha256').update(bytes).digest('hex'));
      const review = await f.ask(
        '/delegation verify ' +
          e.id +
          ': I independently read this owned result and checked its nonce, schema and verified flag.',
      );
      assert.equal(review.status, 'completed', review.answer);
      assert.equal(f.delegations.entry(e.id).review.kind, 'human_review');
      assert.equal(f.responsibilities.entry(e.childId).state, 'completed');
      assert.notEqual(f.responsibilities.entry(e.parentId).state, 'completed');
    }
    assert.equal(f.calls, 2);
    assert.equal(workers.length, 2);
    // Cancellation inherits the exact parent, leaving its other queue records alone.
    f.sources[0].lifecycle = 'working';
    const third = await f.start('Wait for the next human result review', f.sources[0]),
      pending = f.delegations.entry(third.delegationId);
    assert.equal(third.status, 'completed', third.answer);
    await f.ask('/responsibility cancel ' + pending.parentId);
    await f.delegations.tick();
    assert.equal(f.delegations.entry(pending.id).phase, 'cancelled');
    assert.equal(f.delegations.entry(pending.id).cancelRequested, true);
    assert.equal(f.calls, 2);
    const state = structuredClone(f.delegations.state),
      policy = structuredClone(f.policy.state);
    await f.ask(
      'Can you explain how specialist output, cancellation, permissions and parent verification behave?',
    );
    assert.deepEqual(f.delegations.state, state);
    assert.deepEqual(f.policy.state, policy);
    const report = {
      schema: 1,
      passed: true,
      synthetic: true,
      sourceRevision,
      sourceDirty,
      actualWorkerProcesses: workers.length,
      sourceDispatches: f.calls,
      resultSha256: resultHashes,
      distinctChildArtifactsIndependentlyRead: true,
      persistedContractsSurvivedRestart: true,
      exactChildBodiesAndDestinations: true,
      concurrentWriterRefused: true,
      childRunDidNotVerifyResultOrParent: true,
      humanChildReviewKeptParentGoalSeparate: true,
      parentCancellationCancelledOwnedUnsentChild: true,
      behaviorQuestionLeftPermissionsAndChildrenUnchanged: true,
      accountsUsed: 0,
      modelCalls: 0,
      installedAppChanged: false,
      limits:
        'Disposable local profiles and owned Node workers. Existing source transport is synthetic. Human-review fixtures are distinct from independent production executor verification. Admission deadlines do not limit accepted execution or charges; accepted cancellation requires source-owner handoff and matching proof. No physical input, account-reader, external delivery or tool-sandbox proof.',
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
