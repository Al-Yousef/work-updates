'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { run } = require('./native-qa-runner.cjs');
const root = path.resolve(__dirname, '..');
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !/^--lane=(isolated|simulated|physical|codex|all)$/.test(args[0]))
    throw new Error('Use --lane=isolated|simulated|physical|codex|all');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (
    !/^[a-f0-9]{40}$/.test(revision) ||
    execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  )
    throw new Error('QA requires a clean source checkout');
  const artifacts = path.join(root, 'artifacts');
  if (fs.existsSync(artifacts) && fs.lstatSync(artifacts).isSymbolicLink())
    throw new Error('QA artifacts cannot be a symbolic link');
  const parent = path.join(artifacts, 'native-qa');
  fs.mkdirSync(parent, { recursive: true });
  if (fs.lstatSync(parent).isSymbolicLink()) throw new Error('QA output cannot be a symbolic link');
  const directory = path.join(parent, crypto.randomUUID()),
    controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const lane = args[0].slice(7),
      report = await run({
        root,
        directory,
        revision,
        signal: controller.signal,
        lanes: lane === 'all' ? ['isolated', 'simulated', 'physical', 'codex'] : [lane],
        verifyCandidate: () => {
          if (process.platform !== 'win32') throw new Error('Native Windows candidate required');
          return require('./native-build-audit.cjs').verifyCandidate(
            path.join(root, 'native/windows/build/candidate'),
          );
        },
      });
    console.log(
      JSON.stringify({
        passed: report.passed,
        integratedAcceptance: false,
        report: path
          .relative(root, path.join(directory, 'verification.json'))
          .replaceAll('\\', '/'),
        lanes: report.lanes.map((l) => ({ lane: l.lane, status: l.status, reason: l.reason })),
      }),
    );
    if (!report.passed) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
main().catch(() => {
  console.error(
    'Native QA did not finish; verify source, arguments and the private report and logs.',
  );
  process.exitCode = 1;
});
