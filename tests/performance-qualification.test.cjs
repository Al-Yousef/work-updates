'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { growth, qualification, phases, phaseVisibility } = require('../src/performance-qualification.cjs');
const visibility = (phase, count = 60) => ({mode: phase === 'hidden_idle' ? 'hidden' : 'pinned',
  panelVisible: phase !== 'hidden_idle', nativePid: 2, samples: count,
  entrySurfaceDraws: 5, lastSurfaceDraws: phase === 'hidden_idle' ? 5 : 10,
  observedSurfaceDraws: phase === 'hidden_idle' ? 0 : 5});
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
      secondsPerPhase: 60,
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
            durationSeconds: 60,
            samples: 60,
            logicalCores:4,
            cpuPhase:{complete:true,cpuSeconds:120,elapsedSeconds:60,intervals:59},
            metrics: Object.fromEntries(
              ['privateBytes', 'workingSetBytes', 'cpuNormalizedPercent'].map((key) => [
                key,
                { p95: 50, ...(key==='cpuNormalizedPercent'?{timeWeightedMean:50}:{}) },
              ]),
            ),
          },
          latencies: { chat_selection_handler: { p95: 2 } },
          visibility: visibility(phase),
        })),
      )
      .concat(
        i === 6
          ? [
              {
                count: 1500,
                phase: 'navigation_reconnect_soak',
                summary: {samples: 101},
                ownedRoots: [1, 2, 3].map((pid) => `${pid}:creation-1500-${i}`),
                visibility: visibility('navigation_reconnect_soak', 101),
                hardwareKey: 'runner-hardware',
                fixture: { reconnectCycles: 20, observedReconnections: 19, ownershipLeasePreserved: true, boundedLatestFrames: true },
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
  assert.equal(qualification(r.slice(0, 5), r[5], r[6]).cpuBudgetStatistic,'timeWeightedMean');
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
    [(r) => (r[6].cases.at(-1).fixture.observedReconnections = 0), /reconnect/],
    [(r) => (r[6].cases.at(-1).fixture.ownershipLeasePreserved = false), /reconnect/],
    [(r) => (r[1].metadata.counts = []), /Declared workloads/],
    [(r) => (r[1].metadata.secondsPerPhase = 90), /sampling policy/],
    [(r) => (r[6].metadata.soakSeconds = 300), /ten minutes/],
    [(r) => (r[6].cases.at(-1).growth = growth(samples())), /ten minutes/],
    [(r) => delete r[0].cases[0].visibility, /production mode/],
    [(r) => (r[0].cases.find(c => c.phase === 'hidden_idle').visibility.mode = 'pinned'), /production mode/],
    [(r) => (r[0].cases.find(c => c.phase === 'hidden_idle').visibility.panelVisible = true), /visibility/],
    [(r) => (r[0].cases.find(c => c.phase === 'hidden_idle').visibility.observedSurfaceDraws = 1), /native rendering/],
    [(r) => (r[0].cases[0].visibility.nativePid = 99), /owner differs/],
    [(r) => (r[0].cases[0].visibility.samples = 1), /sample count/],
  ]) {
    const r = runs();
    mutate(r);
    assert.throws(() => qualification(r.slice(0, 5), r[5], r[6]), pattern);
  }
  const r = runs();
  r[5].cases[0].summary.metrics.privateBytes.p95 = 500;
  assert.equal(qualification(r.slice(0, 5), r[5], r[6]).passed, false);
  r[5].cases[0].summary.metrics.privateBytes.p95 = 50;
  r[5].cases[0].summary.metrics.cpuNormalizedPercent.timeWeightedMean=500;
  r[5].cases[0].summary.cpuPhase.cpuSeconds=1200;
  assert.equal(qualification(r.slice(0, 5), r[5], r[6]).passed, false);
  r[5].cases[0].summary.metrics.cpuNormalizedPercent.timeWeightedMean=50;
  r[5].cases[0].summary.cpuPhase.cpuSeconds=120;
  r[6].cases.at(-1).growth = growth(samples(true, 101), 600);
  assert.equal(qualification(r.slice(0, 5), r[5], r[6]).passed, false);
});

test('full qualification requires actual longer CPU time and sample coverage in every fixture', () => {
  const old = runs();
  for (const run of old) run.metadata.secondsPerPhase = 30;
  assert.throws(() => qualification(old.slice(0, 5), old[5], old[6]), /sampling policy/);
  for (const group of [0, 5, 6]) {
    const short = runs();
    short[group].cases[0].summary.cpuPhase.elapsedSeconds = 29;
    assert.throws(() => qualification(short.slice(0, 5), short[5], short[6]), /declared qualification window/);
  }
  const sparse = runs();
  sparse[5].cases[0].summary.samples = 30;
  sparse[5].cases[0].visibility.samples = 30;
  assert.throws(() => qualification(sparse.slice(0, 5), sparse[5], sparse[6]), /declared qualification window/);
  const cadence = runs();
  for (const run of cadence) run.metadata.sampleIntervalMs = 500;
  assert.throws(() => qualification(cadence.slice(0, 5), cadence[5], cadence[6]), /declared qualification window/);
  for (const invalid of [0, -1, NaN, 5001]) {
    const invalidCadence = runs();
    for (const run of invalidCadence) run.metadata.sampleIntervalMs = invalid;
    assert.throws(() => qualification(invalidCadence.slice(0, 5), invalidCadence[5], invalidCadence[6]), /sampling policy/);
  }
});

test('hidden idle requires the original production hidden mode and no rendering throughout its observation', () => {
  const entry = {pid: 2, mode: 'hidden', panelVisible: false, surfaceDraws: 7};
  const states = Array.from({length: 3}, () => ({...entry}));
  assert.equal(phaseVisibility('hidden_idle', states, 3, 2, entry).observedSurfaceDraws, 0);
  for (const [mutate, pattern] of [
    [s => {s[1].mode = 'pinned';}, /production mode/],
    [s => {s[1].panelVisible = true;}, /visibility/],
    [s => {s[1].surfaceDraws++;}, /native rendering/],
    [s => {s[1].pid = 99;}, /replaced process/],
    [s => {delete s[1].surfaceDraws;}, /draw counter/],
  ]) {
    const changed = structuredClone(states); mutate(changed);
    assert.throws(() => phaseVisibility('hidden_idle', changed, 3, 2, entry), pattern);
  }
  assert.throws(() => phaseVisibility('hidden_idle', states.slice(0, 2), 3, 2, entry), /every process sample/);
  assert.throws(() => phaseVisibility('hidden_idle', states, 3, 2, {...entry, mode: 'pinned'}), /production mode/);
});

test('visible benchmark phases require a pinned original surface and retain observed draws', () => {
  const entry = {pid: 2, mode: 'pinned', panelVisible: true, surfaceDraws: 7};
  const states = [{...entry}, {...entry, surfaceDraws: 9}];
  assert.equal(phaseVisibility('active_stream', states, 2, 2, entry).observedSurfaceDraws, 2);
  assert.throws(() => phaseVisibility('active_stream', [{...entry, panelVisible: false}], 1, 2, entry), /visibility/);
  assert.throws(() => phaseVisibility('unknown', states, 2, 2, entry), /Unknown/);
});
