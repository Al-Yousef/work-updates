'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Commands come from the reviewed matrix, never from an account or source message.
// Only the process created by this invocation can be terminated on interruption.
function execute(command, { cwd, directory, timeoutMs, signal, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    throw new Error('Invalid bounded case timeout');
  if (signal?.aborted)
    return Promise.resolve({ status: 'interrupted', started: false, cleanup: 'not_started' });
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString(),
      started = performance.now();
    const stdoutFile = path.join(directory, 'stdout.txt'),
      stderrFile = path.join(directory, 'stderr.txt');
    const stdout = fs.openSync(stdoutFile, 'wx', 0o600),
      stderr = fs.openSync(stderrFile, 'wx', 0o600);
    let child,
      timer,
      killTimer,
      failure = null,
      cleanup = 'normal_exit',
      bytes = 0,
      finished = false,
      stopping = false;
    const finish = (exitCode, terminationSignal, exitObserved = true) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      fs.closeSync(stdout);
      fs.closeSync(stderr);
      resolve({
        status: failure || (exitCode === 0 ? 'passed' : 'failed'),
        started: !!child?.pid,
        processId: child?.pid || null,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
        exitCode,
        terminationSignal,
        exitObserved,
        cleanup,
        logs: [
          { file: 'stdout.txt', sha256: hash(stdoutFile) },
          { file: 'stderr.txt', sha256: hash(stderrFile) },
        ],
      });
    };
    const stop = (reason) => {
      failure ||= reason;
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
      if (stopping) return;
      stopping = true;
      cleanup = 'forced_owned_tree';
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => {
          cleanup = 'unverified';
          child.kill();
        });
        killer.on('exit', (code) => {
          if (code !== 0) {
            // Direct termination uses the handle of our own child. Descendant
            // cleanup remains unverified when Windows tree enumeration fails.
            cleanup = 'unverified';
            child.kill();
          }
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (e) {
          if (e.code !== 'ESRCH') cleanup = 'unverified';
        }
      }
      killTimer ||= setTimeout(() => {
        cleanup = 'unverified';
        child.kill();
        finish(null, null, false);
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }, 10000);
    };
    const abort = () => stop('interrupted');
    try {
      child = spawn(command.file, command.args, {
        cwd,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      failure = 'launch_failed';
      cleanup = 'not_started';
      finish(null, null);
      return;
    }
    const capture = (fd) => (chunk) => {
      if (finished) return;
      const room = Math.max(0, maxBytes - bytes);
      try {
        fs.writeSync(fd, chunk.subarray(0, room));
      } catch {
        stop('storage_failed');
        return;
      }
      bytes += chunk.length;
      if (bytes > maxBytes) stop('output_limit');
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.on('error', () => {
      failure ||= 'launch_failed';
      cleanup = child.pid ? 'unverified' : 'not_started';
    });
    child.on('close', finish);
    timer = setTimeout(() => stop('timed_out'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function matrix(root, lane) {
  if (lane === 'isolated')
    return [
      {
        id: 'node-contracts',
        evidence: 'isolated_backend_contracts',
        file: process.execPath,
        args: ['--test', 'tests/*.test.cjs'],
        timeoutMs: 180000,
      },
      {
        id: 'python-reader-collector',
        evidence: 'owned_original_record_fixtures',
        file: process.env.WORK_UPDATES_PYTHON || 'python',
        args: ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'],
        timeoutMs: 60000,
      },
      {
        id: 'privacy',
        evidence: 'tracked_source_allowlist',
        file: process.execPath,
        args: ['scripts/audit-release.cjs'],
        timeoutMs: 30000,
      },
    ];
  if (lane === 'simulated') {
    const ps = (id, script, args = [], timeoutMs = 180000) => ({
      id,
      evidence: 'simulated_owned_native_controls',
      file: 'pwsh',
      args: ['-NoProfile', '-File', 'native/windows/scripts/' + script, ...args],
      timeoutMs,
    });
    return [
      {
        id: 'adapter',
        evidence: 'isolated_adapter_and_simulated_panel',
        file: path.join(root, 'native/windows/build/candidate/native-adapter-tests.exe'),
        args: [],
        timeoutMs: 60000,
      },
      ps('queue', 'queue-audit.ps1'),
      ps('composer-scales', 'ux-audit.ps1'),
      ps('responsiveness', 'responsiveness-audit.ps1', ['-Mode', 'final']),
      ps('status-scales', 'status-audit.ps1'),
    ];
  }
  if (lane === 'physical' || lane === 'codex') return [];
  throw new Error('Unknown QA lane');
}

async function run({
  root,
  directory,
  lanes,
  revision,
  signal,
  verifyCandidate,
  executeCase = execute,
}) {
  if (
    !Array.isArray(lanes) ||
    !lanes.length ||
    new Set(lanes).size !== lanes.length ||
    lanes.some((l) => !['isolated', 'simulated', 'physical', 'codex'].includes(l))
  )
    throw new Error('Select distinct reviewed QA lanes');
  fs.mkdirSync(directory, { recursive: false });
  const report = {
    schema: 1,
    sourceRevision: revision,
    version: require(path.join(root, 'package.json')).version,
    capturedAt: new Date().toISOString(),
    passed: false,
    integratedAcceptance: false,
    accountsUsed: 0,
    modelCalls: 0,
    installedAppChanged: false,
    lanes: [],
  };
  const save = () =>
    fs.writeFileSync(
      path.join(directory, 'verification.json'),
      JSON.stringify(report, null, 2) + '\n',
      { mode: 0o600 },
    );
  save();
  let executionUncertain = false;
  for (const lane of lanes) {
    const result = { lane, status: 'pending', cases: [] };
    report.lanes.push(result);
    save();
    if (executionUncertain) {
      result.status = 'blocked';
      result.reason = 'prior_case_cleanup_unverified';
      save();
      continue;
    }
    if (signal?.aborted) {
      result.status = 'interrupted';
      save();
      continue;
    }
    if (['physical', 'codex'].includes(lane)) {
      result.status = 'unsupported';
      result.reason =
        lane === 'physical'
          ? 'physical_scenario_driver_pending_prerequisites_6_7'
          : 'separate_authorized_disposable_account_driver_required';
      save();
      continue;
    }
    if (lane === 'simulated') {
      try {
        const candidate = verifyCandidate();
        if (candidate.dirty !== false || candidate.revision !== revision)
          throw new Error('Changed candidate');
        result.candidate = { revision: candidate.revision, binaryHashes: candidate.binaryHashes };
      } catch {
        result.status = 'blocked';
        result.reason = 'fresh_clean_native_candidate_required';
        save();
        continue;
      }
    }
    for (const spec of matrix(root, lane)) {
      if (signal?.aborted) {
        result.status = 'interrupted';
        break;
      }
      const caseDirectory = path.join(directory, spec.id);
      fs.mkdirSync(caseDirectory);
      const started = { id: spec.id, evidence: spec.evidence, status: 'running' };
      result.cases.push(started);
      save();
      const observed = await executeCase(
        { file: spec.file, args: spec.args },
        { cwd: root, directory: caseDirectory, timeoutMs: spec.timeoutMs, signal },
      );
      Object.assign(started, observed);
      save();
      // No automatic retry or input replay after failed or uncertain execution.
      if (
        observed.status !== 'passed' ||
        observed.cleanup !== 'normal_exit' ||
        observed.exitObserved !== true
      ) {
        result.status = observed.status === 'passed' ? 'failed' : observed.status;
        executionUncertain = observed.exitObserved !== true || observed.cleanup === 'unverified';
        break;
      }
    }
    if (result.status === 'pending')
      result.status =
        result.cases.length &&
        result.cases.every(
          (c) => c.status === 'passed' && c.cleanup === 'normal_exit' && c.exitObserved === true,
        )
          ? 'passed'
          : 'failed';
    save();
  }
  report.passed = report.lanes.every((l) => l.status === 'passed');
  save();
  return report;
}
module.exports = { matrix, execute, run };
