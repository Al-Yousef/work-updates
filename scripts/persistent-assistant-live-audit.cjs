'use strict';
// Opt-in account audit: two new disposable chats, four assistant turns and one
// synthetic source turn. Never reads or messages existing personal chats.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {Codex}=require('../src/codex.cjs'),{Queue}=require('../src/queue.cjs'),{Messages}=require('../src/messages.cjs'),{Controller}=require('../src/controller.cjs');
const {Assistant}=require('../src/assistant.cjs'),{feed}=require('../src/demo.cjs');
if(!process.argv.includes('--allow-disposable-chats'))throw new Error('Separate human authorization is required: two disposable Codex chats and five synthetic model messages, then archive both chats.');
const resume=process.argv.includes('--resume-audit');
const directory=path.resolve(process.argv.find(a=>a.startsWith('--output='))?.slice(9)||'artifacts/persistent-assistant-'+Date.now());
if(!resume&&fs.existsSync(directory)&&fs.readdirSync(directory).length)throw new Error('Use a new empty audit directory, never installed data.');fs.mkdirSync(directory,{recursive:true});
const workerName='Hyphen persistent audit worker',marker='MAPLE-'+crypto.randomBytes(5).toString('hex'),toolCalls=[],outcomes=new Map();
let client,queue,messages,assistant,workerId,coordinatorId,model,dispatches=0,acceptedTurn=null,archived=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function snapshot(){const value=messages.decorate(queue.snapshot());value.cards=value.cards.map(c=>({...c,owner:{id:'audit-pc',name:'Disposable audit PC',kind:'pc',online:true}}));return value;}
async function refresh(read=false){
  let conversation=[];if(read){const value=await client.call('thread/read',{threadId:workerId,includeTurns:true});conversation=value.thread.turns.flatMap(t=>t.items||[]).flatMap(i=>
    i.type==='userMessage'?[{role:'user',text:(i.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')}]:i.type==='agentMessage'?[{role:'assistant',text:i.text}]:[]);}
  const value=feed(),terminal=outcomes.get(acceptedTurn),working=!!acceptedTurn&&!terminal;
  value.threads=[{...value.threads[0],id:workerId,title:workerName,taskTitle:'Synthetic persistent assistant audit',body:conversation.at(-1)?.text||'A new disposable audit chat.',conversation,contextLoaded:true,conversationLoaded:read,
    lifecycle:working?'working':'completed',turnId:acceptedTurn||'',turnOutcome:terminal||null,fingerprint:'audit-'+outcomes.size,updatedAt:Date.now()/1000}];
  value.monitoredCount=1;value.collectedAt=Date.now()/1000;queue.setFeed(value);assistant?.observe(snapshot());return snapshot();
}
function open(){assistant=new Assistant({directory,snapshot,loadContext:async targets=>{assert.ok(targets.every(t=>t.sourceId===workerId));if(acceptedTurn&&!outcomes.has(acceptedTurn))await waitForSource();return refresh(true);},
  dispatch:async(mode,input)=>{assert.equal(input.sourceId,workerId);assert.equal(mode,'send');const receipt=await messages.send(input);return {...receipt,ownerId:'audit-pc'};}});
  const answer=assistant.provider.answer.bind(assistant.provider);assistant.provider.answer=async(input,tools)=>{
    const call=tools.call.bind(tools);tools.call=async(name,args)=>{toolCalls.push(name);return call(name,args);};return answer(input,tools);};
  assistant.focus(snapshot().cards[0],workerId);
}
async function ask(text){await refresh();const messageId=crypto.randomUUID();assistant.ask({messageId,text});await assistant.work;
  const message=assistant.state.messages.find(m=>m.id===messageId);assert.equal(message.status,'completed',message.error);coordinatorId=assistant.provider.session.state.threadId;return message;}
async function waitForSource(){const deadline=Date.now()+90000;while(!outcomes.has(acceptedTurn)){if(Date.now()>deadline)throw new Error('Audit source timed out; no delivery retry.');await pause(100);}assert.equal(outcomes.get(acceptedTurn),'completed');await refresh(true);}
(async()=>{const started=Date.now();try{
  client=new Codex({requestTimeoutMs:60000});await client.connect();const catalog=await client.call('model/list',{includeHidden:false});model=['gpt-6-luna','gpt-5.6-luna'].find(id=>catalog.data.some(m=>m.model===id));assert.ok(model);
  const {config:existing}=await client.call('config/read',{includeLayers:false}),config={project_doc_max_bytes:0,include_environment_context:false,include_apps_instructions:false,include_collaboration_mode_instructions:false,web_search:'disabled','tools.view_image':false,'agents.enabled':false,'features.code_mode.enabled':false};
  for(const name of ['shell_tool','unified_exec','multi_agent','apps','hooks','memories','remote_plugin','goals'])config['features.'+name]=false;
  for(const id of Object.keys(existing.mcp_servers||{})){config['mcp_servers.'+id+'.enabled']=false;config['mcp_servers.'+id+'.required']=false;}for(const id of Object.keys(existing.plugins||{}))config['plugins.'+id+'.enabled']=false;
  const policy='This is a disposable synthetic transport audit. Never call tools or access files/accounts. Follow the synthetic user prompt only.';
  if(resume){
    const saved=JSON.parse(fs.readFileSync(path.join(directory,'private-audit-identity.json')));assert.equal(saved.createdByAudit,true);workerId=saved.workerId;coordinatorId=saved.coordinatorId;assert.notEqual(workerId,coordinatorId);
    for(const id of [workerId,coordinatorId]){const {thread}=await client.call('thread/read',{threadId:id,includeTurns:true});assert.equal(path.resolve(thread.cwd),directory+(id===coordinatorId?path.sep+'assistant-session':''));
      assert.equal(thread.turns.length,id===coordinatorId?3:0,'Resume is limited to the original stopped five-message audit.');await client.call('thread/unarchive',{threadId:id});}
    await client.call('thread/resume',{threadId:workerId,cwd:directory,model,sandbox:'read-only',approvalPolicy:'never',config,baseInstructions:policy,developerInstructions:policy});
  }else workerId=(await client.call('thread/start',{cwd:directory,model,ephemeral:false,sandbox:'read-only',approvalPolicy:'never',config,baseInstructions:policy,developerInstructions:policy,serviceName:'hyphen_persistent_audit'})).thread.id;
  client.loaded.add(workerId);await client.call('thread/name/set',{threadId:workerId,name:workerName});
  client.on('notification',event=>{if(event.params?.threadId===workerId&&event.method==='turn/completed')outcomes.set(event.params.turn.id,event.params.turn.status);});
  client.on('request',request=>client.reject(request.id));
  const send=client.send.bind(client);client.send=async(id,...args)=>{assert.equal(id,workerId);dispatches++;const result=await send(id,...args);acceptedTurn=result.turn?.id||result.turnId;return result;};
  queue=new Queue(directory);messages=new Messages(queue,new Controller(queue,client),{auto:false});await refresh();open();
  let relay;
  if(resume){const originalId=coordinatorId;relay=await ask('Send "Reply only PERSISTENT_WORKER_OK." to it, then read its actual reply, check the message status and relay the result to me. Distinguish completed pass from verified goal.');assert.ok(relay.action);assert.equal(coordinatorId,originalId);await waitForSource();}
  else{await ask('For this disposable audit, our project marker is '+marker+'. Acknowledge it briefly.');const originalId=coordinatorId;
    assistant.close();open();const recalled=await ask('What is our audit project marker? Reply with the marker.');assert.ok(recalled.answer.includes(marker));assert.equal(coordinatorId,originalId);
    const sent=await ask('Tell '+workerName+' chat to Reply only PERSISTENT_WORKER_OK.');assert.equal(sent.action.status,'accepted');assert.equal(dispatches,1);await waitForSource();
    relay=await ask('Read '+workerName+' and relay its actual latest reply. Also check the receipt for the message you sent; distinguish completed pass from verified goal.');}
  assert.ok(relay.answer.includes('PERSISTENT_WORKER_OK'));assert.equal(dispatches,1);
  for(const tool of ['hyphen_message_chat','hyphen_read_chat','hyphen_message_status'])assert.ok(toolCalls.includes(tool),'Missing actual tool: '+tool);
  const stored=(await client.call('thread/read',{threadId:coordinatorId,includeTurns:true})).thread;assert.equal(stored.ephemeral,false);assert.equal(stored.turns.length,4);
  for(const turn of stored.turns){const users=turn.items.filter(i=>i.type==='userMessage');assert.equal(users.length,1);assert.ok(!JSON.stringify(users[0]).includes('savedNotesProvenance'));}
  const result={schema:1,passed:true,at:new Date().toISOString(),model,assistantModelTurns:4,sourceModelTurns:1,createdChats:2,existingChatsTouched:0,dispatches,
    sameChatAfterRestart:true,markerRecalled:true,readableStoredUserMessages:true,toolCalls,actualSourceReplyRelayed:true,completedPassIsNotGoalVerification:true,elapsedMs:Date.now()-started};
  fs.writeFileSync(path.join(directory,'verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
  coordinatorId??=assistant?.provider.session?.state.threadId;
  fs.writeFileSync(path.join(directory,'private-audit-identity.json'),JSON.stringify({workerId,coordinatorId,createdByAudit:true}));
  assistant?.close();messages?.close();
  if(client)for(const threadId of [workerId,coordinatorId].filter(Boolean)){try{await client.call('thread/archive',{threadId});archived.push(threadId);}catch{}}
  fs.writeFileSync(path.join(directory,'cleanup.json'),JSON.stringify({created: [workerId,coordinatorId].filter(Boolean).length,archived:archived.length,complete:archived.length===2}));client?.close();
}})().catch(error=>{fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({passed:false,error:error.message,dispatches,archived:archived.length}));console.error(error.stack);process.exitCode=1;});
