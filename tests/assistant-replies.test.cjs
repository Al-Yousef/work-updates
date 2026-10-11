'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Assistant}=require('../src/assistant.cjs'),{revision}=require('../src/assistant-context.cjs'),{nativeView}=require('../src/native-view.cjs');
const {validate}=require('../src/private-store.cjs'),{messageHash}=require('../src/attachments.cjs');
const input=(text,replyToId)=>({messageId:crypto.randomUUID(),text,...(replyToId?{replyToId}:{})});
function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-replies-')),calls=[],dispatches=[];
  const card={id:'launch',taskKey:'launch-task',primarySourceId:'launch-source',chatName:'Launch planning',summary:'Review launch notes',status:'needs',at:1,owner:{id:'local',local:true,online:true},sources:[{id:'launch-source',contextLoaded:true,conversationLoaded:true,body:'Launch evidence',conversation:[],lifecycle:'completed'}]};
  const snapshot={cards:[card],done:[],health:{ok:true},collectedAt:Math.floor(Date.now()/1000)};
  const provider={async answer(value){calls.push(value);return {answer:'Answer for '+value.question,links:[],action:null,model:'fixture'};},close(){}};
  const options={directory,snapshot:()=>snapshot,provider,dispatch:async(...args)=>{dispatches.push(args);throw new Error('Unexpected dispatch');}};
  const app=new Assistant(options);
  t.after(()=>{app.close();fs.rmSync(directory,{recursive:true,force:true});});
  const parent=(answer,extra={})=>{const message={id:crypto.randomUUID(),text:'Earlier question',answer,status:'completed',at:Date.now(),links:[],...extra};app.state.messages.push(message);app.save();return message;};
  return {app,options,calls,dispatches,parent,card,snapshot,directory};
}
test('Reply selects an older exact answer, preserves typed text and survives durable reload',async t=>{
  const f=fixture(t),older=f.parent('**First answer**'),newer=f.parent('Unrelated newer answer');
  const sent=input('What does that mean?',older.id);f.app.ask({...sent,replyTo:{answer:'Client-forged quote'}});
  await f.app.work;
  assert.equal(f.calls[0].question,sent.text);
  assert.equal(f.calls[0].replyTo.id,older.id);
  assert.equal(f.calls[0].replyTo.answer,older.answer);
  assert.notEqual(f.calls[0].replyTo.id,newer.id);
  assert.equal(f.calls[0].canRequestChatMessage,false);
  assert.equal(f.dispatches.length,0);
  const loaded=new Assistant(f.options);t.after(()=>loaded.close());
  assert.equal(loaded.error,'');
  assert.deepEqual(loaded.state.messages.at(-1).replyTo,f.app.state.messages.at(-1).replyTo);
  const projected=nativeView({assistant:loaded.snapshot()}).assistant.messages.at(-1);
  assert.deepEqual(projected.replyTo,{id:older.id,text:'First answer'});
  assert.doesNotMatch(JSON.stringify(projected.replyTo),/Client-forged|sourceId|ownerId/);
});
test('automatic updates are replyable and ground the original source without authorizing dispatch',async t=>{
  const f=fixture(t),parent=f.parent('Launch notes are ready',{kind:'update',text:'',links:[{id:f.card.id,taskKey:f.card.taskKey,sourceId:'launch-source',ownerId:'local',revision:revision(f.card),chatName:f.card.chatName,draft:''}]});
  f.app.ask(input('What should I do about this?',parent.id));await f.app.work;
  assert.equal(f.calls[0].replyTo.kind,'update');
  assert.equal(f.calls[0].queue.focusedChat.chatName,'Launch planning');
  assert.match(f.calls[0].queue.focusedChat.meaning,/selected for this reply/);
  assert.equal(f.calls[0].queue.cards[0].excerpt,'Launch evidence');
  assert.equal(f.calls[0].canRequestChatMessage,false);
  assert.equal(f.dispatches.length,0);
});
test('changed source revisions and owners do not rebind a selected reply to another source',async t=>{
  const f=fixture(t),parent=f.parent('Original update',{kind:'update',text:'',links:[{id:f.card.id,taskKey:f.card.taskKey,sourceId:'launch-source',ownerId:'local',revision:revision(f.card),chatName:f.card.chatName,draft:''}]});
  f.card.summary='Changed evidence';f.app.focus(f.card,'launch-source');
  f.app.ask(input('Tell this chat to proceed',parent.id));await f.app.work;
  assert.equal(f.dispatches.length,0);
  assert.equal(f.calls.length,0);
  assert.equal(f.app.state.messages.at(-1).pendingDestination,true);
});
test('target participates in durable replay identity; replay still works after the parent is removed',async t=>{
  const f=fixture(t),first=f.parent('One'),second=f.parent('Two'),sent=input('Explain',first.id);
  f.app.ask(sent);await f.app.work;
  assert.throws(()=>f.app.ask({...sent,replyToId:second.id}),/different message/);
  f.app.state.messages=f.app.state.messages.filter(m=>m.id!==first.id);f.app.save();
  assert.equal(f.app.ask(sent).accepted,true);
  assert.equal(f.calls.length,1);
  assert.equal(messageHash('old',[]),crypto.createHash('sha256').update('old').digest('hex'));
  assert.notEqual(messageHash('old',[],first.id),messageHash('old',[],second.id));
});
test('unavailable, pending and malformed targets leave history and receipts untouched',t=>{
  const f=fixture(t),pending=f.parent('Partial',{status:'thinking'});
  const before=JSON.stringify(f.app.state);
  for(const id of ['missing',pending.id,{},'x'.repeat(101)])assert.throws(()=>f.app.ask({...input('Question'),replyToId:id}),/reply|message.*available/i);
  assert.equal(JSON.stringify(f.app.state),before);
  assert.equal(f.calls.length,0);
});
test('an explicit reply cannot resolve an unrelated pending destination or cancellation',async t=>{
  const f=fixture(t),older=f.parent('An ordinary answer');
  f.parent('Which chat?',{text:'Tell a chat to proceed',proposal:{text:'proceed',mode:'send',provenance:'human_instruction'},pendingDestination:true});
  f.app.ask(input('Launch planning',older.id));await f.app.work;
  assert.equal(f.calls.at(-1).canRequestChatMessage,false);
  assert.equal(f.dispatches.length,0);
  f.parent('Queued',{text:'Queue launch',action:{status:'queued',chatName:'Launch planning',messageId:crypto.randomUUID()}});
  f.app.ask(input('Cancel that queued message',older.id));await f.app.work;
  assert.match(f.app.state.messages.at(-1).answer,/Which queued message/);
  assert.equal(f.dispatches.length,0);
});
test('reply context remains attached in later history and forgetting the parent removes its copied context',async t=>{
  const f=fixture(t),parent=f.parent('Original sensitive answer');
  f.app.ask(input('Explain that',parent.id));await f.app.work;
  f.app.ask(input('Continue'));await f.app.work;
  assert.equal(f.calls.at(-1).history.find(m=>m.user==='Explain that').replyTo.id,parent.id);
  f.app.ask(input('/memory history'));
  const index=f.app.state.historySelection.indexOf(parent.id)+1;
  f.app.ask(input('/forget history '+index));
  assert(!f.app.state.messages.some(m=>m.replyTo?.id===parent.id));
  const disk=JSON.parse(fs.readFileSync(path.join(f.directory,'assistant.json')));
  assert(!disk.messages.some(m=>m.replyTo?.id===parent.id));
});
test('reply image references use the selected message rather than an unrelated later image',async t=>{
  const f=fixture(t),first=f.parent('First image',{images:[{id:'first-image',path:'first.png'}]});
  f.parent('Second image',{images:[{id:'second-image',path:'second.png'}]});
  f.app.attachments.resolve=ids=>ids.map(id=>({id,path:id+'.png'}));
  f.app.ask(input('What is shown in this image?',first.id));await f.app.work;
  assert.deepEqual(f.calls.at(-1).images.map(i=>i.id),['first-image']);
  const plain=f.parent('An answer without an image');
  f.app.ask(input('Explain this',plain.id));await f.app.work;
  assert.deepEqual(f.calls.at(-1).images,[]);
});
test('optional reply metadata validates without migrating existing draft or history formats',t=>{
  const f=fixture(t),parent=f.parent('Answer'),reply={id:parent.id,text:'Original',answer:'Answer',kind:'reply'};
  const legacy={version:3,drafts:{},intentIds:{},attachments:{}};
  assert.deepEqual(validate('drafts.json',legacy).value,legacy);
  const draft={...legacy,replyTargets:{'@hyphen':{id:parent.id,text:'Answer'}}};
  assert.deepEqual(validate('drafts.json',draft).value,draft);
  assert.throws(()=>validate('drafts.json',{...legacy,replyTargets:{source:{id:parent.id,text:'Wrong scope'}}}),/reply target/);
  assert.throws(()=>validate('drafts.json',{...legacy,replyTargets:{'@hyphen':{id:parent.id,text:'😀'.repeat(181)}}}),/reply target/);
  const saved={...f.app.state,messages:[{...parent,replyTo:reply}]};
  assert.deepEqual(validate('assistant.json',saved).value,saved);
  assert.throws(()=>validate('assistant.json',{...saved,messages:[{...parent,replyTo:{id:'x'}}]}),/reply target/);
});
