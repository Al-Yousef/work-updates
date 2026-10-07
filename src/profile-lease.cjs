'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {syncDirectory}=require('./private-store.cjs');
function alive(pid){try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
function readLease(file){try{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>2048)throw new Error('Invalid ownership record');const v=JSON.parse(fs.readFileSync(file));if(v.version!==1||!Number.isInteger(v.pid)||v.pid<=0||typeof v.token!=='string'||!/^[-a-f0-9]{36}$/.test(v.token))throw new Error('Invalid ownership record');return v;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function acquireLease(directory,name,{token=crypto.randomUUID(),isAlive=alive,updateToken=null}={}){
  fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,name);let fd;
  for(let attempt=0;attempt<3;attempt++){
    try{fd=fs.openSync(file,'wx',0o600);break;}catch(e){if(e.code!=='EEXIST')throw e;
      const previous=readLease(file);if(!previous)continue;if(isAlive(previous.pid))throw Object.assign(new Error('Hyphen maintenance or another backend owns this profile. Close the other instance before retrying.'),{code:'PROFILE_BUSY'});
      // Never steal a live or changed lease. A dead owner's exact token may be reclaimed.
      if(readLease(file)?.token!==previous.token)continue;fs.unlinkSync(file);syncDirectory(directory);
    }
  }
  if(fd===undefined)throw new Error('Profile ownership changed during startup');
  const value={version:1,pid:process.pid,token,updateToken,at:new Date().toISOString()};
  try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}catch(e){fs.closeSync(fd);try{fs.unlinkSync(file);}catch{}throw e;}fs.closeSync(fd);syncDirectory(directory);
  let closed=false;return {...value,file,close(){if(closed)return;closed=true;if(readLease(file)?.token===token){fs.unlinkSync(file);syncDirectory(directory);}}};
}
function acquireBackend(directory,{updateToken=process.env.HYPHEN_UPDATE_TOKEN}={}){
  const update=readLease(path.join(directory,'.update-lease.json'));
  if(update&&(!alive(update.pid)||update.token!==updateToken))throw Object.assign(new Error('Hyphen is being updated. Wait for recovery to finish before starting.'),{code:'UPDATE_IN_PROGRESS'});
  const lease=acquireLease(directory,'.backend-lease.json',{updateToken});
  // Close the check/acquire race with the installer.
  const current=readLease(path.join(directory,'.update-lease.json'));
  if(current&&(!alive(current.pid)||current.token!==updateToken)){lease.close();throw Object.assign(new Error('Hyphen maintenance began during startup. Retry after recovery.'),{code:'UPDATE_IN_PROGRESS'});}
  return lease;
}
function maintenanceActive(directory){return !!readLease(path.join(directory,'.update-lease.json'));}
module.exports={alive,readLease,acquireLease,acquireBackend,maintenanceActive};
