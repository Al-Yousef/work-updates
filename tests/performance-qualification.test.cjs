'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { growth, qualification, phases } = require('../src/performance-qualification.cjs');
function samples(grow = false, length = 60) {
  return Array.from({ length }, (_, i) => ({
    at: new Date(1700000000000 + i * 6000).toISOString(),
    processes: [
      {
        pid: 1,
        privateBytes: 100 * 1024 * 1024 + (grow ? i * 1024 * 1024 : (i % 3) * 1024),
        workingSetBytes: 130 * 1024 * 1024,
        handles: 100,
        threads: 12,
      },
    ],
  }));
}
function runs() {
  return Array.from({ length: 7 }, (_, i) => ({
    passed: true,
    sourceRevision: 'same-verified-source',
    metadata: {
      runId: 'independent-' + i,
      counts: i === 6 ? [1500] : [100, 500, 1500],
      secondsPerPhase: 30,
      sampleIntervalMs: 1000,
      soakSeconds: i === 6 ? 600 : 0,
    },
    cases: [100, 500, 1500]
      .flatMap((count) =>
        phases.map((phase) => ({
          count,
          phase,
          hardwareKey: 'runner-hardware',
          ownedRoots: [1, 2, 3].map((pid) => `${pid}:creation-${count}-${i}`),
          summary: {
            partial: false,
            durationSeconds: 30,
            samples: 30,
            metrics: Object.fromEntries(
              ['privateBytes', 'workingSetBytes', 'cpuNormalizedPercent'].map((key) => [
                key,
                { p95: 50 },
              ]),
            ),
          },
          latencies: { chat_selection_handler: { p95: 2 } },
        })),
      )
      .concat(
        i === 6
          ? [
              {
                count: 1500,
                phase: 'navigation_reconnect_soak',
                hardwareKey: 'runner-hardware',
                fixture: { reconnectCycles: 20, boundedLatestFrames: true },
                distinctSelectedSources: 30,
                growth: growth(samples(false, 101), 600),
              },
            ]
          : [],
      ),
  }));
}
test('long-run windows tolerate bounded noise and reject sustained memory growth', () => {
  const stable = growth(samples());
  assert.equal(stable.state, 'bounded_observed_growth');
  const leak = growth(samples(true));
  assert.equal(leak.state, 'growth_regression');
  assert.equal(leak.checks[0].monotonic, true);
});
test('short or missing process samples cannot establish growth bounds', () => {
  assert.throws(() => growth(samples().slice(0, 20)), /25 samples/);
  const partial = samples();
  partial[20].processes[0].unavailable = true;
  assert.throws(() => growth(partial), /Partial/);
  partial[20].processes = [];
  assert.throws(() => growth(partial), /Missing/);
});
test('qualification needs five matching independent process runs and a real reconnect/navigation soak', () => {
  const r = runs();
  assert.equal(qualification(r.slice(0, 5), r[5], r[6]).passed, true);
  assert.throws(() => qualification(r.slice(0, 4), r[5], r[6]), /five independent/);
  r[1].metadata.runId = r[0].metadata.runId;
  assert.throws(() => qualification(r.slice(0, 5), r[5], r[6]), /Copied/);
  r[1].metadata.runId = 'independent-1';
  r[1].cases[0].ownedRoots = r[0].cases[0].ownedRoots;
  assert.throws(() => qualification(r.slice(0, 5), r[5], r[6]), /Reused process/);
});
test('partial, mismatched, short and regressed measurements remain failed', () => {
  for (const [mutate, pattern] of [
    [(r) => (r[1].cases[0].summary.partial = true), /partial_measurements/],
    [(r) => (r[1].cases[0].hardwareKey = 'different'), /incomparable/],
    [(r) => (r[1].cases[0].summary.durationSeconds = 6), /too short/],
    [(r) => (r[6].cases.at(-1).distinctSelectedSources = 2), /recent-chat cache/],
    [(r) => (r[6].cases.at(-1).fixture.reconnectCycles = 0), /reconnect/],
    [(r) => (r[1].metadata.counts = []), /Declared workloads/],
    [(r) => (r[1].metadata.secondsPerPhase = 60), /sampling policy/],
    [(r) => (r[6].metadata.soakSeconds = 300), /ten minutes/],
    [(r) => (r[6].cases.at(-1).growth = growth(samples())), /ten minutes/],
  ]) {
    const r = runs();
    mutate(r);
    assert.throws(() => qualification(r.slice(0, 5), r[5], r[6]), pattern);
  }
  const r = runs();
  r[5].cases[0].summary.metrics.privateBytes.p95 = 500;
  assert.equal(qualification(r.slice(0, 5), r[5], r[6]).passed, false);
  r[5].cases[0].summary.metrics.privateBytes.p95 = 50;
  r[6].cases.at(-1).growth = growth(samples(true, 101), 600);
  assert.equal(qualification(r.slice(0, 5), r[5], r[6]).passed, false);
});
