'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./fixtures/update-profile.cjs');
const {digest,validateManifest,ready}=require('../src/update-transaction.cjs');
const {acquireBackend,acquireLease,readLease}=require('../src/profile-lease.cjs');
const store=(f,name)=>JSON.parse(fs.readFileSync(path.join(f.dataDirectory,name)));
const phases=['prepared','staged','stopping','stopped','replacing','replaced','starting','healthy','launching'];
test('interruption between atomic component replacements recovers every component independently',async t=>{
  const f=await fixture();t.after(()=>f.close());const target=path.join(f.installRoot,'desktop/resources/helper/collector.exe');fs.mkdirSync(path.dirname(target));fs.writeFileSync(target,'prior collector');const next=path.join(f.packageDirectory,'collector.exe');fs.writeFileSync(next,'candidate collector');
  f.manifest.components.push({role:'collector',path:'desktop/resources/helper/collector.exe',file:'collector.exe',sha256:digest(next),baselineSha256:digest(target)});
  let crash=false;await assert.rejects(f.transaction({checkpoint:(p,s)=>{if(p==='replacing'&&s.pending===null&&!crash){crash=true;throw Object.assign(new Error('post-replacement interruption'),{simulatedInterruption:true});}}}).run(f.manifest));
  assert.equal(digest(f.original),f.manifest.components[0].sha256);assert.equal(fs.readFileSync(target,'utf8'),'prior collector');
  await f.transaction().recover();assert.equal(digest(f.original),f.manifest.components[0].baselineSha256);assert.equal(fs.readFileSync(target,'utf8'),'prior collector');
});
test('a second interruption during rollback can be resumed without restoring private backups',async t=>{
  const f=await fixture();t.after(()=>f.close());await assert.rejects(f.transaction({checkpoint:p=>{if(p==='replaced')throw Object.assign(new Error('crash'),{simulatedInterruption:true});}}).run(f.manifest));
  let crash=false;await assert.rejects(f.transaction({checkpoint:(p,s)=>{if(p==='rolling-back'&&s.rollbackPending===null&&!crash){crash=true;throw Object.assign(new Error('rollback interruption'),{simulatedInterruption:true});}}}).recover());
  await f.transaction().recover();assert.equal(digest(f.original),f.manifest.components[0].baselineSha256);assert.equal(store(f,'messages.json').entries[0].id,'stable-intent');
});
test('a healthy disposable backend process prevents a second process from owning its stores',async t=>{
  const f=await fixture();t.after(()=>f.close());await f.transaction().run(f.manifest);assert.ok(f.pid);
  assert.throws(()=>acquireBackend(f.dataDirectory),{code:'PROFILE_BUSY'});
});
for(const phase of phases)test('interrupted update recovers program and retained intents after '+phase,async t=>{
  const f=await fixture();t.after(()=>f.close());let interrupted=false;
  const transaction=f.transaction({checkpoint:p=>{if(p===phase&&!interrupted){interrupted=true;throw Object.assign(new Error('fixture interruption'),{simulatedInterruption:true});}}});
  await assert.rejects(transaction.run(f.manifest),/fixture interruption/);
  const result=await f.transaction().recover();assert.equal(result.phase,'rolled-back');assert.equal(digest(f.original),f.manifest.components[0].baselineSha256);
  assert.equal(store(f,'messages.json').entries[0].id,'stable-intent');assert.equal(store(f,'drafts.json').intentIds['fixture-source'],'12345678-1234-1234-1234-123456789abc');assert.equal(digest(f.resident),f.manifest.resident.sha256);
});
test('healthy update commits only after matching backend and launcher and never alters queued intent',async t=>{
  const f=await fixture();t.after(()=>f.close());const dataBefore=fs.readFileSync(path.join(f.dataDirectory,'messages.json'));
  const result=await f.transaction().run(f.manifest);assert.equal(result.phase,'committed');assert.equal(digest(f.original),f.manifest.components[0].sha256);assert.equal(f.launches,1);
  assert.deepEqual(fs.readFileSync(path.join(f.dataDirectory,'messages.json')),dataBefore);assert.equal(readLease(path.join(f.dataDirectory,'.update-lease.json')),null);
  assert.deepEqual(await f.transaction().recover(),{recovered:false,phase:'committed'});
});
for(const mode of ['exit','stale'])test(mode+' candidate startup automatically restores and launches compatible prior program',async t=>{
  const f=await fixture();t.after(()=>f.close());f.mode=mode;await assert.rejects(f.transaction().run(f.manifest),mode==='exit'?/exited/:/readiness/);
  assert.equal(digest(f.original),f.manifest.components[0].baselineSha256);assert.equal(store(f,'update-journal.json').phase,'rolled-back');assert.equal(f.starts,2);
});
test('failed launcher rolls program back while preserving newer receipt and draft bytes',async t=>{
  const f=await fixture();t.after(()=>f.close());f.mode='new-data';f.failLaunch=true;await assert.rejects(f.transaction().run(f.manifest),/launcher failed/);
  assert.equal(digest(f.original),f.manifest.components[0].baselineSha256);assert.equal(store(f,'messages.json').receipts['new-receipt'].receipt.turnId,'new-turn');assert.equal(store(f,'drafts.json').drafts['fixture-source'],'Newer draft from candidate startup');
});
test('rollback refuses a store version that the prior program cannot read and preserves it',async t=>{
  const f=await fixture();t.after(()=>f.close());f.failLaunch=true;const launch=f.hooks.launch;f.hooks.launch=async input=>{if(!input.baseline){const file=path.join(f.dataDirectory,'messages.json'),v=store(f,'messages.json');v.version=2;fs.writeFileSync(file,JSON.stringify(v));}return launch(input);};
  const err=await assert.rejects(f.transaction().run(f.manifest),/launcher failed/);assert.equal(store(f,'update-journal.json').phase,'recovery-required');assert.equal(store(f,'messages.json').version,2);assert.equal(digest(f.original),f.manifest.components[0].sha256);
});
test('source, baseline, candidate, resident and corrupt-store preflight fail before stop or replacement',async t=>{
  for(const kind of ['source','baseline','candidate','resident','private']){
    const f=await fixture();try{let stopped=0;f.hooks.stop=async()=>stopped++;
      const file={source:path.join(f.sourceRoot,'main.cjs'),baseline:f.original,candidate:f.updated,resident:f.resident,private:path.join(f.dataDirectory,'state.json')}[kind];fs.writeFileSync(file,kind==='private'?'{bad':'changed');const before=fs.readFileSync(f.original);
      await assert.rejects(f.transaction().run(f.manifest));assert.deepEqual(fs.readFileSync(f.original),before);assert.equal(stopped,0);assert.equal(fs.readFileSync(file,'utf8'),kind==='private'?'{bad':'changed');
    }finally{await f.close();}}
});
test('second installer and backend are excluded while an update owns the profile',async t=>{
  const f=await fixture();t.after(()=>f.close());const lease=acquireLease(f.dataDirectory,'.update-lease.json');t.after(()=>lease.close());
  await assert.rejects(f.transaction().run(f.manifest),{code:'PROFILE_BUSY'});assert.throws(()=>acquireBackend(f.dataDirectory),{code:'UPDATE_IN_PROGRESS'});
  const backend=acquireBackend(f.dataDirectory,{updateToken:lease.token});assert.throws(()=>acquireBackend(f.dataDirectory,{updateToken:lease.token}),{code:'PROFILE_BUSY'});backend.close();
});
test('failed stop leaves program intact and cannot force a live writer or overwrite its stores',async t=>{
  const f=await fixture();t.after(()=>f.close());const backend=acquireBackend(f.dataDirectory);t.after(()=>backend.close());f.hooks.stop=async()=>{};
  await assert.rejects(f.transaction().run(f.manifest),/backend still owns/);assert.equal(digest(f.original),f.manifest.components[0].baselineSha256);assert.equal(store(f,'update-journal.json').phase,'recovery-required');
});
test('corrupt or independently changed recovery input is preserved for manual repair',async t=>{
  const f=await fixture();t.after(()=>f.close());await assert.rejects(f.transaction({checkpoint:p=>{if(p==='replaced')throw Object.assign(new Error('crash'),{simulatedInterruption:true});}}).run(f.manifest));
  fs.writeFileSync(f.original,'independently changed package');await assert.rejects(f.transaction().recover(),/independently changed/);assert.equal(fs.readFileSync(f.original,'utf8'),'independently changed package');
  fs.writeFileSync(path.join(f.dataDirectory,'update-journal.json'),'{bad');await assert.rejects(f.transaction().recover(),/journal needs repair/);assert.equal(fs.readFileSync(path.join(f.dataDirectory,'update-journal.json'),'utf8'),'{bad');
});
test('manifests cannot replace resident adapters, private files or use incompatible protocols',async t=>{
  const f=await fixture();t.after(()=>f.close());for(const mutate of [m=>m.components[0].path='data/desktop/messages.json',m=>m.components[0].role='resident-adapter',m=>m.candidate.protocols.snapshot=2,m=>m.components[0].file='../app.asar']){
    const manifest=structuredClone(f.manifest);mutate(manifest);await assert.rejects(f.transaction().run(manifest));assert.equal(digest(f.original),f.manifest.components[0].baselineSha256);
  }
});
