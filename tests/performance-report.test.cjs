'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { summary, comparison, percentile } = require('../src/performance-report.cjs');
const process = (pid, cpu, creation = 'one') => ({
  pid,
  creationTicks: creation,
  cpuSeconds: cpu,
  workingSetBytes: 100,
  privateBytes: 50,
  handles: 10,
  threads: 2,
});
const sample = (seconds, processes) => ({
  at: new Date(1700000000000 + seconds * 1000).toISOString(),
  processes,
});
test('whole-tree CPU uses elapsed time and logical cores; memory includes every observed process', () => {
  const r = summary(
    [sample(0, [process(1, 2), process(2, 3)]), sample(2, [process(1, 3), process(2, 6)])],
    4,
  );
  assert.equal(r.metrics.cpuNormalizedPercent.p95, 50);
  assert.equal(r.metrics.privateBytes.p95, 100);
  assert.equal(r.metrics.handles.p95, 20);
  assert.equal(r.partial, false);
  assert.equal(r.wakeups.value, null);
});
test('PID reuse, departed children and inaccessible samples disclose incomplete measurement rather than zero use', () => {
  const r = summary(
    [
      sample(0, [process(1, 10), process(2, 20)]),
      sample(1, [process(1, 1, 'reused'), { pid: 3, unavailable: true }]),
    ],
    4,
  );
  assert.equal(r.partial, true);
  assert.ok(r.measurementGaps > 0);
  assert.equal(r.metrics.privateBytes.count, 1);
  assert.equal(r.observedProcessInstances, 3);
  assert.equal(r.metrics.cpuNormalizedPercent.p95, null);
});
test('regressions need comparable independent baselines and an explicit noise allowance', () => {
  const s = summary([sample(0, [process(1, 0)]), sample(1, [process(1, 1)])], 4),
    current = { hardwareKey: 'synthetic', count: 500, phase: 'hidden_idle', summary: s };
  assert.equal(comparison(current, []).state, 'insufficient_baseline');
  assert.equal(
    comparison(
      current,
      Array.from({ length: 5 }, () => ({ ...current, count: 100 })),
    ).state,
    'incomparable_hardware_or_workload',
  );
  assert.equal(
    comparison(
      current,
      Array.from({ length: 5 }, () => structuredClone(current)),
    ).state,
    'within_baseline',
  );
  const higher = structuredClone(current);
  higher.summary.metrics.privateBytes.p95 = 200;
  assert.equal(
    comparison(
      higher,
      Array.from({ length: 5 }, () => structuredClone(current)),
    ).state,
    'regression',
  );
  assert.equal(percentile([], 0.95), null);
});
