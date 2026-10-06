'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {Attachments,MAX_BYTES}=require('../src/attachments.cjs');
const {Messages}=require('../src/messages.cjs');
const {Queue}=require('../src/queue.cjs');
const {feed}=require('../src/demo.cjs');
const {Assistant}=require('../src/assistant.cjs');
const {cardView}=require('../src/native-view.cjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4c8AAAAASUVORK5CYII=','base64');
function setup(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-images-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const attachments=new Attachments(directory),file=path.join(directory,'original.png');fs.writeFileSync(file,png);return {directory,attachments,file};}
test('imports are durable, deduplicated by content and reject path traversal, wrong types, oversized and changed blobs',t=>{
  const {attachments,file,directory}=setup(t);const [image]=attachments.import([file,file]);fs.unlinkSync(file);
  assert.equal(attachments.resolve([image.id])[0].bytes,png.length);assert.deepEqual(attachments.inputs([image.id]),[{type:'localImage',path:image.path}]);
  assert.throws(()=>attachments.resolve(['../original.png']),/valid images/);assert.throws(()=>attachments.resolve([image.id,image.id]),/already attached/);
  fs.writeFileSync(file,'not an image');assert.throws(()=>attachments.import([file]),/PNG/);
  fs.truncateSync(file,MAX_BYTES+1);assert.throws(()=>attachments.import([file]),/20 MB/);
  fs.writeFileSync(image.path,Buffer.concat([png,Buffer.from('changed')]));assert.throws(()=>attachments.resolve([image.id]),/changed/);
  assert.equal(fs.readdirSync(path.join(directory,'attachments')).length,1);
});
test('an image-only queue survives restart and deletion of the original, delivers once and binds identity to its attachments',async t=>{
  const {attachments,file,directory}=setup(t),q=new Queue(directory);q.setFeed(feed());const card=q.cards()[0],source=card.sources[0];
  const [image]=attachments.import([file]);const input={id:card.id,taskKey:card.taskKey,sourceId:source.id,text:'',attachmentIds:[image.id],messageId:crypto.randomUUID()};
  const first=new Messages(q,{send:async()=>assert.fail('No dispatch until pumped')},{auto:false,attachments});t.after(()=>first.close());first.enqueue(input);fs.unlinkSync(file);
  let calls=0;const restored=new Messages(q,{send:async(id,text,source,key,options)=>{calls++;assert.equal(text,'');assert.equal(options.images[0].path,image.path);return {turnId:'image-turn',route:'desktop'};}},{auto:false,attachments});t.after(()=>restored.close());
  assert.throws(()=>restored.enqueue({...input,attachmentIds:[]}),/another draft/);await restored.pump();await restored.pump();assert.equal(calls,1);
  assert.equal((await restored.send(input)).delivery,'sent');assert.equal(calls,1);
});
test('a lost image acknowledgement remains uncertain and never auto-dispatches again',async t=>{
  const {attachments,file,directory}=setup(t),q=new Queue(directory);q.setFeed(feed());const card=q.cards()[0],[image]=attachments.import([file]);let calls=0;
  const messages=new Messages(q,{send:async()=>{calls++;throw Object.assign(new Error('Lost receipt'),{delivery:'uncertain'});}},{auto:false,attachments});t.after(()=>messages.close());
  const input={id:card.id,taskKey:card.taskKey,sourceId:card.primarySourceId,text:'Look at this',attachmentIds:[image.id],messageId:crypto.randomUUID()};
  await assert.rejects(messages.send(input),/Lost receipt/);await messages.pump();await assert.rejects(messages.send(input),/unconfirmed/);assert.equal(calls,1);
});
test('assistant image input is persisted and replaying its receipt does not invoke inference again',async t=>{
  const {attachments,file,directory}=setup(t),[image]=attachments.import([file]);let calls=0;
  const provider={async answer(input){calls++;assert.equal(input.images[0].path,image.path);return {answer:'An image',links:[]};},close(){}};
  const options={directory,attachments,provider,snapshot:()=>({cards:[]})},assistant=new Assistant(options);t.after(()=>assistant.close());
  const input={text:'',attachmentIds:[image.id],messageId:crypto.randomUUID()};assistant.ask(input);await assistant.work;
  const restored=new Assistant(options);t.after(()=>restored.close());assert.equal(restored.error,'');restored.ask(input);assert.equal(calls,1);
  assert.equal(restored.snapshot().messages[0].images[0].id,image.id);assert.throws(()=>restored.ask({...input,text:'Changed'}),/different message/);
});
test('selected source conversation imports local output images without placing them in every queue broadcast',t=>{
  const {attachments,file}=setup(t);const card={sources:[{id:'s',body:'Answer',conversation:[{role:'assistant',text:'Here it is',images:[file]}]}]};
  assert.equal(cardView(card).sources[0].conversation,undefined);const details=cardView(card,true,attachments);
  assert.equal(details.sources[0].conversation[0].images.length,1);assert.ok(details.sources[0].conversation[0].images[0].id);
});
test('local Markdown output images render as attachments, keep the caption and deduplicate explicit image refs',t=>{
  const {attachments,file}=setup(t),card={sources:[{id:'s',conversation:[{role:'assistant',text:`Result ![preview](<${file}>)`,images:[file]}]}]};
  const message=cardView(card,true,attachments).sources[0].conversation[0];assert.equal(message.text,'Result preview');assert.equal(message.images.length,1);
  assert.equal(cardView({...card,owner:{local:false}},true,attachments).sources[0].conversation[0].images.length,0);
});
