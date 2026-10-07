'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { fixture } = require('../tests/fixtures/authorization-profile.cjs');
const { OutcomeVerification } = require('../src/outcome-verification.cjs');
async function audit() {
  const root = path.resolve(__dirname, '..'),
    reportFile = path.join(root, 'artifacts/outcome-audit/verification.json');
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
    throw new Error('Outcome audit requires clean source');
  const f = fixture(),
    nonce = crypto.randomBytes(16).toString('hex');
  let store,
    workers = 0;
  try {
    store = new OutcomeVerification({
      directory: f.directory,
      actorId: 'fixture-human',
      responsibilities: f.responsibilities,
      snapshot: f.snapshot,
    });
    f.assistant.options.outcomes = store;
    f.responsibilities.options.outcomeRequired = (e) => store.required(e);
    f.responsibilities.options.outcomeAdmission = (e, h) => store.admission(e, h);
    f.client.run = () => {
      workers++;
      execFileSync(
        process.execPath,
        [path.join(root, 'tests/fixtures/responsibility-worker.cjs'), f.directory, nonce],
        { timeout: 10000, stdio: 'pipe' },
      );
    };
    const started = await f.ask('/responsibility start Save the owned synthetic result'),
      id = started.responsibilityId;
    assert.ok(id);
    assert.equal(f.calls, 0);
    const criterion = {
      kind: 'artifact',
      stage: 'saved',
      description: 'Save the exact nonce-bound synthetic result',
      target: 'synthetic-result',
      targetRevision: sourceRevision,
      maxAgeSeconds: 600,
      until: Date.now() + 3600000,
      root: fs.realpathSync.native(f.directory),
      file: 'requested-result.json',
      fields: { schema: 1, verified: true, nonce },
    };
    assert.equal(
      (await f.ask('/outcome require ' + id + ': ' + JSON.stringify(criterion))).status,
      'completed',
    );
    await f.ask('/outcome check ' + id);
    assert.equal(store.entry(id).result.status, 'missing');
    f.source.lifecycle = 'completed';
    await f.messages.pump();
    f.complete();
    assert.equal(workers, 1);
    assert.equal(f.responsibilities.entry(id).state, 'waiting_user');
    await f.ask('/outcome check ' + id);
    assert.equal(store.entry(id).result.status, 'verified');
    const artifact = fs.readFileSync(path.join(f.directory, 'requested-result.json')),
      artifactSha256 = crypto.createHash('sha256').update(artifact).digest('hex');
    assert.equal(store.entry(id).result.proof.sha256, artifactSha256);
    store.close();
    store = new OutcomeVerification(store.options);
    f.assistant.options.outcomes = store;
    assert.equal(store.entry(id).result.proof.sha256, artifactSha256);
    fs.writeFileSync(
      path.join(f.directory, 'requested-result.json'),
      JSON.stringify({ schema: 1, verified: true, nonce: 'wrong' }),
    );
    const refused = await f.ask('/responsibility verify ' + id);
    assert.equal(refused.status, 'failed');
    assert.equal(f.responsibilities.entry(id).state, 'waiting_user');
    fs.writeFileSync(path.join(f.directory, 'requested-result.json'), artifact);
    const complete = await f.ask('/responsibility verify ' + id);
    assert.equal(complete.status, 'completed', complete.error);
    assert.equal(f.responsibilities.entry(id).state, 'completed');
    const report = {
      schema: 1,
      passed: true,
      synthetic: true,
      sourceRevision,
      sourceDirty,
      actualOwnedWorkerProcesses: workers,
      actualArtifactSha256: artifactSha256,
      missingProofHeld: true,
      completedWorkerDidNotFinishGoal: true,
      artifactReplacementBlockedCompletion: true,
      restartRetainedOutcome: true,
      matchingSavedResultVerifiedBeforeHumanCompletion: true,
      sourceDispatches: f.calls,
      accountsUsed: 0,
      modelCalls: f.questions,
      installedAppChanged: false,
      limits:
        'Only an explicitly scoped saved JSON artifact from one owned worker; source transport is synthetic. This does not prove deployment, merge, external delivery, account coverage or physical input.',
    };
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify(report) + '\n');
  } finally {
    store?.close();
    f.close();
  }
}
audit().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
