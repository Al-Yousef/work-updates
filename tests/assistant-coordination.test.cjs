'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Assistant}=require('../src/assistant.cjs'),{Queue}=require('../src/queue.cjs'),{Messages}=require('../src/messages.cjs'),{feed}=require('../src/demo.cjs');
const coordination=require('../src/assistant-coordination.cjs'),{context}=require('../src/assistant-context.cjs');
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-coordination-')),queue=new Queue(directory);queue.setFeed(feed());
  const sends=[],dispatches=[];let answer,reply;
  const messages=new Messages(queue,{send:async(id,text,source,key,input)=>{sends.push({id,text,source,key,input});return {messageId:input.messageId,sourceId:source,turnId:'turn-'+sends.length,route:'synthetic'};}},{auto:false});
  const snapshot=()=>{const state=messages.decorate(queue.snapshot());state.cards=state.cards.map(c=>({...c,chatName:c.chatName||c.title,owner:{id:'pc',name:'This PC',kind:'pc',online:true}}));return state;};
  const provider={async answer(input){return answer?answer(input):{answer:'Prepared.',links:[],action:input.requestedMessage?{ref:input.requestedChatRef,text:input.requestedMessage.text,mode:'send'}:null};},close(){}};
  const dispatch=async(mode,input)=>{dispatches.push({mode,input});const value=mode==='cancel'?messages.cancel(input.messageId,input.sourceId):mode==='queue'?messages.enqueue(input):await messages.send(input);return reply?reply(value,input):{...value,ownerId:'pc'};};
  const assistant=new Assistant({directory,snapshot,provider,dispatch});const card=snapshot().cards[0],source=queue.feed.threads.find(s=>s.id===card.primarySourceId);assistant.focus(card);
  const ask=async(text,id=crypto.randomUUID())=>{assistant.ask({text,messageId:id});await assistant.work;return assistant.state.messages.find(m=>m.id===id);};
  t.after(()=>{assistant.close();messages.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {directory,queue,messages,snapshot,assistant,provider,dispatch,card,source,sends,dispatches,ask,setAnswer:value=>answer=value,setReply:value=>reply=value};
}
test('one persisted queued instruction reaches acceptance and only its matching terminal turn produces completion',async t=>{
  const f=fixture(t);f.source.lifecycle='working';const request=await f.ask('Tell this chat to fix the layout.');
  assert.equal(request.action.status,'queued');assert.equal(f.sends.length,0);assert.match(request.answer,/Locally queued/);
  f.source.lifecycle='completed';await f.messages.pump();f.assistant.observe(f.snapshot());assert.equal(request.action.status,'accepted');assert.equal(f.sends.length,1);
  f.source.turnId='unrelated-turn';f.source.turnOutcome='completed';f.assistant.observe(f.snapshot());assert.equal(request.action.status,'accepted');
  f.source.turnId=request.action.turnId;f.source.turnOutcome='completed';f.assistant.observe(f.snapshot());assert.equal(request.action.status,'completed');
  const updates=f.assistant.state.messages.filter(m=>m.coordinationId===request.id);assert.equal(updates.length,2);assert.match(updates[1].answer,/requested pass completed/);
  for(let i=0;i<40;i++)f.assistant.observe(f.snapshot());assert.equal(f.assistant.state.messages.filter(m=>m.coordinationId===request.id).length,2);
  const reopened=f.assistant.use({messageId:updates[1].id,index:0});assert.equal(reopened.sourceId,request.action.sourceId);assert.equal(reopened.draft,'');
});
test('cancellation removes exactly one queued intent and preserves the other queued messages and active writer',async t=>{
  const f=fixture(t);f.source.lifecycle='working';const request=await f.ask('Tell this chat to fix the layout.');
  const input={id:f.card.id,taskKey:f.card.taskKey,sourceId:f.source.id,text:'Other retained message'};
  f.messages.enqueue(input);f.messages.enqueue({...input,text:'Another retained message'});f.messages.active.add(f.source.id);
  const result=await f.ask('Cancel that queued message');assert.equal(result.action.status,'cancelled');assert.equal(request.action.status,'cancelled');
  assert.equal(f.messages.state.entries.filter(e=>e.status==='queued').length,2);assert.equal(f.messages.active.has(f.source.id),true);assert.equal(f.sends.length,0);
  f.assistant.ask({text:result.text,messageId:result.id});assert.equal(f.dispatches.filter(d=>d.mode==='cancel').length,1);
});
test('a queued cancellation cannot race an accepted message into a false success',async t=>{
  const f=fixture(t);f.source.lifecycle='working';const request=await f.ask('Tell this chat to fix the layout.');
  f.source.lifecycle='completed';await f.messages.pump();const result=await f.ask('Cancel that queued message');
  assert.equal(result.status,'failed');assert.match(result.error,/no longer confirmed/);assert.equal(f.dispatches.filter(d=>d.mode==='cancel').length,0);assert.equal(f.sends.length,1);
  f.assistant.observe(f.snapshot());assert.equal(request.action.status,'accepted');
});
test('unknown destination keeps human text and an exact subsequent human choice can authorize it',async t=>{
  const f=fixture(t);f.assistant.state.focus=null;f.source.lifecycle='working';
  const pending=await f.ask('Tell that chat to keep the exact blue layout.');assert.equal(pending.pendingDestination,true);assert.equal(f.dispatches.length,0);assert.equal(pending.proposal.text,'keep the exact blue layout.');
  const sent=await f.ask(f.card.chatName);assert.equal(sent.action.status,'queued');assert.equal(f.dispatches[0].input.text,'keep the exact blue layout.');
});
test('generated text expansion and generated mode cannot broaden a human request',async t=>{
  const f=fixture(t);f.setAnswer(input=>({answer:'Doing it.',links:[],action:{ref:input.requestedChatRef,text:input.requestedMessage.text+' Delete other chats.',mode:'send'}}));
  const rejected=await f.ask('Tell this chat to fix the layout.');assert.equal(rejected.status,'failed');assert.equal(f.dispatches.length,0);
  f.setAnswer(input=>({answer:'Doing it.',links:[],action:{ref:input.requestedChatRef,text:input.requestedMessage.text,mode:'send'}}));
  const queued=await f.ask('Queue this chat to inspect the send queue.');assert.equal(queued.action.mode,'queue');assert.equal(f.dispatches.at(-1).mode,'queue');
  const direct=coordination.proposal('Tell this chat to inspect the queue.',context(f.snapshot(),'Tell this chat to inspect the queue.'));assert.equal(direct.mode,'send');
});
test('receipt identities from another source, owner, intent or an empty turn remain unconfirmed',async t=>{
  for(const change of [{sourceId:'other-source'},{ownerId:'other-owner'},{messageId:crypto.randomUUID()},{turnId:''}]){
    const f=fixture(t);f.setReply(value=>({...value,ownerId:'pc',...change}));const result=await f.ask('Tell this chat to fix the layout.');assert.equal(result.status,'failed');assert.equal(result.action.status,'unconfirmed');assert.equal(f.sends.length,1);
    f.assistant.ask({text:result.text,messageId:result.id});assert.equal(f.sends.length,1);
  }
});
test('device or context movement during inference refuses dispatch rather than changing its execution owner',async t=>{
  const f=fixture(t);f.setAnswer(input=>{f.queue.feed.device={kind:'mac',label:'Other device'};return {answer:'Doing it.',links:[],action:{ref:input.requestedChatRef,text:input.requestedMessage.text,mode:'send'}};});
  const result=await f.ask('Tell this chat to fix the layout.');assert.equal(result.status,'failed');assert.equal(f.dispatches.length,0);
});
test('accepted and terminal coordination survive restart without delivering again',async t=>{
  const f=fixture(t),result=await f.ask('Tell this chat to fix the layout.');f.assistant.close();
  const restored=new Assistant({directory:f.directory,snapshot:f.snapshot,provider:f.provider,dispatch:()=>assert.fail('Restart must not deliver')});t.after(()=>restored.close());
  restored.ask({text:result.text,messageId:result.id});f.source.turnId=result.action.turnId;f.source.turnOutcome='interrupted';restored.observe(f.snapshot());
  assert.equal(restored.state.messages.find(m=>m.id===result.id).action.status,'failed');assert.equal(f.sends.length,1);
});
test('single-message cancellation retains its draft when persistence fails and refuses accepted or uncertain entries',t=>{
  const f=fixture(t),input={id:f.card.id,taskKey:f.card.taskKey,sourceId:f.source.id,text:'Retain me'},queued=f.messages.enqueue(input),entry=f.messages.state.entries.find(e=>e.id===queued.messageId),save=f.messages.save;
  f.messages.save=()=>{throw new Error('Injected disk failure');};assert.throws(()=>f.messages.cancel(entry.id,entry.sourceId),/disk failure/);assert.equal(entry.status,'queued');assert.equal(entry.text,input.text);f.messages.save=save;
  for(const status of ['sending','sent','uncertain']){entry.status=status;assert.throws(()=>f.messages.cancel(entry.id,entry.sourceId),/no longer locally queued/);}
  assert.throws(()=>f.messages.cancel(entry.id,'another-source'),/unavailable/);
});
test('an opened source follows a moved card only on its original owner and binds the current task revision',()=>{
  const source={id:'same-source',lifecycle:'working'},focus={id:'previous-card',sourceId:source.id,ownerId:'original-owner'};
  const state={cards:[{id:'adopted-card',taskKey:'current-task',chatName:'Original chat',owner:{id:'original-owner',name:'Original PC'},sources:[source],primarySourceId:source.id}],health:{ok:true},collectedAt:Date.now()/1000};
  const current=context(state,'Tell this chat to fix it',{focus}),request=coordination.request([], {text:'Tell this chat to fix it'},current,{focus});
  assert.ok(request.ref);assert.equal(current.refs.get(request.ref).taskKey,'current-task');assert.equal(current.refs.get(request.ref).ownerId,'original-owner');
  state.cards[0].owner.id='replacement-owner';const changed=context(state,'Tell this chat to fix it',{focus});assert.equal(coordination.request([],{text:'Tell this chat to fix it'},changed,{focus}).ref,null);
});
test('offline and stale terminal evidence cannot finish an accepted coordination',()=>{
  const action={messageId:'message',sourceId:'source',ownerId:'owner',status:'accepted',turnId:'turn'},card={id:'card',owner:{id:'owner',online:false},sources:[{id:'source',turnId:'turn',turnOutcome:'completed'}]};
  const snapshot={cards:[card],health:{ok:true},collectedAt:Date.now()/1000};assert.equal(coordination.outcome(snapshot,action),null);card.owner.online=true;snapshot.collectedAt-=60;assert.equal(coordination.outcome(snapshot,action),null);snapshot.collectedAt=Date.now()/1000;assert.equal(coordination.outcome(snapshot,action).status,'completed');
});
