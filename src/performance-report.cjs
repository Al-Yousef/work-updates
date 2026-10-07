'use strict';
const fs = require('node:fs'),
  crypto = require('node:crypto');
function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]
    : null;
}
function summary(samples, cores) {
  if (!Number.isInteger(cores) || cores < 1 || !Array.isArray(samples) || samples.length < 2)
    throw new Error('Performance report requires logical cores and at least two samples');
  const values = {
    workingSetBytes: [],
    privateBytes: [],
    handles: [],
    threads: [],
    cpuNormalizedPercent: [],
  };
  let prior = null,
    gaps = 0;
  const identities = new Set();
  for (const s of samples) {
    const at = Date.parse(s.at);
    if (!Number.isFinite(at) || !Array.isArray(s.processes))
      throw new Error('Invalid process sample');
    for (const key of ['workingSetBytes', 'privateBytes', 'handles', 'threads']) {
      if (s.processes.some((p) => p.unavailable || !Number.isFinite(p[key]))) {
        gaps++;
        continue;
      }
      values[key].push(s.processes.reduce((n, p) => n + p[key], 0));
    }
    const map = new Map(
      s.processes.filter((p) => !p.unavailable).map((p) => [p.pid + ':' + p.creationTicks, p]),
    );
    for (const key of map.keys()) identities.add(key);
    if (prior) {
      const elapsed = (at - prior.at) / 1000;
      if (elapsed <= 0) throw new Error('Process samples must advance in time');
      let cpu = 0,
        complete = s.processes.length === map.size;
      for (const [key, p] of map) {
        const old = prior.map.get(key);
        if (!old) {
          gaps++;
          complete = false;
          continue;
        }
        if (!Number.isFinite(p.cpuSeconds) || p.cpuSeconds < old.cpuSeconds) {
          gaps++;
          complete = false;
          continue;
        }
        cpu += p.cpuSeconds - old.cpuSeconds;
      }
      for (const key of prior.map.keys())
        if (!map.has(key)) {
          gaps++;
          complete = false;
        }
      if (complete) values.cpuNormalizedPercent.push((100 * cpu) / elapsed / cores);
    }
    prior = { at, map };
  }
  return {
    samples: samples.length,
    durationSeconds: (Date.parse(samples.at(-1).at) - Date.parse(samples[0].at)) / 1000,
    logicalCores: cores,
    cpuNormalization: 'one fully occupied logical CPU divided by available logical CPUs',
    observedProcessInstances: identities.size,
    measurementGaps: gaps,
    metrics: Object.fromEntries(
      Object.entries(values).map(([key, v]) => [
        key,
        {
          count: v.length,
          p50: percentile(v, 0.5),
          p95: percentile(v, 0.95),
          p99: percentile(v, 0.99),
          min: v.length ? Math.min(...v) : null,
          max: v.length ? Math.max(...v) : null,
        },
      ]),
    ),
    wakeups: { value: null, state: 'unavailable_without_ETW' },
    partial: gaps > 0,
  };
}
function comparison(current, baselines) {
  if (!Array.isArray(baselines) || baselines.length < 5)
    return { state: 'insufficient_baseline', requiredIndependentRuns: 5 };
  const signatures = baselines.map((b) => b.hardwareKey + ':' + b.count + ':' + b.phase);
  if (signatures.some((s) => s !== current.hardwareKey + ':' + current.count + ':' + current.phase))
    return { state: 'incomparable_hardware_or_workload' };
  if (current.summary.partial || baselines.some((b) => b.summary.partial))
    return { state: 'partial_measurements' };
  const checks = [];
  for (const key of ['privateBytes', 'workingSetBytes', 'cpuNormalizedPercent']) {
    const observed = current.summary.metrics[key].p95,
      values = baselines.map((b) => b.summary.metrics[key].p95);
    if (!Number.isFinite(observed) || values.some((v) => !Number.isFinite(v)))
      return { state: 'missing_metrics' };
    const center = percentile(values, 0.5),
      noise = percentile(values, 0.75) - percentile(values, 0.25);
    const threshold = center + Math.max(3 * noise, 0.15 * center);
    checks.push({
      metric: key,
      baselineMedian: center,
      baselineIqr: noise,
      threshold,
      observed,
      passed: observed <= threshold,
    });
  }
  return {
    state: checks.every((c) => c.passed) ? 'within_baseline' : 'regression',
    baselineRuns: baselines.length,
    checks,
  };
}
function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function hardwareKey(metadata) {
  if (!metadata?.hardware || !metadata.windows)
    throw new Error('Hardware and Windows metadata are required');
  // PowerShell hashtable enumeration order differs between shell processes.
  // Hash the same recorded values independently of JSON object field order.
  const canonical = value => Array.isArray(value) ? value.map(canonical) :
    value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return crypto.createHash('sha256').update(JSON.stringify(canonical([metadata.hardware, metadata.windows]))).digest('hex');
}
module.exports = { percentile, summary, comparison, hash, hardwareKey };
