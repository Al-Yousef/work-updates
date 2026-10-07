'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./fixtures/update-profile.cjs');
const {readStore,atomicJSON,inspectStores,validate}=require('../src/private-store.cjs');
const {Queue}=require('../src/queue.cjs');
const {Devices}=require('../src/devices.cjs');
test('every corrupt or unsupported private format is preserved rather than reset',async t=>{
  const f=await fixture();t.after(()=>f.close());for(const name of ['state.json','messages.json','assistant.json','device.json','drafts.json']){
    const file=path.join(f.dataDirectory,name),original=fs.readFileSync(file);for(const value of ['{unfinished',JSON.stringify({...JSON.parse(original),version:99})]){
      fs.writeFileSync(file,value);assert.throws(()=>readStore(file),{code:'PRIVATE_STORE_RECOVERY'});assert.equal(fs.readFileSync(file,'utf8'),value);
    }fs.writeFileSync(file,original);}
  assert.equal(Object.keys(inspectStores(f.dataDirectory)).length,5);
});
test('queue and device startup reject corrupt input without creating a fresh queue or identity',async t=>{
  const f=await fixture();t.after(()=>f.close());const queue=path.join(f.dataDirectory,'state.json'),device=path.join(f.dataDirectory,'device.json');
  fs.writeFileSync(queue,'{broken');assert.throws(()=>new Queue(f.dataDirectory),{code:'PRIVATE_STORE_RECOVERY'});assert.equal(fs.readFileSync(queue,'utf8'),'{broken');
  fs.writeFileSync(device,'{}');assert.throws(()=>new Devices({directory:f.dataDirectory}),{code:'PRIVATE_STORE_RECOVERY'});assert.equal(fs.readFileSync(device,'utf8'),'{}');
});
test('an interrupted durable JSON write preserves the original and cleans only its own temporary file',async t=>{
  const f=await fixture();t.after(()=>f.close());const file=path.join(f.dataDirectory,'messages.json'),bytes=fs.readFileSync(file);
  assert.throws(()=>atomicJSON(file,{version:1,entries:[],barriers:{}},{beforeReplace:()=>{throw new Error('interrupted before replace');}}),/interrupted/);
  assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(fs.readdirSync(f.dataDirectory).some(n=>n.endsWith('.tmp')),false);
});
test('legacy device and draft migration retains identities, text and attachments without writing during inspection',async t=>{
  const f=await fixture();t.after(()=>f.close());const deviceFile=path.join(f.dataDirectory,'device.json'),device=JSON.parse(fs.readFileSync(deviceFile));delete device.version;fs.writeFileSync(deviceFile,JSON.stringify(device));
  const before=fs.readFileSync(deviceFile);assert.equal(readStore(deviceFile).value.version,1);assert.deepEqual(fs.readFileSync(deviceFile),before);
  const live=new Devices({directory:f.dataDirectory});assert.equal(live.local.id,device.id);assert.equal(JSON.parse(fs.readFileSync(deviceFile)).version,1);live.close();
  for(const version of [1,2,3]){
    const draft={version,drafts:{'source':'Retained draft'},intentIds:{'source':'12345678-1234-1234-1234-123456789abc'},attachments:{'source':[{id:'fixture-image',path:'fixture.png'}]}};
    assert.deepEqual(validate('drafts.json',draft).value,{...draft,version:3});
  }
  assert.deepEqual(validate('drafts.json',{'source':'Retained legacy draft'}).value.drafts,{'source':'Retained legacy draft'});
});
test('invalid migration cannot partially save valid fields from a corrupt store',async t=>{
  const f=await fixture();t.after(()=>f.close());const file=path.join(f.dataDirectory,'drafts.json'),data={version:2,drafts:{good:'Keep me',bad:17},intentIds:{},attachments:{}};fs.writeFileSync(file,JSON.stringify(data));
  assert.throws(()=>readStore(file),{code:'PRIVATE_STORE_RECOVERY'});assert.deepEqual(JSON.parse(fs.readFileSync(file)),data);
});
