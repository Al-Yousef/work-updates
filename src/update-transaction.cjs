'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {atomicJSON,inspectStores,syncDirectory,versions}=require('./private-store.cjs');
const {acquireLease,readLease,alive}=require('./profile-lease.cjs');
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const phases=['prepared','staged','stopping','stopped','replacing','replaced','starting','healthy','launching','committed','rolling-back','rolled-back','recovery-required'];
const roles=new Map([['backend','desktop/resources/app.asar'],['collector','desktop/resources/helper/collector.exe'],['native-ui','native/Native Hover.exe'],['native-launcher','native/Start Native Preview.exe']]);
function inside(root,relative){
  if(typeof relative!=='string'||relative.includes('\\')||relative.includes(':')||relative.split('/').some(x=>!x||x==='.'||x==='..'))throw new Error('Invalid update path');
  const resolved=path.resolve(root,...relative.split('/'));for(let next=resolved;next!==root;next=path.dirname(next)){
    try{if(fs.lstatSync(next).isSymbolicLink())throw new Error('Linked update paths are not supported');}catch(e){if(e.code!=='ENOENT')throw e;}}
  return resolved;
}
function program(value){return value&&/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.version)&&hash(value.sourceHash)&&value.protocols?.descriptor===1&&value.protocols?.snapshot===1&&
  Object.keys(versions).every(name=>Array.isArray(value.stores?.[name])&&value.stores[name].length>0&&value.stores[name].every(v=>Number.isInteger(v)&&v>=0&&v<=versions[name]));}
function validateManifest(value){
  if(value?.schema!==1||value.product!=='Hyphen'||!/^[a-f0-9]{40}$/.test(value.sourceRevision||'')||!program(value.candidate)||!program(value.baseline)||
    !Array.isArray(value.components)||!value.components.length||value.components.length>roles.size||!value.components.some(c=>c.role==='backend')||
    new Set(value.components.map(c=>c.role)).size!==value.components.length||value.components.some(c=>roles.get(c.role)!==c.path||!hash(c.sha256)||!hash(c.baselineSha256)||typeof c.file!=='string')||
    !value.sourceHashes||typeof value.sourceHashes!=='object'||!Object.keys(value.sourceHashes).length||Object.values(value.sourceHashes).some(v=>!hash(v)))throw new Error('Invalid or incompatible update manifest');
  if(value.resident&&(value.resident.path!=='native/WorkUpdatesTaskbar-v2.dll'||!hash(value.resident.sha256)))throw new Error('Invalid resident adapter identity');
  return value;
}
function copyDurable(source,target){const bytes=fs.readFileSync(source);fs.mkdirSync(path.dirname(target),{recursive:true});const fd=fs.openSync(target,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(path.dirname(target));}
function ready(record,{pid,token,manifest,startedAt,now=Date.now(),baseline=false}){
  const p=baseline?manifest.baseline:manifest.candidate;
  const packageHash=manifest.components.find(c=>c.role==='backend')[baseline?'baselineSha256':'sha256'];
  return record?.appPid===pid&&record.updateToken===token&&record.version===p.version&&record.sourceHash===p.sourceHash&&record.packageHash===packageHash&&
    record.protocols?.descriptor===p.protocols.descriptor&&record.protocols?.snapshot===p.protocols.snapshot&&
    Number.isFinite(record.updatedAt)&&record.updatedAt*1000>=startedAt&&record.updatedAt*1000<=now+5000&&now-record.updatedAt*1000<=12000&&
    record.health?.ok===true&&!record.assistant?.error&&record.mode==='native-backend'&&record.windowCount===0&&record.rendererCount===0&&
    Object.keys(versions).every(name=>p.stores[name].includes(record.storeVersions?.[name]));
}
class UpdateTransaction{
  constructor({installRoot,dataDirectory,packageDirectory,sourceRoot,hooks,checkpoint=()=>{}}){
    for(const v of [installRoot,dataDirectory,packageDirectory,sourceRoot])if(!path.isAbsolute(v))throw new Error('Update roots must be absolute');
    this.root=fs.realpathSync(installRoot);this.data=fs.realpathSync(dataDirectory);this.package=fs.realpathSync(packageDirectory);this.source=fs.realpathSync(sourceRoot);this.hooks=hooks;this.checkpoint=checkpoint;
    this.journalFile=path.join(this.data,'update-journal.json');this.state=null;this.lease=null;
  }
  phase(phase,extra={}){this.state={...this.state,...extra,phase,updatedAt:new Date().toISOString()};atomicJSON(this.journalFile,this.state);this.checkpoint(phase,this.state);}
  verifySources(manifest){for(const [relative,expected]of Object.entries(manifest.sourceHashes))if(digest(inside(this.source,relative))!==expected)throw new Error('Update source changed after packaging');}
  verifyResident(manifest){if(manifest.resident&&digest(inside(this.root,manifest.resident.path))!==manifest.resident.sha256)throw new Error('The resident adapter changed independently. Backend maintenance cannot replace it.');}
  privateIdle(){const lease=readLease(path.join(this.data,'.backend-lease.json'));if(lease&&alive(lease.pid))throw new Error('A backend still owns private storage');}
  async run(manifest){
    validateManifest(manifest);this.lease=acquireLease(this.data,'.update-lease.json');
    try{
      const old=this.readJournal();if(old&&!['committed','rolled-back'].includes(old.phase))throw new Error('An interrupted update must be recovered first');
      this.verifySources(manifest);this.verifyResident(manifest);inspectStores(this.data,manifest.candidate.stores);inspectStores(this.data,manifest.baseline.stores);
      for(const c of manifest.components){if(digest(inside(this.package,c.file))!==c.sha256||digest(inside(this.root,c.path))!==c.baselineSha256)throw new Error('The installed or candidate component identity changed');}
      await this.hooks.assertIdle(manifest);
      const directory=inside(this.root,'updates/'+crypto.randomUUID());fs.mkdirSync(directory,{recursive:true});
      this.state={schema:1,token:this.lease.token,phase:'prepared',directory:path.relative(this.root,directory).replaceAll(path.sep,'/'),manifest,applied:[],pending:null};
      this.phase('prepared');
      for(let i=0;i<manifest.components.length;i++){const c=manifest.components[i];copyDurable(inside(this.root,c.path),path.join(directory,`${i}.backup`));copyDurable(inside(this.package,c.file),path.join(directory,`${i}.stage`));
        if(digest(path.join(directory,`${i}.stage`))!==c.sha256||digest(path.join(directory,`${i}.backup`))!==c.baselineSha256)throw new Error('Staged update identity changed');}
      this.phase('staged');this.phase('stopping');await this.hooks.stop(manifest);this.privateIdle();this.verifyResident(manifest);inspectStores(this.data,manifest.candidate.stores);this.phase('stopped');
      for(let i=0;i<manifest.components.length;i++){
        const c=manifest.components[i],target=inside(this.root,c.path);if(digest(target)!==c.baselineSha256)throw new Error('A component changed while stopping');
        this.phase('replacing',{pending:i});
        // Same-volume staged file is renamed over the target atomically.
        fs.renameSync(path.join(directory,`${i}.stage`),target);syncDirectory(path.dirname(target));
        if(digest(target)!==c.sha256)throw new Error('Replacement hash mismatch');
        this.state.applied.push(i);this.phase('replacing',{pending:null});
      }
      this.phase('replaced');this.phase('starting');await this.hooks.start({token:this.lease.token,manifest,baseline:false,onStarted:pid=>this.phase('starting',{startedPid:pid})});this.phase('healthy');
      inspectStores(this.data,manifest.candidate.stores);this.verifyResident(manifest);
      this.phase('launching');await this.hooks.launch({manifest,baseline:false});this.phase('committed');
      return {installed:true,phase:this.state.phase,version:manifest.candidate.version};
    }catch(error){
      if(error.simulatedInterruption)throw error;
      if(this.state&&!['committed','rolled-back'].includes(this.state.phase))try{await this.rollback();}catch(recovery){error.recovery=recovery.message;}
      throw error;
    }finally{this.lease.close();}
  }
  readJournal(){
    try{const st=fs.lstatSync(this.journalFile);if(!st.isFile()||st.isSymbolicLink()||st.size>1024*1024)throw new Error('Invalid update journal');
      const v=JSON.parse(fs.readFileSync(this.journalFile));if(v.schema!==1||!/^[a-f0-9-]{36}$/.test(v.token||'')||(v.startedPid!==undefined&&(!Number.isInteger(v.startedPid)||v.startedPid<=0))||!phases.includes(v.phase)||!Array.isArray(v.applied)||new Set(v.applied).size!==v.applied.length||v.applied.some(i=>!Number.isInteger(i)||i<0||i>=v.manifest?.components?.length)||
        !(v.pending===null||Number.isInteger(v.pending)&&v.pending>=0&&v.pending<v.manifest?.components?.length)||typeof v.directory!=='string')throw new Error('Invalid update journal');
      validateManifest(v.manifest);inside(this.root,v.directory);return v;
    }catch(e){if(e.code==='ENOENT')return null;throw new Error('Update journal needs repair. Preserve it and all program backups before retrying.');}
  }
  async rollback(){
    const manifest=this.state.manifest;
    try{
      const priorPhase=this.state.phase;this.phase('rolling-back');await this.hooks.stop(manifest,{recovery:true,priorPhase,startedPid:this.state.startedPid,updateToken:this.state.token});this.privateIdle();
      // Data is checked in place and NEVER restored from a package backup.
      inspectStores(this.data,manifest.baseline.stores);this.verifyResident(manifest);
      const directory=inside(this.root,this.state.directory);
      for(let i=manifest.components.length-1;i>=0;i--){const c=manifest.components[i],target=inside(this.root,c.path),current=digest(target);
        if(current===c.baselineSha256)continue;
        if(current!==c.sha256)throw new Error('Rollback refuses to replace an independently changed component');
        const backup=path.join(directory,`${i}.backup`);if(digest(backup)!==c.baselineSha256)throw new Error('Rollback backup identity changed');
        this.phase('rolling-back',{rollbackPending:i});
        const stage=path.join(directory,`${i}.rollback-${crypto.randomUUID()}`);copyDurable(backup,stage);fs.renameSync(stage,target);syncDirectory(path.dirname(target));
        this.phase('rolling-back',{rollbackPending:null});
      }
      this.state.token=this.lease.token;
      await this.hooks.start({token:this.lease.token,manifest,baseline:true,onStarted:pid=>this.phase('rolling-back',{startedPid:pid})});await this.hooks.launch({manifest,baseline:true});this.phase('rolled-back');
      return {installed:false,recovered:true,phase:this.state.phase,version:manifest.baseline.version};
    }catch(error){this.phase('recovery-required');throw error;}
  }
  async recover(){this.lease=acquireLease(this.data,'.update-lease.json');try{
    this.state=this.readJournal();if(!this.state||['committed','rolled-back'].includes(this.state.phase))return {recovered:false,phase:this.state?.phase||'none'};
    return await this.rollback();
  }finally{this.lease.close();}}
}
module.exports={UpdateTransaction,validateManifest,ready,inside,digest,roles};
