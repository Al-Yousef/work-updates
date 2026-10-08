'use strict';
const fs = require('node:fs'),
  crypto = require('node:crypto');
function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]
    : null;
}
function pinnedIdentity(p) {
  if(p.handlePinned!==true||typeof p.creationTicks!=='string'||!/^\d+$/.test(p.creationTicks))return false;
  const start=Date.parse(p.startedAt);
  const created=Number(BigInt(p.creationTicks)/10000n-62135596800000n);
  return Number.isFinite(start)&&Math.abs(start-created)<=1;
}
function confirmedExit(p, completedAt) {
  const exit=Date.parse(p.exitedAt);
  return p.lifecycle==='exited'&&!p.unavailable&&pinnedIdentity(p)&&
    Number.isFinite(p.cpuSeconds)&&p.cpuSeconds>=0&&Number.isInteger(p.exitCode)&&
    Number.isFinite(exit)&&exit>=Date.parse(p.startedAt)&&exit<=Date.parse(completedAt)&&
    ['workingSetBytes','privateBytes','handles','threads'].every(key=>p[key]===null);
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
    gaps = 0, starts=0, exits=0, abnormalExits=0;
  const identities = new Set();
  for (const s of samples) {
    const at = Date.parse(s.at);
    if (!Number.isFinite(at) || !Array.isArray(s.processes))
      throw new Error('Invalid process sample');
    const completed=s.completedAt||s.at;
    const exited=p=>confirmedExit(p,completed);
    const active=s.processes.filter(p=>!exited(p));
    for(const p of s.processes.filter(exited)){exits++;if(p.exitCode!==0)abnormalExits++;}
    for (const key of ['workingSetBytes', 'privateBytes', 'handles', 'threads']) {
      if (active.some((p) => p.unavailable || !Number.isFinite(p[key])||p[key]<0)) {
        gaps++;
        continue;
      }
      values[key].push(active.reduce((n, p) => n + p[key], 0));
    }
    const map = new Map(
      s.processes.filter((p) => !p.unavailable && (p.lifecycle!=='exited'||exited(p))).map((p) => [p.pid + ':' + p.creationTicks, p]),
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
          const born=Date.parse(p.startedAt);
          if(pinnedIdentity(p)&&born>=prior.at&&born<=Date.parse(completed)&&Number.isFinite(p.cpuSeconds)&&p.cpuSeconds>=0){
            cpu+=p.cpuSeconds;starts++;
          }else{gaps++;complete=false;}
          continue;
        }
        if (old.lifecycle==='exited'||!Number.isFinite(p.cpuSeconds) || p.cpuSeconds < old.cpuSeconds) {
          gaps++;
          complete = false;
          continue;
        }
        cpu += p.cpuSeconds - old.cpuSeconds;
      }
      for (const [key,p] of prior.map)
        if (!map.has(key)&&!confirmedExit(p,prior.completed)) {
          gaps++;
          complete = false;
        }
      if (complete) values.cpuNormalizedPercent.push((100 * cpu) / elapsed / cores);
    }
    prior = { at, map, completed };
  }
  return {
    samples: samples.length,
    durationSeconds: (Date.parse(samples.at(-1).at) - Date.parse(samples[0].at)) / 1000,
    logicalCores: cores,
    cpuNormalization: 'one fully occupied logical CPU divided by available logical CPUs',
    observedProcessInstances: identities.size,
    measurementGaps: gaps,
    confirmedProcessStarts:starts,
    confirmedProcessExits:exits,
    abnormalProcessExits:abnormalExits,
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
module.exports = { percentile, summary, comparison, hash, hardwareKey, confirmedExit };
