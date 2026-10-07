'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {ready,inside}=require('../src/update-transaction.cjs');
const {readLease}=require('../src/profile-lease.cjs');
const execute=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms));
function control(directory,method){return new Promise((resolve,reject)=>{
  const file=path.join(directory,'native-control.info'),st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>4096)throw new Error('Invalid native control descriptor');
  const [magic,pipe,token]=fs.readFileSync(file,'utf8').split('\n');if(magic!=='work-updates-native-v1'||!pipe||!token)throw new Error('Unsupported native control descriptor');
  const socket=net.createConnection(pipe);let response='';socket.setTimeout(3000,()=>socket.destroy(new Error('Native maintenance timed out')));
  socket.on('connect',()=>socket.write(JSON.stringify({method,token})+'\n'));socket.setEncoding('utf8');socket.on('error',reject);
  socket.on('data',bytes=>{response+=bytes;if(response.length>65536)return socket.destroy(new Error('Oversized maintenance response'));if(response.includes('\n')){try{const value=JSON.parse(response.split('\n')[0]);if(!value.ok)throw new Error(value.error||'Maintenance refused');resolve(value.value||{});}catch(e){reject(e);}finally{socket.destroy();}}});
});}
function windowsHooks({installRoot,dataDirectory,demo=false}){
  if(process.platform!=='win32')throw new Error('This portable installer supports Windows. Other platforms need their own ownership and launch adapters.');
  const root=fs.realpathSync(installRoot),directory=fs.realpathSync(dataDirectory),exe=inside(root,'desktop/Work Updates.exe'),launcher=inside(root,'native/Start Native Preview.exe');
  const environment={...process.env,HYPHEN_INSTALL_ROOT:root};delete environment.ELECTRON_RUN_AS_NODE;
  const runtime=()=>JSON.parse(fs.readFileSync(path.join(directory,'runtime.json'),'utf8'));
  const owner=async pid=>{const {stdout}=await execute('pwsh',['-NoProfile','-File',path.join(__dirname,'update-owner.ps1'),'-InstallRoot',root,'-DataDirectory',directory,...(pid?['-ExpectedPid',String(pid)]:[])],{windowsHide:true,timeout:10000,maxBuffer:65536});return JSON.parse(stdout);};
  const idle=async()=>{
    const identity=await owner();if(!identity.pid){if(identity.processes.length)throw new Error('A native component is still running without a backend');return identity;}
    const value=runtime(),age=Date.now()/1000-value.updatedAt;
    if(value.appPid!==identity.pid||!Number.isFinite(age)||age< -5||age>12||value.mode!=='native-backend'||!value.health?.ok||value.codex?.active!==0||(value.codex?.pending??(demo?0:-1))!==0||value.messages?.active!==0||value.assistant?.active||value.desktop?.pending!==0)throw new Error('Hyphen is busy or ownership is not fresh enough for maintenance');
    const status=await control(directory,'status');if(status.pid!==identity.pid||status.activeWriters!==0)throw new Error('Hyphen refused idle maintenance');return identity;
  };
  let child=null;
  return {
    assertIdle:idle,
    async stop(manifest,{recovery=false,startedPid,updateToken}={}){
      let identity;
      if(recovery&&startedPid){
        identity=await owner();if(identity.pid){
          const lease=readLease(path.join(directory,'.backend-lease.json'));
          if(identity.pid!==startedPid||lease?.pid!==identity.pid||lease.updateToken!==updateToken)throw new Error('Recovery backend ownership changed; automatic shutdown was refused');
          const status=await control(directory,'status');if(status.pid!==identity.pid||status.activeWriters!==0)throw new Error('Recovery backend is handling work; keep the journal and retry when idle');
        }
      }else identity=await idle();
      if(identity.pid)await control(directory,'quitIfIdle');
      if(identity.native.length){const result=await execute(launcher,['--exit'],{windowsHide:true,timeout:7000,maxBuffer:65536,env:environment});if(result.stderr)throw new Error('The native launcher could not stop its UI');}
      const deadline=Date.now()+8000;while(Date.now()<deadline){const remaining=await owner();if(!remaining.processes.length){child=null;return;}await pause(100);}
      throw new Error('The owned backend or native UI did not release the installation');
    },
    async start({token,manifest,baseline,onStarted}){
      const startedAt=Math.floor(Date.now()/1000)*1000;
      child=spawn(exe,[...(demo?['--demo']:[]),'--native-backend','--hidden','--data-dir',directory],{windowsHide:true,stdio:'ignore',env:{...environment,HYPHEN_UPDATE_TOKEN:token}});
      let spawnError;child.once('error',e=>{spawnError=e;});if(child.pid)onStarted?.(child.pid);const deadline=Date.now()+15000;
      while(Date.now()<deadline){if(spawnError)throw spawnError;if(child.exitCode!==null||child.signalCode!==null)throw new Error('The update backend exited before becoming healthy');
        try{if(ready(runtime(),{pid:child.pid,token,manifest,startedAt,baseline})){await owner(child.pid);return;}}catch(e){if(!['ENOENT'].includes(e.code)&&!(e instanceof SyntaxError))throw e;}
        await pause(100);
      }
      throw new Error('The update backend did not publish matching fresh readiness');
    },
    async launch(){
      const result=await execute(launcher,['--no-auto-attach'],{windowsHide:true,timeout:7000,maxBuffer:65536,env:environment});if(result.stderr)throw new Error('The native launcher did not complete cleanly');
      const deadline=Date.now()+5000;while(Date.now()<deadline){const identity=await owner();if(identity.pid===child?.pid&&identity.native.length===1){const status=await control(directory,'status');if(status.pid===child.pid&&status.cornerOwner==='native')return;}await pause(100);}
      throw new Error('The native launcher did not claim the matching backend');
    },
  };
}
module.exports={windowsHooks,control};
