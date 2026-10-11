'use strict';
const fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execute=promisify(execFile);
const delays=[1000,2000,4000,8000,16000,30000];
function installedDirectory({packaged,platform,demo,executable,dataDirectory}) {
  if(!packaged||platform!=='win32'||demo||!path.isAbsolute(executable)||!path.isAbsolute(dataDirectory))return null;
  if(path.basename(executable).toLowerCase()!=='work updates.exe'||path.basename(path.dirname(executable)).toLowerCase()!=='desktop')return null;
  const root=path.dirname(path.dirname(executable));
  return path.resolve(dataDirectory).toLowerCase()===path.join(root,'data/desktop').toLowerCase()?path.join(root,'native'):null;
}
function readState(directory) {
  const endpoint=path.join(directory,'artifacts/taskbar-adapter.info'),trace=path.join(directory,'artifacts/native-hover.jsonl');
  const st=fs.lstatSync(endpoint);if(!st.isFile()||st.isSymbolicLink()||st.size!==32)throw new Error('Invalid weather endpoint');
  const bytes=fs.readFileSync(endpoint),pid=bytes.readUInt32LE(24);
  if(bytes.readBigUInt64LE(0)!==0x3152414254575557n||bytes.readUInt32LE(28)!==1||!pid||!bytes.readBigUInt64LE(8)||!bytes.readBigUInt64LE(16))throw new Error('Invalid weather session');
  process.kill(pid,0);
  const stat=fs.lstatSync(trace);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Invalid weather trace');
  const fd=fs.openSync(trace,'r'),length=Math.min(stat.size,65536),buffer=Buffer.alloc(length);
  try{fs.readSync(fd,buffer,0,length,stat.size-length);}finally{fs.closeSync(fd);}
  const lines=buffer.toString('utf8').split('\n');if(stat.size>length)lines.shift();
  for(let i=lines.length-1;i>=0;--i){
    let frame;try{frame=JSON.parse(lines[i]);}catch{continue;}
    if(frame.pid!==pid||typeof frame.adapterReady!=='boolean')continue;
    // Native trace seconds are system uptime, not this native session's age.
    const settled=frame.adapterReady||Date.now()-st.mtimeMs>=12000||['adapter-stopped','adapter-failed','adapter-attach-failed','adapter-controller-finished'].includes(frame.event);
    return {session:pid+':'+bytes.readBigUInt64LE(8).toString(16),ready:frame.adapterReady,
      eligible:settled&&frame.taskbarAdapter===true&&frame.adapterAutoAttach===true&&frame.cornerCoordinated===true,
      nativeRecovery:Number.isSafeInteger(frame.adapterRetryAttempts)};
  }
  throw new Error('Current native weather state is unavailable');
}
class LegacyWeatherRecovery {
  constructor({directory,claimed,log,read=()=>readState(directory),run=execute,timers={set:setTimeout,clear:clearTimeout}}) {
    this.directory=directory;this.claimed=claimed;this.log=log;this.read=read;this.run=run;this.timers=timers;
    this.session=null;this.attempts=0;this.closed=false;this.enabled=false;this.retry=null;this.stable=null;this.stableReady=false;this.flight=null;
  }
  status(){return {active:!this.closed&&this.enabled,attempts:this.attempts,pending:!!this.retry,running:!!this.flight};}
  cancel(){if(this.retry)this.timers.clear(this.retry);if(this.stable)this.timers.clear(this.stable);this.retry=null;this.stable=null;this.stableReady=false;}
  sample(){try{return this.claimed()?this.read():null;}catch{return null;}}
  refresh(){this.observe(this.sample());}
  observe(value) {
    if(this.closed)return;
    if(!value?.eligible||value.nativeRecovery){this.cancel();this.enabled=false;return;}
    this.enabled=true;
    if(this.session!==value.session){this.cancel();this.session=value.session;this.attempts=0;}
    if(value.ready){
      if(this.retry)this.timers.clear(this.retry);this.retry=null;
      if(!this.stable&&!this.stableReady){const session=this.session;this.stable=this.timers.set(()=>{
        this.stable=null;const current=this.sample();
        if(!this.closed&&current?.session===session&&current.ready&&current.eligible&&!current.nativeRecovery){this.attempts=0;this.stableReady=true;}
      },30000);this.stable.unref?.();}
      return;
    }
    if(this.stable)this.timers.clear(this.stable);this.stable=null;this.stableReady=false;
    if(this.retry||this.flight||this.attempts>=delays.length)return;
    const session=this.session,delay=delays[this.attempts++];
    this.retry=this.timers.set(()=>{this.retry=null;this.attach(session);},delay);this.retry.unref?.();
  }
  attach(session) {
    const current=this.sample();
    if(this.closed||this.flight||current?.session!==session||!current.eligible||current.nativeRecovery||current.ready){this.observe(current);return;}
    this.log?.write('native.weather.recovery.started',{count:this.attempts});
    // The existing controller verifies Explorer, the exact supported taskbar,
    // sibling native process, HWND and cookie. No arbitrary PID or input API.
    this.flight=Promise.resolve().then(()=>this.run(path.join(this.directory,'Taskbar Adapter Control.exe'),['--attach'],{windowsHide:true,timeout:10000,maxBuffer:4096}))
      .then(()=>this.log?.write('native.weather.recovery.completed',{count:this.attempts}),()=>this.log?.write('native.weather.recovery.failed',{count:this.attempts}))
      .finally(()=>{this.flight=null;if(!this.closed)this.refresh();});
  }
  start() {
    if(this.closed||this.watcher)throw new Error('Weather recovery already started or closed');
    const directory=path.join(this.directory,'artifacts');
    if(!fs.existsSync(path.join(this.directory,'Native Hover.exe'))||!fs.existsSync(path.join(this.directory,'Taskbar Adapter Control.exe')))return;
    fs.mkdirSync(directory,{recursive:true});
    if(fs.lstatSync(directory).isSymbolicLink())throw new Error('Linked weather artifacts are unavailable');
    this.watcher=fs.watch(directory,(_event,name)=>{if(name==='native-hover.jsonl'||name==='taskbar-adapter.info')this.refresh();});
    this.watcher.on('error',()=>{this.log?.write('native.weather.recovery.watch-failed',{});this.closeAndWait();});
    this.watcher.unref?.();this.refresh();
  }
  async closeAndWait(){this.closed=true;this.cancel();this.watcher?.close();this.watcher=null;await this.flight;}
}
module.exports={LegacyWeatherRecovery,installedDirectory,readState};
