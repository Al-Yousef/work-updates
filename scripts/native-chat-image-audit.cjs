'use strict';
// Only the human-authorized disposable chat is permitted. Requests are saved
// before delivery and retained across reruns; receipts never trigger a resend.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const threadId=process.env.HYPHEN_TEST_THREAD_ID;
if(!process.argv.includes('--confirm') || !/^[a-f0-9-]{36}$/i.test(threadId || ''))
  throw new Error('Use --confirm and set HYPHEN_TEST_THREAD_ID to an explicitly authorized disposable chat.');
const data=require('./dev-paths.cjs').installed('data/desktop'),directory=path.resolve(__dirname,'../artifacts/chat-image-delivery');
const image=path.resolve(__dirname,'../artifacts/image-live-audit-sol/sample.png');
fs.mkdirSync(directory,{recursive:true});
const [magic,pipe,token]=fs.readFileSync(path.join(data,'native-control.info'),'utf8').split('\n');
if(magic!=='work-updates-native-v1')throw new Error('Unsupported native descriptor');
function rpc(request){return new Promise((resolve,reject)=>{
  const socket=net.createConnection(pipe);let buffer='',settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;socket.destroy();error?reject(error):resolve(value);};
  socket.setTimeout(request.command==='send'?240000:15000,()=>finish(new Error('Native audit timed out; inspect persisted receipts before retrying.')));
  socket.setEncoding('utf8');socket.on('connect',()=>socket.write(JSON.stringify({...request,token})+'\n'));
  socket.on('error',error=>finish(error));socket.on('end',()=>{if(!settled)finish(new Error('No audit response'));});
  socket.on('data',chunk=>{buffer+=chunk;if(!buffer.includes('\n'))return;try{const result=JSON.parse(buffer.split('\n')[0]);
    if(result.event==='state')finish(null,result.state);else if(result.ok)finish(null,result.value);else finish(Object.assign(new Error(result.error),result));
  }catch(error){finish(error);}});
});}
const command=(name,input)=>rpc({method:'command',command:name,input});
async function card(){const state=await rpc({method:'subscribe'}),found=[...state.cards,...state.done].find(c=>c.sources.some(s=>s.id===threadId));
  if(!found)throw new Error('Disposable chat is not in the published queue.');if(found.done)throw new Error('Disposable task is closed.');return found;}
const file=path.join(directory,'requests.json');let saved;
try{saved=JSON.parse(fs.readFileSync(file));}catch(error){if(error.code!=='ENOENT')throw error;saved={threadId};}
if(saved.threadId!==threadId)throw new Error('Audit destination changed');
const persist=()=>fs.writeFileSync(file,JSON.stringify(saved,null,2));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  if(!saved.image){saved.image=(await command('attachImages',{paths:[image]})).images[0];persist();}
  if(!saved.send){const c=await card();saved.send={id:c.id,taskKey:c.taskKey,sourceId:threadId,attachmentIds:[saved.image.id],messageId:crypto.randomUUID(),
    text:'This is a disposable Hyphen image-delivery test. Inspect the attached image and reply only LEFT=[color]; RIGHT=[color]. Do not call tools or make changes.'};persist();}
  const sent=await command('send',saved.send);console.log(JSON.stringify({phase:'send',delivery:sent.delivery,route:sent.route,turnId:sent.turnId}));
  const replay=await command('send',saved.send);if(replay.messageId!==sent.messageId||replay.turnId!==sent.turnId)throw new Error('Replay receipt changed');
  if(!saved.queue){const c=await card();saved.queue={id:c.id,taskKey:c.taskKey,sourceId:threadId,attachmentIds:[saved.image.id],messageId:crypto.randomUUID(),
    text:'This is a queued Hyphen image-delivery test. Inspect this attached image and reply only QUEUED_LEFT=[color]; QUEUED_RIGHT=[color]. Do not call tools or make changes.'};persist();}
  const queued=await command('queueMessage',saved.queue);const repeated=await command('queueMessage',saved.queue);
  if(repeated.messageId!==queued.messageId)throw new Error('Queue replay identity changed');console.log(JSON.stringify({phase:'queue',delivery:queued.delivery}));
  for(let i=0;i<90;i++){
    const entries=JSON.parse(fs.readFileSync(path.join(data,'messages.json'))).entries;
    const entry=entries.find(e=>e.id===saved.queue.messageId);
    if(entry?.status==='sent'){
      const result={receiptsPassed:true,threadId,imageSend:true,imageQueue:true,replayStable:true,directTurnId:sent.turnId,queuedTurnId:entry.receipt.turnId,directRoute:sent.route,queuedRoute:entry.receipt.route,at:new Date().toISOString()};
      fs.writeFileSync(path.join(directory,'receipts.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));return;
    }
    if(entry&&['failed','uncertain','cancelled'].includes(entry.status))throw new Error('Queued image '+entry.status+': '+entry.error);
    await delay(2000);
  }
  throw new Error('Queued image still pending; inspect state before taking further action.');
})().catch(error=>{console.error(JSON.stringify({error:error.message,code:error.code,delivery:error.delivery}));process.exitCode=1;});
