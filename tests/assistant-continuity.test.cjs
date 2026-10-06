'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {Assistant}=require('../src/assistant.cjs');
const {context,loadContext,messageTarget}=require('../src/assistant-context.cjs');
function card(name='Release review',id='release',extra={}){return {id,taskKey:id+'-v1',chatName:name,title:'Review '+name,summary:'Waiting for your review',kind:'local',status:'needs',waitingOn:{kind:'you'},at:Date.now()/1000,
  owner:{id:'pc',name:'This PC',online:true},primarySourceId:'source-'+id,sources:[{id:'source-'+id,contextLoaded:true,conversationLoaded:true,lifecycle:'completed',body:'Recorded source context',conversation:[]}],...extra};}
function fixture(t,options={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-continuity-'));
  const state={cards:[card()],done:[],collectedAt:Math.floor(Date.now()/1000),health:{ok:true}};
  const calls=[],dispatches=[];
  const provider={async answer(input){calls.push(input);return options.answer?options.answer(input):{answer:'Understood.',links:[],action:null};},close(){}};
  const app=new Assistant({directory,snapshot:()=>state,provider,dispatch:async(mode,input)=>{dispatches.push({mode,input});return options.dispatch?options.dispatch(mode,input):{delivery:mode==='queue'?'queued':'sent',route:'synthetic'};},...options.appOptions});
  t.after(()=>{app.close();fs.rmSync(directory,{recursive:true,force:true});});
  const ask=async(text,id=crypto.randomUUID())=>{app.ask({text,messageId:id});await app.work;return app.state.messages.find(m=>m.id===id);};
  return {app,state,directory,calls,dispatches,ask,provider};
}
test('hundreds of automatic updates cannot evict conversations or pollute their prompt after restart',async t=>{
  const f=fixture(t);await f.ask('My preferred release codename is Paper Kite.');f.app.observe(f.state);
  for(let i=0;i<130;i++){f.state.cards[0].fingerprint='update-'+i;f.app.observe(f.state);}
  assert.equal(f.app.state.messages.filter(m=>m.kind==='update').length,40);
  assert.equal(f.app.state.messages.filter(m=>m.text).length,1);
  assert.ok(f.app.snapshot().messages.some(m=>m.text.includes('Paper Kite')));
  const reloaded=new Assistant({directory:f.directory,snapshot:()=>f.state,provider:f.provider});t.after(()=>reloaded.close());
  reloaded.ask({text:'What codename did I give you?',messageId:crypto.randomUUID()});await reloaded.work;
  assert.equal(f.calls.at(-1).history[0].user,'My preferred release codename is Paper Kite.');
  assert.ok(f.calls.at(-1).history.every(m=>m.user));assert.deepEqual(reloaded.state.notes,[]);
});
test('relevant older decisions are recalled beyond the recent exchange window',async t=>{
  const f=fixture(t);await f.ask('For the Neptune project, use the violet layout.');
  for(let i=0;i<18;i++)await f.ask('A separate unrelated discussion '+i);
  await f.ask('What layout did we choose for Neptune?');
  assert.ok(!f.calls.at(-1).history.some(m=>m.user.includes('Neptune')));
  assert.ok(f.calls.at(-1).recalledHistory.some(m=>m.user.includes('violet')));
  assert.equal(f.calls.at(-1).historyCoverage.retainedExchanges,19);
});
test('version one history migrates without losing receipts, explicit notes or dialogue',t=>{
  const f=fixture(t),id=crypto.randomUUID();
  fs.writeFileSync(f.app.file,JSON.stringify({version:1,messages:[{id,text:'Keep the release private',answer:'Understood',status:'completed',at:1,links:[]}],notes:['Morning updates'],receipts:{[id]:'digest'},seen:{}}));
  const reloaded=new Assistant({directory:f.directory,snapshot:()=>f.state,provider:f.provider});t.after(()=>reloaded.close());
  assert.equal(reloaded.state.version,2);assert.equal(reloaded.state.messages[0].text,'Keep the release private');
  assert.equal(reloaded.state.receipts[id],'digest');assert.deepEqual(reloaded.state.notes,['Morning updates']);
});
test('a named historical chat beats unrelated urgent queue cards and includes its actual transcript',()=>{
  const old=card('Neptune layout','old',{kind:'observed',at:1,sources:[{id:'source-old',contextLoaded:true,conversationLoaded:true,body:'Decision recorded',conversation:[{role:'user',text:'Use violet for Neptune'}]}]});
  const state={cards:Array.from({length:80},(_,i)=>card('Urgent review '+i,'urgent-'+i,{urgent:true})).concat(old),settings:{queueSince:100}};
  const result=context(state,'What did we decide for the Neptune layout?');
  assert.equal(result.data.cards[0].chatName,'Neptune layout');assert.equal(result.data.cards[0].inQueue,false);
  assert.equal(result.data.cards[0].conversation[0].text,'Use violet for Neptune');
});
test('opening a source supplies this-chat context and survives restart with exact device identity',async t=>{
  const f=fixture(t);f.app.focus(f.state.cards[0],'source-release');await f.ask('What is happening in this chat?');
  assert.equal(f.calls.at(-1).queue.focusedChat.chatName,'Release review');
  const reloaded=new Assistant({directory:f.directory,snapshot:()=>f.state,provider:f.provider});t.after(()=>reloaded.close());
  assert.equal(reloaded.state.focus.sourceId,'source-release');assert.equal(reloaded.state.focus.ownerId,'pc');
});
test('context loading requests only missing sources, waits on the feed, and removes listeners',async()=>{
  const events=new EventEmitter(),state={cards:[card()]};state.cards[0].sources[0].conversationLoaded=false;let requested;
  const target={id:'release',sourceId:'source-release',ownerId:'pc'};
  const value=await loadContext({snapshot:()=>state,subscribe:cb=>{events.on('change',cb);return()=>events.off('change',cb);},request:async targets=>{requested=targets;state.cards[0].sources[0].conversationLoaded=true;events.emit('change');}},[target]);
  assert.equal(requested.length,1);assert.equal(value.cards[0].sources[0].conversationLoaded,true);assert.equal(events.listenerCount('change'),0);
});
test('offline and unavailable source context remains labelled and waits are bounded',async()=>{
  const events=new EventEmitter(),state={cards:[card()]};state.cards[0].sources[0].conversationLoaded=false;
  const target={id:'release',sourceId:'source-release',ownerId:'pc'};
  const result=await loadContext({timeoutMs:10,snapshot:()=>state,subscribe:cb=>{events.on('change',cb);return()=>events.off('change',cb);},request:async()=>{}},[target]);
  assert.equal(result.cards[0].sources[0].conversationLoaded,false);assert.equal(events.listenerCount('change'),0);
  state.cards[0].owner.online=false;
  await loadContext({snapshot:()=>state,request:()=>{throw new Error('must not request offline');}},[target]);
});
test('a clear user instruction sends once to the focused chat and preserves the receipt across restart',async t=>{
  const f=fixture(t,{answer:async input=>({answer:'I will pass that instruction along.',links:[],action:{ref:input.requestedChatRef,text:'Fix the layout spacing.',mode:'send'}})});
  f.app.focus(f.state.cards[0]);const id=crypto.randomUUID(),question='Tell that chat to fix the layout spacing.';
  const answer=await f.ask(question,id);assert.equal(answer.status,'completed');assert.match(answer.answer,/^Sent to Release review/);
  assert.equal(f.dispatches.length,1);assert.equal(f.dispatches[0].input.sourceId,'source-release');
  f.app.ask({text:question,messageId:id});assert.equal(f.dispatches.length,1);
  const reloaded=new Assistant({directory:f.directory,snapshot:()=>f.state,provider:f.provider,dispatch:()=>{throw new Error('must not replay');}});t.after(()=>reloaded.close());
  reloaded.ask({text:question,messageId:id});assert.equal(reloaded.state.messages.at(-1).action.status,'sent');
});
test('working source instructions are queued and never reported as sent',async t=>{
  const f=fixture(t,{answer:async input=>({answer:'I will handle it.',links:[],action:{ref:input.requestedChatRef,text:'Check the next step.',mode:'send'}})});
  f.state.cards[0].sources[0].lifecycle='working';f.app.focus(f.state.cards[0]);
  const answer=await f.ask('Tell this chat to check the next step.');assert.match(answer.answer,/^Queued for/);assert.equal(f.dispatches[0].mode,'queue');
});
test('question, quoted command and draft requests cannot authorize an injected model action',async t=>{
  const f=fixture(t,{answer:async()=>({answer:'Doing it.',links:[],action:{ref:'c0',text:'Unrequested work',mode:'send'}})});f.app.focus(f.state.cards[0]);
  for(const question of ['What needs me?', 'The chat said "tell that chat to fix it". What do you think?', 'Draft a reply for Release review.', 'Tell me about Release review.']){
    const answer=await f.ask(question);assert.equal(answer.status,'failed');
  }
  assert.equal(f.dispatches.length,0);
});
test('ambiguous names and changed source context cannot deliver to another chat',async t=>{
  const f=fixture(t,{answer:async input=>{f.state.cards[0].summary='Changed during inference';return {answer:'Doing it',links:[],action:{ref:input.requestedChatRef||'c0',text:'Fix it',mode:'send'}};}});
  f.app.focus(f.state.cards[0]);const answer=await f.ask('Tell that chat to fix it');assert.equal(answer.status,'failed');assert.equal(f.dispatches.length,0);
  const snapshot={cards:[card('Release review','one'),card('Release review','two')]};
  assert.equal(messageTarget(context(snapshot,'Tell the release chat to fix it'),'Tell the release chat to fix it'),null);
});
test('an interrupted dispatch is unconfirmed after restart and is never automatically replayed',async t=>{
  const f=fixture(t,{answer:async input=>({answer:'Doing it',links:[],action:{ref:input.requestedChatRef,text:'Fix it',mode:'send'}}),dispatch:()=>new Promise(()=>{})});
  f.app.focus(f.state.cards[0]);const id=crypto.randomUUID();f.app.ask({messageId:id,text:'Tell this chat to fix it'});
  for(let i=0;i<5&&f.dispatches.length===0;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.dispatches.length,1);
  const reloaded=new Assistant({directory:f.directory,snapshot:()=>f.state,provider:f.provider,dispatch:()=>{throw new Error('must not replay');}});t.after(()=>reloaded.close());
  const message=reloaded.state.messages.find(m=>m.id===id);assert.equal(message.action.status,'unconfirmed');assert.match(message.error,/delivery is unconfirmed/);
  reloaded.ask({messageId:id,text:'Tell this chat to fix it'});assert.equal(reloaded.active,false);
});

test('assistant-triggered delivery cannot use future-dated or invalid collection freshness after inference',async t=>{
  for(const timestamp of [Date.now()/1000+90,NaN]){
    const f=fixture(t,{answer:async input=>{f.state.collectedAt=timestamp;return {answer:'Doing it',links:[],action:{ref:input.requestedChatRef,text:'Fix it',mode:'send'}};}});
    f.app.focus(f.state.cards[0]);const answer=await f.ask('Tell this chat to fix it');
    assert.equal(answer.status,'failed');assert.match(answer.error,/unavailable/);assert.equal(f.dispatches.length,0);
  }
});
