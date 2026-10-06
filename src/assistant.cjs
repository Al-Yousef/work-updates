'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {atomic}=require('./queue.cjs');
const {AssistantProvider}=require('./assistant-provider.cjs');
const {Attachments,attachmentIds,messageHash}=require('./attachments.cjs');
const {context,history,conversation,revision,messageTarget}=require('./assistant-context.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const clip=(value,n)=>String(value??'').toWellFormed().slice(0,n);
const directMessageRequest=text=>/^(?:(?:ok(?:ay)?|yeah|yes)[,.!]?\s+)?(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:tell|ask|message|send|queue)\b(?!\s+(?:me|us|yourself)\b)/i.test(text)&&!/(?:\bonly draft\b|\bdraft only\b|\bwithout sending\b)/i.test(text);
class Assistant extends EventEmitter {
  constructor(options) {
    super();this.options=options;this.file=path.join(options.directory,'assistant.json');this.active=false;this.closed=false;this.error='';
    this.state={version:2,messages:[],notes:[],receipts:{},seen:null,focus:null};
    try {if(fs.existsSync(this.file)) {
      if(fs.statSync(this.file).size>32*1024*1024)throw new Error();
      const value=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(![1,2].includes(value.version)||!Array.isArray(value.messages)||value.messages.length>(value.version===1?100:540)||!Array.isArray(value.notes)||value.notes.length>32||
        value.notes.some(n=>typeof n!=='string'||n.length>1000)||!value.receipts||typeof value.receipts!=='object'||Array.isArray(value.receipts)||
        value.messages.some(m=>typeof m.id!=='string'||typeof m.text!=='string'||m.text.length>4000||!['thinking','completed','failed'].includes(m.status)||
          (m.images!==undefined&&(!Array.isArray(m.images)||m.images.length>4||m.images.some(i=>typeof i.id!=='string'||typeof i.path!=='string'||i.path.length>32768)))||
          (m.answer!==undefined&&(typeof m.answer!=='string'||m.answer.length>6000))||!Array.isArray(m.links)||m.links.length>3||
          m.links.some(l=>typeof l.chatName!=='string'||typeof l.draft!=='string'||l.draft.length>12000)))throw new Error();
      if(value.seen!==undefined&&value.seen!==null&&(typeof value.seen!=='object'||Array.isArray(value.seen)||Object.keys(value.seen).length>2048))throw new Error();
      if(value.focus!==undefined&&value.focus!==null&&(!value.focus.sourceId||!value.focus.id||!value.focus.ownerId))throw new Error();
      if(value.historySelection!==undefined&&(!Array.isArray(value.historySelection)||value.historySelection.length>20||value.historySelection.some(id=>typeof id!=='string'||id.length>100)))throw new Error();
      value.seen??=null;value.focus??=null;
      this.state=value;let recovered=value.version!==2;value.version=2;
      for(const message of value.messages)if(message.status==='thinking'){message.status='failed';message.error=message.action?.status==='dispatching'?'Hyphen restarted during delivery. Check the source chat before retrying; delivery is unconfirmed.':'Hyphen restarted before answering. Send a new message to retry.';if(message.action?.status==='dispatching')message.action.status='unconfirmed';recovered=true;}
      this.trim();
      if(recovered)this.save();
    }}catch{this.error='Assistant history could not be loaded. The original file is preserved.';}
    this.attachments=options.attachments||new Attachments(options.directory);
    this.provider=options.provider||new AssistantProvider({directory:path.join(options.directory,'assistant-session'),binary:options.binary});
  }
  trim(){const kept=new Set([...this.state.messages.filter(conversation).slice(-500),...this.state.messages.filter(m=>m.kind==='update').slice(-40)]);this.state.messages=this.state.messages.filter(m=>kept.has(m));}
  save(){this.trim();if(Buffer.byteLength(JSON.stringify(this.state))>32*1024*1024)throw new Error('Hyphen history reached its local storage limit.');atomic(this.file,this.state);}
  focus(card,sourceId){const source=card.sources?.find(s=>s.id===(sourceId||card.primarySourceId));if(!source)return;
    const next={id:card.id,taskKey:card.taskKey,sourceId:source.id,ownerId:card.owner?.id||'local',chatName:clip(card.chatName||card.title,180)};
    if(JSON.stringify(next)===JSON.stringify(this.state.focus))return;const prior=this.state.focus;this.state.focus=next;
    try{this.save();}catch{this.state.focus=prior;this.log('focus_save_failed',{code:'ASSISTANT_STORAGE_FAILED'});}}
  snapshot(){const visible=new Set([...this.state.messages.filter(conversation).slice(-27),...this.state.messages.filter(m=>m.kind==='update').slice(-3)]);
    return {responding:this.active,error:this.error,model:this.provider.model||null,memoryCount:this.state.notes.length,
    messages:this.state.messages.filter(m=>visible.has(m)).map(m=>({...m,focus:undefined,action:undefined,links:m.links.map(({chatName,draft},index)=>({chatName,draft:clip(draft,12000),index}))}))};}
  log(event,details){this.options.log?.write('assistant.'+event,details);}
  observe(snapshot) {
    if(this.closed||this.error||!snapshot.health?.ok||!snapshot.collectedAt||Math.floor(Date.now()/1000)-snapshot.collectedAt>30)return;
    const cards=(snapshot.cards||[]).slice(0,2048),seen=Object.fromEntries(cards.map(c=>[c.id,hash(JSON.stringify([c.fingerprint,c.status,c.sources?.map(s=>[s.id,s.lifecycle])]))]));
    if(JSON.stringify(seen)===JSON.stringify(this.state.seen))return;
    const baseline=this.state.seen===null,prior={...this.state,messages:[...this.state.messages]},arrived=[];
    if(!baseline)for(const card of cards) {
      if(this.state.seen[card.id]===seen[card.id]||card.done||card.reviewed||card.snoozed||card.owner?.online===false||
        (card.at||0)<(snapshot.settings?.queueSince||0)||!['needs','ready','blocked','waiting'].includes(card.status)||
        !(card.urgent||card.status==='needs'||card.status==='ready'||card.waitingOn?.kind==='you'||(card.status==='blocked'&&card.waitingOn?.kind!=='other')))continue;
      const source=card.sources?.find(s=>s.id===card.primarySourceId)||card.sources?.[0];
      arrived.push({id:crypto.randomUUID(),text:'',kind:'update',status:'completed',at:Date.now(),
        answer:clip([...new Set([card.chatName||card.title,card.title,card.summary,card.label].filter(Boolean))].join('\n'),1800),links:source?[{
          id:card.id,taskKey:card.taskKey,sourceId:source.id,ownerId:card.owner?.id||'local',revision:revision(card),
          chatName:clip(card.chatName||card.title,180),draft:''}]:[]});
    }
    this.state.seen=seen;this.state.messages.push(...arrived.slice(0,10));this.trim();
    try {this.save();}catch{this.state=prior;this.log('updates_save_failed',{code:'ASSISTANT_STORAGE_FAILED'});return;}
    if(arrived.length){this.log('updates',{count:Math.min(arrived.length,10)});this.emit('change');}
  }
  ask(input) {
    if(this.closed)throw new Error('Hyphen is closing.');
    if(this.error)throw new Error(this.error);
    const text=typeof input.text==='string'?input.text.trim():'';
    const ids=attachmentIds(input.attachmentIds||[]);
    if((!text&&!ids.length)||text.length>4000)throw new Error('Write a message of up to 4,000 characters or attach an image.');
    if(!/^[a-f0-9-]{36}$/i.test(input.messageId||''))throw new Error('A message identity is required.');
    const existing=this.state.receipts[input.messageId];
    if(existing){if(existing!==messageHash(text,ids))throw new Error('That message identity belongs to a different message.');return {accepted:true,messageId:input.messageId};}
    if(this.active)throw new Error('Hyphen is answering. You can send another message when it finishes.');
    if(Object.keys(this.state.receipts).length>=5000)throw new Error('Assistant history reached its message limit.');
    const prior=structuredClone(this.state);
    const message={id:input.messageId,text,images:this.attachments.resolve(ids),focus:this.state.focus?{...this.state.focus}:null,status:'thinking',at:Date.now(),links:[]};
    this.state.messages.push(message);this.trim();this.state.receipts[message.id]=messageHash(text,ids);
    const local=ids.length?null:this.local(text);
    if(local!==null){message.answer=local;message.status='completed';if(/^\/memory(?:\s|$)/i.test(text))message.kind='memory_inspection';}
    try {this.save();}catch{this.state=prior;throw new Error('Your message could not be saved. It was not submitted.');}
    this.log('accepted',{messageId:message.id,local:local!==null,characters:text.length});
    if(local===null){this.active=true;this.work=this.generate(message);}
    this.emit('change');return {accepted:true,messageId:message.id};
  }
  local(text) {
    if(/^\/memory history$/i.test(text)){
      const exchanges=this.state.messages.filter(m=>m.status==='completed'&&m.kind!=='memory_inspection'&&conversation(m)).slice(-20);
      this.state.historySelection=exchanges.map(m=>m.id);
      return 'Retained conversation: '+this.state.messages.filter(conversation).filter(m=>m.status==='completed').length+' exchanges, newest 20 shown.\n'+
        exchanges.map((m,i)=>`${i+1}. You: ${clip(m.text,120)}\nHyphen: ${clip(m.answer,120)}`).join('\n')+
        '\n\nUse /forget history N to remove a listed exchange or /forget history all. Pinned notes and source chats are separate. Message replay protection is retained.';
    }
    if(/^\/forget history all$/i.test(text)){
      this.state.messages=this.state.messages.filter(m=>m.status==='thinking'||m.kind==='update');this.state.historySelection=[];
      return 'Removed earlier retained conversation. This confirmation, pinned notes, update alerts, local images, source chats and message replay protection remain.';
    }
    const forgetHistory=text.match(/^\/forget history (\d+)$/i);
    if(forgetHistory){
      const id=this.state.historySelection?.[Number(forgetHistory[1])-1];
      const entry=this.state.messages.find(m=>m.id===id&&m.status==='completed'&&conversation(m));
      if(!entry)return 'That retained exchange is unavailable. Use /memory history to inspect the current list.';
      this.state.messages=this.state.messages.filter(m=>m!==entry&&m.kind!=='memory_inspection');
      return 'Removed that retained exchange and saved memory inspections. Pinned notes, source chats, local images and message replay protection remain.';
    }
    if(/^\/memory sources$/i.test(text)){
      const selected=context(this.options.snapshot(),'');
      return 'Source context is read-only and selected from connected chats; it is not a pinned note or a retained Hyphen exchange.\n'+
        selected.data.cards.slice(0,20).map(c=>`${c.chatName}: ${c.sourceCoverage.state}${c.sourceCoverage.historical?', historical':''}${c.sourceCoverage.truncated?', truncated':''}`).join('\n')+
        '\n\nDeleting a pinned note or Hyphen exchange does not delete source records or their reader cache. Manage source records in their owning chat.';
    }
    const correct=text.match(/^\/correct (\d+) ([\s\S]+)$/i);
    if(correct){const index=Number(correct[1])-1,note=correct[2].trim();
      if(index<0||index>=this.state.notes.length)return 'That pinned note does not exist. Use /memory to inspect it.';
      if(!note||note.length>1000)return 'Use a replacement pinned note of up to 1,000 characters.';
      this.state.notes[index]=note;return 'Corrected that pinned note. Earlier conversation and source records remain separate.';
    }
    const remember=text.match(/^(?:\/remember\s+|remember(?:\s+that)?\s+)([\s\S]+)$/i);
    if(remember){const note=remember[1].trim();if(note.length>1000)return 'Use a shorter note, up to 1,000 characters.';
      if(this.state.notes.includes(note))return 'I already have that saved.';
      if(this.state.notes.length>=32)return 'My saved notes are full. Use /memory to review them and /forget N to remove one.';
      this.state.notes.push(note);return 'Saved in Hyphen: '+note;}
    if(/^\/memory$/i.test(text))return this.state.notes.length?
      'Saved in Hyphen:\n'+this.state.notes.map((n,i)=>`${i+1}. ${clip(n,150)}${n.length>150?'…':''}`).join('\n')+'\n\nUse /forget N to remove a note, or /forget all.':
      'Our conversation is saved across restarts and can be recalled when relevant. No pinned notes yet. Say “Remember that …” to pin a note, or ask what we discussed.';
    if(/^\/forget all$/i.test(text)){this.state.notes=[];return 'Removed all pinned notes from Hyphen. Retained conversation and source records remain.';}
    const forget=text.match(/^\/forget (\d+)$/i);
    if(forget){const index=Number(forget[1])-1;if(index<0||index>=this.state.notes.length)return 'That note does not exist. Use /memory to see the list.';
      this.state.notes.splice(index,1);return 'Removed that pinned note from Hyphen. Retained conversation and source records remain.';}
    return null;
  }
  async generate(message) {
    const started=Date.now();
    try {
      const recalled=history(this.state.messages,message),recent=recalled.recent;
      const selection={focus:message.focus,history:recalled.messages};
      let current=context(this.options.snapshot(),message.text,selection);
      if(this.options.loadContext&&current.data.fresh) {const refreshed=await this.options.loadContext(current.targets);if(this.closed)return;current=context(refreshed||this.options.snapshot(),message.text,selection);}
      const requestedRef=directMessageRequest(message.text)?messageTarget(current,message.text,selection):null;
      let images=message.images||[];
      if(!images.length&&/\b(image|photo|picture|screenshot|attachment|shown|left|right|colou?r|previous|earlier|that|this)\b/i.test(message.text)){const prior=recent.findLast(m=>m.imageIds.length);if(prior){try{images=this.attachments.resolve(prior.imageIds);}catch{prior.imagesUnavailable=true;}}}
      const value=await this.provider.answer({question:message.text||'Describe the attached image and help me understand it.',images,imagesFromHistory:!(message.images||[]).length&&!!images.length,history:recent,recalledHistory:recalled.recalled,userEvidence:recalled.userEvidence,historyCoverage:recalled.coverage,savedNotes:this.state.notes,
        savedNotesProvenance:'explicit_pinned_notes',memoryCoverage:{retentionExchanges:500,retentionAlerts:40,pinnedNoteLimit:32,pinnedNoteCharacters:this.state.notes.join('').length},queue:current.data,canRequestChatMessage:!!this.options.dispatch&&!!requestedRef,requestedChatRef:requestedRef});
      if(this.closed)return;
      if(typeof value.answer!=='string'||!value.answer.trim()||value.answer.length>6000||!Array.isArray(value.links)||value.links.length>3)
        throw new Error('Hyphen returned an invalid answer.');
      const seen=new Set();const links=[];
      for(const link of value.links){const ref=current.refs.get(link.ref);
        if(!ref||seen.has(link.ref)||typeof link.draft!=='string'||link.draft.length>12000||(!ref.sourceId&&link.draft))throw new Error('Hyphen returned an invalid chat reference.');
        seen.add(link.ref);links.push({...ref,draft:link.draft});}
      message.answer=value.answer;message.links=links;message.status='completed';message.model=value.model||'';
      if(value.action) {
        if(!this.options.dispatch||!requestedRef||value.action.ref!==requestedRef)throw new Error('A chat message needs a clear instruction and destination from you. No message was sent.');
        const ref=current.refs.get(value.action.ref);
        if(!ref?.sourceId||typeof value.action.text!=='string'||!value.action.text.trim()||value.action.text.length>12000||!['send','queue'].includes(value.action.mode))throw new Error('Hyphen could not identify a valid chat message. No message was sent.');
        const latest=this.options.snapshot(),card=[...(latest.cards||[]),...(latest.done||[])].find(c=>c.id===ref.id&&c.taskKey===ref.taskKey&&(c.owner?.id||'local')===ref.ownerId&&revision(c)===ref.revision);
        const source=card?.sources?.find(s=>s.id===ref.sourceId);
        if(!latest.health?.ok||Math.floor(Date.now()/1000)-(latest.collectedAt||latest.feedCollectedAt||0)>30||!card||card.done||card.owner?.online===false||!source||source.deliveryIssue)throw new Error('The source chat changed or is unavailable. No message was sent.');
        const mode=value.action.mode==='queue'||['working','starting'].includes(source.lifecycle)||['working','starting'].includes(card.status)?'queue':'send';
        message.status='thinking';message.action={...ref,text:value.action.text.trim(),mode,messageId:crypto.randomUUID(),status:'dispatching'};this.save();
        let receipt;
        try{receipt=await this.options.dispatch(mode,{id:ref.id,taskKey:ref.taskKey,sourceId:ref.sourceId,messageId:message.action.messageId,text:message.action.text});}
        catch(error){message.action.status=error.delivery==='not-sent'?'not-sent':'unconfirmed';throw new Error(message.action.status==='not-sent'?'The chat refused the message. It was not sent; your request is saved.':'Delivery is unconfirmed. Check the source chat before sending again.');}
        if(!['sent','queued'].includes(receipt?.delivery)){message.action.status='unconfirmed';throw new Error('Delivery is unconfirmed. Check the source chat before sending again.');}
        message.action.status=receipt.delivery;message.answer=(receipt.delivery==='queued'?'Queued for ':'Sent to ')+ref.chatName+':\n'+clip(message.action.text,5500);message.status='completed';
        this.log('chat_message',{messageId:message.id,delivery:receipt.delivery,route:receipt.route||'',elapsedMs:Date.now()-started});
      }
      message.contextAt=current.data.capturedAt;this.save();this.log('completed',{messageId:message.id,elapsedMs:Date.now()-started,links:links.length,model:message.model});
    } catch(error) {
      if(this.closed)return;
      message.status='failed';delete message.answer;message.links=[];
      message.error=error.message||'Hyphen could not answer.';
      try {this.save();}catch{this.error='Assistant history could not be saved. Keep the app open.';}
      this.log('failed',{messageId:message.id,elapsedMs:Date.now()-started,code:error.code||'ASSISTANT_FAILED'});
    } finally {this.active=false;this.emit('change');}
  }
  use(input) {
    const message=this.state.messages.find(m=>m.id===input.messageId&&m.status==='completed');
    if(!Number.isInteger(input.index)||input.index<0)throw new Error('Choose a related update from Hyphen’s answer.');
    const link=message?.links[input.index];if(!link)throw new Error('That related update is unavailable.');
    const state=this.options.snapshot();const card=[...(state.cards||[]),...(state.done||[])].find(c=>c.id===link.id&&c.taskKey===link.taskKey&&
      (c.owner?.id||'local')===link.ownerId&&revision(c)===link.revision);
    if(!card||card.done||!card.sources?.some(s=>s.id===link.sourceId))throw new Error('This update changed. Ask Hyphen again to use its latest context.');
    return {card,sourceId:link.sourceId,draft:link.draft};
  }
  close(){this.closed=true;this.provider.close();}
}
module.exports={Assistant,context,revision};
