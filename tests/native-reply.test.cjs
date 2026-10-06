'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {once,EventEmitter}=require('node:events');
const {NativeControl}=require('../src/native-control.cjs');
const {Queue}=require('../src/queue.cjs');
const {Controller}=require('../src/controller.cjs');
const {feed}=require('../src/demo.cjs');
async function setup(t,client=new EventEmitter()) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-reply-'));
  const queue=new Queue(directory);queue.setFeed(feed());
  const controller=new Controller(queue,client);
  const control=await new NativeControl({directory,changed:()=>{},status:()=>({activeWriters:queue.busy.size}),quit:()=>{},
    command:async(method,input)=>{
      assert.equal(method,'send');return controller.send(input.id,input.text,input.sourceId,input.taskKey);
    }}).start();
  t.after(()=>{control.close();fs.rmSync(directory,{recursive:true,force:true});});
  async function send(input,token=control.token) {
    const socket=net.createConnection(control.pipe);socket.on('error',()=>{});await once(socket,'connect');
    const result=new Promise((resolve,reject)=>{
      let buffer='';socket.on('data',data=>{buffer+=data;if(buffer.includes('\n'))resolve(JSON.parse(buffer.split('\n')[0]));});
      socket.on('end',()=>{if(!buffer)reject(new Error('Reply connection ended without a receipt'));});
    });
    socket.write(JSON.stringify({method:'command',command:'send',input,token})+'\n');return result;
  }
  const card=queue.cards()[0],input={id:card.id,taskKey:card.taskKey,sourceId:card.primarySourceId,text:'A draft'};
  return {queue,client,control,send,input};
}
test('authenticated native replies keep exact source identity and return the adopted task receipt',async t=>{
  const {queue,client,send,input}=await setup(t);let sends=0;
  client.prepare=async id=>assert.equal(id,input.sourceId);
  client.send=async(id,text)=>{assert.equal(id,input.sourceId);assert.equal(text,input.text);sends++;};
  assert.equal((await send(input,'wrong')).ok,false);assert.equal(sends,0);
  assert.equal((await send({...input,taskKey:'stale'})).ok,false);assert.equal(sends,0);
  const result=await send(input);assert.equal(result.ok,true);assert.ok(result.value.taskId);
  assert.equal(queue.state.tasks[0].id,result.value.taskId);assert.equal(queue.state.tasks[0].threadId,input.sourceId);
  assert.equal(sends,1);
});
test('writer refusal returns an error and leaves the observed chat and draft history untouched',async t=>{
  const {queue,client,send,input}=await setup(t);
  client.prepare=async()=>{const error=new Error('already has an active writer');error.code=-32600;throw error;};
  client.send=async()=>assert.fail('Must not send after a writer refusal');
  const result=await send(input);assert.equal(result.ok,false);assert.equal(result.code,-32600);
  assert.match(result.error,/active writer/);assert.equal(queue.state.tasks.length,0);assert.equal(queue.busy.size,0);
});
test('a slow native send keeps its acknowledgement connection and concurrent submission is rejected',async t=>{
  const {queue,client,control,send,input}=await setup(t);let release,started;
  const ready=new Promise(resolve=>started=resolve);let sends=0;
  client.send=async()=>{sends++;started();await new Promise(resolve=>release=resolve);};
  const first=send(input);await ready;
  assert.ok([...control.clients].some(socket=>socket.timeout===240000));
  const adopted=queue.cards().find(card=>card.primarySourceId===input.sourceId);
  const duplicate=await send({...input,id:adopted.id,taskKey:adopted.taskKey});
  assert.equal(duplicate.ok,false);assert.match(duplicate.error,/already being sent/);
  release();assert.equal((await first).ok,true);assert.equal(sends,1);
});
test('a full non-ASCII multiline draft fits the native frame and delivery failures are explicit',async t=>{
  const {queue,client,send,input}=await setup(t);
  input.text='漢'.repeat(11998)+'\n漢'; // UTF-8 exceeds the former 32 KiB pipe limit.
  client.send=async(id,text)=>{assert.equal(id,input.sourceId);assert.equal(text,input.text.trim());
    const error=new Error('Check chat before retrying.');error.code='CODEX_TIMEOUT';throw error;};
  const result=await send(input);assert.equal(result.ok,false);assert.equal(result.code,'CODEX_TIMEOUT');
  assert.ok(result.taskId);assert.equal(queue.busy.size,0);
});

test('the native panel receives not-sent for a prepare timeout and no local chat or fake message is created',async t=>{
  const {queue,client,send,input}=await setup(t);
  client.prepare=async()=>{throw Object.assign(new Error('Your message was not sent.'),{code:'CODEX_TIMEOUT',method:'thread/resume'});};
  client.send=async()=>assert.fail('No mutation may follow failed preparation');
  const result=await send(input);assert.equal(result.ok,false);assert.equal(result.code,'CODEX_TIMEOUT');
  assert.equal(result.delivery,'not-sent');assert.match(result.error,/not sent/);
  assert.equal(queue.state.tasks.length,0);assert.equal(queue.busy.size,0);assert.equal(queue.ownedThreads.size,0);
});
