'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { summary, comparison, percentile } = require('../src/performance-report.cjs');
test('a cleanup boolean cannot hide a killed collector or a different original launch', () => {
  const { verifyShutdown } = require('../scripts/performance-report.cjs');
  const ready = { collectorPid: 123, collectorSession: 'owned-session' };
  const cleanup = { normalExit: true, collectorPid: 123 };
  const exited = { pid: 123, session: 'owned-session', exitCode: 0, signal: null, intentional: true };
  assert.doesNotThrow(() => verifyShutdown(cleanup, exited, ready));
  for (const change of [e => {e.exitCode=1;}, e => {e.signal='SIGTERM';}, e => {e.session='other';},
    e => {e.pid=124;}, e => {e.intentional=false;}]) {
    const bad = {...exited}; change(bad);
    assert.throws(() => verifyShutdown(cleanup, bad, ready));
  }
});
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
  assert.equal(r.metrics.cpuNormalizedPercent.timeWeightedMean,50);
  assert.deepEqual(r.cpuPhase,{cpuSeconds:4,elapsedSeconds:2,intervals:1,complete:true,
    policy:'Sum original-handle CPU deltas divided by their total measured elapsed time and logical processors.'});
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
  assert.equal(r.metrics.cpuNormalizedPercent.timeWeightedMean,null);
});
test('phase CPU weights unequal intervals and preserves visible burst variation for equal total work',()=>{
  const steady=summary([sample(0,[process(1,0)]),sample(1,[process(1,1)]),sample(2,[process(1,2)])],2);
  const burst=summary([sample(0,[process(1,0)]),sample(1,[process(1,2)]),sample(2,[process(1,2)])],2);
  assert.equal(steady.metrics.cpuNormalizedPercent.timeWeightedMean,50);
  assert.equal(burst.metrics.cpuNormalizedPercent.timeWeightedMean,50);
  assert.equal(steady.metrics.cpuNormalizedPercent.p95,50);
  assert.equal(burst.metrics.cpuNormalizedPercent.p95,100);
  const unequal=summary([sample(0,[process(1,0)]),sample(1,[process(1,1)]),sample(10,[process(1,1)])],1);
  assert.equal(unequal.metrics.cpuNormalizedPercent.timeWeightedMean,10);
  const current={hardwareKey:'synthetic',count:100,phase:'warm_idle',summary:burst},
    baselines=Array.from({length:5},()=>({...current,summary:steady}));
  const result=comparison(current,baselines);
  assert.equal(result.state,'within_baseline');assert.equal(result.cpuBurstDiagnostic.state,'regression');
  assert.equal(result.cpuBurstDiagnostic.gated,false);
  const sustained={...current,summary:summary([sample(0,[process(1,0)]),sample(1,[process(1,2)]),sample(2,[process(1,4)])],2)};
  assert.equal(comparison(sustained,baselines).state,'regression');
  const absent=structuredClone(current);delete absent.summary.metrics.cpuNormalizedPercent.timeWeightedMean;
  assert.equal(comparison(absent,baselines).state,'missing_metrics');
  for(const change of [r=>{r.cpuPhase.complete=false;},r=>{r.cpuPhase.intervals--;},
    r=>{r.cpuPhase.elapsedSeconds=0;},r=>{r.cpuPhase.cpuSeconds=0;},
    r=>{r.durationSeconds++;},r=>{r.logicalCores=0;}]){
    const invalid=structuredClone(current);change(invalid.summary);
    assert.equal(comparison(invalid,baselines).state,'missing_phase_cpu');
  }
});
test('nonfinite original CPU and incomplete phase time cannot become a finite average',()=>{
  for(const value of [NaN,Infinity,-1]){
    const report=summary([sample(0,[process(1,value)]),sample(1,[process(1,1)])],2);
    assert.equal(report.partial,true);assert.equal(report.metrics.cpuNormalizedPercent.timeWeightedMean,null);
    assert.equal(report.cpuPhase.complete,false);
  }
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
test('matching hardware fingerprints ignore field order and retain CPU, memory and Windows differences', () => {
  const { hardwareKey } = require('../src/performance-report.cjs');
  const first = {hardware:{manufacturer:'Synthetic VM', model:'Synthetic model', logicalCores:4,
    physicalMemoryBytes:16000000000, processors:[{model:'Synthetic CPU', cores:4, maxClockMHz:2800}]},
    windows:{caption:'Synthetic Windows', version:'10.0', build:'26100'}};
  const reordered = {windows:{build:'26100', version:'10.0', caption:'Synthetic Windows'},
    hardware:{processors:[{maxClockMHz:2800, cores:4, model:'Synthetic CPU'}], physicalMemoryBytes:16000000000,
      logicalCores:4, model:'Synthetic model', manufacturer:'Synthetic VM'}};
  assert.equal(hardwareKey(first), hardwareKey(reordered));
  for (const change of [m => {m.hardware.processors[0].model='Other CPU';},
    m => {m.hardware.physicalMemoryBytes++;}, m => {m.windows.build='different';}]) {
    const different = structuredClone(first); change(different);
    assert.notEqual(hardwareKey(first), hardwareKey(different));
  }
  assert.throws(() => hardwareKey({hardware:first.hardware}), /metadata/);
});
function tracked(pid,cpu,start,exit=null){
  const startedAt=new Date(1700000000000+start*1000).toISOString();
  return {...process(pid,cpu,String(BigInt(Date.parse(startedAt))*10000n+621355968000000000n)),handlePinned:true,startedAt,
    ...(exit===null?{lifecycle:'running'}:{lifecycle:'exited',exitedAt:new Date(1700000000000+exit*1000).toISOString(),exitCode:0,workingSetBytes:null,privateBytes:null,handles:null,threads:null})};
}
test('known child birth and final CPU from its original handle complete an interval without masking an unknown departure',()=>{
  const r=summary([sample(0,[tracked(1,0,0)]),sample(1,[tracked(1,.1,0),tracked(2,.2,.5)]),
    sample(2,[tracked(1,.2,0),tracked(2,.3,.5,1.5)]),sample(3,[tracked(1,.3,0)])],2);
  assert.equal(r.partial,false);assert.equal(r.measurementGaps,0);
  assert.equal(r.confirmedProcessStarts,1);assert.equal(r.confirmedProcessExits,1);
  assert.equal(r.metrics.cpuNormalizedPercent.count,3);assert.ok(Math.abs(r.metrics.cpuNormalizedPercent.p95-15)<1e-9);
  assert.ok(Math.abs(r.metrics.cpuNormalizedPercent.timeWeightedMean-10)<1e-9);
  assert.equal(r.metrics.privateBytes.min,50);assert.equal(r.metrics.privateBytes.max,100);
  const missing=summary([sample(0,[tracked(1,0,0),tracked(2,0,0)]),sample(1,[tracked(1,.1,0)])],2);
  assert.equal(missing.partial,true);assert.equal(missing.metrics.cpuNormalizedPercent.count,0);
});
test('unproven births, fabricated exits, changed identities and revived exited counters remain incomplete',()=>{
  const before=sample(1,[tracked(1,.1,0)]),child=tracked(2,.1,.5);
  assert.equal(summary([before,sample(2,[tracked(1,.2,0),child])],2).partial,true);
  for(const change of [p=>{p.handlePinned=false;},p=>{p.privateBytes=0;},p=>{p.creationTicks='other';},p=>{p.exitedAt=sample(4,[]).at;}]){
    const ended=tracked(2,.2,.5,1.5);change(ended);
    assert.equal(summary([sample(1,[tracked(1,.1,0),tracked(2,.1,.5)]),sample(2,[tracked(1,.2,0),ended])],2).partial,true);
  }
  assert.equal(summary([sample(1,[tracked(1,.1,0),tracked(2,.2,.5,.9)]),sample(2,[tracked(1,.2,0),tracked(2,.3,.5)])],2).partial,true);
});
