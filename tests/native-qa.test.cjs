'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { execute, run, matrix } = require('../scripts/native-qa-runner.cjs');
const root = path.resolve(__dirname, '..'),
  revision = 'a'.repeat(40);
function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-native-qa-contract-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('hyphen-native-qa-contract-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return directory;
}
test('a deliberate child failure retains evidence and cannot pass or start a later case', async (t) => {
  const directory = temp(t),
    reportDirectory = path.join(directory, 'run');
  let calls = 0;
  const report = await run({
    root,
    directory: reportDirectory,
    lanes: ['isolated'],
    revision,
    executeCase: async () => {
      calls++;
      return { status: 'failed', cleanup: 'normal_exit', exitObserved: true, exitCode: 17 };
    },
  });
  assert.equal(calls, 1);
  assert.equal(report.passed, false);
  assert.equal(report.integratedAcceptance, false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(reportDirectory, 'verification.json'))).lanes[0].cases[0]
      .exitCode,
    17,
  );
});
test('changed or missing native proof fails before any native process is started', async (t) => {
  for (const candidate of [
    null,
    { revision: 'b'.repeat(40), dirty: false },
    { revision, dirty: true },
  ]) {
    let calls = 0;
    const directory = path.join(temp(t), 'run');
    const report = await run({
      root,
      directory,
      lanes: ['simulated'],
      revision,
      verifyCandidate: () => candidate,
      executeCase: async () => {
        calls++;
      },
    });
    assert.equal(report.passed, false);
    assert.equal(report.lanes[0].status, 'blocked');
    assert.equal(calls, 0);
  }
});
test('physical input and live delivery cannot be inferred from passing simulated commands', async (t) => {
  const report = await run({
    root,
    directory: path.join(temp(t), 'run'),
    lanes: ['simulated', 'physical', 'codex'],
    revision,
    verifyCandidate: () => ({ revision, dirty: false, binaryHashes: {} }),
    executeCase: async () => ({ status: 'passed', cleanup: 'normal_exit', exitObserved: true }),
  });
  assert.deepEqual(
    report.lanes.map((l) => l.status),
    ['passed', 'unsupported', 'unsupported'],
  );
  assert.equal(report.passed, false);
  assert.equal(report.accountsUsed, 0);
  assert.equal(report.modelCalls, 0);
});
test('an interrupted run cannot launch a case or claim cleanup or success', async (t) => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const report = await run({
    root,
    directory: path.join(temp(t), 'run'),
    lanes: ['isolated'],
    revision,
    signal: controller.signal,
    executeCase: async () => {
      calls++;
    },
  });
  assert.equal(calls, 0);
  assert.equal(report.passed, false);
  assert.equal(report.lanes[0].status, 'interrupted');
});
test('matrix commands contain only existing reviewed local scripts and never a signed-in account audit', () => {
  assert.throws(() => matrix(root, 'unreviewed'));
  const cases = matrix(root, 'isolated').concat(matrix(root, 'simulated'));
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  assert.ok(cases.every((c) => c.timeoutMs <= 300000));
  assert.ok(cases.every((c) => !JSON.stringify(c).includes('live-audit')));
  for (const spec of cases.filter((c) => c.file === 'pwsh'))
    assert.ok(fs.existsSync(path.join(root, spec.args[2])));
});
test('actual owned child exit and bounded stdout are independently retained', async (t) => {
  const directory = temp(t);
  const result = await execute(
    {
      file: process.execPath,
      args: ['-e', 'process.stdout.write("fixture-only"); process.exitCode=7'],
    },
    { cwd: root, directory, timeoutMs: 5000 },
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 7);
  assert.equal(result.cleanup, 'normal_exit');
  assert.equal(fs.readFileSync(path.join(directory, 'stdout.txt'), 'utf8'), 'fixture-only');
  assert.match(result.logs[0].sha256, /^[a-f0-9]{64}$/);
});
test('actual owned child timeout performs cleanup and always fails the lane', async (t) => {
  const result = await execute(
    {
      file: process.execPath,
      args: ['-e', 'setTimeout(()=>process.exit(29),5000);setInterval(()=>{},1000)'],
    },
    { cwd: root, directory: temp(t), timeoutMs: 300 },
  );
  assert.equal(result.status, 'timed_out');
  assert.equal(result.exitObserved, true);
  assert.notEqual(
    result.exitCode,
    29,
    'The observed exit must precede the child self-cleanup guard',
  );
  assert.ok(Number.isFinite(result.stopDurationMs));
  assert.ok(
    result.stopDurationMs < 10000,
    'Owned termination must finish within its enforced cleanup deadline',
  );
  assert.notEqual(result.cleanup, 'normal_exit');
  assert.ok(result.durationMs < 11000);
});
test('actual owned child interruption cannot be accepted as successful shutdown', async (t) => {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 300);
  try {
    const result = await execute(
      {
        file: process.execPath,
        args: ['-e', 'setTimeout(()=>process.exit(29),5000);setInterval(()=>{},1000)'],
      },
      { cwd: root, directory: temp(t), timeoutMs: 5000, signal: controller.signal },
    );
    assert.equal(result.status, 'interrupted');
    assert.equal(result.exitObserved, true);
    assert.notEqual(
      result.exitCode,
      29,
      'The observed exit must precede the child self-cleanup guard',
    );
    assert.ok(Number.isFinite(result.stopDurationMs));
    assert.ok(
      result.stopDurationMs < 10000,
      'Owned termination must finish within its enforced cleanup deadline',
    );
    assert.notEqual(result.cleanup, 'normal_exit');
  } finally {
    clearTimeout(timer);
  }
});
test('stdout overflow remains a failure with bounded retained output', async (t) => {
  const directory = temp(t),
    result = await execute(
      {
        file: process.execPath,
        args: [
          '-e',
          'process.stdout.write("x".repeat(100000));setTimeout(()=>process.exit(29),5000);setInterval(()=>{},1000)',
        ],
      },
      { cwd: root, directory, timeoutMs: 5000, maxBytes: 256 },
    );
  assert.equal(result.status, 'output_limit');
  assert.equal(result.exitObserved, true);
  assert.notEqual(
    result.exitCode,
    29,
    'The observed exit must precede the child self-cleanup guard',
  );
  assert.ok(Number.isFinite(result.stopDurationMs));
  assert.ok(
    result.stopDurationMs < 10000,
    'Owned termination must finish within its enforced cleanup deadline',
  );
  assert.ok(fs.statSync(path.join(directory, 'stdout.txt')).size <= 256);
});
test('a missing executable fails with original evidence instead of falling back to another installation', async (t) => {
  const result = await execute(
    { file: path.join(temp(t), 'missing-command'), args: [] },
    { cwd: root, directory: temp(t), timeoutMs: 1000 },
  );
  assert.equal(result.status, 'launch_failed');
  assert.equal(result.started, false);
  assert.equal(result.cleanup, 'not_started');
});
test('a forced-cleanup result cannot be called a passed lane even if a case returned zero', async (t) => {
  const report = await run({
    root,
    directory: path.join(temp(t), 'run'),
    lanes: ['isolated'],
    revision,
    executeCase: async () => ({ status: 'passed', cleanup: 'forced_owned_tree' }),
  });
  assert.equal(report.passed, false);
  assert.equal(report.lanes[0].status, 'failed');
});

test('uncertain cleanup stops later lanes and retains the affected process identity for manual recovery', async (t) => {
  let calls = 0;
  const report = await run({
    root,
    directory: path.join(temp(t), 'run'),
    lanes: ['isolated', 'simulated'],
    revision,
    verifyCandidate: () => {
      throw new Error('Later lane must not be prepared');
    },
    executeCase: async () => {
      calls++;
      return { status: 'timed_out', cleanup: 'unverified', exitObserved: false, processId: 1234 };
    },
  });
  assert.equal(calls, 1);
  assert.equal(report.lanes[1].reason, 'prior_case_cleanup_unverified');
  assert.equal(report.lanes[0].cases[0].processId, 1234);
  assert.equal(report.passed, false);
});

test('a controlled filesystem failure retains its bounded code, stops its actual owned child and cannot claim saved evidence', async (t) => {
  const result = await execute(
    {
      file: process.execPath,
      args: [
        '-e',
        'process.stdout.write("fixture");setTimeout(()=>process.exit(29),5000);setInterval(()=>{},1000)',
      ],
    },
    {
      cwd: root,
      directory: temp(t),
      timeoutMs: 5000,
      writeLog: () => {
        throw Object.assign(new Error('Synthetic private path must not be copied'), {
          code: 'EPERM',
        });
      },
    },
  );
  assert.equal(result.status, 'storage_failed');
  assert.equal(result.storageFailureCode, 'EPERM');
  assert.equal(result.exitObserved, true);
  assert.notEqual(
    result.exitCode,
    29,
    'The controlled failure must terminate the child before its own guard',
  );
  assert.ok(Number.isFinite(result.stopDurationMs));
  assert.ok(result.stopDurationMs < 10000);
  assert.ok(!JSON.stringify(result).includes('private path'));
});

test('unexpected driver failure remains unconfirmed and stops every later lane', async (t) => {
  let calls = 0;
  const report = await run({
    root,
    directory: path.join(temp(t), 'run'),
    lanes: ['isolated', 'simulated'],
    revision,
    executeCase: async () => {
      calls++;
      throw new Error('Synthetic private failure text');
    },
  });
  assert.equal(calls, 1);
  assert.equal(report.passed, false);
  assert.equal(report.lanes[0].cases[0].status, 'runner_failed');
  assert.equal(report.lanes[0].cases[0].started, null);
  assert.equal(report.lanes[1].reason, 'prior_case_cleanup_unverified');
  assert.ok(!JSON.stringify(report).includes('private failure text'));
});
test('a log-open failure releases its already-opened descriptor and never launches a child', async (t) => {
  const directory = temp(t), marker = path.join(directory, 'must-not-launch.txt');
  let opened = null;
  t.after(() => { if(opened !== null) { try { fs.closeSync(opened); } catch {} } });
  fs.mkdirSync(path.join(directory, 'stderr.txt'));
  const originalOpen = fs.openSync;
  fs.openSync = (file, ...args) => {
    const fd = originalOpen(file, ...args);
    if(file === path.join(directory, 'stdout.txt')) opened = fd;
    return fd;
  };
  let result;
  try {
    result = await execute({ file: process.execPath, args: ['-e',
      "require('node:fs').writeFileSync(process.argv[1], 'unexpected child')", marker] }, {
      cwd: root, directory, timeoutMs: 5000,
    });
  } catch (error) {
    t.diagnostic('Original stdout descriptor still open before cleanup: ' + fs.fstatSync(opened).isFile());
    throw error;
  } finally { fs.openSync = originalOpen; }
  assert.throws(() => fs.fstatSync(opened), {code:'EBADF'});
  assert.equal(result.status, 'storage_failed');
  assert.equal(result.storageFailureCode, 'EEXIST');
  assert.equal(result.started, false);
  assert.equal(result.cleanup, 'not_started');
  assert.equal(result.exitObserved, false);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(JSON.stringify(result).includes('private storage detail'), false);
});
test('a pre-existing stdout file is preserved and cannot become evidence from a new QA child', async (t) => {
  const directory = temp(t), marker = path.join(directory, 'must-not-launch.txt'), file = path.join(directory, 'stdout.txt');
  fs.writeFileSync(file, 'original synthetic bytes');
  const before = fs.readFileSync(file);
  const result = await execute({file:process.execPath, args:['-e',
    "require('node:fs').writeFileSync(process.argv[1], 'unexpected child')", marker]},
    {cwd:root, directory, timeoutMs:5000});
  assert.equal(result.status, 'storage_failed');
  assert.equal(result.storageFailureCode, 'EEXIST');
  assert.equal(result.started, false);
  assert.equal(result.cleanup, 'not_started');
  assert.deepEqual(result.logs, []);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(path.join(directory, 'stderr.txt')), false);
});
test('unavailable log evidence stops every later QA lane before its candidate can be prepared', async (t) => {
  let calls = 0;
  const report = await run({root, directory:path.join(temp(t),'run'), lanes:['isolated','simulated'], revision,
    verifyCandidate: () => { throw new Error('Later candidate must not be prepared'); },
    executeCase: (command, options) => {
      calls++;
      fs.mkdirSync(path.join(options.directory, 'stderr.txt'));
      return execute(command, options);
    },
  });
  assert.equal(calls, 1);
  assert.equal(report.passed, false);
  assert.equal(report.lanes[0].cases[0].started, false);
  assert.equal(report.lanes[0].cases[0].status, 'storage_failed');
  assert.equal(report.lanes[1].status, 'blocked');
  assert.equal(report.lanes[1].reason, 'prior_case_cleanup_unverified');
});
