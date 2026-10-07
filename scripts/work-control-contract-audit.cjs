'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict'),
  { spawn, execFileSync } = require('node:child_process');
const { fixture } = require('../tests/fixtures/work-control-profile.cjs'),
  { atomicJSON } = require('../src/private-store.cjs');
async function audit() {
  const root = path.resolve(__dirname, '..'),
    file = path.join(root, 'artifacts/work-control-audit/verification.json');
  fs.rmSync(file, { force: true });
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    sourceDirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  if (process.argv.includes('--require-clean') && sourceDirty)
    throw new Error('Work audit requires clean source');
  const f = fixture(),
    nonce = crypto.randomBytes(16).toString('hex');
  let worker, ready, exited;
  try {
    const parent = await f.parent();
    f.sources[0].lifecycle = 'completed';
    const child = await f.start(
        'Perform the owned stoppable synthetic task and await its exact stop control.',
      ),
      e = f.delegations.entry(child.delegationId);
    assert.equal(child.status, 'completed', child.answer);
    f.client.run = ({ thread, text }) => {
      assert.equal(thread, e.scope.sourceId);
      assert.equal(text, e.instruction);
      assert.equal(worker, undefined);
      worker = spawn(
        process.execPath,
        [path.join(root, 'tests/fixtures/stoppable-worker.cjs'), f.directory, nonce],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      ready = new Promise((resolve, reject) => {
        let output = '';
        worker.stdout.on('data', (chunk) => {
          output += chunk;
          if (output.length > 256)
            return reject(new Error('Owned worker output exceeded its bound'));
          if (output.endsWith('\n')) {
            try {
              assert.deepEqual(JSON.parse(output), { ready: true, nonce });
              resolve();
            } catch (error) {
              reject(error);
            }
          }
        });
        worker.once('error', reject);
      });
      exited = new Promise((resolve, reject) => {
        worker.once('exit', (code, signal) =>
          code === 0 && !signal ? resolve() : reject(new Error('Owned worker failed')),
        );
        worker.once('error', reject);
      });
      // Keep both rejections handled even if admission fails before waiting.
      ready.catch(() => {});
      exited.catch(() => {});
    };
    await f.messages.pump();
    f.observe();
    await ready;
    assert.equal(f.delegations.entry(e.id).phase, 'accepted');
    const paused = await f.ask('/work pause-main ' + parent);
    assert.equal(paused.status, 'completed', paused.answer);
    assert.equal(f.calls, 1);
    f.client.onInterrupt = async ({ sourceId, turnId }) => {
      assert.equal(sourceId, e.scope.sourceId);
      assert.equal(turnId, f.delegations.child(f.delegations.entry(e.id)).currentStep.turnId);
      worker.stdin.write(JSON.stringify({ stop: nonce }) + '\n');
      await exited;
    };
    const stopped = await f.ask('/work stop-child ' + e.id);
    assert.equal(stopped.status, 'completed', stopped.answer);
    assert.equal(f.interrupts, 1);
    assert.equal(
      f.controls.action(stopped.workControlId).resources[0].status,
      'interrupt_requested',
    );
    const bytes = fs.readFileSync(path.join(f.directory, 'stopped-' + nonce + '.json'));
    assert.deepEqual(JSON.parse(bytes), {
      schema: 1,
      nonce,
      terminal: 'interrupted',
      requestedWorkFinished: false,
    });
    f.complete(e.id, 'interrupted');
    f.controls.reconcile();
    assert.equal(
      f.controls.action(stopped.workControlId).resources[0].status,
      'terminal_interrupted',
    );
    assert.equal(f.delegations.entry(e.id).leaseHeld, false);
    f.restartControls();
    assert.equal(f.interrupts, 1);
    assert.equal(f.controls.active('main', parent).active, true);
    assert.equal(f.controls.active('child', e.id).active, true);
    const resumed = await f.ask('/work resume-main ' + parent);
    assert.equal(resumed.status, 'completed', resumed.answer);
    assert.equal(f.calls, 1);
    assert.notEqual(f.responsibilities.entry(parent).state, 'completed');
    const all = await f.ask('/work stop-all');
    assert.equal(all.status, 'completed', all.answer);
    assert.equal(f.controls.active('all', 'all').active, true);
    assert.equal(f.responsibilities.entry(parent).currentStep.status, 'cancelled');
    const before = JSON.stringify(f.policy.state);
    await f.ask('What work has already committed and what is still paused?');
    assert.equal(JSON.stringify(f.policy.state), before);
    const report = {
      schema: 1,
      passed: true,
      synthetic: true,
      sourceRevision,
      sourceDirty,
      actualOwnedWorkerProcesses: 1,
      sourceDispatches: f.calls,
      ownedTurnInterruptRequests: f.interrupts,
      workerExitAndTerminalArtifactIndependentlyVerified: true,
      resultSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      acknowledgementDistinctFromTerminal: true,
      pauseAndChildFenceSurvivedRestart: true,
      verifiedResumeDidNotResend: true,
      parentGoalNotCompletedByChildStop: true,
      stopAllCancelledUnsentWork: true,
      accountsUsed: 0,
      modelCalls: 0,
      installedAppChanged: false,
      limits:
        'Own disposable Node worker and production local contracts. Source transport and terminal event are synthetic; the independently read artifact verifies the owned worker stopped without finishing its work. No production account interrupt, foreign-process stop, physical input, external side-effect rollback or new executor capability is claimed.',
    };
    atomicJSON(file, report);
    console.log(JSON.stringify(report));
    return report;
  } finally {
    // Only the spawned owned worker may be terminated on failed cleanup.
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      worker.kill();
      await exited?.catch(() => {});
    }
    f.close();
  }
}
if (require.main === module)
  audit().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
module.exports = { audit };
