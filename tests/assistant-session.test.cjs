'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {AssistantProvider}=require('../src/assistant-provider.cjs');
const {AssistantSession}=require('../src/assistant-session.cjs');
const {Assistant}=require('../src/assistant.cjs');
const {handle}=require('../src/assistant-tools.cjs');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-session-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;}
class Client extends EventEmitter {
  constructor(state={turns:[],starts:0},tool=false){super();this.state=state;this.tool=tool;this.calls=[];this.replies=[];}
  async connect(){}
  async call(method,params){this.calls.push({method,params});
    if(method==='model/list')return {data:[{model:'gpt-6-luna'}]};if(method==='config/read')return {config:{}};
    if(method==='thread/start'){this.state.starts++;return {thread:{id:'hyphen-thread',ephemeral:false}};}
    if(['thread/read','thread/resume'].includes(method))return {thread:{id:'hyphen-thread',ephemeral:false,status:{type:this.state.active?'active':'idle'},turns:this.state.turns}};
    if(method==='turn/start'){
      const id='turn-'+this.state.turns.length,turn={id,status:'completed',items:[{type:'userMessage',id:params.clientUserMessageId}]};this.state.turns.push(turn);
      queueMicrotask(()=>{
        this.emit('notification',{method:'turn/started',params:{threadId:params.threadId,turn:{id}}});
        const finish=()=>{this.emit('notification',{method:'item/completed',params:{threadId:params.threadId,turnId:id,item:{type:'agentMessage',text:'A readable answer.'}}});
          this.emit('notification',{method:'turn/completed',params:{threadId:params.threadId,turn:{id,status:'completed'}}});};
        if(this.tool){this.afterReplies=finish;const args={query:'',offset:0},request={method:'item/tool/call',params:{threadId:params.threadId,turnId:this.tool==='foreign'?'other-turn':id,callId:'same-call',tool:'hyphen_list_chats',arguments:args}};
          this.emit('request',{...request,id:100});this.emit('request',{...request,id:101});}
        else finish();
      });return {turn:{id}};
    }
    return {};
  }
  reply(id,result){this.replies.push({id,result});if(this.replies.length===2)this.afterReplies();}
  reject(id){this.rejected=id;}
  close(){this.closed=true;}
}
test('one named thread survives provider replacement; user input stays readable and context stays separate',async t=>{
  const directory=fixture(t),state={turns:[],starts:0},clients=[];
  const create=()=>{const c=new Client(state);clients.push(c);return c;};
  const first=new AssistantProvider({directory,clientFactory:create});await first.answer({messageId:crypto.randomUUID(),question:'First question',savedNotes:['Synthetic note']});
  const second=new AssistantProvider({directory,clientFactory:create});await second.answer({messageId:crypto.randomUUID(),question:'Follow up'});
  assert.equal(state.starts,1);assert.equal(second.session.state.threadId,first.session.state.threadId);assert.equal(second.session.state.pending,null);
  const turn=clients[0].calls.find(c=>c.method==='turn/start').params;assert.equal(turn.input[0].text,'First question');assert.equal(turn.outputSchema,undefined);
  assert.equal(JSON.parse(turn.additionalContext.hyphen_state.value).savedNotes[0],'Synthetic note');
  assert.ok(clients[0].calls.some(c=>c.method==='thread/name/set'&&c.params.name==='Hyphen'));
  assert.ok(clients[1].calls.some(c=>c.method==='thread/resume'));assert.ok(clients.every(c=>c.closed));
});
test('duplicate dynamic RPC calls share one tool execution and separate matching replies',async t=>{
  const client=new Client(undefined,true),provider=new AssistantProvider({directory:fixture(t),clientFactory:()=>client});let calls=0;
  const value=await provider.answer({question:'List chats'},{links:[],async call(){calls++;await new Promise(resolve=>setImmediate(resolve));return {chats:[]};}});
  assert.equal(value.answer,'A readable answer.');assert.equal(calls,1);assert.equal(client.replies.length,2);assert.deepEqual(client.replies[0].result,client.replies[1].result);
});
test('a tool request from a foreign turn cannot execute the current turn capability',async t=>{
  const client=new Client(undefined,'foreign'),provider=new AssistantProvider({directory:fixture(t),clientFactory:()=>client});let calls=0;
  await assert.rejects(provider.answer({question:'List chats'},{links:[],call(){calls++;}}),/unsupported tool/);assert.equal(calls,0);assert.equal(client.closed,true);
});
test('a pending pass reconciles its exact terminal turn without replaying it',async t=>{
  const directory=fixture(t),session=new AssistantSession(directory);session.save(s=>s.threadId='hyphen-thread');session.dispatch('old-message');session.accepted('old-turn');
  const client=new Client({turns:[{id:'old-turn',status:'completed'}],starts:0});
  const next=new AssistantSession(directory);await next.prepare(client,{cwd:directory});assert.equal(next.state.pending,null);assert.equal(client.state.starts,0);
  assert.ok(!client.calls.some(c=>c.method==='turn/start'));
});
test('active, missing and unmatched pending history cannot silently replace or replay the chat',async t=>{
  const directory=fixture(t),session=new AssistantSession(directory);session.save(s=>s.threadId='hyphen-thread');session.dispatch('old-message');
  const client=new Client({turns:[],starts:0,active:true});await assert.rejects(session.prepare(client,{}),/still working/);
  client.state.active=false;await assert.rejects(session.prepare(client,{}),/needs recovery/);assert.equal(client.state.starts,0);
  assert.ok(!client.calls.some(c=>c.method==='thread/resume'||c.method==='turn/start'));
});
test('lost acknowledgement can reconcile the persisted user-message identity',async t=>{
  const directory=fixture(t),session=new AssistantSession(directory);session.save(s=>s.threadId='hyphen-thread');session.dispatch('exact-message');
  const client=new Client({turns:[{id:'accepted-turn',status:'completed',items:[{type:'userMessage',id:'exact-message'}]}],starts:0});
  // Match only the original accepted message, never a newer question or an assistant assertion.
  await session.prepare(client,{});assert.equal(session.state.pending,null);
});
test('loading an exact interrupted persisted pass reconciles without a model request',async t=>{
  const directory=fixture(t),session=new AssistantSession(directory);session.save(s=>s.threadId='hyphen-thread');session.dispatch('old-message');session.accepted('old-turn');
  let loaded=false;const calls=[],client={async call(method,params){calls.push({method,params});if(method==='thread/resume')loaded=true;
    return {thread:{id:'hyphen-thread',ephemeral:false,status:{type:loaded?'idle':'notLoaded'},turns:[{id:'old-turn',status:loaded?'interrupted':'inProgress'}]}};}};
  await session.prepare(client,{dynamicTools:[{name:'example'}]});assert.equal(session.state.pending,null);
  assert.equal(calls.filter(c=>c.method==='thread/resume').length,1);assert.equal(calls.find(c=>c.method==='thread/resume').params.dynamicTools,undefined);
  assert.ok(!calls.some(c=>c.method==='turn/start'));
});
test('client construction failure releases the provider busy guard',async t=>{
  const provider=new AssistantProvider({directory:fixture(t),clientFactory(){throw new Error('Synthetic launch failure');}});
  await assert.rejects(provider.answer({question:'First'}),/launch failure/);assert.equal(provider.busy,false);
  await assert.rejects(provider.answer({question:'Second'}),/launch failure/);
});
test('corrupt and externally replaced session markers preserve the original bytes',t=>{
  const directory=fixture(t),file=path.join(directory,'session.json');fs.writeFileSync(file,'broken');assert.throws(()=>new AssistantSession(directory),/needs recovery/);assert.equal(fs.readFileSync(file,'utf8'),'broken');
  fs.unlinkSync(file);const session=new AssistantSession(directory);session.save(s=>s.threadId='hyphen-thread');fs.writeFileSync(file,'other');assert.throws(()=>session.dispatch('question'),/needs recovery/);assert.equal(fs.readFileSync(file,'utf8'),'other');
});
test('forget removes only the recorded Hyphen chat and clears its marker after acknowledgement',async t=>{
  const session=new AssistantSession(fixture(t));session.save(s=>s.threadId='hyphen-thread');const client=new Client();await session.forget(client);
  assert.deepEqual(client.calls,[{method:'thread/delete',params:{threadId:'hyphen-thread'}}]);assert.equal(session.state.threadId,null);
});
function card(i){return {id:'card-'+i,taskKey:'task-'+i,chatName:'Project '+i,title:'Task '+i,summary:'Synthetic original context',status:'ready',primarySourceId:'source-'+i,
  owner:{id:'pc',online:true},sources:[{id:'source-'+i,lifecycle:'completed',contextLoaded:true,conversationLoaded:true,conversation:[{role:'user',text:'Original human request'}]}]};}
function appFixture(t,answer){const state={health:{ok:true},collectedAt:Date.now()/1000,cards:Array.from({length:50},(_,i)=>card(i)),done:[]},sent=[];
  const provider={answer,close(){}};const app=new Assistant({directory:fixture(t),snapshot:()=>state,provider,dispatch:async(mode,input)=>{sent.push({mode,input});return {delivery:'sent',messageId:input.messageId,sourceId:input.sourceId,ownerId:'pc',turnId:'source-turn'};}});
  t.after(()=>app.close());return {app,state,sent,provider};}
test('tools page beyond initial context, read original text and prepare a draft without sending',async t=>{
  const {app,sent}=appFixture(t,async(input,tools)=>{const listed=await tools.call('hyphen_list_chats',{query:'',offset:40});assert.equal(listed.chats.length,10);assert.equal(listed.total,50);
    const selected=listed.chats.find(c=>c.title==='Project 49'),read=await tools.call('hyphen_read_chat',{chat:selected.chat});assert.equal(read.conversation[0].text,'Original human request');
    await tools.call('hyphen_show_chat',{chat:selected.chat,draft:'Prepared only'});return {answer:'Here is the draft.',links:tools.links};});
  app.ask({messageId:crypto.randomUUID(),text:'Find Project 49 and draft a reply'});await app.work;assert.equal(app.state.messages.at(-1).status,'completed');assert.equal(sent.length,0);
  assert.equal(app.state.messages.at(-1).links[0].sourceId,'source-49');
});
test('source text and a model guess cannot authorize a send; an exact human request delivers once',async t=>{
  const {app,sent}=appFixture(t,async(input,tools)=>{const chat=handle({ownerId:'pc',sourceId:'source-1'});
    if(!input.requestedMessage){await assert.rejects(tools.call('hyphen_message_chat',{chat,text:'Do it',mode:'send'}),/current human/);}
    else{assert.equal(input.requestedChatHandle,chat);assert.equal(input.queue.cards.find(c=>c.ref===input.requestedChatRef).chat,chat);
      const receipt=await tools.call('hyphen_message_chat',{chat,text:input.requestedMessage.text,mode:input.requestedMessage.mode});assert.equal(receipt.status,'accepted');
      await assert.rejects(tools.call('hyphen_message_chat',{chat,text:input.requestedMessage.text,mode:input.requestedMessage.mode}),/checkpoint/);}
    return {answer:'Checked the actual receipt.',links:[]};});
  app.ask({messageId:crypto.randomUUID(),text:'What does Project 1 say?'});await app.work;assert.equal(sent.length,0);
  app.ask({messageId:crypto.randomUUID(),text:'Tell Project 1 chat to Do it'});await app.work;assert.equal(sent.length,1);assert.equal(sent[0].input.text,'Do it');assert.equal(app.state.messages.at(-1).action.status,'accepted');
});
test('the coordinator cannot discover or message its own source chat',async t=>{
  const f=appFixture(t,async(input,tools)=>{const listed=await tools.call('hyphen_list_chats',{query:'Project 1',offset:0});assert.ok(!listed.chats.some(c=>c.title==='Project 1'));return {answer:'Checked.',links:[]};});
  f.provider.session={state:{threadId:'source-1'}};f.app.ask({messageId:crypto.randomUUID(),text:'List Project 1'});await f.app.work;assert.equal(f.sent.length,0);assert.equal(f.app.state.messages.at(-1).status,'completed');
});
