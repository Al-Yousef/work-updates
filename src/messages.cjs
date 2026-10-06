'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {atomic,text}=require('./queue.cjs');
const {taskSource}=require('./task-source.cjs');
const {Attachments,attachmentIds,messageHash}=require('./attachments.cjs');
const terminal=new Set(['sent','cancelled']);
const unknown=error=>error.delivery==='uncertain'||(error.delivery!=='not-sent'&&['CODEX_TIMEOUT','CODEX_DISCONNECTED','DESKTOP_RECEIPT'].includes(error.code));
class Messages extends EventEmitter {
  constructor(queue,controller,{log,auto=true,attachments}={}) {
    super();this.queue=queue;this.controller=controller;this.log=log;this.file=path.join(queue.directory,'messages.json');
    this.attachments=attachments||new Attachments(queue.directory);
    this.active=new Set();this.closed=false;this.state={version:1,entries:[],barriers:{}};
    try{this.state=JSON.parse(fs.readFileSync(this.file,'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw new Error('Hyphen message storage cannot be read. Preserve messages.json before repairing it.');}
    if(this.state.version!==1||!Array.isArray(this.state.entries)||!this.state.barriers)
      throw new Error('Hyphen message storage is invalid. No messages were dispatched.');
    this.state.receipts??={};
    for(const entry of this.state.entries)if(entry.status==='sending'){
      entry.status='uncertain';entry.code='APP_RESTARTED';entry.error='Delivery interrupted. Check this chat before sending again.';
    }
    this.save();this.changed=()=>this.schedule();
    if(auto){queue.on('change',this.changed);this.timer=setInterval(()=>this.schedule(),2000);this.timer.unref();}
  }
  save(){
    // Message text is private local storage, never diagnostic output. Commit
    // intent before network I/O, and a receipt before reporting success.
    const keep=this.state.entries.filter(e=>!terminal.has(e.status));
    const allHistory=this.state.entries.filter(e=>terminal.has(e.status));
    const receipts={...this.state.receipts};
    for(const entry of allHistory.slice(0,-200))if(entry.textHash)receipts[entry.id]={id:entry.id,sourceId:entry.sourceId,textHash:entry.textHash,status:entry.status,receipt:entry.receipt};
    const history=allHistory.slice(-200);
    const next={...this.state,entries:[...history,...keep],receipts};
    atomic(this.file,next);this.state=next;this.emit('change');
  }
  record(event,entry,extra={}){this.log?.write('message.'+event,{messageId:entry.id,sourceId:entry.sourceId,cardId:entry.cardId,mode:entry.mode,...extra});}
  validate(input){
    const card=this.queue.get(input.id,input.taskKey),value=text(input.text,12000),source=taskSource(card,input.sourceId);
    const images=attachmentIds(input.attachmentIds||[]);this.attachments.resolve(images);
    if(!value&&!images.length)throw new Error('Write a message or attach an image first.');
    if(card.done)throw new Error('Reopen this task before replying.');
    if(!source)throw new Error('Choose a source chat.');
    if(this.state.entries.some(e=>e.sourceId===source.id&&e.status==='uncertain'))
      throw new Error('A previous delivery is unconfirmed. Open this chat and check delivery before replying.');
    return {card,source,value,images};
  }
  existing(input){
    if(!input.messageId)return null;
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.messageId))throw new Error('Invalid message identity.');
    const entry=this.state.entries.find(e=>e.id===input.messageId)||this.state.receipts[input.messageId];if(!entry)return null;
    const digest=messageHash(text(input.text,12000),attachmentIds(input.attachmentIds||[]));
    if(entry.sourceId!==input.sourceId||entry.textHash!==digest)throw new Error('This message identity belongs to another draft.');
    const proof=entry.receiptIdentity;
    if(entry.status==='uncertain'&&proof?.messageId===entry.id&&proof.sourceId===entry.sourceId&&proof.textHash===entry.textHash&&
      typeof proof.turnId==='string'&&proof.turnId&&proof.turnId===entry.receipt?.turnId){
      const draft=entry.text;entry.status='sent';delete entry.text;
      try{this.save();}catch(error){entry.status='uncertain';entry.text=draft;error.delivery='uncertain';error.messageId=entry.id;throw error;}
      this.record('reconciled',entry,{turnId:proof.turnId,route:entry.receipt.route});
    }
    if(entry.status==='sent')return {...entry.receipt,messageId:entry.id,delivery:'sent'};
    if(entry.status==='queued')return {messageId:entry.id,delivery:'queued',route:'hyphen'};
    if(entry.status==='cancelled'){const error=new Error('That message was cancelled. Use a new message identity for a new draft.');error.code='DELIVERY_CANCELLED';error.messageId=entry.id;error.delivery='not-sent';throw error;}
    const error=new Error(entry.error||'This delivery is still unconfirmed. Check the chat before retrying.');
    error.code=entry.code||'DELIVERY_PENDING';error.messageId=entry.id;error.delivery=['uncertain','sending'].includes(entry.status)?'uncertain':'not-sent';throw error;
  }
  create(input,mode){
    const {card,source,value,images}=this.validate(input);
    if(this.state.entries.filter(e=>!terminal.has(e.status)).length>=100)
      throw new Error('The message queue is full. Clear queued messages before adding more.');
    const entry={id:input.messageId||crypto.randomUUID(),sourceId:source.id,cardId:card.id,taskKey:card.taskKey,
      textHash:messageHash(value,images),attachmentIds:images,
      text:value,mode,status:mode==='queue'?'queued':'sending',createdAt:Date.now()};
    this.state.entries.push(entry);try{this.save();}catch(error){this.state.entries.pop();throw error;}
    this.record(mode==='queue'?'queued':'requested',entry);return entry;
  }
  enqueue(input){const previous=this.existing(input);if(previous)return previous;const entry=this.create(input,'queue');this.schedule();return {messageId:entry.id,delivery:'queued',route:'hyphen'};}
  async send(input){
    const previous=this.existing(input);if(previous)return previous;
    const {source}=this.validate(input);if(this.active.has(source.id))throw new Error('A message is already being sent.');
    const entry=this.create(input,'send');return this.deliver(entry,input);
  }
  async deliver(entry,input){
    const draft=entry.text,clearedFailures=[];
    this.active.add(entry.sourceId);entry.status='sending';entry.attemptedAt=Date.now();
    try {
      this.save();this.record('dispatching',entry);
      const images=this.attachments.resolve(entry.attachmentIds||[]);
      const result=await this.controller.send(input.id,entry.text,entry.sourceId,input.taskKey,{messageId:entry.id,images});
      if(!result||typeof result.turnId!=='string'||!result.turnId.trim()||(result.messageId&&result.messageId!==entry.id)||(result.sourceId&&result.sourceId!==entry.sourceId))
        throw Object.assign(new Error('Codex did not return a matching acceptance receipt. Check this chat before retrying.'),{code:'DELIVERY_RECEIPT',delivery:'uncertain'});
      entry.status='sent';entry.receipt=result;entry.completedAt=Date.now();delete entry.text;
      entry.receiptIdentity={messageId:entry.id,sourceId:entry.sourceId,textHash:entry.textHash,turnId:result.turnId};
      for(const old of this.state.entries)if(old!==entry&&old.sourceId===entry.sourceId&&old.status==='failed'){clearedFailures.push({entry:old,status:old.status,text:old.text});old.status='cancelled';delete old.text;}
      const source=this.queue.feed.threads.find(s=>s.id===entry.sourceId);
      this.state.barriers[entry.sourceId]={turnId:result.turnId||'',fingerprint:source?.fingerprint||'',at:Date.now()};
      this.save();this.record('sent',entry,{route:result.route,turnId:result.turnId,elapsedMs:Date.now()-entry.attemptedAt});
      return {...result,messageId:entry.id,delivery:'sent'};
    } catch(error) {
      // A lost acknowledgement can mean it was delivered. Never retry it
      // automatically or allow another queued message to pass that uncertainty.
      entry.text=draft;
      for(const old of clearedFailures){old.entry.status=old.status;old.entry.text=old.text;}
      entry.status=unknown(error)||entry.status==='sent'?'uncertain':'failed';entry.code=error.code||'SEND_FAILED';
      entry.error=entry.status==='uncertain'?'Delivery unconfirmed. Check this chat before retrying.':error.message;
      try{this.save();}catch{entry.status='uncertain';}
      this.record(entry.status,entry,{code:entry.code,route:error.route,method:error.method,phase:error.phase,
        delivery:entry.status==='uncertain'?'uncertain':'not-sent',elapsedMs:Date.now()-entry.attemptedAt});
      error.messageId=entry.id;error.delivery=entry.status==='uncertain'?'uncertain':'not-sent';throw error;
    } finally {this.active.delete(entry.sourceId);this.emit('change');}
  }
  schedule(){if(this.closed||this.scheduled)return;this.scheduled=setTimeout(()=>{this.scheduled=null;this.pump().catch(error=>this.log?.write('message.queue.error',{code:error.code||'QUEUE_ERROR'}));},100);this.scheduled.unref();}
  async pump(){
    const age=Date.now()/1000-this.queue.feed.collectedAt;
    if(this.closed||!this.queue.health.ok||!Number.isFinite(age)||age< -5||age>30)return;
    const sources=new Set(this.state.entries.filter(e=>e.status==='queued').map(e=>e.sourceId));
    for(const sourceId of sources){
      if(this.active.has(sourceId)||this.state.entries.some(e=>e.sourceId===sourceId&&['uncertain','failed'].includes(e.status)))continue;
      const source=this.queue.feed.threads.find(s=>s.id===sourceId);
      if(!source||source.lifecycle!=='completed')continue;
      const barrier=this.state.barriers[sourceId];
      if(barrier && (barrier.turnId?source.turnId!==barrier.turnId && !(source.fingerprint!==barrier.fingerprint && source.updatedAt>=Math.ceil(barrier.at/1000)):source.fingerprint===barrier.fingerprint))continue;
      const card=this.queue.cards().find(c=>c.sources.some(s=>s.id===sourceId));
      if(!card||card.done||this.queue.busy.has(sourceId))continue;
      if(this.controller.client?.active?.has(sourceId)||card.sources.some(s=>s.id===sourceId&&['working','starting'].includes(s.lifecycle)))continue;
      const entry=this.state.entries.find(e=>e.sourceId===sourceId&&e.status==='queued');
      try{await this.deliver(entry,{id:card.id,taskKey:card.taskKey});}catch{}
    }
  }
  clear(sourceId,checked=false){
    const priorEntries=[...this.state.entries],priorReceipts={...this.state.receipts},changed=[];
    for(const entry of this.state.entries)if(entry.sourceId===sourceId&&(checked?['failed','uncertain']:['queued','failed']).includes(entry.status)){
      changed.push({entry,status:entry.status,text:entry.text});entry.status='cancelled';delete entry.text;
    }
    try{this.save();}catch(error){for(const item of changed){item.entry.status=item.status;item.entry.text=item.text;}this.state.entries=priorEntries;this.state.receipts=priorReceipts;throw error;}
    for(const item of changed)this.record('cleared',item.entry);
    return {cleared:true};
  }
  decorate(state){return {...state,cards:state.cards.map(card=>({...card,
    sources:card.sources.map(source=>({...source,queuedMessages:this.state.entries.filter(e=>e.sourceId===source.id&&e.status==='queued').length,
      deliveryIssue:this.state.entries.findLast(e=>e.sourceId===source.id&&['failed','uncertain'].includes(e.status))?.error||'',
      messageQueue:this.state.entries.filter(e=>e.sourceId===source.id&&['queued','sending','failed','uncertain'].includes(e.status)).map(e=>({id:e.id,text:e.text,status:e.status,error:e.error||''}))})),
    queuedMessages:this.state.entries.filter(e=>card.sources.some(s=>s.id===e.sourceId)&&e.status==='queued').length,
  }))};}
  close(){this.closed=true;clearInterval(this.timer);clearTimeout(this.scheduled);this.queue.off('change',this.changed);}
}
module.exports={Messages};
