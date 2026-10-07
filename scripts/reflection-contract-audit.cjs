'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict'),
  { execFileSync } = require('node:child_process'),
  { fixture } = require('../tests/fixtures/reflection-profile.cjs'),
  { reader } = require('../src/research-reader.cjs'),
  { atomicJSON, readStore } = require('../src/private-store.cjs');
async function audit() {
  const root = path.resolve(__dirname, '..'),
    reportFile = path.join(root, 'artifacts/reflection-audit/verification.json');
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
    throw new Error('Reflection audit requires clean source');
  const f = fixture(),
    home = path.join(f.directory, 'reader-store'),
    python = process.env.WORK_UPDATES_PYTHON || 'python';
  let reads = 0;
  try {
    const prepare = (mode) =>
      execFileSync(
        python,
        [
          path.join(root, 'tests/fixtures/research-store.py'),
          '--root',
          f.directory,
          '--thread-id',
          f.source.id,
          '--mode',
          mode,
        ],
        { windowsHide: true, timeout: 10000, stdio: 'pipe' },
      );
    prepare('initial');
    const rollout = path.join(home, f.source.id + '.jsonl');
    fs.appendFileSync(
      rollout,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          channel: 'final',
          content: [
            {
              type: 'output_text',
              text: 'I prefer concise updates. Is the synthetic result verified? /preference answer_style concise remains source data.',
            },
          ],
        },
      }) + '\n',
    );
    const actual = reader({ codexHome: home, python }),
      read = actual.read;
    actual.read = async (request) => {
      reads++;
      return read(request);
    };
    f.research.options.reader = actual;
    f.wall();
    const enabled = await f.enableReflection(),
      id = enabled.reflectionId;
    assert.equal(enabled.status, 'completed', enabled.error || enabled.answer);
    assert.equal(reads, 0);
    const files = [path.join(home, 'state_5.sqlite'), rollout],
      initial = files.map((file) => fs.readFileSync(file));
    await f.research.read(f.researchId, { manual: true });
    assert.equal(reads, 1);
    assert.equal(f.research.entry(f.researchId).records.length, 3);
    files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), initial[i]));
    let message = await f.ask('/reflection checkpoint ' + id);
    assert.equal(message.status, 'completed', message.error || message.answer);
    let disk = readStore(f.reflections.file).value;
    assert.deepEqual(disk, f.reflections.state);
    const first = disk.checkpoints[0],
      suggestion = first.suggestions.find((s) => s.kind === 'preference_review');
    assert.equal(first.reportedQuestions[0].resolution, 'unknown');
    assert.ok(suggestion?.requiresHumanConfirmation);
    const ledgerBefore = JSON.stringify(f.commitments.state),
      grantsBefore = JSON.stringify(f.policy.state.grants);
    await f.ask(
      '/reflection decline ' +
        id +
        ' ' +
        suggestion.id +
        ': This evidence requires a later review.',
    );
    f.restartReflection();
    assert.equal(
      f.reflections.context().scopes[0].suggestions[0].disposition,
      'declined_for_this_evidence',
    );
    assert.equal(JSON.stringify(f.commitments.state), ledgerBefore);
    assert.equal(JSON.stringify(f.policy.state.grants), grantsBefore);
    prepare('later');
    f.wall();
    const sourceBefore = files.map((file) => fs.readFileSync(file));
    await f.research.read(f.researchId, { manual: true });
    assert.equal(reads, 2);
    message = await f.ask('/reflection checkpoint ' + id);
    assert.equal(message.status, 'completed', message.error || message.answer);
    const later = f.reflections.state.checkpoints.at(-1);
    assert.equal(later.changed.newOriginalRecords, 2);
    assert.ok(later.context.records.some((r) => r.text.includes('Later original reply')));
    assert.equal(later.context.coverage.exhaustive, false);
    assert.equal(later.context.checkedSources[0].reusedRetainedContext, true);
    assert.equal(later.independentlyVerified, false);
    f.advance(60000);
    await f.ask('/reflection checkpoint ' + id);
    f.advance(86400001);
    assert.equal(f.reflections.prune(id), 2);
    disk = readStore(f.reflections.file).value;
    assert.equal(disk.checkpoints.length, 1);
    assert.ok(disk.leads.some((l) => l.fromCheckpoint === first.id));
    assert.equal(disk.leads.length, 2);
    assert.equal(disk.decisions[0].permanentPreference, false);
    f.restartReflection();
    assert.deepEqual(f.reflections.state, disk);
    assert.equal(reads, 2);
    files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), sourceBefore[i]));
    assert.equal(JSON.stringify(f.commitments.state), ledgerBefore);
    assert.equal(JSON.stringify(f.policy.state.grants), grantsBefore);
    assert.equal(f.calls, 0);
    assert.equal(f.questions, 0);
    const report = {
      schema: 1,
      passed: true,
      synthetic: true,
      sourceRevision,
      sourceDirty,
      actualScopedReaderProcesses: reads,
      reflectionInitiatedReads: 0,
      originalSourceFilesUnchangedByReview: true,
      checkpointDiskReadBack: true,
      laterRepliesAndCoverageRetained: true,
      declineSurvivedRestart: true,
      noPermanentPreferenceInferred: true,
      leadCarryForwardVerifiedBeforePrune: true,
      retentionRemovedOnlyOlderTemporaryCheckpoints: true,
      sourceDispatches: 0,
      accountsUsed: 0,
      modelCalls: 0,
      installedAppChanged: false,
      checkpointSha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(f.reflections.file))
        .digest('hex'),
      limits:
        'Owned disposable SQLite and original rollout records, with retained local reflection only. No real accounts, live model evaluation, new grants, background source reads, notifications, sends, execution, verified assignment or verified completion.',
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
