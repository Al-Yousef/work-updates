'use strict';
// One harmless orientation message to Hyphen itself. Never sends to a source chat.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const directory=require('./dev-paths.cjs').installed('data/desktop');
const runtime=JSON.parse(fs.readFileSync(path.join(directory,'runtime.json'),'utf8'));
const [magic,pipe,token,pid]=fs.readFileSync(path.join(directory,'native-control.info'),'utf8').split('\n');
if(magic!=='work-updates-native-v1'||Number(pid)!==runtime.appPid||runtime.version!=='0.6.0')throw new Error('Installed Hyphen identity differs.');
const request=message=>new Promise((resolve,reject)=>{
  const socket=net.createConnection(pipe);let buffer='';socket.setEncoding('utf8');socket.setTimeout(10000,()=>socket.destroy(new Error('Hyphen acknowledgement timed out.')));
  socket.on('connect',()=>socket.write(JSON.stringify({...message,token})+'\n'));socket.on('error',reject);
  socket.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n')){try {const value=JSON.parse(buffer.split('\n')[0]);socket.destroy();if(!value.ok)throw new Error(value.error);resolve(value.value);}catch(error){reject(error);}}});
});
const socket=net.createConnection(pipe);socket.setEncoding('utf8');let buffer='',latest={},resolveReady,resolveAnswer,rejectAnswer;
const ready=new Promise(resolve=>resolveReady=resolve);const answered=new Promise((resolve,reject)=>{resolveAnswer=resolve;rejectAnswer=reject;});
const messageId=crypto.randomUUID();
socket.setTimeout(125000,()=>socket.destroy(new Error('Installed assistant verification timed out.')));
socket.on('error',rejectAnswer);socket.on('connect',()=>socket.write(JSON.stringify({method:'subscribe',token})+'\n'));
socket.on('data',chunk=>{
  buffer+=chunk;if(buffer.length>2*1024*1024)return socket.destroy(new Error('Assistant snapshot exceeded its limit.'));
  while(buffer.includes('\n')){const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
    try {const frame=JSON.parse(line);if(frame.event!=='state')continue;latest=frame.state;resolveReady();
      const message=latest.assistant?.messages.find(m=>m.id===messageId);if(message?.status==='completed')resolveAnswer(message);
      else if(message?.status==='failed')rejectAnswer(new Error(message.error));
    }catch(error){rejectAnswer(error);}
  }
});
(async()=>{try {
  await Promise.race([ready,answered]);if(!latest.assistant||latest.assistant.error)throw new Error(latest.assistant?.error||'Assistant unavailable.');
  const input={messageId,text:'Give me a short introduction to this new Hyphen chat. Explain how I can ask what is waiting on me and draft a reply. Be clear about whether phone messaging is connected yet.'};
  const first=await request({method:'command',command:'assistantAsk',input});
  const duplicate=await request({method:'command',command:'assistantAsk',input});
  if(first.messageId!==messageId||duplicate.messageId!==messageId)throw new Error('Assistant acknowledgement mismatch.');
  const message=await answered;const status=await request({method:'status'});
  if(!message.answer||latest.assistant.messages.filter(m=>m.id===messageId).length!==1)throw new Error('Assistant history mismatch.');
  const result={passed:true,version:runtime.version,backendPid:runtime.appPid,messageId,model:latest.assistant.model,
    duplicateGuard:true,assistantMessageCount:latest.assistant.messages.length,answer:message.answer,
    activeWriters:status.activeWriters,windowCount:status.windowCount,rendererCount:status.rendererCount,at:new Date().toISOString()};
  const file=path.resolve(__dirname,'../artifacts/native-migration/assistant-installed-verification.json');
  fs.writeFileSync(file,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {socket.destroy();}})().catch(error=>{console.error(error.message);process.exitCode=1;});
