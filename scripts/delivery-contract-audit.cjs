'use strict';
// Opt-in: one newly created disposable chat, four synthetic turns, no connectors.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {Codex}=require('../src/codex.cjs'),{Queue}=require('../src/queue.cjs'),{Controller}=require('../src/controller.cjs'),{Messages}=require('../src/messages.cjs');
const {DemoCodex,feed}=require('../src/demo.cjs');
const synthetic=process.argv.includes('--synthetic');
if(!synthetic&&!process.argv.includes('--allow-disposable-chat'))throw new Error('Requires explicit human authorization and --allow-disposable-chat. Creates and archives one test chat and consumes existing model quota.');
const directory=path.resolve(process.argv.find(a=>a.startsWith('--output='))?.slice(9)||'artifacts/delivery-contract-'+Date.now());
if(fs.existsSync(directory)&&fs.readdirSync(directory).length)throw new Error('Use a new empty audit directory. Existing app data is not a fixture.');
fs.mkdirSync(directory,{recursive:true});
let client,q,controller,messages,threadId,model,dispatches=0,completed=0,toolRequested=false;const turnStatuses=new Map();
const tokens=['SYNTHETIC_SEND_OK','SYNTHETIC_BUSY_LINES','SYNTHETIC_QUEUE_OK','SYNTHETIC_RECEIPT_OK'];
const prompts=[`Reply only ${tokens[0]}.`,`${tokens[1]}: Write 100 numbered lines, each containing only its number and AUDIT. Do not call tools.`, `Reply only ${tokens[2]}.`,`Reply only ${tokens[3]}.`];
const accepted=[],evidence=[];let transcript=[];
const wait=async predicate=>{const deadline=Date.now()+180000;while(!predicate()){if(toolRequested)throw new Error('Unexpected tool request; audit stopped.');if(Date.now()>deadline)throw new Error('Audit timed out; no automatic delivery retry.');await new Promise(r=>setTimeout(r,100));}};
function refresh(){const fixture=feed();fixture.threads=[{...fixture.threads[0],id:threadId,title:'Hyphen disposable delivery audit',taskTitle:'Synthetic delivery contract',body:'Synthetic delivery evidence only',
  lifecycle:client.active.has(threadId)?'working':'completed',turnId:accepted.at(-1)||'',fingerprint:'audit-'+completed,updatedAt:Math.floor(Date.now()/1000)}];fixture.monitoredCount=1;fixture.collectedAt=Date.now()/1000;q.setFeed(fixture);}
function input(value){refresh();const card=q.cards().find(c=>c.sources.some(s=>s.id===threadId));assert.ok(card,'Exact audit source is present');return {id:card.id,taskKey:card.taskKey,sourceId:threadId,text:value,messageId:crypto.randomUUID()};}
function wire(next){
  client=next;client.on('notification',m=>{if(m.params?.threadId===threadId&&m.method==='turn/completed'){completed++;turnStatuses.set(m.params.turn.id,m.params.turn.status);}});
  client.on('request',m=>{toolRequested=true;client.reject(m.id);});
  const send=client.send.bind(client);client.send=async(id,text,images,options)=>{assert.equal(id,threadId,'Never submit to another source');dispatches++;transcript.push(text);const r=await send(id,text,images,options);accepted.push(r.turn?.id||r.turnId);return r;};
  q=new Queue(directory);refresh();controller=new Controller(q,client);messages=new Messages(q,controller,{auto:false});
}
async function idle(){const turnId=accepted.at(-1);await wait(()=>turnStatuses.has(turnId)&&!client.active.has(threadId));assert.equal(turnStatuses.get(turnId),'completed','The accepted audit turn must finish successfully');refresh();}
function restoreMessages(){messages.close();messages=new Messages(q,controller,{auto:false});}
async function newPrivateClient(){
  const next=new Codex({requestTimeoutMs:15000});await next.connect();return next;
}
class AuditDemo extends DemoCodex {
  async send(id){
    const turnId=crypto.randomUUID();
    // Match real RPC ordering: acceptance may precede turn/started.
    setTimeout(()=>{this.active.set(id,turnId);this.emit('notification',{method:'turn/started',params:{threadId:id,turn:{id:turnId}}});
      setTimeout(()=>{this.active.delete(id);this.emit('notification',{method:'turn/completed',params:{threadId:id,turn:{id:turnId,status:'completed'}}});},500);
    },20);
    return {turn:{id:turnId}};
  }
}
async function verifyTranscript(){
  if(synthetic)return transcript;
  const out=await client.call('thread/read',{threadId,includeTurns:true});assert.equal(out.thread.id,threadId);
  return out.thread.turns.flatMap(turn=>turn.items||[]).filter(item=>item.type==='userMessage').map(item=>(item.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n'));
}
(async()=>{
  const started=Date.now();let archived=false;
  try{
    if(synthetic){model='synthetic-transport';threadId=crypto.randomUUID();wire(new AuditDemo());}
    else{
      client=await newPrivateClient();const models=await client.call('model/list',{includeHidden:false});
      model=['gpt-6-luna','gpt-5.6-luna'].find(id=>models.data.some(m=>m.model===id));assert.ok(model,'Existing small model must be available');
      const {config:existing}=await client.call('config/read',{includeLayers:false});
      const config={project_doc_max_bytes:0,include_environment_context:false,include_apps_instructions:false,include_collaboration_mode_instructions:false,web_search:'disabled','tools.view_image':false,'agents.enabled':false,'features.code_mode.enabled':false};
      for(const name of ['shell_tool','unified_exec','multi_agent','apps','hooks','memories','remote_plugin','goals'])config['features.'+name]=false;
      for(const id of Object.keys(existing.mcp_servers||{})){config[`mcp_servers.${id}.enabled`]=false;config[`mcp_servers.${id}.required`]=false;}
      for(const id of Object.keys(existing.plugins||{}))config[`plugins.${id}.enabled`]=false;
      const instructions='This is a disposable Hyphen delivery audit. Respond only to the synthetic text. Never call tools, read files, use connectors or do external work.';
      const out=await client.call('thread/start',{cwd:directory,model,approvalPolicy:'never',sandbox:'read-only',baseInstructions:instructions,developerInstructions:instructions,config,serviceName:'hyphen_delivery_audit'});
      threadId=out.thread.id;assert.ok(threadId);client.loaded.add(threadId);
      fs.writeFileSync(path.join(directory,'private-audit-identity.json'),JSON.stringify({threadId,createdByAudit:true}));
      await client.call('thread/name/set',{threadId,name:'Hyphen disposable delivery audit'});wire(client);
    }
    const first=input(prompts[0]);const firstReceipt=await messages.send(first);assert.equal(firstReceipt.delivery,'sent');await idle();
    // Drop the panel's response, then restart the message journal and helper.
    messages.close();client.close();wire(synthetic?new AuditDemo():await newPrivateClient());
    const replay=await messages.send(first);assert.deepEqual(replay,firstReceipt);assert.equal(dispatches,1);evidence.push('Lost panel acknowledgement and restart reuse the saved receipt without resending');
    const busy=input(prompts[1]);await messages.send(busy);
    await wait(()=>client.active.has(threadId)||turnStatuses.has(accepted.at(-1)));
    assert.ok(client.active.has(threadId),'Busy Queue must observe a genuinely active turn');
    const queued=input(prompts[2]);assert.equal(messages.enqueue(queued).delivery,'queued');await messages.pump();assert.equal(dispatches,2);
    restoreMessages();assert.equal(messages.enqueue(queued).delivery,'queued');await messages.pump();assert.equal(dispatches,2);await idle();
    await messages.pump();assert.equal(dispatches,3);await idle();assert.equal(messages.state.entries.find(e=>e.id===queued.messageId).status,'sent');
    evidence.push('Busy-chat Queue persists across journal restart and duplicate requests, then dispatches once');
    const failure=input(prompts[3]);const save=messages.save.bind(messages);let writes=0;
    messages.save=()=>{if(++writes===3)throw new Error('Synthetic receipt commit failure');return save();};
    await assert.rejects(messages.send(failure),e=>e.delivery==='uncertain');assert.equal(messages.state.entries.find(e=>e.id===failure.messageId).text,failure.text);await idle();
    restoreMessages();const reconciled=await messages.send(failure);assert.equal(reconciled.delivery,'sent');assert.equal(dispatches,4);
    evidence.push('Acceptance plus injected receipt-storage failure retains the draft and reconciles without resending');
    const userTexts=await verifyTranscript();for(const prompt of prompts)assert.equal(userTexts.filter(t=>t===prompt).length,1,'Each synthetic intent occurs once in the exact chat');
    assert.equal(userTexts.length,4);assert.equal(toolRequested,false);
    if(!synthetic){await client.call('thread/archive',{threadId});archived=true;}
    const report={passed:true,mode:synthetic?'synthetic transport':'actual Codex app-server',model,actualModelTurns:synthetic?0:4,dispatches,
      elapsedMs:Date.now()-started,originalUserMessagesVerified:userTexts.length,realExistingChatsTouched:0,createdChats:synthetic?0:1,archived,
      connectorCalls:0,actualUsageAvailable:false,usageNote:'Current transport exposes no billed token/cost metadata.',evidence,
      limits:synthetic?'Synthetic transport only; no account, model or actual chat acceptance was tested.':'Panel acknowledgement loss and receipt-storage failure are injected locally. This is app-server acceptance evidence, not desktop-owner/device/native GUI or physical input proof.'};
    fs.writeFileSync(path.join(directory,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }catch(error){fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({passed:false,error:error.message,dispatches,elapsedMs:Date.now()-started,createdAuditChat:!!threadId&&!synthetic,archived,needsHumanReview:!!threadId&&!synthetic}));throw error;}
  finally{messages?.close();client?.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
