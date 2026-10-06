'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {once}=require('node:events');
const {NativeControl}=require('../src/native-control.cjs');
const {nativeView,cardView}=require('../src/native-view.cjs');
const {Queue}=require('../src/queue.cjs');
const {feed}=require('../src/demo.cjs');
function lines(socket) {
  let buffer='',waiting=[],ready=[];
  socket.setEncoding('utf8');socket.on('data',data=>{
    buffer+=data;let end;
    while((end=buffer.indexOf('\n'))>=0){const value=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
      if(waiting.length)waiting.shift()(value);else ready.push(value);}
  });
  return ()=>ready.length?Promise.resolve(ready.shift()):new Promise(resolve=>waiting.push(resolve));
}
test('native subscription and actions use the existing queue, preserve task identity and reject stale updates',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-queue-'));
  const queue=new Queue(directory);queue.setFeed(feed());let calls=[];
  const control=await new NativeControl({directory,changed:()=>{},status:()=>({activeWriters:0}),quit:()=>{},
    state:()=>nativeView(queue.snapshot()),command:async(method,input)=>{
      calls.push({method,input});
      if(method==='action')return queue.action(input.id,input.action,input.taskKey);
      if(method==='undo')return queue.undoLast();
      if(method==='details')return cardView(queue.get(input.id,input.taskKey),true);
      if(method==='open')return {sourceId:input.sourceId};
    }}).start();
  t.after(()=>{control.close();fs.rmSync(directory,{recursive:true,force:true});});
  const subscriber=net.createConnection(control.pipe),next=lines(subscriber);
  await once(subscriber,'connect');subscriber.write(JSON.stringify({method:'subscribe',token:control.token})+'\n');
  const initial=await next();assert.equal(initial.event,'state');assert.equal(initial.state.cards.length,3);
  assert.equal(control.claimed,false);assert.equal(calls.length,0);
  const first=initial.state.cards[0];assert.ok(first.chatName);assert.ok(first.taskKey);
  assert.equal(Object.hasOwn(first.sources[0],'body'),false);
  async function command(method,input={},token=control.token){
    const socket=net.createConnection(control.pipe),read=lines(socket);await once(socket,'connect');
    socket.write(JSON.stringify({method:'command',command:method,input,token})+'\n');return read();
  }
  assert.equal((await command('details',{id:first.id,taskKey:first.taskKey})).value.sources[0].contextLoaded,true);
  assert.equal((await command('action',{id:first.id,taskKey:'stale',action:'reviewed'})).ok,false);
  assert.equal((await command('action',{id:first.id,taskKey:first.taskKey,action:'reviewed'},'wrong')).ok,false);
  assert.equal(queue.cards().find(c=>c.id===first.id).reviewed,false);
  assert.equal((await command('action',{id:first.id,taskKey:first.taskKey,action:'reviewed'})).ok,true);
  control.broadcast(nativeView(queue.snapshot()));
  assert.equal((await next()).state.cards.find(c=>c.id===first.id).reviewed,true);
  assert.equal((await command('undo')).ok,true);
  assert.equal(queue.cards().find(c=>c.id===first.id).reviewed,false);
  assert.equal((await command('start',{id:first.id,text:'unsupported action'})).ok,false);
  assert.equal(calls.some(c=>c.method==='start'),false);
  const refreshed=feed();refreshed.threads.find(c=>c.id===first.primarySourceId).fingerprint='new-update';
  await command('action',{id:first.id,taskKey:first.taskKey,action:'reviewed'});
  queue.setFeed(refreshed);assert.equal(queue.cards().find(c=>c.id===first.id).reviewed,false);
  const originalOwner=net.createConnection(control.pipe),ownerNext=lines(originalOwner);
  await once(originalOwner,'connect');originalOwner.write(JSON.stringify({method:'claimCorner',token:control.token})+'\n');
  assert.equal((await ownerNext()).ok,true);
  subscriber.destroy();await new Promise(resolve=>setImmediate(resolve));assert.equal(control.claimed,true);
  originalOwner.destroy();
});
test('projection bounds display text, omits writer internals and preserves backend order',()=>{
  const raw={cards:[{id:'1',taskKey:'t',title:'x'.repeat(1000),messages:['private'],sources:[{id:'s',body:'context',contextLoaded:true}]}],
    done:[],settings:{queueSince:123,codexBinary:'private'},approvals:['private'],undo:true};
  const value=nativeView(raw);assert.equal(value.cards[0].title.length,240);
  assert.equal(value.settings.queueSince,123);assert.equal(value.cards[0].messages,undefined);
  assert.equal(value.approvals,undefined);assert.equal(value.settings.codexBinary,undefined);
  const emoji=cardView({title:'x'.repeat(239)+'😀'}).title;
  assert.equal(emoji,'x'.repeat(239));assert.equal(emoji.isWellFormed(),true);
});
