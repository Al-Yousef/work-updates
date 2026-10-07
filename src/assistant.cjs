'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {atomic}=require('./queue.cjs');
const {readStore}=require('./private-store.cjs');
const {AssistantProvider}=require('./assistant-provider.cjs');
const {Attachments,attachmentIds,messageHash}=require('./attachments.cjs');
const {context,history,conversation,revision,messageTarget}=require('./assistant-context.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const clip=(value,n)=>String(value??'').toWellFormed().slice(0,n);
const coordination=require('./assistant-coordination.cjs');
const {command:responsibilityCommand}=require('./responsibility-command.cjs');
const {currentScope}=require('./responsibility-target.cjs');
const {command:authorizationCommand}=require('./authorization-command.cjs');
const {command:scheduleCommand}=require('./schedule-command.cjs');
const {command:commitmentCommand}=require('./commitment-command.cjs');
class Assistant extends EventEmitter {
  constructor(options) {
    super();this.options=options;this.file=path.join(options.directory,'assistant.json');this.active=false;this.closed=false;this.error='';
    this.state={version:2,messages:[],notes:[],receipts:{},seen:null,focus:null};
    try {if(fs.existsSync(this.file)) {
      if(fs.statSync(this.file).size>32*1024*1024)throw new Error();
      const value=readStore(this.file).value;
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
      for(const message of value.messages)if(message.status==='thinking'){message.status='failed';message.error=['dispatching','cancelling'].includes(message.action?.status)?'Hyphen restarted during delivery. Check the source chat before retrying; delivery is unconfirmed.':'Hyphen restarted before answering. Send a new message to retry.';if(['dispatching','cancelling'].includes(message.action?.status))message.action.status='unconfirmed';recovered=true;}
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
    return {responding:this.active,error:this.error,model:this.provider.model||null,memoryCount:this.state.notes.length,scheduleCount:this.options.schedules?.snapshot().filter(s=>!['cancelled','expired'].includes(s.state)).length||0,responsibilityCount:this.options.responsibilities?.snapshot().filter(r=>!['completed','cancelled'].includes(r.state)).length||0,
    messages:this.state.messages.filter(m=>visible.has(m)).map(m=>({...m,focus:undefined,action:undefined,links:m.links.map(({chatName,draft},index)=>({chatName,draft:clip(draft,12000),index}))}))};}
  log(event,details){this.options.log?.write('assistant.'+event,details);}
  observe(snapshot) {
    if(this.closed||this.error||!coordination.fresh(snapshot))return;
    const cards=(snapshot.cards||[]).slice(0,2048),seen=Object.fromEntries(cards.map(c=>[c.id,hash(JSON.stringify([c.fingerprint,c.status,c.sources?.map(s=>[s.id,s.lifecycle])]))]));
    const progress=this.state.messages.filter(m=>m.action&&['queued','accepted','unconfirmed'].includes(m.action.status)).map(message=>({message,next:coordination.outcome(snapshot,message.action)})).filter(x=>x.next);
    if(!progress.length&&JSON.stringify(seen)===JSON.stringify(this.state.seen))return;
    const baseline=this.state.seen===null,prior=structuredClone(this.state),arrived=[];
    for(const {message,next}of progress){message.action.status=next.status;message.action.turnId=next.turnId;message.links=[next.link];
      const descriptions={accepted:'Codex accepted the queued message for',completed:'The requested pass completed in',failed:'The requested pass failed or was stopped in',cancelled:'Cancelled the queued message for','not-sent':'The queued message was not sent to',unconfirmed:'Delivery is unconfirmed for'};
      next.link.coordinationId=message.id;arrived.push({id:crypto.randomUUID(),text:'',kind:'update',status:'completed',at:Date.now(),coordinationId:message.id,answer:descriptions[next.status]+' '+message.action.chatName+'.',links:[next.link]});}
    if(!baseline)for(const card of cards) {
      if(progress.some(p=>p.next.link.id===card.id))continue;
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
      const authorization=authorizationCommand(message.text);
      if(authorization){await this.manageAuthorization(message,authorization);this.save();return;}
      const recorded=commitmentCommand(message.text);if(recorded){require('./commitment-control.cjs').manage(this.options.commitments,message,recorded,this.options.snapshot());this.save();return;}
      const planned=scheduleCommand(message.text);if(planned){await this.manageSchedule(message,planned);this.save();return;}
      const ongoing=responsibilityCommand(message.text);
      if(ongoing){await this.manageResponsibility(message,ongoing);this.save();return;}
      const cancel=coordination.cancellation(this.state.messages,message);
      if(cancel){
        if(!cancel.target){message.status='completed';message.answer='Which queued message should I cancel? Name its chat. The queue is unchanged.';this.save();return;}
        const target=cancel.target,action=target.action,snapshot=this.options.snapshot(),match=coordination.sourceFor(snapshot,action);
        const queued=match?.source.deliveryOutcomes?.some(d=>d.messageId===action.messageId&&d.sourceId===action.sourceId&&d.status==='queued');
        if(!this.options.dispatch||!coordination.fresh(snapshot)||!match||match.card.owner?.online===false||!queued)throw new Error('That message is no longer confirmed as locally queued on its original device. Check its source chat before cancelling.');
        message.action={...action,status:'cancelling',coordinationParent:target.id};this.save();
        let receipt;try{receipt=await this.options.dispatch('cancel',{id:match.card.id,taskKey:match.card.taskKey,sourceId:action.sourceId,messageId:action.messageId});}
        catch(error){message.action.status=error.delivery==='not-sent'?'not-sent':'unconfirmed';throw error;}
        if(receipt?.delivery!=='cancelled'||receipt.messageId!==action.messageId||receipt.sourceId!==action.sourceId||receipt.ownerId!==action.ownerId){message.action.status='unconfirmed';throw new Error('Cancellation is unconfirmed. Check the source queue before retrying.');}
        target.action.status='cancelled';message.action.status='cancelled';message.status='completed';message.answer='Cancelled the locally queued message for '+action.chatName+'. Other messages and the active pass are unchanged.';message.links=[{...coordination.link(match.card,action.sourceId),coordinationId:target.id}];this.save();return;
      }
      const recalled=history(this.state.messages,message),recent=recalled.recent;
      const selection={focus:message.focus,history:recalled.messages};
      let current=context(this.options.snapshot(),message.text,selection);
      if(this.options.loadContext&&current.data.fresh&&this.options.commitments?.preferenceSnapshot().research?.value!=='off') {const refreshed=await this.options.loadContext(current.targets);if(this.closed)return;current=context(refreshed||this.options.snapshot(),message.text,selection);}
      const requested=coordination.request(this.state.messages,message,current,selection),requestedRef=requested?.ref||null;
      if(requested&&!requestedRef){message.proposal=requested.proposal;message.pendingDestination=true;message.status='completed';message.answer='Which chat should receive this message? I’ve kept the text:\n'+message.proposal.text;
        message.links=current.data.cards.filter(c=>c.hasChat&&!c.done).slice(0,3).map(c=>({...current.refs.get(c.ref),draft:message.proposal.text}));this.save();return;}
      let images=message.images||[];
      if(!images.length&&/\b(image|photo|picture|screenshot|attachment|shown|left|right|colou?r|previous|earlier|that|this)\b/i.test(message.text)){const prior=recent.findLast(m=>m.imageIds.length);if(prior){try{images=this.attachments.resolve(prior.imageIds);}catch{prior.imagesUnavailable=true;}}}
      const value=await this.provider.answer({question:message.text||'Describe the attached image and help me understand it.',images,imagesFromHistory:!(message.images||[]).length&&!!images.length,history:recent,recalledHistory:recalled.recalled,userEvidence:recalled.userEvidence,historyCoverage:recalled.coverage,savedNotes:this.state.notes,
        savedNotesProvenance:'explicit_pinned_notes',memoryCoverage:{retentionExchanges:500,retentionAlerts:40,pinnedNoteLimit:32,pinnedNoteCharacters:this.state.notes.join('').length},queue:current.data,
        responsibilities:this.options.responsibilities?.snapshot().slice(-8).map(r=>({id:r.id,origin:{text:clip(r.origin.text,600),provenance:'accepted_human_instruction'},instruction:clip(r.instruction,800),revision:r.revision,state:r.state,chatName:r.scope.chatName,ownerId:r.ownerId,stepStatus:r.currentStep.status,wakeReason:r.wakeReason.kind,completionCriteria:r.completionCriteria})),
        schedules:this.options.schedules?.snapshot().slice(-8).map(s=>({id:s.id,responsibilityId:s.responsibilityId,state:s.state,reason:s.reason,timeZone:s.schedule.timeZone,endAt:s.schedule.endAt,nextWake:s.nextWake,lastActualRun:s.lastActualRun,lastRun:s.runs.at(-1)?.status})),
        commitments:this.options.commitments?.context(),
        canRequestChatMessage:!!this.options.dispatch&&!!requestedRef,requestedChatRef:requestedRef,requestedMessage:requested?.proposal||null});
      if(this.closed)return;
      if(typeof value.answer!=='string'||!value.answer.trim()||value.answer.length>6000||!Array.isArray(value.links)||value.links.length>3)
        throw new Error('Hyphen returned an invalid answer.');
      const seen=new Set();const links=[];
      for(const link of value.links){const ref=current.refs.get(link.ref);
        if(!ref||seen.has(link.ref)||typeof link.draft!=='string'||link.draft.length>12000||(!ref.sourceId&&link.draft))throw new Error('Hyphen returned an invalid chat reference.');
        seen.add(link.ref);links.push({...ref,draft:link.draft});}
      message.answer=value.answer;message.links=links;message.status='completed';message.model=value.model||'';
      if(requested&&!value.action){message.proposal=requested.proposal;message.answer='Your message has not been sent or queued. The proposed text is saved:\n'+requested.proposal.text;}
      if(value.action) {
        if(!this.options.dispatch||!requestedRef||value.action.ref!==requestedRef)throw new Error('A chat message needs a clear instruction and destination from you. No message was sent.');
        const ref=current.refs.get(value.action.ref);
        if(!ref?.sourceId||typeof value.action.text!=='string'||!value.action.text.trim()||value.action.text.length>12000||!['send','queue'].includes(value.action.mode))throw new Error('Hyphen could not identify a valid chat message. No message was sent.');
        if(coordination.normalize(value.action.text)!==coordination.normalize(requested.proposal.text))throw new Error('The proposed message changed your instruction. No message was sent; your original text is saved.');
        const latest=this.options.snapshot(),card=[...(latest.cards||[]),...(latest.done||[])].find(c=>c.id===ref.id&&c.taskKey===ref.taskKey&&(c.owner?.id||'local')===ref.ownerId&&revision(c)===ref.revision);
        const source=card?.sources?.find(s=>s.id===ref.sourceId);
        const collectedAt=Number(latest.collectedAt||latest.feedCollectedAt||0),age=Date.now()/1000-collectedAt;
        if(!latest.health?.ok||collectedAt<=0||!Number.isFinite(age)||age< -5||age>30||!card||card.done||card.owner?.online===false||!source||source.deliveryIssue)throw new Error('The source chat changed or is unavailable. No message was sent.');
        const mode=requested.proposal.mode==='queue'||['working','starting'].includes(source.lifecycle)||['working','starting'].includes(card.status)?'queue':'send';
        message.status='thinking';message.action={...ref,text:requested.proposal.text,mode,messageId:crypto.randomUUID(),status:'dispatching'};this.save();
        let receipt;
        try{const dispatch=()=>this.options.dispatch(mode,{id:ref.id,taskKey:ref.taskKey,sourceId:ref.sourceId,messageId:message.action.messageId,text:message.action.text});
          receipt=await (this.options.log?.scope?this.options.log.scope({assistantIntentId:message.id,messageId:message.action.messageId,sourceId:ref.sourceId,ownerId:ref.ownerId,taskKey:ref.taskKey},dispatch):dispatch());}
        catch(error){message.action.status=error.delivery==='not-sent'?'not-sent':'unconfirmed';throw new Error(message.action.status==='not-sent'?'The chat refused the message. It was not sent; your request is saved.':'Delivery is unconfirmed. Check the source chat before sending again.');}
        if(!coordination.receiptMatches(receipt,message.action)){message.action.status='unconfirmed';throw new Error('A matching delivery receipt is unavailable. Delivery is unconfirmed; check the source chat before sending again.');}
        message.action.status=receipt.delivery==='sent'?'accepted':'queued';message.action.turnId=receipt.turnId||null;message.action.route=receipt.route||'';
        message.answer=(receipt.delivery==='queued'?'Locally queued for ':'Accepted by Codex for ')+ref.chatName+':\n'+clip(message.action.text,5200)+(receipt.delivery==='queued'?'\nSay “cancel that queued message” to cancel it.':'\nThis receipt confirms acceptance; the pass has not been verified complete.');message.status='completed';
        const exact=coordination.sourceFor(this.options.snapshot(),message.action);message.links=[exact?coordination.link(exact.card,ref.sourceId):{...ref,draft:''}];message.links[0].coordinationId=message.id;
        this.log('chat_message',{assistantIntentId:message.id,messageId:message.action.messageId,sourceId:ref.sourceId,ownerId:ref.ownerId,taskKey:ref.taskKey,turnId:receipt.turnId,delivery:receipt.delivery,route:receipt.route||'',elapsedMs:Date.now()-started});
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
    if(link.responsibilityId){const entry=this.options.responsibilities?.entry(link.responsibilityId),match=entry&&coordination.sourceFor(this.options.snapshot(),entry.scope);if(!match)throw new Error('The responsibility source is unavailable on its original device.');return {card:match.card,sourceId:entry.scope.sourceId,draft:''};}
    if(link.coordinationId){const action=this.state.messages.find(m=>m.id===link.coordinationId)?.action;const match=action&&coordination.sourceFor(this.options.snapshot(),action);if(!match)throw new Error('The source chat is unavailable on its original device.');return {card:match.card,sourceId:action.sourceId,draft:''};}
    const state=this.options.snapshot();const card=[...(state.cards||[]),...(state.done||[])].find(c=>c.id===link.id&&c.taskKey===link.taskKey&&
      (c.owner?.id||'local')===link.ownerId&&revision(c)===link.revision);
    if(!card||card.done||!card.sources?.some(s=>s.id===link.sourceId))throw new Error('This update changed. Ask Hyphen again to use its latest context.');
    return {card,sourceId:link.sourceId,draft:link.draft};
  }
  close(){this.closed=true;this.provider.close();}
  async manageAuthorization(message,command){
    const policy=this.options.authorization;if(!policy)throw new Error('Authorization controls are unavailable in this session.');
    const bridge=require('./responsibility-authorization.cjs'),human=bridge.human(policy,{messageId:message.id,text:message.text});
    if(command.kind==='list'){
      const state=policy.snapshot(),grants=state.grants.slice(-12),pending=state.operations.filter(o=>o.state==='waiting_human').slice(-12);
      message.answer=grants.length?grants.map(g=>g.action+' · '+g.mode+' · '+g.state+'\n'+g.id+'\nDestination: '+g.scope.destination+'\nAccount: '+g.scope.accountKind+' / '+g.scope.accountId+'\nDuration: '+(g.duration.kind==='until'?new Date(g.duration.endAt).toISOString():'until the responsibility ends')+' · uses '+state.operations.filter(o=>o.grantId===g.id).length+'/'+g.maxUses).join('\n\n'):'No authorization grants yet.';
      if(pending.length)message.answer+='\n\nWaiting for your approval:\n'+pending.map(o=>o.action+' · '+o.id).join('\n');
    }else if(command.kind==='inspect'){
      const grant=policy.grant(command.id);message.answer=grant.action+' · '+grant.mode+' · '+grant.state+'\n'+grant.id+'\n'+Object.entries(grant.scope).map(([key,value])=>key+': '+value).join('\n')+'\nDuration: '+(grant.duration.kind==='until'?new Date(grant.duration.endAt).toISOString():'until this responsibility ends')+' · maximum uses '+grant.maxUses+'\nHuman instruction: '+clip(grant.instruction,1800)+(grant.instruction.length>1800?'\nInstruction preview is truncated. Review its full draft in the source queue.':'')+'\nAttachments: '+(grant.attachmentIds.length?grant.attachmentIds.join(', '):'none');
    }else{
      if(command.kind==='revoke')policy.revoke(command.id,human);
      else if(command.kind==='mode')policy.setMode(command.id,command.mode,human);
      else if(command.kind==='account'){
        if(command.operation==='revoke')policy.revokeAccount(command.accountKind,command.accountId,human);
        else{const snapshot=this.options.snapshot(),owner=snapshot.cards.find(c=>c.owner?.id===command.accountId)?.owner;policy.restoreAccount(command.accountKind,command.accountId,human,{id:owner?.id,local:owner?.local===true,fresh:coordination.fresh(snapshot),online:owner?.online!==false});}
      }
      else if(command.kind==='approve'){
        const store=this.options.responsibilities,entry=store?.state.entries.find(e=>e.currentStep.messageId===command.id);
        const request=entry?bridge.request(entry,this.options.snapshot()):this.options.authorizationRequest?.(command.id);
        if(!request)throw new Error('Open the owning source for this operation. It cannot be approved from an unrelated chat.');
        policy.approve(command.id,human,request);
        if(entry?.state==='waiting_approval'&&entry.wakeReason.kind==='authorization_ask'){store.wake(entry.id,{role:'human',messageId:message.id,text:message.text,kind:'approval'});await store.dispatch(entry.id);}
      }
      message.answer='Saved your authorization '+command.kind+' control. Accepted work keeps its existing source receipt.';
    }
    message.answer=clip(message.answer,5800);message.status='completed';
  }
  async manageResponsibility(message,command){
    const store=this.options.responsibilities;if(!store)throw new Error('Responsibilities are unavailable in this session.');
    const human={role:'human',messageId:message.id,text:message.text};let id=command.id;
    if(command.kind==='list'){
      const entries=store.snapshot().slice(-12);message.answer=entries.length?entries.map(r=>r.scope.chatName+' · '+r.state.replaceAll('_',' ')+'\n'+r.id+'\n'+clip(r.instruction,180)).join('\n\n'):'No responsibilities yet. Open a source chat, then use /responsibility start INSTRUCTION.';
    }else{
      if(command.kind==='start'){
        if(!message.focus?.sourceId)throw new Error('Open the source chat first, then start its responsibility. Your instruction is saved; nothing was dispatched.');
        const scope=currentScope(message.focus,this.options.snapshot());
        id=store.create({...human,instruction:command.instruction},scope,{kind:command.completionKind,description:command.completionKind==='source_terminal'?'The requested source pass reaches its matching terminal completion.':'The human verifies the requested result against the originating instruction.'});
        await store.dispatch(id);
      }else if(command.kind==='steer'){store.steer(id,{...human,instruction:command.instruction});await store.dispatch(id);}
      else if(command.kind==='wait')store.wait(id,command.state,command.reason,human);
      else if(command.kind==='wake'||command.kind==='approve'){store.wake(id,{...human,kind:command.kind==='approve'?'approval':'wake'});await store.dispatch(id);}
      else if(command.kind==='cancel')await store.cancel(id,human);
      else if(command.kind==='verify')store.confirm(id,human);
      const entry=store.entry(id);message.responsibilityId=id;message.answer=entry.scope.chatName+' · '+entry.state.replaceAll('_',' ')+'\nResponsibility '+id+'\n'+clip(entry.instruction,3500)+'\nStep: '+entry.currentStep.status+'.';
      if(entry.wakeReason.kind==='source_finished_outcome_unverified')message.answer+=' The source pass finished; the broader requested result still needs verification.';
      const match=coordination.sourceFor(this.options.snapshot(),entry.scope);message.links=match?[{...coordination.link(match.card,entry.scope.sourceId),responsibilityId:id}]:[];
    }
    message.status='completed';
  }
  async manageSchedule(message,command){
    const store=this.options.schedules,responsibilities=this.options.responsibilities;if(!store||!responsibilities)throw new Error('Schedules are unavailable in this session.');
    const human={role:'human',messageId:message.id,text:message.text};let id=command.id;
    if(command.kind==='list')message.answer=store.snapshot().slice(-12).map(s=>s.grant.chatName+' · '+s.state+'\n'+s.id+'\nNext planned: '+(s.nextWake?new Date(s.nextWake).toISOString():'none')+' · Last actual: '+(s.lastActualRun?new Date(s.lastActualRun).toISOString():'none')).join('\n\n')||'No schedules yet. Create one for an unfinished responsibility with an explicit timezone, end date and run limit.';
    else{
      if(command.kind==='start'){
        const entry=responsibilities.entry(id);require('./scheduled-responsibility.cjs').target(responsibilities,{responsibilityId:id,grant:{instruction:entry.instruction,responsibilityRevision:entry.revision,...entry.scope}});
        id=store.create(human,entry,command.schedule,command.limits);
      }else store.control(id,command.kind,human,command.schedule,command.limits);
      await store.tick();
      const entry=store.entry(id);message.scheduleId=id;message.answer=entry.grant.chatName+' · '+entry.state+'\nSchedule '+id+'\nTimezone: '+entry.schedule.timeZone+'\nNext planned: '+(entry.nextWake?new Date(entry.nextWake).toISOString():'none')+'\nLast actual: '+(entry.lastActualRun?new Date(entry.lastActualRun).toISOString():'none')+'\nEnds: '+new Date(entry.schedule.endAt).toISOString()+'. Source acceptance and the requested result are tracked separately.';
    }
    message.status='completed';
  }
}
module.exports={Assistant,context,revision};
