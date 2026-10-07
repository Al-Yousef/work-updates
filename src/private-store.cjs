'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const strings=(v,max=12000)=>object(v)&&Object.entries(v).every(([k,x])=>k.length>0&&k.length<512&&typeof x==='string'&&x.length<=max);
const versions=Object.freeze({'state.json':1,'messages.json':1,'assistant.json':2,'device.json':1,'drafts.json':3,'responsibilities.json':1,'schedules.json':1,'authorizations.json':1,'commitments.json':1,'delegations.json':1,'research.json':1,'work-controls.json':1,'reflections.json':1,'triage.json':1,'activity.json':1,'outcomes.json':1,'privacy.json':1,'executors.json':1,'documents.json':1,'voice.json':1});
class StorageRecoveryError extends Error {
  constructor(file,reason){super(`Hyphen cannot safely load ${path.basename(file)} (${reason}). The original file is preserved. Close Hyphen and repair a copy before restarting.`);this.code='PRIVATE_STORE_RECOVERY';this.store=path.basename(file);}
}
function syncDirectory(directory){let fd;try{fd=fs.openSync(directory,'r');fs.fsyncSync(fd);}catch(e){if(!['EINVAL','ENOTSUP','EPERM','EISDIR','EACCES'].includes(e.code))throw e;}finally{if(fd!==undefined)fs.closeSync(fd);}}
function atomicJSON(file,value,{beforeReplace}={}){
  fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';let fd;
  try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    beforeReplace?.();fs.renameSync(tmp,file);syncDirectory(path.dirname(file));
  }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
function validate(name,value){
  if(!object(value))throw new Error('invalid object');
  let result=structuredClone(value),migrated=false;
  if(name==='device.json'&&result.version===undefined){result.version=1;migrated=true;}
  if(name==='drafts.json'&&result.version===undefined){
    // The original native format was a source-to-text map.
    if(!strings(result,48000))throw new Error('invalid legacy drafts');
    result={version:3,drafts:result,intentIds:{},attachments:{}};migrated=true;
  }
  const supported=name==='assistant.json'?[1,2]:name==='drafts.json'?[1,2,3]:[versions[name]];
  if(!supported.includes(result.version))throw new Error('unsupported version');
  if(name==='documents.json'){
    require('./documents.cjs').validate(result);
  }else if(name==='voice.json'){
    require('./voice-session.cjs').validate(result);
  }else if(name==='privacy.json'){
    require('./privacy.cjs').validate(result);
  }else if(name==='executors.json'){
    require('./executor-bindings.cjs').validate(result);
  }else if(name==='outcomes.json'){
    require('./outcome-verification.cjs').validate(result);
  }else if(name==='work-controls.json'){
    require('./work-controls.cjs').validate(result);
  }else if(name==='reflections.json'){
    require('./reflections.cjs').validate(result);
  }else if(name==='activity.json'){
    require('./activity.cjs').validate(result);
  }else if(name==='triage.json'){
    require('./triage.cjs').validate(result);
  }else if(name==='research.json'){
    require('./research.cjs').validate(result);
  }else if(name==='delegations.json'){
    require('./delegations.cjs').validate(result);
  }else if(name==='authorizations.json'){
    require('./authorization.cjs').validate(result);
  }else if(name==='commitments.json'){
    require('./commitments.cjs').validate(result);
  }else if(name==='schedules.json'){
    require('./schedules.cjs').validate(result);
  }else if(name==='responsibilities.json'){
    require('./responsibilities.cjs').validate(result);
  }else if(name==='state.json'){
    if(!Array.isArray(result.tasks)||result.tasks.length>10000||result.tasks.some(t=>!object(t)||typeof t.id!=='string'||!t.id||!['queued','starting','working','ready','needs','blocked','waiting','unknown','done'].includes(t.status)||(t.adoptedTaskKey!==undefined&&(typeof t.adoptedTaskKey!=='string'||!t.adoptedTaskKey||t.adoptedTaskKey.length>512)))||
      ['cards','done','settings'].some(k=>result[k]!==undefined&&!object(result[k]))||(result.groups!==undefined&&!Array.isArray(result.groups)))throw new Error('invalid queue');
  }else if(name==='messages.json'){
    if(!Array.isArray(result.entries)||result.entries.length>10000||!object(result.barriers)||result.entries.some(e=>!object(e)||typeof e.id!=='string'||!e.id||typeof e.sourceId!=='string'||!e.sourceId||!['queued','sending','sent','cancelled','uncertain','failed'].includes(e.status)||
      (e.text!==undefined&&(typeof e.text!=='string'||e.text.length>12000))||(e.expiresAt!==undefined&&(!Number.isSafeInteger(e.expiresAt)||e.expiresAt<=0||e.expiresAt>8640000000000000)))||(result.receipts!==undefined&&!object(result.receipts)))throw new Error('invalid message intents');
    result.receipts??={};
    if(Object.entries(result.receipts).some(([id,r])=>!object(r)||r.id!==id||typeof r.sourceId!=='string'||!['sent','cancelled'].includes(r.status)))throw new Error('invalid receipts');
  }else if(name==='assistant.json'){
    if(!Array.isArray(result.messages)||result.messages.length>(result.version===1?100:540)||!Array.isArray(result.notes)||result.notes.length>32||result.notes.some(n=>typeof n!=='string'||n.length>1000)||!object(result.receipts)||
      result.messages.some(m=>!object(m)||typeof m.id!=='string'||typeof m.text!=='string'||m.text.length>4000||!['thinking','completed','failed'].includes(m.status)||!Array.isArray(m.links)||m.links.length>3||m.links.some(l=>!object(l)||typeof l.chatName!=='string'||typeof l.draft!=='string'||l.draft.length>12000)||
        (m.answer!==undefined&&(typeof m.answer!=='string'||m.answer.length>6000))||(m.images!==undefined&&(!Array.isArray(m.images)||m.images.length>4||m.images.some(i=>!object(i)||typeof i.id!=='string'||typeof i.path!=='string'||i.path.length>32768)))))throw new Error('invalid assistant history');
    if(result.seen!=null&&(!object(result.seen)||Object.keys(result.seen).length>2048))throw new Error('invalid observation state');
    if(result.focus!=null&&(!object(result.focus)||!result.focus.id||!result.focus.sourceId||!result.focus.ownerId))throw new Error('invalid focus');
    if(result.historySelection!==undefined&&(!Array.isArray(result.historySelection)||result.historySelection.length>20||result.historySelection.some(x=>typeof x!=='string'||x.length>100)))throw new Error('invalid history selection');
  }else if(name==='device.json'){
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.id||'')||['name','label','kind'].some(k=>typeof result[k]!=='string'||result[k].length>200))throw new Error('invalid device identity');
  }else if(name==='drafts.json'){
    if(!strings(result.drafts,48000))throw new Error('invalid drafts');
    result.attachments??={};result.intentIds??={};
    if(!object(result.attachments)||!object(result.intentIds)||Object.entries(result.attachments).some(([k,a])=>!k||k.length>=512||!Array.isArray(a)||a.length>4||a.some(i=>!object(i)||typeof i.id!=='string'||!i.id||typeof i.path!=='string'||i.path.length>=32768))||
      Object.entries(result.intentIds).some(([k,id])=>!Object.hasOwn(result.drafts,k)&&!Object.hasOwn(result.attachments,k)||typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id)))throw new Error('invalid draft identities');
    if(result.version!==3){result.version=3;migrated=true;}
  }
  return {value:result,migrated,version:value.version??0};
}
function readStore(file,{missing}={}){
  const name=path.basename(file);if(!Object.hasOwn(versions,name))throw new Error('Unknown private store');
  let bytes;try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32*1024*1024)throw new Error('invalid file');bytes=fs.readFileSync(file);}
  catch(e){if(e.code==='ENOENT')return {value:typeof missing==='function'?missing():structuredClone(missing),missing:true,migrated:false,version:null};throw new StorageRecoveryError(file,'unreadable file');}
  try{return {...validate(name,JSON.parse(bytes)),missing:false};}catch(e){throw new StorageRecoveryError(file,e.message==='unsupported version'?'unsupported version':'invalid contents');}
}
function inspectStores(directory,supported){
  const result={};for(const name of Object.keys(versions)){const store=readStore(path.join(directory,name));if(store.missing)continue;
    if(supported&&!supported[name]?.includes(store.version))throw new StorageRecoveryError(name,'incompatible program version');
    result[name]={version:store.version,migrated:store.migrated};}
  return result;
}
module.exports={versions,StorageRecoveryError,atomicJSON,readStore,validate,inspectStores,syncDirectory};
