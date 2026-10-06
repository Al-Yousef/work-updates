'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const crypto=require('node:crypto');
const {Queue}=require('../src/queue.cjs'),{Messages}=require('../src/messages.cjs'),{feed}=require('../src/demo.cjs');
const {DiagnosticLog}=require('../src/diagnostics.cjs');
function setup(t,send){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-messages-')),q=new Queue(directory);q.setFeed(feed());
  const messages=new Messages(q,{send},{auto:false,log:new DiagnosticLog(directory)});
  t.after(()=>{messages.close();fs.rmSync(directory,{recursive:true,force:true});});
  const card=q.cards()[0];return {q,messages,directory,input:{id:card.id,taskKey:card.taskKey,sourceId:card.primarySourceId,text:'Private test text'}};
}
test('queue persists before receipt, waits for completion, follows task changes and preserves FIFO',async t=>{
  let calls=[];const {q,messages,directory,input}=setup(t,async(id,value,source,key,options)=>{calls.push(value);return {turnId:'turn-'+calls.length,messageId:options.messageId,route:'desktop'};});
  const source=q.feed.threads.find(s=>s.id===input.sourceId);source.lifecycle='working';
  const first=messages.enqueue(input),second=messages.enqueue({...input,text:'Second message'});
  assert.equal(first.delivery,'queued');assert.equal(JSON.parse(fs.readFileSync(messages.file)).entries.length,2);
  await messages.pump();assert.deepEqual(calls,[]);source.lifecycle='completed';source.taskTitle='New task after completion';
  await messages.pump();assert.deepEqual(calls,['Private test text']);await messages.pump();assert.equal(calls.length,1);
  source.turnId='turn-1';source.fingerprint='new';await messages.pump();assert.deepEqual(calls,['Private test text','Second message']);
  assert.ok(second.messageId);assert.equal(messages.active.size,0);
  const logs=fs.readFileSync(path.join(directory,'app.log'),'utf8');assert.ok(logs.includes(first.messageId));assert.ok(!logs.includes(input.text));
  assert.ok(!fs.readFileSync(messages.file,'utf8').includes(input.text));
});
test('lost receipt and restart never resend, checking delivery releases a paused queue',async t=>{
  let calls=0;const {messages,q,input}=setup(t,async()=>{calls++;const e=new Error('Lost connection');e.delivery='uncertain';e.code='DESKTOP_DISCONNECTED';throw e;});
  await assert.rejects(messages.send(input),/Lost connection/);assert.equal(messages.state.entries[0].status,'uncertain');
  assert.throws(()=>messages.enqueue(input),/unconfirmed/);await messages.pump();assert.equal(calls,1);
  messages.state.entries[0].status='sending';messages.save();const restored=new Messages(q,{send:async()=>assert.fail('Restart must not resend')},{auto:false});
  t.after(()=>restored.close());assert.equal(restored.state.entries[0].status,'uncertain');await restored.pump();
  restored.clear(input.sourceId,true);assert.equal(restored.enqueue(input).delivery,'queued');
});
test('stale identity, duplicate submissions and stale monitoring cannot dispatch',async t=>{
  let release,called;const ready=new Promise(resolve=>called=resolve);
  const {messages,q,input}=setup(t,async()=>{called();await new Promise(resolve=>release=resolve);return {turnId:'t',route:'desktop'};});
  assert.throws(()=>messages.enqueue({...input,taskKey:'wrong'}),/changed/);assert.equal(messages.state.entries.length,0);
  const sending=messages.send(input);await ready;await assert.rejects(messages.send(input),/already being sent/);release();await sending;
  messages.enqueue(input);q.health.ok=false;await messages.pump();assert.equal(messages.state.entries.filter(e=>e.status==='sent').length,1);
  messages.clear(input.sourceId);assert.equal(messages.decorate(q.snapshot()).cards[0].queuedMessages,0);
});
test('a rejected queued message remains visible and pauses later messages',async t=>{
  let calls=0;const {messages,q,input}=setup(t,async()=>{calls++;throw new Error('Explicit rejection');});
  messages.enqueue(input);messages.enqueue({...input,text:'Next'});await messages.pump();await messages.pump();
  assert.equal(calls,1);const source=messages.decorate(q.snapshot()).cards[0].sources.find(s=>s.id===input.sourceId);
  assert.equal(source.messageQueue[0].text,input.text);assert.match(source.deliveryIssue,/Explicit rejection/);
});
test('lost panel acknowledgements reconcile the saved receipt after restart without dispatching again',async t=>{
  let calls=0;const {messages,q,input}=setup(t,async()=>{calls++;return {turnId:'accepted-turn',route:'desktop'};});
  input.messageId=crypto.randomUUID();const receipt=await messages.send(input);assert.equal(calls,1);
  const restored=new Messages(q,{send:async()=>assert.fail('Do not repeat an accepted message')},{auto:false});t.after(()=>restored.close());
  assert.deepEqual(await restored.send({...input,taskKey:'old-after-completion'}),receipt);assert.equal(calls,1);
  assert.throws(()=>restored.enqueue({...input,sourceId:'another-chat'}),/another draft/);
  assert.throws(()=>restored.enqueue({...input,text:'Changed text'}),/another draft/);
});
test('queued drafts restore once and reject duplicate panel requests',async t=>{
  const {messages,q,input}=setup(t,async()=>({turnId:'queue-turn',route:'desktop'}));input.messageId=crypto.randomUUID();
  const receipt=messages.enqueue(input);assert.deepEqual(messages.enqueue(input),receipt);assert.equal(messages.state.entries.length,1);
  const restored=new Messages(q,{send:async()=>({turnId:'queue-turn',route:'desktop'})},{auto:false});t.after(()=>restored.close());
  assert.deepEqual(restored.enqueue(input),receipt);await restored.pump();assert.equal(restored.state.entries.filter(e=>e.status==='sent').length,1);
});

test('preparation timeouts preserve a failed draft, log its phase, and allow an explicit new attempt without a delivery barrier',async t=>{
  let calls=0;
  const {messages,q,input,directory}=setup(t,async()=>{
    calls++;
    if(calls===1)throw Object.assign(new Error('Your message was not sent.'),{
      code:'CODEX_TIMEOUT',method:'thread/resume',phase:'preparing-chat',delivery:'not-sent'});
    return {turnId:'accepted-turn',route:'app-server'};
  });
  input.messageId=crypto.randomUUID();
  await assert.rejects(messages.send(input),error=>error.delivery==='not-sent');
  const failed=messages.state.entries[0];assert.equal(failed.status,'failed');assert.equal(failed.text,input.text);
  const restored=new Messages(q,{send:async()=>assert.fail('Never automatically replay a failed draft')},{auto:false});
  t.after(()=>restored.close());await restored.pump();assert.equal(calls,1);
  await assert.rejects(messages.send(input),error=>error.delivery==='not-sent');assert.equal(calls,1);
  const logs=fs.readFileSync(path.join(directory,'app.log'),'utf8');
  assert.ok(logs.includes('preparing-chat'));assert.ok(logs.includes('not-sent'));assert.ok(!logs.includes(input.text));
  const result=await messages.send({...input,messageId:crypto.randomUUID()});assert.equal(result.delivery,'sent');
  assert.equal(calls,2);assert.equal(failed.status,'cancelled');
});

test('timeouts without a known preparation boundary still block delivery and preserve the draft',async t=>{
  let calls=0;const {messages,input}=setup(t,async()=>{calls++;throw Object.assign(new Error('Receipt timed out'),{code:'CODEX_TIMEOUT'});});
  await assert.rejects(messages.send(input),error=>error.delivery==='uncertain');
  assert.equal(messages.state.entries[0].text,input.text);
  assert.throws(()=>messages.enqueue({...input,text:'Another message'}),/unconfirmed/);
  await messages.pump();assert.equal(calls,1);
});
test('receipt write failure preserves text and explicit same-ID recovery reconciles proof without resending after restart',async t=>{
  let calls=0;const {messages,q,input}=setup(t,async()=>{calls++;return {turnId:'accepted-turn',route:'app-server'};});
  input.messageId=crypto.randomUUID();const save=messages.save.bind(messages);let writes=0;
  messages.save=()=>{writes++;if(writes===3)throw Object.assign(new Error('Synthetic receipt write failed'),{code:'STORE_FAILED'});return save();};
  await assert.rejects(messages.send(input),error=>error.delivery==='uncertain');
  assert.equal(messages.state.entries[0].text,input.text);
  assert.equal(JSON.parse(fs.readFileSync(messages.file)).entries[0].text,input.text);
  await messages.pump();assert.equal(calls,1);
  const restored=new Messages(q,{send:async()=>assert.fail('Reconciliation must not resubmit')},{auto:false});t.after(()=>restored.close());
  const result=await restored.send(input);assert.equal(result.delivery,'sent');assert.equal(result.turnId,'accepted-turn');
  assert.equal(restored.state.entries[0].text,undefined);assert.equal(calls,1);
});
test('missing or mismatched acceptance receipts retain an uncertain draft and never unblock automatic delivery',async t=>{
  for(const receipt of [{route:'app-server'},{turnId:'other-turn',messageId:crypto.randomUUID()}]){
    const {messages,input}=setup(t,async()=>receipt);input.messageId=crypto.randomUUID();
    await assert.rejects(messages.send(input),error=>error.delivery==='uncertain'&&error.code==='DELIVERY_RECEIPT');
    assert.equal(messages.state.entries[0].text,input.text);await messages.pump();
    assert.equal(messages.state.entries[0].status,'uncertain');assert.equal(messages.state.entries[0].receiptIdentity,undefined);
  }
});
test('failed cancellation storage cannot clear a queued draft or emit a successful cancellation record',t=>{
  const {messages,input,directory}=setup(t,async()=>assert.fail('No dispatch expected'));
  input.messageId=crypto.randomUUID();messages.enqueue(input);messages.save=()=>{throw new Error('Synthetic store failure');};
  assert.throws(()=>messages.clear(input.sourceId),/store failure/);
  assert.equal(messages.state.entries[0].status,'queued');assert.equal(messages.state.entries[0].text,input.text);
  assert.ok(!fs.readFileSync(path.join(directory,'app.log'),'utf8').includes('message.cleared'));
});
test('cancelled identities cannot submit again and have a distinct not-sent outcome',async t=>{
  const {messages,input}=setup(t,async()=>assert.fail('No dispatch expected'));input.messageId=crypto.randomUUID();
  messages.enqueue(input);messages.clear(input.sourceId);
  await assert.rejects(messages.send(input),error=>error.code==='DELIVERY_CANCELLED'&&error.delivery==='not-sent');
});
test('future-dated monitoring cannot dispatch an eligible queue',async t=>{
  let calls=0;const {messages,q,input}=setup(t,async()=>{calls++;return {turnId:'accepted'};});
  messages.enqueue(input);q.feed.collectedAt=Date.now()/1000+500;await messages.pump();assert.equal(calls,0);
});

test('reconciliation requires every recorded identity field and preserves the draft if its commit fails',async t=>{
  const {messages,input}=setup(t,async()=>({turnId:'accepted-turn',route:'app-server'}));input.messageId=crypto.randomUUID();
  const save=messages.save.bind(messages);let writes=0;
  messages.save=()=>{if(++writes===3)throw new Error('Synthetic receipt failure');return save();};
  await assert.rejects(messages.send(input));const entry=messages.state.entries[0];
  entry.receiptIdentity.sourceId='different-source';
  await assert.rejects(messages.send(input),error=>error.delivery==='uncertain');assert.equal(entry.status,'uncertain');
  entry.receiptIdentity.sourceId=input.sourceId;messages.save=()=>{throw new Error('Synthetic reconciliation failure');};
  await assert.rejects(messages.send(input),error=>error.delivery==='uncertain');
  assert.equal(entry.status,'uncertain');assert.equal(entry.text,input.text);
  assert.equal(JSON.parse(fs.readFileSync(messages.file)).entries[0].status,'uncertain');
});

test('failed journal compaction keeps original entries and cannot publish an unsaved receipt',t=>{
  const {messages,input}=setup(t,async()=>assert.fail('No dispatch expected'));
  messages.state.entries=Array.from({length:201},()=>({id:crypto.randomUUID(),sourceId:input.sourceId,textHash:'synthetic',status:'sent',receipt:{turnId:'accepted'}}));
  const entries=messages.state.entries,receipts=messages.state.receipts;
  fs.rmSync(messages.file);fs.mkdirSync(messages.file);
  assert.throws(()=>messages.save());assert.equal(messages.state.entries,entries);assert.equal(entries.length,201);assert.deepEqual(messages.state.receipts,receipts);
});
