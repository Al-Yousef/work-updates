'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {fork}=require('node:child_process');
const {once}=require('node:events');
const {atomicJSON}=require('../../src/private-store.cjs');
const {UpdateTransaction,digest,ready}=require('../../src/update-transaction.cjs');
const compatibility=require('../../src/update-compatibility.json');
async function fixture(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-update-fixture-')),installRoot=path.join(directory,'install'),dataDirectory=path.join(installRoot,'data/desktop'),packageDirectory=path.join(directory,'package'),sourceRoot=path.join(directory,'source');
  for(const dir of [dataDirectory,packageDirectory,sourceRoot,path.join(installRoot,'desktop/resources'),path.join(installRoot,'native')])fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(sourceRoot,'main.cjs'),'synthetic source');
  const program=version=>({version,sourceHash:digest(path.join(sourceRoot,'main.cjs')),protocols:compatibility.protocols,stores:compatibility.stores});
  const baseline=program('0.6.9'),candidate=program('0.6.10');
  const original=path.join(installRoot,'desktop/resources/app.asar'),updated=path.join(packageDirectory,'app.asar');atomicJSON(original,baseline);atomicJSON(updated,candidate);
  const resident=path.join(installRoot,'native/WorkUpdatesTaskbar-v2.dll');fs.writeFileSync(resident,'resident fixture bytes');
  atomicJSON(path.join(dataDirectory,'state.json'),{version:1,tasks:[],cards:{},done:{},groups:[],settings:{}});
  atomicJSON(path.join(dataDirectory,'messages.json'),{version:1,entries:[{id:'stable-intent',sourceId:'fixture-source',status:'queued',mode:'queue',text:'Keep this queued message',textHash:'a'.repeat(64)}],barriers:{},receipts:{}});
  atomicJSON(path.join(dataDirectory,'assistant.json'),{version:2,messages:[],notes:[],receipts:{},seen:null,focus:null});
  atomicJSON(path.join(dataDirectory,'device.json'),{version:1,id:'12345678-1234-1234-1234-123456789abc',kind:'pc',name:'Fixture PC',label:'Windows PC'});
  atomicJSON(path.join(dataDirectory,'drafts.json'),{version:3,drafts:{'fixture-source':'Original draft'},intentIds:{'fixture-source':'12345678-1234-1234-1234-123456789abc'},attachments:{}});
  const manifest={schema:1,product:'Hyphen',sourceRevision:'a'.repeat(40),sourceHashes:{'main.cjs':digest(path.join(sourceRoot,'main.cjs'))},candidate,baseline,
    components:[{role:'backend',path:'desktop/resources/app.asar',file:'app.asar',sha256:digest(updated),baselineSha256:digest(original)}],resident:{path:'native/WorkUpdatesTaskbar-v2.dll',sha256:digest(resident)}};
  let child=null,starts=0,launches=0,mode='healthy',failLaunch=false;
  const stop=async()=>{if(!child)return;const target=child;child=null;if(target.exitCode===null&&target.signalCode===null){const exited=once(target,'exit');target.send('stop');await exited;}};
  const hooks={async assertIdle(){},stop,async start({token,manifest,baseline,onStarted}){
    starts++;const startedAt=Date.now();child=fork(path.join(__dirname,'update-backend.cjs'),[dataDirectory,original,token,baseline?'healthy':mode],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});let errors='';child.stderr.on('data',v=>errors+=v);onStarted?.(child.pid);
    const outcome=await Promise.race([once(child,'message').then(([v])=>v),once(child,'exit').then(([code])=>({error:'backend exited '+code}))]);
    if(outcome.error)throw new Error(outcome.error+errors);
    const value=JSON.parse(fs.readFileSync(path.join(dataDirectory,'runtime.json')));if(!ready(value,{pid:child.pid,token,manifest,startedAt,baseline}))throw new Error('matching fresh readiness was not published');
  },async launch({baseline}){launches++;if(failLaunch&&!baseline)throw new Error('launcher failed');}};
  return {directory,installRoot,dataDirectory,packageDirectory,sourceRoot,manifest,hooks,original,updated,resident,
    get starts(){return starts;},get launches(){return launches;},get pid(){return child?.pid;},set mode(value){mode=value;},set failLaunch(value){failLaunch=value;},
    transaction(options={}){return new UpdateTransaction({...this,hooks,...options});},async close(){await stop();fs.rmSync(directory,{recursive:true,force:true});}};
}
module.exports={fixture};
