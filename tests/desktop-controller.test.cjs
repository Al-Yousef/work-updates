'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Queue}=require('../src/queue.cjs'),{Controller}=require('../src/controller.cjs'),{feed}=require('../src/demo.cjs');
test('desktop-owned replies preserve observed status and never resume or adopt the chat',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-route-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const q=new Queue(directory);q.setFeed(feed());const client=new EventEmitter();client.prepare=client.send=()=>assert.fail('Desktop owns the writer');
  let sent=[];const desktop={owner:async()=> 'owner',send:async(id,value,options)=>{sent.push({id,value,options});return {messageId:options.messageId,turnId:'turn',delivery:'sent'};}};
  const c=new Controller(q,client,{desktop}),card=q.cards()[0];
  await c.send(card.id,'Reply',card.primarySourceId,card.taskKey,{messageId:'message'});
  assert.equal(sent[0].id,card.primarySourceId);assert.equal(q.state.tasks.length,0);assert.equal(q.ownedThreads.size,0);assert.equal(q.busy.size,0);assert.equal(q.get(card.id).status,card.status);
  q.feed.threads.find(s=>s.id===card.primarySourceId).lifecycle='working';await c.send(card.id,'Steer',card.primarySourceId,card.taskKey);
  assert.equal(sent[1].options.working,true);
  desktop.send=async()=>{const error=new Error('Receipt lost');error.delivery='uncertain';throw error;};
  await assert.rejects(c.send(card.id,'Reply',card.primarySourceId,card.taskKey),/Receipt lost/);assert.equal(q.busy.size,0);assert.equal(q.state.tasks.length,0);
});
