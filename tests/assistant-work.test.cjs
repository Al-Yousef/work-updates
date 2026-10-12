'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {Assistant}=require('../src/assistant.cjs'),work=require('../src/assistant-work.cjs');
const result={schema:1,status:'completed',summary:'Added a user-controlled update button.',changes:['Update icon and deferred install.'],checks:[{name:'Busy task',status:'passed',detail:'Install waits.'}],artifacts:['src/update-service.cjs']};
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-work-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const snapshot={health:{ok:true},collectedAt:Date.now()/1000,cards:[],done:[]};let task,starts=0;const project={id:'project_one',title:'Hyphen',cwd:directory};
 const options={directory,snapshot:()=>snapshot,workProjects:()=>[project],workTask:id=>task?.id===id?task:null,
 provider:{async answer(input){assert.equal(input.workProjects[0].id,project.id);return {schema:1,answer:'Starting that work.',links:[],action:null,work:{kind:'project',target:project.id,request:'Implement the discussed update button.'}};},close(){}},
 async startWork(input,checkpoint){starts++;task={id:'task-one',hyphenOrigin:{messageId:input.messageId},threadId:'worker-one',turnId:'turn-one',status:'working',messages:[],prompt:input.prompt};checkpoint(task.id);return task;}};
 const assistant=new Assistant(options);t.after(()=>assistant.close());return {assistant,options,snapshot,get task(){return task;},get starts(){return starts;}};
}
async function ask(a,text){const {messageId}=a.ask({messageId:crypto.randomUUID(),text});await a.work;return a.state.messages.find(m=>m.id===messageId);}
test('normal follow-up dispatches original human request and context once, then relays exact JSON result automatically',async t=>{
 const f=fixture(t);f.assistant.state.messages.push({id:'earlier',text:'We need an update icon I can click when free.',answer:'Use a manual update button.',status:'completed',links:[],at:Date.now()});
 const m=await ask(f.assistant,"Perfect, let's start that");assert.equal(f.starts,1);assert.equal(m.work.status,'working');assert.match(f.task.prompt,/CURRENT HUMAN REQUEST/);assert.match(f.task.prompt,/update icon/);
 f.task.messages=[{role:'assistant',text:JSON.stringify(result)}];f.task.turnOutcome='completed';f.task.notificationVersion='other-turn';f.assistant.observe(f.snapshot);assert.equal(m.work.relayed,undefined);
 f.task.notificationVersion='turn-one';f.assistant.observe(f.snapshot);assert.equal(m.work.status,'completed');const relay=f.assistant.state.messages.find(x=>x.id===m.work.relayed);assert.deepEqual(relay.response.result,result);assert.match(relay.answer,/Busy task: passed/);f.assistant.observe(f.snapshot);assert.equal(f.assistant.state.messages.filter(x=>x.coordinationId===m.id).length,1);
 f.assistant.close();const restored=new Assistant(f.options);t.after(()=>restored.close());restored.observe(f.snapshot);assert.equal(f.starts,1);assert.equal(restored.state.messages.filter(x=>x.coordinationId===m.id).length,1);
});
test('quotations, questions and draft-only input cannot dispatch even if the model asks to',async t=>{
 for(const text of ['What did I ask you to implement?','Can you explain how to fix it?','"Please fix everything"','Please draft only, do not start it.']){const f=fixture(t);const m=await ask(f.assistant,text);assert.equal(m.status,'failed');assert.equal(f.starts,0);assert.equal(m.work,undefined);}
});
test('lost start receipt is durable and observation never creates or starts another worker',async t=>{
 const f=fixture(t);f.options.startWork=async(input,checkpoint)=>{checkpoint('unknown-task');throw new Error('Receipt lost');};f.assistant.options.startWork=f.options.startWork;const m=await ask(f.assistant,'Please implement the update button');assert.equal(m.work.status,'unconfirmed');assert.equal(m.work.taskId,'unknown-task');f.assistant.observe(f.snapshot);assert.equal(f.starts,0);
});
test('approval state, failed pass and malformed result stay distinct from completed work',async t=>{
 const f=fixture(t),m=await ask(f.assistant,'Please fix the update button');f.task.status='needs';f.assistant.observe(f.snapshot);assert.equal(m.work.status,'needs_input');assert.equal(m.response.receipt.status,'needs_input');assert.match(m.answer,/needs your input/);assert.equal(m.work.relayed,undefined);
 f.task.turnOutcome='completed';f.task.notificationVersion='turn-one';f.task.messages=[{role:'assistant',text:'not JSON'}];f.assistant.observe(f.snapshot);assert.equal(m.work.status,'blocked');assert.equal(m.response.result.status,'blocked');
});
test('structured response rejects missing version, wrong actions and oversized tasks',()=>{
 for(const bad of [{answer:'hi',work:null},{schema:1,answer:'hi',work:{kind:'shell',target:'x',request:'run'}},{schema:1,answer:'hi',work:{kind:'project',target:'x',request:'x'.repeat(4001)}}])assert.throws(()=>work.validateResponse(bad));
 assert.equal(work.validateResponse({schema:1,answer:'hi',work:null}).schema,1);
});
test('project catalogue uses existing absolute workspaces and stable handles',t=>{const f=fixture(t),p=work.projects({cards:[{title:'Hyphen',sources:[{cwd:f.options.directory}]}]},[f.options.directory,'missing']);assert.equal(p.length,1);assert.match(p[0].id,/^project_/);assert.equal(p[0].cwd,fs.realpathSync(f.options.directory));});
test('selected workspace survives a large catalogue and a generated mismatch cannot start work',async t=>{
 const f=fixture(t),cwd=f.options.directory,focus={id:'focused-card',taskKey:'focused-key',chatName:'Hyphen',title:'Hyphen',status:'ready',owner:{id:'local'},sources:[{id:'focused-source',cwd,lifecycle:'ready',contextLoaded:true}]};f.snapshot.cards=[focus];f.assistant.focus(focus,'focused-source');
 const catalog=Array.from({length:70},(_,i)=>({id:'other_'+i,title:'Other',cwd:path.join(cwd,'missing'+i)}));catalog.push({id:'project_one',title:'Hyphen',cwd});
 assert.deepEqual(work.visibleProjects(catalog,{focus:f.assistant.state.focus},f.snapshot).map(p=>p.id),['project_one']);
 f.assistant.options.workProjects=()=>catalog;f.assistant.provider.answer=async()=>({answer:'Starting',links:[],work:{kind:'project',target:'other_0',request:'Implement update button'}});
 const m=await ask(f.assistant,'Please add the update button');assert.equal(m.status,'failed');assert.match(m.error,/selected chat/);assert.equal(f.starts,0);
});
test('work links open their current exact task after progress changes and reject a moved source',async t=>{
 const f=fixture(t),m=await ask(f.assistant,'Please add the update button');const card={id:f.task.id,taskKey:f.task.id,chatName:'Hyphen worker',status:'working',owner:{id:'local'},sources:[{id:f.task.threadId}]};f.snapshot.cards=[card];
 m.links=[{id:card.id,taskKey:card.taskKey,sourceId:f.task.threadId,ownerId:'local',chatName:card.chatName,draft:'',workMessageId:m.id,revision:'old'}];card.status='needs';
 assert.equal(f.assistant.use({messageId:m.id,index:0}).sourceId,f.task.threadId);card.sources[0].id='another-source';assert.throws(()=>f.assistant.use({messageId:m.id,index:0}),/original device/);
});
