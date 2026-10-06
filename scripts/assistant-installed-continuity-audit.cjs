'use strict';
// One read-only question to Hyphen itself; no Send/Queue command to a source.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const directory=require('./dev-paths.cjs').installed('data/desktop'),root=path.resolve(__dirname,'../artifacts/assistant-continuity-20261006');
const runtime=JSON.parse(fs.readFileSync(path.join(directory,'runtime.json'),'utf8'));
const [magic,pipe,token,pid]=fs.readFileSync(path.join(directory,'native-control.info'),'utf8').split('\n');
assert.equal(magic,'work-updates-native-v1');assert.equal(Number(pid),runtime.appPid);assert.equal(runtime.version,'0.6.9');assert.equal(runtime.assistant.active,false);
const sourceHash=()=>crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,'messages.json'))).digest('hex');const before=sourceHash();
const request=frame=>new Promise((resolve,reject)=>{const socket=net.createConnection(pipe);let buffer='';socket.setEncoding('utf8');socket.setTimeout(10000,()=>socket.destroy(new Error('Installed acknowledgement timeout')));
  socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify({...frame,token})+'\n'));socket.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n')){socket.destroy();try{const result=JSON.parse(buffer.split('\n')[0]);if(!result.ok)throw new Error(result.error);resolve(result.value);}catch(error){reject(error);}}});});
const subscription=net.createConnection(pipe),id=crypto.randomUUID();let buffer='',readyResolve,answerResolve,answerReject;
const ready=new Promise(resolve=>readyResolve=resolve),answered=new Promise((resolve,reject)=>{answerResolve=resolve;answerReject=reject;});
subscription.setEncoding('utf8');subscription.setTimeout(120000,()=>subscription.destroy(new Error('Installed answer timeout')));subscription.on('error',answerReject);
subscription.on('connect',()=>subscription.write(JSON.stringify({method:'subscribe',token})+'\n'));
subscription.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);const frame=JSON.parse(line);if(frame.event!=='state')continue;readyResolve();
  const message=frame.state.assistant.messages.find(m=>m.id===id);if(message?.status==='completed')answerResolve(message);else if(message?.status==='failed')answerReject(new Error(message.error));}});
(async()=>{try{
  await ready;const text='What was I trying to do in our earlier conversation? Do you know which chat I meant, or was the name a guess? Use my own earlier questions. Do not send or queue any messages.';
  const frame={method:'command',command:'assistantAsk',input:{messageId:id,text}};
  await request(frame);await request(frame);const answer=await answered;assert.match(answer.answer,/context|chat/i);assert.match(answer.answer,/guess|confirm|uncertain|not sure|not certain/i);assert.equal(sourceHash(),before);
  const stored=JSON.parse(fs.readFileSync(path.join(directory,'assistant.json'),'utf8'));assert.equal(stored.messages.filter(m=>m.id===id).length,1);assert.equal(stored.messages.find(m=>m.id===id).action,undefined);
  const status=await request({method:'status'});assert.equal(status.activeWriters,0);assert.equal(status.windowCount,0);assert.equal(status.rendererCount,0);
  const result={passed:true,at:new Date().toISOString(),backendPid:runtime.appPid,messageId:id,answer:answer.answer,conversationExchanges:stored.messages.filter(m=>m.kind!=='update'&&m.text).length,sourceMessagesUnchanged:true,duplicateAskAcceptedOnce:true,version:runtime.version};
  fs.writeFileSync(path.join(root,'installed-audit.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{subscription.destroy();}})().catch(error=>{console.error(error.message);process.exitCode=1;});
