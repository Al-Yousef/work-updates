'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict'),
  { execFileSync } = require('node:child_process');
const { fixture } = require('../tests/fixtures/activity-profile.cjs'),
  { reader } = require('../src/research-reader.cjs'),
  { atomicJSON, readStore } = require('../src/private-store.cjs');
async function audit() {
  const root = path.resolve(__dirname, '..'),
    output = path.join(root, 'artifacts/activity-audit'),
    reportFile = path.join(output, 'verification.json');
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
    throw new Error('Activity audit requires clean source');
  const f = fixture(),
    home = path.join(f.directory, 'owned-original-store'),
    nonce = crypto.randomBytes(16).toString('hex');
  let actual;
  try {
    const python =
      process.env.WORK_UPDATES_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    fs.mkdirSync(home);
    const rollout = path.join(home, f.source.id + '.jsonl'),
      stamp = new Date(f.now - 10000).toISOString();
    fs.writeFileSync(
      rollout,
      JSON.stringify({
        timestamp: stamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Synthetic original request: verify the result before calling it complete.',
            },
          ],
        },
      }) + '\n',
    );
    execFileSync(
      python,
      [
        '-X',
        'utf8',
        '-c',
        "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE threads (id TEXT, rollout_path TEXT, archived INTEGER, source TEXT, name TEXT, title TEXT, preview TEXT, cwd TEXT, updated_at INTEGER)'); c.execute('INSERT INTO threads VALUES (?,?,0,?,?,?,?,?,?)',(sys.argv[2],sys.argv[3],'appServer','Synthetic collector fixture','Synthetic collector fixture','','',int(sys.argv[4]))); c.commit(); c.close()",
        path.join(home, 'state_5.sqlite'),
        f.source.id,
        rollout,
        String(Math.floor(f.now / 1000)),
      ],
      { windowsHide: true, timeout: 10000 },
    );
    actual = reader({ codexHome: home, python });
    f.research.options.reader = f.activity.reader(actual, f.research);
    const enabled = await f.enableResearch();
    assert.equal(enabled.status, 'completed', enabled.error || enabled.answer);
    const originalBytes = fs.readFileSync(rollout),
      dbBytes = fs.readFileSync(path.join(home, 'state_5.sqlite'));
    await f.research.read(enabled.researchId, { manual: true });
    assert.equal(
      f.research.entry(enabled.researchId).scans.at(-1).status,
      'bounded_original_records',
    );
    assert.deepEqual(fs.readFileSync(rollout), originalBytes);
    assert.deepEqual(fs.readFileSync(path.join(home, 'state_5.sqlite')), dbBytes);
    const r = f.responsibilities.entry(f.responsibilityId);
    const dispatch = f.activity.dispatch(async (mode, input) => {
      execFileSync(
        process.execPath,
        [path.join(root, 'tests/fixtures/responsibility-worker.cjs'), f.directory, nonce],
        { windowsHide: true, timeout: 10000 },
      );
      return {
        messageId: input.messageId,
        sourceId: input.sourceId,
        ownerId: r.scope.ownerId,
        delivery: 'sent',
        turnId: 'synthetic-activity-worker-turn',
      };
    }, f.responsibilities);
    await dispatch('queue', {
      id: r.scope.id,
      sourceId: r.scope.sourceId,
      taskKey: r.scope.taskKey,
      messageId: r.currentStep.messageId,
      text: r.currentStep.text,
    });
    const artifact = fs.readFileSync(path.join(f.directory, 'requested-result.json'));
    assert.equal(JSON.parse(artifact).nonce, nonce);
    assert.equal(JSON.parse(artifact).verified, true);
    await f.enable();
    f.finding();
    const deliver = f.destination.deliver;
    f.destination.deliver = async (d) => {
      await deliver(d);
      return null;
    };
    await f.triage.pump();
    f.restart();
    await f.triage.pump();
    assert.equal(f.triage.state.deliveries[0].reason, 'destination_receipt_recovered');
    f.activity.capture({ ...f.stores, triage: f.triage });
    const producer = JSON.parse(
      execFileSync(
        python,
        [
          '-X',
          'utf8',
          '-c',
          "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('collector',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.collect({'codexHome':sys.argv[2],'_requestedIds':[sys.argv[3]]})['activityAccess']))",
          path.join(root, 'bridge/collector.py'),
          home,
          f.source.id,
        ],
        { windowsHide: true, timeout: 10000, encoding: 'utf8' },
      ),
    );
    f.activity.collector(producer);
    const timeline = f.activity.query({ limit: 100 });
    assert.equal(timeline.counts.checkingSessionsStarted, 2);
    assert.equal(timeline.counts.sourceReadAttemptsStarted, 3);
    assert.equal(timeline.counts.workerStepsObserved, 1);
    assert.equal(timeline.counts.notificationIntentsObserved, 1);
    assert.ok(
      timeline.events.some((e) => e.links.sourceRecordId && e.coverage.acceptedForResearch),
    );
    assert.ok(
      timeline.events.some(
        (e) => e.type === 'worker_run' && e.timing === 'instrumented' && e.phase === 'returned',
      ),
    );
    assert.ok(
      timeline.events.some((e) => e.type === 'notification' && e.evidence === 'inbox_stored'),
    );
    const receipt = f.activity.export(
        f.control('/activity export: {"redacted":true,"filters":{"synthetic":true}}'),
        { synthetic: true },
      ),
      bytes = fs.readFileSync(receipt.file),
      redacted = JSON.parse(bytes);
    assert.equal(redacted.redacted, true);
    assert.equal(redacted.synthetic, true);
    assert.equal(bytes.includes(Buffer.from(f.source.id)), false);
    assert.equal(bytes.includes(Buffer.from(f.directory)), false);
    assert.equal(bytes.includes(Buffer.from('Synthetic original request')), false);
    assert.deepEqual(readStore(f.activity.file).value, f.activity.state);
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'synthetic-export.json'), bytes);
    const report = {
      schema: 1,
      passed: true,
      synthetic: true,
      sourceRevision,
      sourceDirty,
      actualScopedReaderProcesses: 1,
      actualCollectorProcesses: 1,
      localCollectorBatchesRecordedWithoutContent: true,
      actualOwnedWorkerProcesses: 1,
      correlatedReadWorkerFindingAndNotification: true,
      distinctRetainedCountSemantics: true,
      actualInboxReceiptRecovered: true,
      redactedExportReadBackVerified: true,
      userInspection: 'pending',
      accountsUsed: 0,
      modelCalls: 0,
      installedAppChanged: false,
      resultSha256: crypto.createHash('sha256').update(artifact).digest('hex'),
      limits:
        'Owned original records, worker and inbox. Source transport and task transitions are synthetic; local provider-call times do not establish remote task runtime. Bounded recorded scope and prior-history gaps remain explicit. User inspection, platform and integrated acceptance are separate.',
    };
    atomicJSON(reportFile, report);
    console.log(JSON.stringify(report));
    return report;
  } finally {
    actual?.close();
    f.close();
  }
}
if (require.main === module)
  audit().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
module.exports = { audit };
