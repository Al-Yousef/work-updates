'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fileURLToPath}=require('node:url');
const {execFileSync}=require('node:child_process');
function summarizeProfile(profile,repo,tracked){
  assert.ok(Array.isArray(profile.nodes)&&profile.nodes.length>0&&profile.nodes.length<=10000);
  assert.ok(Array.isArray(profile.samples)&&profile.samples.length>0&&profile.samples.length<=250000);
  assert.equal(profile.samples.length,profile.timeDeltas.length);
  assert.ok(Number.isFinite(profile.startTime)&&Number.isFinite(profile.endTime)&&profile.endTime>profile.startTime);
  const nodes=new Map(),parents=new Map(),totals=new Map();
  for(const node of profile.nodes){assert.ok(Number.isInteger(node.id)&&!nodes.has(node.id));nodes.set(node.id,node);
    for(const child of node.children||[]){assert.ok(!parents.has(child));parents.set(child,node.id);}}
  function frame(node){
    const call=node.callFrame||{};let relative='';
    try{const file=call.url.startsWith('file:')?fileURLToPath(call.url):call.url;
      relative=path.relative(repo,file).replaceAll('\\','/');}catch{}
    if(relative&&tracked.has(relative))return {file:relative,line:Number.isInteger(call.lineNumber)?call.lineNumber+1:0,
      function:/^[\w$ .<>:-]{1,100}$/.test(call.functionName)?call.functionName:'[anonymous]'};
    return {file:'[runtime or dependency]',line:0,function:['(idle)','(program)','(garbage collector)','(root)'].includes(call.functionName)?call.functionName:'[unattributed]'};
  }
  let totalMicroseconds=0;
  for(let index=0;index<profile.samples.length;index++){
    const micros=profile.timeDeltas[index];assert.ok(Number.isFinite(micros)&&micros>=0);totalMicroseconds+=micros;
    let id=profile.samples[index],leaf=true;const seen=new Set(),keys=new Set();
    while(id!==undefined){assert.ok(nodes.has(id)&&!seen.has(id));seen.add(id);assert.ok(seen.size<=200);
      const value=frame(nodes.get(id)),key=JSON.stringify(value);let row=totals.get(key);
      if(!row){row={...value,selfMs:0,inclusiveMs:0};totals.set(key,row);}
      if(leaf)row.selfMs+=micros/1000;
      if(!keys.has(key))row.inclusiveMs+=micros/1000;keys.add(key);leaf=false;id=parents.get(id);
    }
  }
  const rows=[...totals.values()];return {samples:profile.samples.length,durationSeconds:(profile.endTime-profile.startTime)/1e6,
    totalSampledMs:totalMicroseconds/1000,topSelf:rows.sort((a,b)=>b.selfMs-a.selfMs).slice(0,40),
    topInclusiveSource:rows.filter(r=>tracked.has(r.file)).sort((a,b)=>b.inclusiveMs-a.inclusiveMs).slice(0,40),
    limits:'In-process V8 sampling attribution includes profiler overhead. Inclusive stacks overlap. This is diagnostic attribution, not an operating-system CPU budget, native-thread profile or performance qualification.'};
}
function profilePhase(value='warm_idle'){
  assert.ok(['warm_idle','image_decode'].includes(value));return value;
}
function diagnostic(directory){
  assert.equal(process.env.CI,'true');assert.equal(process.env.RUNNER_OS,'Windows');
  assert.ok(process.versions.electron);assert.ok(fs.existsSync(path.join(directory,'source','state_5.sqlite')));
  const phase=profilePhase(process.env.HYPHEN_PERFORMANCE_CPU_PHASE);
  const repo=path.resolve(__dirname,'..'),tracked=new Set(execFileSync('git',['ls-files','-z'],{cwd:repo,encoding:'utf8'}).split('\0').filter(Boolean));
  const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
  const session=new (require('node:inspector').Session)();session.connect();let active=false,cpu,start;
  const post=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(error,result)=>error?reject(error):resolve(result)));
  return {phase,async start(){assert.equal(active,false);await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:1000});
      cpu=process.cpuUsage();start=process.hrtime.bigint();await post('Profiler.start');active=true;},
    async stop(){if(!active)return;const {profile}=await post('Profiler.stop');active=false;
      const usage=process.cpuUsage(cpu),elapsedSeconds=Number(process.hrtime.bigint()-start)/1e9;
      const report={schema:1,synthetic:true,phase,sourceRevision:revision,backendPid:process.pid,accountsUsed:0,modelCalls:0,
        installedAppChanged:false,qualifiesPerformance:false,samplingIntervalMicroseconds:1000,
        backendCpuSeconds:(usage.user+usage.system)/1e6,elapsedSeconds,...summarizeProfile(profile,repo,tracked)};
      assert.ok(report.durationSeconds>=25&&report.durationSeconds<=45);
      fs.writeFileSync(path.join(directory,phase.replaceAll('_','-')+'-cpu-profile.json'),JSON.stringify(report,null,2));
    },close(){session.disconnect();}};
}
module.exports={summarizeProfile,diagnostic,profilePhase};
