'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {Assistant,context}=require('../src/assistant.cjs');
const {AssistantProvider}=require('../src/assistant-provider.cjs');
const {nativeView}=require('../src/native-view.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function card(id='a',other={}){return {id,taskKey:id+'1',primarySourceId:'source-'+id,owner:{id:'pc',name:'This PC',online:true},
  chatName:'Delivery chat',title:'Check delivery',summary:'A draft is prepared, not sent.',status:'needs',waitingOn:{kind:'you'},
  at:50,sources:[{id:'source-'+id,lifecycle:'completed',contextLoaded:true,body:'Recorded context'}],...other};}
function fixture(t,provider){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-assistant-'));
  const state={cards:[card()],done:[],health:{ok:true},collectedAt:Math.floor(Date.now()/1000),monitoredCount:100};
  const fake=provider||{calls:[],async answer(input){this.calls.push(input);return {answer:'Review the delivery draft.',links:[{ref:'c0',draft:'Please check delivery.'}],model:'test'};},close(){}};
  const app=new Assistant({directory,snapshot:()=>state,provider:fake});
  t.after(()=>{app.close();fs.rmSync(directory,{recursive:true,force:true});});return {app,fake,directory,state};}
const input=text=>({messageId:crypto.randomUUID(),text});
test('a durable accepted question resolves with an exact chat draft without mutating its queue',async t=>{
  const {app,state}=fixture(t);const before=JSON.stringify(state);const question=input('What needs me?');
  assert.equal(app.ask(question).messageId,question.messageId);assert.equal(app.active,true);
  await app.work;assert.equal(app.active,false);assert.equal(app.snapshot().messages[0].status,'completed');
  const used=app.use({messageId:question.messageId,index:0});assert.equal(used.card.id,'a');assert.equal(used.sourceId,'source-a');
  assert.equal(used.draft,'Please check delivery.');assert.equal(JSON.stringify(state),before);
});
test('lost acknowledgements and restart replay the same receipt without another AI call',async t=>{
  const {app,directory,state,fake}=fixture(t);const question=input('What is happening?');app.ask(question);app.ask(question);await app.work;
  app.ask(question);assert.equal(fake.calls.length,1);
  const reloaded=new Assistant({directory,snapshot:()=>state,provider:fake});t.after(()=>reloaded.close());
  reloaded.ask(question);assert.equal(fake.calls.length,1);assert.throws(()=>reloaded.ask({...question,text:'Different text'}),/different message/);
});
test('a second question while answering is rejected, kept drafts can submit when idle',async t=>{
  let finish;const {app}=fixture(t,{answer:()=>new Promise(resolve=>finish=resolve),close(){}});
  app.ask(input('First'));assert.throws(()=>app.ask(input('Second')),/answering/);
  finish({answer:'First answer',links:[]});await app.work;assert.doesNotThrow(()=>app.ask(input('/memory')));
});
test('explicit memories persist, list, deduplicate and forget without inference',async t=>{
  const {app,directory,state,fake}=fixture(t);app.ask(input('Remember that I prefer morning updates.'));
  app.ask(input('Remember that I prefer morning updates.'));assert.deepEqual(app.state.notes,['I prefer morning updates.']);assert.equal(fake.calls.length,0);
  const reloaded=new Assistant({directory,snapshot:()=>state,provider:fake});t.after(()=>reloaded.close());
  reloaded.ask(input('/memory'));assert.match(reloaded.snapshot().messages.at(-1).answer,/morning updates/);
  reloaded.ask(input('/forget 1'));assert.equal(reloaded.state.notes.length,0);reloaded.ask(input('/remember one'));reloaded.ask(input('/forget all'));assert.equal(reloaded.state.notes.length,0);
});
test('ordinary conversation does not extract or persist inferred memories',async t=>{
  const {app,fake}=fixture(t);app.ask(input('I prefer afternoon updates.'));await app.work;
  assert.deepEqual(app.state.notes,[]);assert.deepEqual(fake.calls[0].savedNotes,[]);
});
test('interrupted assistant inference is visible after restart and never auto replays',async t=>{
  const {app,directory,state}=fixture(t,{answer:()=>new Promise(()=>{}),close(){}});const question=input('In flight');app.ask(question);
  const reloaded=new Assistant({directory,snapshot:()=>state,provider:{answer(){throw new Error('must not replay');},close(){}}});t.after(()=>reloaded.close());
  assert.equal(reloaded.snapshot().messages[0].status,'failed');assert.match(reloaded.snapshot().messages[0].error,/restarted/);
  assert.equal(reloaded.ask(question).accepted,true);assert.equal(reloaded.active,false);
});
test('corrupt history is preserved and cannot be overwritten by a new question',t=>{
  const {directory,state}=fixture(t);const file=path.join(directory,'assistant.json');fs.writeFileSync(file,'broken');
  const app=new Assistant({directory,snapshot:()=>state,provider:{close(){}}});t.after(()=>app.close());
  assert.throws(()=>app.ask(input('Hello')),/history/);assert.equal(fs.readFileSync(file,'utf8'),'broken');
});
test('invalid model references fail the answer instead of routing to another chat',async t=>{
  const {app}=fixture(t,{async answer(){return {answer:'Draft',links:[{ref:'foreign',draft:'send here'}]};},close(){}});
  const question=input('Draft a reply');app.ask(question);await app.work;assert.equal(app.state.messages[0].status,'failed');
  assert.throws(()=>app.use({messageId:question.messageId,index:0}),/unavailable/);
});
test('updated context and another device cannot use an old assistant draft',async t=>{
  const {app,state}=fixture(t);const question=input('Draft a reply');app.ask(question);await app.work;
  state.cards[0].summary='The recipient replied.';assert.throws(()=>app.use({messageId:question.messageId,index:0}),/changed/);
  state.cards[0]=card('a',{owner:{id:'other-device'}});assert.throws(()=>app.use({messageId:question.messageId,index:0}),/changed/);
});
test('bounded retrieval prioritizes urgent requests and preserves unknown waiting ownership',()=>{
  const state={cards:Array.from({length:500},(_,i)=>card('c'+i,{status:'waiting',waitingOn:{kind:'unknown'}})),done:[],health:{ok:false}};
  state.cards.push(card('urgent',{urgent:true}));const value=context(state,'What needs me?').data;
  assert.equal(value.cards[0].urgent,true);assert.equal(value.cards[1].waitingOn.kind,'unknown');assert.equal(value.health.ok,false);
  assert.equal(value.coverage.totalCards,501);assert.ok(value.cards.length<=36);assert.ok(JSON.stringify(value).length<19000);
});
test('recent history and saved notes are included, with limited source excerpts',async t=>{
  const {app,fake}=fixture(t);app.ask(input('Remember that keep it concise'));app.ask(input('What needs me?'));await app.work;
  app.ask(input('Make that draft shorter'));await app.work;assert.deepEqual(fake.calls.at(-1).savedNotes,['keep it concise']);
  assert.ok(fake.calls.at(-1).history.some(m=>m.user==='What needs me?'));assert.equal(fake.calls.at(-1).queue.cards[0].excerpt,'Recorded context');
});
test('assistant projection exposes related update labels but omits routing and draft payloads',async t=>{
  const {app}=fixture(t);app.ask(input('Draft'));await app.work;const value=nativeView({assistant:app.snapshot()}).assistant;
  assert.equal(value.messages[0].links[0].hasDraft,true);assert.equal(value.messages[0].links[0].chatName,'Delivery chat');
  assert.doesNotMatch(JSON.stringify(value),/source-a|Please check delivery|revision|ownerId/);
});
test('new actionable updates arrive as messages with no inference, while startup does not flood history',t=>{
  const {app,state,fake}=fixture(t);app.observe(state);assert.equal(app.state.messages.length,0);
  state.cards[0].summary='A new draft is ready.';state.cards[0].fingerprint='new-pass';app.observe(state);
  assert.equal(app.state.messages.length,1);assert.equal(app.state.messages[0].kind,'update');assert.match(app.state.messages[0].answer,/new draft/);
  assert.equal(app.use({messageId:app.state.messages[0].id,index:0}).sourceId,'source-a');app.observe(state);assert.equal(app.state.messages.length,1);
  assert.equal(fake.calls.length,0);
});
test('automatic messages ignore stale, reviewed, running and someone-else waiting updates',t=>{
  const {app,state}=fixture(t);app.observe(state);
  state.cards[0]=card('a',{status:'waiting',waitingOn:{kind:'other',name:'Morgan'},fingerprint:'other'});app.observe(state);
  state.cards[0]=card('a',{status:'working',fingerprint:'running'});app.observe(state);
  state.cards[0]=card('a',{reviewed:true,fingerprint:'reviewed'});app.observe(state);
  state.cards[0]=card('a',{fingerprint:'fresh'});state.collectedAt=1;app.observe(state);assert.equal(app.state.messages.length,0);
  state.collectedAt=Math.floor(Date.now()/1000);app.observe(state);assert.equal(app.state.messages.length,1);
});
test('saved update fingerprints survive restart without duplicate automatic messages',t=>{
  const {app,state,directory}=fixture(t);app.observe(state);state.cards[0].fingerprint='next';app.observe(state);
  const reloaded=new Assistant({directory,snapshot:()=>state,provider:{close(){}}});t.after(()=>reloaded.close());
  reloaded.observe(state);assert.equal(reloaded.state.messages.length,1);
});
class FakeClient extends EventEmitter {
  constructor(mode){super();this.calls=[];this.mode=mode;}
  async connect(){}
  async call(method,params){this.calls.push({method,params});
    if(method==='model/list')return {data:[{model:'gpt-6-luna'}]};
    if(method==='config/read')return {config:{mcp_servers:{danger:{}},plugins:{danger:{}}}};
    if(method==='thread/start')return {thread:{id:'assistant-session',ephemeral:this.mode!=='persistent'}};
    if(method==='turn/start'){queueMicrotask(()=>{
      if(this.mode==='tool'){this.emit('request',{id:3,method:'item/commandExecution/requestApproval'});return;}
      this.emit('notification',{method:'item/completed',params:{threadId:params.threadId,item:{type:'agentMessage',text:JSON.stringify({answer:'Hello',links:[]})}}});
      this.emit('notification',{method:'turn/completed',params:{threadId:params.threadId,turn:{status:'completed'}}});
    });return {turn:{id:'test'}};}
  }
  reject(id){this.rejected=id;}
  close(){this.closed=true;}
}
test('provider uses an isolated cheap read-only session with all execution and connectors disabled',async t=>{
  const {directory}=fixture(t);const client=new FakeClient();const provider=new AssistantProvider({directory,clientFactory:()=>client});
  assert.equal((await provider.answer({question:'Hello'})).answer,'Hello');assert.equal(client.closed,true);
  const start=client.calls.find(c=>c.method==='thread/start').params;assert.equal(start.ephemeral,true);assert.equal(start.sandbox,'read-only');
  assert.equal(start.config['features.shell_tool'],false);assert.equal(start.config['mcp_servers.danger.enabled'],false);assert.equal(start.config['plugins.danger.enabled'],false);
  assert.ok(!client.calls.some(c=>c.method==='thread/resume'));assert.equal(client.calls.find(c=>c.method==='turn/start').params.model,'gpt-6-luna');
});
test('a tool request is rejected and the assistant transport is closed',async t=>{
  const {directory}=fixture(t);const client=new FakeClient('tool');const provider=new AssistantProvider({directory,clientFactory:()=>client});
  await assert.rejects(provider.answer({question:'Hello'}),/unsupported tool/);assert.equal(client.rejected,3);assert.equal(client.closed,true);
});
test('provider refuses persistence before invoking a model',async t=>{
  const {directory}=fixture(t);const client=new FakeClient('persistent');const provider=new AssistantProvider({directory,clientFactory:()=>client});
  await assert.rejects(provider.answer({question:'Hello'}),/private assistant/);assert.ok(!client.calls.some(c=>c.method==='turn/start'));assert.equal(client.closed,true);
});
test('provider sends image pixels through localImage input and does not put image paths in text context',async t=>{
  const {directory}=fixture(t),client=new FakeClient(),provider=new AssistantProvider({directory,clientFactory:()=>client});
  await provider.answer({question:'Explain this',images:[{path:'C:/private/image.png',id:'test'}]});
  const turn=client.calls.find(c=>c.method==='turn/start').params;
  assert.deepEqual(turn.input[1],{type:'localImage',path:'C:/private/image.png'});
  assert.ok(!turn.input[0].text.includes('C:/private'));assert.equal(JSON.parse(turn.input[0].text).attachedImages,1);
});
test('ordinary questions keep the small model and visual questions select an image-capable workhorse',async t=>{
  const {directory}=fixture(t);const create=()=>{const c=new FakeClient(),call=c.call.bind(c);c.call=async(method,params)=>method==='model/list'?{data:[
    {model:'gpt-6-sol',inputModalities:['text','image']},{model:'gpt-6-luna',inputModalities:['text','image']}]}:call(method,params);return c;};
  const provider=new AssistantProvider({directory,clientFactory:create});
  assert.equal((await provider.answer({question:'What needs me?'})).model,'gpt-6-luna');
  assert.equal((await provider.answer({question:'What is in this?',images:[{path:'C:/image.png'}]})).model,'gpt-6-sol');
});
