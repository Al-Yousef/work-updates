'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {LegacyWeatherRecovery,installedDirectory,readState}=require('../src/legacy-weather-recovery.cjs');
function fixture(){
  let current={session:'first',ready:false,eligible:true,nativeRecovery:false},claimed=true,calls=[],jobs=[],serial=0,now=0;
  const timers={set(fn,ms){const job={id:++serial,at:now+ms,fn};jobs.push(job);return job;},clear(job){jobs=jobs.filter(j=>j!==job);}};
  const recovery=new LegacyWeatherRecovery({directory:path.resolve('native'),claimed:()=>claimed,read:()=>current,timers,run:async(...args)=>{calls.push(args);throw new Error('synthetic attach refusal');}});
  async function advance(ms){now+=ms;for(;;){const ready=jobs.filter(j=>j.at<=now).sort((a,b)=>a.at-b.at)[0];if(!ready)break;timers.clear(ready);ready.fn();await recovery.flight;}}
  return {recovery,calls,advance,set:value=>current={...current,...value},owner:value=>claimed=value,jobs:()=>jobs};
}
test('attachment failure storms back off, stop after six attempts, and never use source-provided controller arguments',async()=>{
  const f=fixture();for(const delay of [1000,2000,4000,8000,16000,30000]){
    f.recovery.refresh();f.recovery.refresh();assert.equal(f.jobs().length,1);await f.advance(delay);
  }
  f.recovery.refresh();assert.equal(f.calls.length,6);assert.equal(f.jobs().length,0);
  const read=f.recovery.read;f.recovery.read=()=>{throw new Error('temporary unreadable metadata');};f.recovery.refresh();f.recovery.read=read;f.recovery.refresh();assert.equal(f.recovery.attempts,6);assert.equal(f.jobs().length,0);
  for(const [file,args,options] of f.calls){assert.equal(file,path.resolve('native/Taskbar Adapter Control.exe'));assert.deepEqual(args,['--attach']);assert.equal(options.windowsHide,true);assert.equal(options.timeout,10000);}
  await f.recovery.closeAndWait();
});
test('ready/failure flapping retains the budget, while stable readiness renews it',async()=>{
  const f=fixture();f.recovery.refresh();await f.advance(1000);assert.equal(f.recovery.attempts,2);
  f.set({ready:true});f.recovery.refresh();assert.equal(f.recovery.status().pending,false);await f.advance(20000);
  f.set({ready:false});f.recovery.refresh();assert.equal(f.recovery.attempts,3);
  f.set({ready:true});f.recovery.refresh();await f.advance(30000);assert.equal(f.recovery.attempts,0);
  f.set({ready:false});f.recovery.refresh();assert.equal(f.recovery.attempts,1);await f.recovery.closeAndWait();
});
test('new native recovery, lost ownership, disabled attachment and changed sessions cannot borrow a scheduled attempt',async()=>{
  for(const update of [{nativeRecovery:true},{eligible:false},{session:'replacement'}]){
    const f=fixture();f.recovery.refresh();f.set(update);await f.advance(1000);assert.equal(f.calls.length,0);await f.recovery.closeAndWait();
  }
  const f=fixture();f.recovery.refresh();f.owner(false);await f.advance(1000);assert.equal(f.calls.length,0);assert.equal(f.recovery.status().active,false);await f.recovery.closeAndWait();
});
test('an in-flight controller is unique and shutdown waits for its real settlement without starting another',async()=>{
  const f=fixture();let finish;f.recovery.run=(...args)=>{f.calls.push(args);return new Promise(resolve=>finish=resolve);};f.recovery.refresh();
  const advancing=f.advance(1000);await Promise.resolve();f.recovery.refresh();assert.equal(f.calls.length,1);assert.equal(f.jobs().length,0);
  let settled=false;const closing=f.recovery.closeAndWait().then(()=>settled=true);await Promise.resolve();assert.equal(settled,false);
  finish({stdout:'synthetic'});await advancing;await closing;assert.equal(settled,true);assert.equal(f.jobs().length,0);assert.equal(f.recovery.status().active,false);
});
test('only the packaged Windows installation owning its default private directory can enable compatibility recovery',()=>{
  const root=path.resolve('portable'),base={packaged:true,platform:'win32',demo:false,executable:path.join(root,'desktop/Work Updates.exe'),dataDirectory:path.join(root,'data/desktop')};
  assert.equal(installedDirectory(base),path.join(root,'native'));
  for(const change of [{packaged:false},{platform:'darwin'},{demo:true},{dataDirectory:path.resolve('fixture')},{executable:path.join(root,'other.exe')}])assert.equal(installedDirectory({...base,...change}),null);
});
test('bounded trace read requires a complete live endpoint, matching PID and the latest native attachment policy',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-weather-state-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'artifacts'));
  const endpoint=path.join(root,'artifacts/taskbar-adapter.info'),trace=path.join(root,'artifacts/native-hover.jsonl');const bytes=Buffer.alloc(32);
  bytes.writeBigUInt64LE(0x3152414254575557n,0);bytes.writeBigUInt64LE(123n,8);bytes.writeBigUInt64LE(456n,16);bytes.writeUInt32LE(process.pid,24);bytes.writeUInt32LE(1,28);fs.writeFileSync(endpoint,bytes);
  const frame={pid:process.pid,seconds:13,adapterReady:false,taskbarAdapter:true,adapterAutoAttach:true,cornerCoordinated:true};
  fs.writeFileSync(trace,'x'.repeat(100000)+'\n'+JSON.stringify({...frame,pid:process.pid+1})+'\n'+JSON.stringify(frame)+'\n');
  assert.equal(readState(root).eligible,true);assert.equal(readState(root).nativeRecovery,false);
  fs.appendFileSync(trace,JSON.stringify({...frame,adapterAutoAttach:false,adapterRetryAttempts:0})+'\n');assert.equal(readState(root).eligible,false);assert.equal(readState(root).nativeRecovery,true);
  fs.appendFileSync(trace,JSON.stringify({...frame,seconds:1,event:'started'})+'\n');assert.equal(readState(root).eligible,false);
  fs.appendFileSync(endpoint,'x');assert.throws(()=>readState(root),/Invalid weather endpoint/);
});
test('Windows file notifications trigger recovery and closing releases the watcher and pending timers',{skip:process.platform!=='win32'?'Compatibility recovery only starts on Windows':false},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-weather-watch-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'Native Hover.exe'),'fixture');fs.writeFileSync(path.join(root,'Taskbar Adapter Control.exe'),'fixture');
  let state={session:'fixture',ready:true,eligible:true,nativeRecovery:false},calls=0,finish;
  const called=new Promise(resolve=>finish=resolve);
  const recovery=new LegacyWeatherRecovery({directory:root,claimed:()=>true,read:()=>state,run:async()=>{++calls;state={...state,ready:true};finish();},timers:{set:(fn,ms)=>setTimeout(fn,ms===1000?10:ms),clear:clearTimeout}});
  t.after(()=>recovery.closeAndWait());recovery.start();state={...state,ready:false};fs.writeFileSync(path.join(root,'artifacts/native-hover.jsonl'),'fixture event');
  await Promise.race([called,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Watcher did not observe owned fixture')),2000);timer.unref();})]);
  await recovery.closeAndWait();assert.equal(calls,1);assert.equal(recovery.watcher,null);assert.equal(recovery.retry,null);assert.equal(recovery.stable,null);
});
