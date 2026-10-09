'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compare,beforeRevision,afterRevision,counts}=require('../scripts/idle-before-after.cjs');
const {phases}=require('../src/performance-qualification.cjs');
function fixtures(){
  const make=(revision,prefix,cpu,draws)=>Array.from({length:5},(_,i)=>({passed:true,sourceRevision:revision,
    metadata:{runId:prefix+i,hardware:{logicalCores:4},windows:{build:'synthetic'},counts:[...counts],secondsPerPhase:30,
      sampleIntervalMs:1000,soakSeconds:0,accountsUsed:0,modelCalls:0,installedAppChanged:false},
    cases:counts.flatMap(count=>phases.map(phase=>({phase,count,ownedRoots:[0,1,2].map(n=>prefix+i+':'+count+':'+n),
      summary:{cpuPhase:{complete:true,elapsedSeconds:29},metrics:{cpuNormalizedPercent:{timeWeightedMean:cpu},privateBytes:{p95:1000}}},
      components:{native:{metrics:{cpuNormalizedPercent:{timeWeightedMean:cpu/2}}},backend:{metrics:{cpuNormalizedPercent:{timeWeightedMean:cpu/2}}}},
      visibility:{observedSurfaceDraws:draws}})))}));
  return [make(beforeRevision,'before-',1,10),make(afterRevision,'after-',.5,0)];
}
test('all alternating observations survive alongside descriptive medians',()=>{
  const value=compare(...fixtures());assert.equal(value.freshRuns,10);assert.equal(value.freshOriginalRoots,60);
  assert.equal(value.rows.length,12);assert.equal(value.rows[0].before.length,5);assert.equal(value.rows[0].after.length,5);
  assert.equal(value.observedIdleReduction,true);assert.equal(value.qualifiesPerformance,false);
  const groups=fixtures();groups[1][4].cases[0].summary.metrics.cpuNormalizedPercent.timeWeightedMean=10;
  assert.equal(compare(...groups).rows[0].after[4].wholeCpuPercent,10);
});
test('changed sources, copied runs, changed hardware and partial work cannot form a comparison',()=>{
  for(const change of [g=>g[1][0].sourceRevision=beforeRevision,g=>g[1][0].metadata.runId=g[0][0].metadata.runId,
    g=>g[1][0].metadata.hardware.logicalCores=8,g=>g[1][0].cases.pop(),
    g=>g[1][0].metadata.counts=[100],g=>g[1][0].cases[6].ownedRoots=g[1][0].cases[0].ownedRoots,
    g=>g[1][0].cases[0].summary.cpuPhase.complete=false,g=>g[1][0].cases[0].ownedRoots=g[0][0].cases[0].ownedRoots]){
    const groups=fixtures();change(groups);assert.throws(()=>compare(...groups));
  }
});
test('an increase remains visible and cannot be called an idle reduction',()=>{
  const groups=fixtures();for(const run of groups[1])for(const row of run.cases)row.summary.metrics.cpuNormalizedPercent.timeWeightedMean=2;
  assert.equal(compare(...groups).observedIdleReduction,false);
});
