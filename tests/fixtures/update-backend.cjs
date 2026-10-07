'use strict';
// Disposable process: synthetic package identity and stores, no Electron,
// Codex, account, connector, shell integration or model calls.
const fs=require('node:fs'),path=require('node:path');
const {acquireBackend}=require('../../src/profile-lease.cjs');
const {atomicJSON,versions}=require('../../src/private-store.cjs');
const [directory,packageFile,token,mode='healthy']=process.argv.slice(2);
try{
  const lease=acquireBackend(directory,{updateToken:token});
  process.once('exit',()=>lease.close());
  const identity=JSON.parse(fs.readFileSync(packageFile));
  if(mode==='exit')process.exit(3);
  if(mode==='new-data'){
    const file=path.join(directory,'messages.json'),messages=JSON.parse(fs.readFileSync(file));messages.receipts['new-receipt']={id:'new-receipt',sourceId:'fixture-source',textHash:'b'.repeat(64),status:'sent',receipt:{turnId:'new-turn'}};atomicJSON(file,messages);
    atomicJSON(path.join(directory,'drafts.json'),{version:3,drafts:{'fixture-source':'Newer draft from candidate startup'},intentIds:{'fixture-source':'12345678-1234-1234-1234-123456789abc'},attachments:{}});
  }
  atomicJSON(path.join(directory,'runtime.json'),{...identity,appPid:process.pid,updateToken:token,packageHash:require('../../src/update-transaction.cjs').digest(packageFile),
    storeVersions:versions,updatedAt:mode==='stale'?1:Math.ceil(Date.now()/1000),health:{ok:true},assistant:{error:''},mode:'native-backend',windowCount:0,rendererCount:0});
  process.send?.({ready:true});process.on('message',message=>{if(message==='stop')process.exit(0);});
  setInterval(()=>{},1000);
}catch(e){process.send?.({error:e.message,code:e.code});process.exit(2);}
