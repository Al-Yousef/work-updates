'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {percentile,hardwareKey}=require('../src/performance-report.cjs');
const {phases}=require('../src/performance-qualification.cjs');
const beforeRevision='ca7e08e63b159b2fc00b675abe00bea713b076be';
const afterRevision='aa150bd8cf213445ea11c55655a8c32d47aaa14c';
const counts=[100,1500];
function compare(before,after){
  assert.equal(before.length,5);assert.equal(after.length,5);
  const ids=new Set(),roots=new Set(),hardware=hardwareKey(before[0].metadata);
  for(const [group,revision] of [[before,beforeRevision],[after,afterRevision]])for(const run of group){
    assert.equal(run.passed,true);assert.equal(run.sourceRevision,revision);
    assert.equal(hardwareKey(run.metadata),hardware);
    assert.deepStrictEqual(run.metadata.counts,counts);assert.equal(run.metadata.secondsPerPhase,30);
    assert.equal(run.metadata.sampleIntervalMs,1000);assert.equal(run.metadata.soakSeconds,0);
    assert.equal(run.metadata.accountsUsed,0);assert.equal(run.metadata.modelCalls,0);assert.equal(run.metadata.installedAppChanged,false);
    assert.ok(run.metadata.runId&&!ids.has(run.metadata.runId));ids.add(run.metadata.runId);
    assert.equal(run.cases.length,phases.length*counts.length);
    for(const count of counts){
    const originals=run.cases.find(c=>c.count===count&&c.phase==='warm_idle').ownedRoots;
    assert.equal(originals.length,3);
    for(const original of originals){assert.ok(!roots.has(original));roots.add(original);}
    for(const phase of phases){const row=run.cases.find(c=>c.count===count&&c.phase===phase);
      assert.equal(row.count,count);assert.deepStrictEqual(row.ownedRoots,originals);
      assert.equal(row.summary.cpuPhase.complete,true);
      assert.ok(row.summary.cpuPhase.elapsedSeconds>=25);
      assert.ok(Number.isFinite(row.summary.metrics.cpuNormalizedPercent.timeWeightedMean));
      assert.ok(Number.isFinite(row.summary.metrics.privateBytes.p95));
      assert.ok(Number.isSafeInteger(row.visibility.observedSurfaceDraws)&&row.visibility.observedSurfaceDraws>=0);
    }
    }
  }
  const rows=counts.flatMap(count=>phases.map(phase=>{
    const values=group=>group.map(run=>{const row=run.cases.find(c=>c.count===count&&c.phase===phase);return {
      runId:run.metadata.runId,wholeCpuPercent:row.summary.metrics.cpuNormalizedPercent.timeWeightedMean,
      nativeCpuPercent:row.components.native.metrics.cpuNormalizedPercent.timeWeightedMean,
      backendCpuPercent:row.components.backend.metrics.cpuNormalizedPercent.timeWeightedMean,
      privateBytesP95:row.summary.metrics.privateBytes.p95,draws:row.visibility.observedSurfaceDraws};});
    const earlier=values(before),later=values(after),medians=records=>Object.fromEntries(
      ['wholeCpuPercent','nativeCpuPercent','backendCpuPercent','privateBytesP95','draws'].map(key=>[key,percentile(records.map(r=>r[key]),.5)]));
    return {count,phase,before:earlier,after:later,beforeMedian:medians(earlier),afterMedian:medians(later)};
  }));
  const idle=rows.filter(row=>row.phase==='warm_idle');
  return {schema:1,synthetic:true,beforeRevision,afterRevision,freshRuns:ids.size,freshOriginalRoots:roots.size,
    hardwareKey:hardware,hardware:before[0].metadata.hardware,windows:before[0].metadata.windows,
    accountsUsed:0,modelCalls:0,installedAppChanged:false,qualifiesPerformance:false,rows,
    observedIdleReduction:idle.every(row=>row.afterMedian.wholeCpuPercent<row.beforeMedian.wholeCpuPercent&&
      row.afterMedian.nativeCpuPercent<row.beforeMedian.nativeCpuPercent&&row.afterMedian.draws<row.beforeMedian.draws),
    limits:'Five alternating before/after synthetic 100- and 1500-source runs on one CI host. All six workloads and all repetitions are retained. Medians describe this observation, without a significance or energy claim. This comparison does not replace full current-source qualification or physical-device evidence.'};
}
function report(root){
  const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  const {report:reproduce}=require('./performance-report.cjs');
  const groups=['before','after'].map(name=>Array.from({length:5},(_,i)=>{
    const directory=path.join(root,name+'-'+(i+1)),retained=read(path.join(directory,'verification.json'));
    assert.deepStrictEqual(reproduce(directory),retained);return retained;
  }));
  const value={...compare(...groups),rawReportsReproduced:true,originalCollectorZeroExitReceiptsVerified:true};
  fs.writeFileSync(path.join(root,'comparison.json'),JSON.stringify(value,null,2));return value;
}
if(require.main===module){const value=report(path.resolve(process.argv[2]));console.log(JSON.stringify({freshRuns:value.freshRuns,observedIdleReduction:value.observedIdleReduction,qualifiesPerformance:false}));}
module.exports={compare,report,beforeRevision,afterRevision,counts};
