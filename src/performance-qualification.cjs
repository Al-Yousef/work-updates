'use strict';
const assert = require('node:assert/strict');
const { comparison, percentile } = require('./performance-report.cjs');
const phases = [
  'warm_idle',
  'hidden_idle',
  'active_stream',
  'chat_switching',
  'image_decode',
  'messaging',
];
function growth(samples, minimumSeconds = 300) {
  assert.ok(Array.isArray(samples) && samples.length >= 25, 'Growth needs at least 25 samples');
  const duration = (Date.parse(samples.at(-1).at) - Date.parse(samples[0].at)) / 1000;
  assert.ok(duration >= minimumSeconds - 5, 'Growth duration is insufficient');
  const checks = [];
  for (const [metric, floor] of Object.entries({
    privateBytes: 16 * 1024 * 1024,
    workingSetBytes: 32 * 1024 * 1024,
    handles: 64,
    threads: 8,
  })) {
    const totals = samples.map((s) => {
      assert.ok(Array.isArray(s.processes) && s.processes.length > 0, 'Missing owned process tree');
      assert.ok(
        s.processes.every((p) => !p.unavailable && Number.isFinite(p[metric]) && p[metric] >= 0),
        'Partial growth measurement',
      );
      return s.processes.reduce((n, p) => n + p[metric], 0);
    });
    const windows = Array.from({ length: 5 }, (_, i) =>
      totals.slice(Math.floor((i * totals.length) / 5), Math.floor(((i + 1) * totals.length) / 5)),
    );
    const medians = windows.map((v) => percentile(v, 0.5));
    const allowance = Math.max(
      floor,
      medians[0] * 0.1,
      3 * (percentile(windows[0], 0.75) - percentile(windows[0], 0.25)),
    );
    checks.push({
      metric,
      windowMedians: medians,
      allowance,
      delta: medians.at(-1) - medians[0],
      monotonic: medians.slice(1).every((v, i) => v > medians[i]),
      passed: medians.at(-1) - medians[0] <= allowance,
    });
  }
  return {
    state: checks.every((c) => c.passed) ? 'bounded_observed_growth' : 'growth_regression',
    durationSeconds: duration,
    samples: samples.length,
    checks,
    policy:
      'Five equal windows; final versus first median, allowance max(3 first-window IQR, 10%, explicit per-metric floor). This bounded observation is not proof of indefinite leak freedom.',
  };
}
function qualification(baselines, current, soak) {
  assert.equal(baselines.length, 5, 'Exactly five independent baselines are required');
  const runs = [...baselines, current, soak];
  assert.ok(
    runs.every(
      (r) => r.passed === true && r.metadata.runId && r.sourceRevision === current.sourceRevision,
    ),
    'Missing or changed source report',
  );
  assert.equal(
    new Set(runs.map((r) => r.metadata.runId)).size,
    runs.length,
    'Copied run identifiers are not independent',
  );
  const ownedRoots = new Set();
  for (const run of runs) {
    assert.ok(
      run.metadata.secondsPerPhase >= 30 &&
        run.metadata.sampleIntervalMs === current.metadata.sampleIntervalMs,
      'Different or short sampling policy',
    );
    for (const count of run.metadata.counts) {
      const row = run.cases.find((c) => c.count === count && c.phase === 'warm_idle');
      assert.ok(
        row?.ownedRoots?.length === 3,
        'Original backend/native/collector identities are required',
      );
      for (const root of row.ownedRoots) {
        assert.ok(!ownedRoots.has(root), 'Reused process instances are not independent');
        ownedRoots.add(root);
      }
    }
  }
  const checks = [];
  for (const count of [100, 500, 1500])
    for (const phase of phases) {
      const select = (r) => r.cases.filter((c) => c.count === count && c.phase === phase);
      const now = select(current);
      assert.equal(now.length, 1, 'Missing or duplicate current workload');
      const old = baselines.map((r) => {
        const rows = select(r);
        assert.equal(rows.length, 1, 'Missing baseline workload');
        return rows[0];
      });
      assert.ok(
        [...now, ...old].every((c) => c.summary.durationSeconds >= 25 && c.summary.samples >= 20),
        'Raw baseline measurement is too short',
      );
      const result = comparison(now[0], old);
      assert.ok(
        ['within_baseline', 'regression'].includes(result.state),
        'Unverified baseline: ' + result.state,
      );
      checks.push({ count, phase, ...result, localHandlers: now[0].latencies });
    }
  const long = soak.cases.filter((c) => c.phase === 'navigation_reconnect_soak');
  assert.equal(long.length, 1, 'Exactly one long-run workload is required');
  assert.equal(long[0].count, 1500);
  assert.equal(long[0].hardwareKey, current.cases[0].hardwareKey, 'Soak hardware differs');
  assert.ok(
    long[0].fixture?.reconnectCycles >= 10 && long[0].fixture.boundedLatestFrames === true,
    'Repeated reconnect/backpressure was not verified',
  );
  assert.ok(
    long[0].distinctSelectedSources > 12,
    'Navigation did not exceed the recent-chat cache',
  );
  assert.ok(long[0].growth, 'Long-run growth is missing');
  return {
    schema: 1,
    passed:
      checks.every((c) => c.state === 'within_baseline') &&
      long[0].growth.state === 'bounded_observed_growth',
    synthetic: true,
    sourceRevision: current.sourceRevision,
    accountsUsed: 0,
    modelCalls: 0,
    installedAppChanged: false,
    baselineRuns: baselines.map((r) => r.metadata.runId),
    currentRun: current.metadata.runId,
    soakRun: soak.metadata.runId,
    checks,
    soak: long[0],
    limits:
      'Matching runner baseline and bounded synthetic navigation/reconnection only. No optimization savings, physical input, account delivery, indefinite leak freedom, ETW wakeups, or energy measurement is claimed.',
  };
}
module.exports = { growth, qualification, phases };
