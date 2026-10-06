'use strict';
// Scoped live audit: only the explicitly authorized disposable chat is writable.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const crypto=require('node:crypto');
const directory=path.resolve(process.argv[2]),threadId=process.argv[3];
if(!process.argv.includes('--confirm') || !/^[a-f0-9-]{36}$/i.test(threadId || '') || threadId!==process.env.HYPHEN_TEST_THREAD_ID)
  throw new Error('Use --confirm and set HYPHEN_TEST_THREAD_ID to the explicitly authorized disposable chat supplied as the second argument.');
const [magic,pipe,token]=fs.readFileSync(path.join(directory,'native-control.info'),'utf8').split('\n');
if(magic!=='work-updates-native-v1')throw Error('Invalid descriptor');
function request(value){return new Promise((resolve,reject)=>{const s=net.createConnection(pipe);let buffer='';s.setEncoding('utf8');s.setTimeout(130000,()=>s.destroy(Error('Audit timed out; do not resend')));
  s.on('error',reject);s.on('connect',()=>s.write(JSON.stringify({...value,token})+'\n'));s.on('data',data=>{buffer+=data;if(buffer.includes('\n')){s.destroy();const result=JSON.parse(buffer.split('\n')[0]);if(!result.ok)return reject(Object.assign(Error(result.error),result));resolve(result.value);}});
});}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function source(){const f=JSON.parse(fs.readFileSync(path.join(directory,'observer/data/feed.json')));return f.threads.find(s=>s.id===threadId);}
function card(){const {Queue}=require('../src/queue.cjs');const q=new Queue(directory);q.feed=JSON.parse(fs.readFileSync(path.join(directory,'observer/data/feed.json')));return q.cards().find(c=>c.sources.some(s=>s.id===threadId));}
function input(text){const c=card();if(!c)throw Error('Disposable chat is not monitored');return {id:c.id,taskKey:c.taskKey,sourceId:threadId,text};}
(async()=>{
  const before=source();assert.ok(before&&before.lifecycle==='completed');
  const directInput={...input('Delivery audit: call clock.sleep for 12000 milliseconds if available, then reply exactly HYPHEN_AUDIT_PASS_FINISHED. Do not read or change files. This is a harmless disposable chat test.'),messageId:crypto.randomUUID()};
  const direct=await request({method:'command',command:'send',input:directInput});
  assert.equal(direct.delivery,'sent');assert.ok(['desktop','app-server'].includes(direct.route));assert.ok(direct.turnId);
  const queueInput={...input('Reply exactly HYPHEN_QUEUE_DELIVERED_ONCE. Do not call tools or make changes.'),messageId:crypto.randomUUID()};
  const queued=await request({method:'command',command:'queueMessage',input:queueInput});
  assert.equal(queued.delivery,'queued');
  const entry=()=>JSON.parse(fs.readFileSync(path.join(directory,'messages.json'))).entries.find(e=>e.id===queued.messageId);
  assert.equal(entry().status,'queued');let sawWorking=false,finishedSource;
  assert.deepEqual(await request({method:'command',command:'queueMessage',input:queueInput}),queued);
  for(let i=0;i<120;i++){
    const s=source();if(s?.turnId===direct.turnId&&s.lifecycle==='working')sawWorking=true;
    if(entry().status==='sent'){finishedSource=s;break;}
    if(['failed','uncertain'].includes(entry().status))throw Error('Queue delivery '+entry().status+': '+entry().error);
    await pause(500);
  }
  assert.equal(entry().status,'sent');assert.equal(entry().receipt.route,direct.route);assert.notEqual(entry().receipt.turnId,direct.turnId);
  const lines=fs.readFileSync(path.join(directory,'logs/app.log'),'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const starts=lines.filter(l=>l.event==='message.dispatching'&&l.messageId===queued.messageId);
  assert.equal(starts.length,1);assert.ok(finishedSource.completedAt>=before.completedAt);
  assert.deepEqual(await request({method:'command',command:'send',input:directInput}),direct);
  const resume=lines.filter(l=>l.event==='codex.rpc.completed'&&l.method==='thread/resume'&&l.threadId===threadId).at(-1);
  if(direct.route==='app-server'){assert.ok(resume);assert.ok(resume.bytes>0&&resume.bytes<1024*1024);}
  const result={verified:true,threadId,sawWorking,direct,queued,delivered:entry().receipt,dispatchCount:starts.length,
    repeatedReceiptsReconciled:true,resume:resume?{bytes:resume.bytes,elapsedMs:resume.elapsedMs}:null};
  fs.writeFileSync(path.join(directory,'live-message-audit.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})().catch(e=>{console.error(JSON.stringify({error:e.message,code:e.code,delivery:e.delivery}));process.exitCode=1;});
