'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { summary, percentile } = require('../src/performance-report.cjs');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function report(directory) {
  const metadata = read(path.join(directory, 'metadata.json'));
  assert.equal(metadata.schema, 1);
  assert.equal(metadata.synthetic, true);
  assert.equal(metadata.accountsUsed, 0);
  assert.equal(metadata.modelCalls, 0);
  const hardwareKey = crypto
    .createHash('sha256')
    .update(JSON.stringify([metadata.hardware, metadata.windows]))
    .digest('hex');
  const cases = [];
  for (const count of [100, 500, 1500]) {
    const root = path.join(directory, String(count)),
      ready = read(path.join(root, 'performance-ready.json')),
      cleanup = read(path.join(root, 'cleanup.json'));
    assert.equal(ready.chatCount, count);
    assert.ok(ready.backendPid && ready.collectorPid);
    assert.equal(cleanup.normalExit, true);
    for (const phase of [
      'warm_idle',
      'hidden_idle',
      'active_stream',
      'chat_switching',
      'image_decode',
      'messaging',
    ]) {
      const samples = read(path.join(root, phase + '.samples.json')),
        workload = read(path.join(root, phase + '.workload.json'));
      assert.equal(workload.count, count);
      assert.equal(workload.phase, phase);
      assert.ok(
        samples.some((s) => s.processes.some((p) => p.pid === cleanup.backendPid)),
        'Backend missing from process tree',
      );
      assert.ok(
        samples.some((s) => s.processes.some((p) => p.pid === cleanup.nativePid)),
        'Native shell missing from process tree',
      );
      assert.ok(
        samples.some((s) => s.processes.some((p) => p.pid === cleanup.collectorPid)),
        'Collector missing from process tree',
      );
      assert.ok(
        workload.native.cachedChats <= 12 &&
          workload.native.bubbleLayouts <= 512 &&
          workload.native.imageBitmaps <= 32,
        'Native caches exceeded their documented bounds',
      );
      const latencies = Object.fromEntries(
        [...new Set(workload.latencies.map((l) => l.operation))].map((operation) => {
          const values = workload.latencies
            .filter((l) => l.operation === operation)
            .map((l) => l.ms);
          return [
            operation,
            {
              count: values.length,
              p50: percentile(values, 0.5),
              p95: percentile(values, 0.95),
              p99: percentile(values, 0.99),
              targetMs: 100,
              exceptions: values.filter((v) => v >= 100).length,
            },
          ];
        }),
      );
      if (['chat_switching', 'messaging'].includes(phase))
        assert.ok(
          latencies.chat_selection_handler?.count > 0,
          'Local handler latency was not measured',
        );
      if (phase === 'messaging')
        assert.ok(latencies.send_handler?.count > 0, 'Messaging path was not exercised');
      if (phase === 'image_decode')
        assert.ok(workload.native.imageBitmaps > 0, 'Native image decode was not exercised');
      cases.push({
        count,
        phase,
        hardwareKey,
        summary: summary(samples, Number(metadata.hardware.logicalCores)),
        latencies,
        native: workload.native,
        baselineState: 'pilot_only; five independent comparable runs required',
      });
    }
  }
  const value = {
    schema: 1,
    passed: true,
    synthetic: true,
    sourceRevision: metadata.revision,
    installedAppChanged: false,
    accountsUsed: 0,
    modelCalls: 0,
    metadata,
    cases,
    limits:
      'CI pilot with simulated owned Win32 messages and synthetic source transport. Sampling overhead is included. Wakeups, physical input, long-run leak proof and five-run comparable baseline remain unverified. No RAM/CPU optimization or real model latency is claimed.',
  };
  fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify(value, null, 2));
  return value;
}
if (require.main === module) {
  try {
    const value = report(path.resolve(process.argv[2]));
    process.stdout.write(
      JSON.stringify({
        passed: value.passed,
        sourceRevision: value.sourceRevision,
        cases: value.cases.length,
      }) + '\n',
    );
  } catch (error) {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  }
}
module.exports = { report };
