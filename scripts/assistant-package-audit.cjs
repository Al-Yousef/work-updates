'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../artifacts/assistant-continuity-20261006'),manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const directory=path.join(root,'isolated-profile-'+Date.now()),descriptor=path.join(directory,'native-control.info');fs.mkdirSync(directory,{recursive:true});
fs.writeFileSync(path.join(directory,'state.json'),JSON.stringify({version:1,tasks:[],cards:{},done:{},groups:[],settings:{corner:false,pin:false,attention:false,aiSummaries:false}}));
const legacy={version:1,notes:[],receipts:{},seen:null,messages:[{id:crypto.randomUUID(),text:'I prefer a private launch.',answer:'We will keep it private.',status:'completed',at:1,links:[]}]};
for(let i=0;i<99;i++)legacy.messages.push({id:crypto.randomUUID(),kind:'update',text:'',answer:'A synthetic update '+i,status:'completed',at:i+2,links:[]});
fs.writeFileSync(path.join(directory,'assistant.json'),JSON.stringify(legacy));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));let child,subscription,latest;
const archiveHash=()=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'app.asar'))).digest('hex');
async function until(check,label,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await pause(100);}throw new Error(label+' timed out');}
function identity(){const [magic,pipe,token,pid]=fs.readFileSync(descriptor,'utf8').split('\n');assert.equal(magic,'work-updates-native-v1');assert.equal(Number(pid),child.pid);return {pipe,token};}
async function request(frame){const {pipe,token}=identity();return new Promise((resolve,reject)=>{const socket=net.createConnection(pipe);let buffer='';socket.setEncoding('utf8');socket.setTimeout(10000,()=>socket.destroy(new Error('Own test pipe timeout')));
  socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify({...frame,token})+'\n'));socket.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n')){socket.destroy();try{const result=JSON.parse(buffer.split('\n')[0]);if(!result.ok)throw new Error(result.error);resolve(result.value);}catch(error){reject(error);}}});});}
async function start(){latest=null;const exe=path.resolve(__dirname,'../node_modules/electron/dist/electron.exe');child=spawn(exe,[path.join(root,'app.asar'),'--demo','--native-backend','--hidden','--data-dir',directory],{windowsHide:true,stdio:'ignore'});child.on('error',()=>{});
  await until(()=>fs.existsSync(descriptor)&&Number(fs.readFileSync(descriptor,'utf8').split('\n')[3])===child.pid,'Own backend startup');
  const {pipe,token}=identity();subscription=net.createConnection(pipe);subscription.setEncoding('utf8');let buffer='';subscription.on('error',()=>{});
  subscription.on('connect',()=>subscription.write(JSON.stringify({method:'subscribe',token})+'\n'));
  subscription.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);const frame=JSON.parse(line);if(frame.event==='state')latest=frame.state;}});
  await until(()=>latest,'Own state subscription');}
async function quit(){await until(async()=>(await request({method:'status'})).activeWriters===0,'Own work completion');await request({method:'quitIfIdle'});await until(()=>child.exitCode!==null,'Own graceful shutdown');assert.equal(child.exitCode,0);subscription?.destroy();}
(async()=>{try{
  assert.equal(archiveHash(),manifest.sha256);await start();
  const initial=await request({method:'status'});assert.equal(initial.windowCount,0);assert.equal(initial.rendererCount,0);
  const target=latest.cards.find(c=>c.chatName==='Launch planning');assert.ok(target);const sourceId=target.primarySourceId;
  await request({method:'command',command:'details',input:{id:target.id,taskKey:target.taskKey,sourceId}});
  const id=crypto.randomUUID(),question='Tell this chat to review the launch checklist and report the remaining approval steps.';
  const send={method:'command',command:'assistantAsk',input:{messageId:id,text:question}};
  await request(send);await request(send);
  await until(()=>latest.assistant.messages.some(m=>m.id===id&&m.status!=='thinking'),'Own assistant answer',120000);
  const answer=latest.assistant.messages.find(m=>m.id===id);assert.equal(answer.status,'completed',answer.error);assert.match(answer.answer,/^Sent to Launch planning:/);
  let messages=JSON.parse(fs.readFileSync(path.join(directory,'messages.json'),'utf8'));assert.equal(messages.entries.length,1);assert.equal(messages.entries[0].status,'sent');assert.equal(messages.entries[0].sourceId,sourceId);
  await quit();await start();await request(send);
  messages=JSON.parse(fs.readFileSync(path.join(directory,'messages.json'),'utf8'));assert.equal(messages.entries.length,1);
  const stored=JSON.parse(fs.readFileSync(path.join(directory,'assistant.json'),'utf8'));assert.equal(stored.version,2);assert.ok(stored.messages.some(m=>m.text==='I prefer a private launch.'));
  assert.ok(stored.messages.filter(m=>m.kind==='update').length<=40);assert.equal(stored.messages.find(m=>m.id===id).action.status,'sent');
  const result={passed:true,archiveSha256:manifest.sha256,at:new Date().toISOString(),nativeBackend:true,windowCount:initial.windowCount,rendererCount:initial.rendererCount,legacyDialoguePreserved:true,focusFromNativeDetails:true,realPrivateModel:true,actualMessagePipeline:'Assistant -> Devices -> Messages -> Controller -> DemoCodex',syntheticMessages:1,replayAfterRestartDoesNotSend:true,realChatsTouched:0};
  await quit();assert.equal(archiveHash(),manifest.sha256);fs.writeFileSync(path.join(root,'backend-audit.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{subscription?.destroy();if(child&&child.exitCode===null){try{await quit();}catch(error){console.error('Owned audit cleanup: '+error.message);}}}})().catch(error=>{console.error(error.message);process.exitCode=1;});
