'use strict';
const crypto=require('node:crypto');
const clip=(value,n)=>String(value??'').toWellFormed().slice(0,n);
const revision=card=>crypto.createHash('sha256').update(JSON.stringify([card.id,card.taskKey,card.primarySourceId,card.fingerprint,card.status,card.summary,card.sources?.map(s=>[s.id,s.lifecycle])])).digest('hex');
const conversation=m=>m.kind!=='update'&&!!(m.text||(m.images||[]).length);
const stop=new Set('what which when where please needs need right now chat chats thread threads this that with from about draft reply message recently changed happening have does make tell know remember earlier discussed said should could would again there them then want like just can you the and for how why did are was'.split(' '));
const words=text=>[...new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[]).filter(w=>!stop.has(w)))];
const owner=card=>card.owner?.id||'local';
const matches=(card,ref)=>!!ref&&card.id===ref.id&&owner(card)===(ref.ownerId||'local')&&card.sources?.some(s=>s.id===ref.sourceId);
function history(messages,current) {
  const all=messages.filter(m=>m.id!==current.id&&m.status==='completed'&&conversation(m));
  const recent=[];let budget=12000;
  for(const m of all.slice(-10).reverse()) {
    const entry={id:m.id,user:clip(m.text,1000),assistant:clip(m.answer,1500),imageIds:(m.images||[]).map(i=>i.id)};
    const size=JSON.stringify(entry).length;if(size>budget)continue;budget-=size;recent.unshift(entry);
  }
  const included=new Set(recent.map(m=>m.id)),tokens=words(current.text);
  const personal=/\bwhat (?:do you )?(?:remember|know)\b.*(?:about me)?/i.test(current.text);
  const recall=all.filter(m=>!included.has(m.id)).map((m,index)=>({m,index,score:tokens.filter(w=>[m.text,m.answer].join(' ').toLowerCase().includes(w)).length+(personal&&/\b(?:I (?:prefer|like|want|work|live|study)|my (?:name|job|goal|preference)|we (?:agreed|decided))\b/i.test(m.text)?2:0)}))
    .filter(r=>r.score>0).sort((a,b)=>b.score-a.score||b.index-a.index).slice(0,4)
    .map(({m})=>({user:clip(m.text,800),assistant:clip(m.answer,1000),at:m.at}));
  return {recent:recent.map(({id,...m})=>m),recalled:recall,coverage:{retainedExchanges:all.length,recentExchanges:recent.length,recalledExchanges:recall.length},messages:all};
}
function context(snapshot,question,options={}) {
  const all=[...new Map([...(snapshot.cards||[]),...(snapshot.done||[])].map(c=>[owner(c)+'\n'+c.id+'\n'+c.taskKey,c])).values()];
  const tokens=words(question),followUp=/\b(that|this|it|them|him|her|same|continue|again)\b/i.test(question);
  const recentLinks=(options.history||[]).slice(-3).flatMap(m=>m.links||[]);
  const inQueue=c=>!c.done&&!c.reviewed&&!c.snoozed&&(c.kind==='local'||(c.at||0)>=(snapshot.settings?.queueSince||0));
  const rank=card=>{
    const text=[card.chatName,card.title,card.summary,...(card.sources||[]).map(s=>s.title)].join(' ').toLowerCase();
    const lexical=tokens.filter(w=>text.includes(w)).length;
    const focused=followUp&&matches(card,options.focus),linked=followUp&&recentLinks.some(ref=>matches(card,ref));
    return {card,lexical,focused,linked,score:lexical*500+(focused?350:linked?300:0)+(card.waitingOn?.kind==='you'||card.status==='needs'?80:0)+(card.urgent?40:0)-(inQueue(card)?0:100)};
  };
  const ranked=all.map(rank).sort((a,b)=>b.score-a.score||(b.card.at||0)-(a.card.at||0));
  const refs=new Map(),cards=[],targets=[];let budget=18000;
  for(const item of ranked.slice(0,36)) {
    const {card}=item;
    const previous=recentLinks.findLast(ref=>matches(card,ref));
    const source=card.sources?.find(s=>s.id===(item.focused?options.focus.sourceId:item.linked?previous.sourceId:card.primarySourceId))||card.sources?.[0];
    const ref='c'+cards.length;
    const data={ref,chatName:clip(card.chatName,180),task:clip(card.title,240),summary:clip(card.summary,600),
      status:card.status,waitingOn:card.waitingOn,label:clip(card.label,160),urgent:!!card.urgent,reviewed:!!card.reviewed,
      snoozed:!!card.snoozed,done:!!card.done,device:card.owner?.name||card.device?.label,online:card.owner?.online!==false,
      inQueue:inQueue(card),hasChat:!!source,queuedMessages:source?.queuedMessages||0,deliveryIssue:clip(source?.deliveryIssue,300),at:card.at,
      contextLoaded:!!source?.contextLoaded,conversationLoaded:!!source?.conversationLoaded};
    const route={id:card.id,taskKey:card.taskKey,sourceId:source?.id||'',ownerId:owner(card),revision:revision(card),chatName:clip(card.chatName||card.title,180)};
    if(source&&targets.length<3&&(item.lexical>0||item.focused||item.linked||cards.length<3))targets.push(route);
    let size=JSON.stringify(data).length;if(size>budget)continue;
    if(targets.some(t=>t.id===route.id&&t.sourceId===route.sourceId)&&source?.contextLoaded) {
      const extra={excerpt:clip(source.body,1600),conversation:(source.conversation||[]).filter(m=>['user','assistant'].includes(m.role)&&m.text).slice(-8).map(m=>({role:m.role,text:clip(m.text,600)}))};
      while(JSON.stringify(extra).length>4200&&extra.conversation.length)extra.conversation.shift();
      if(size+JSON.stringify(extra).length<=budget)Object.assign(data,extra);
    }
    size=JSON.stringify(data).length;budget-=size;cards.push(data);refs.set(ref,route);
  }
  const collectedAt=snapshot.collectedAt||snapshot.feedCollectedAt||0;
  const focusedEntry=[...refs].find(([,ref])=>matches(all.find(c=>c.id===ref.id&&owner(c)===ref.ownerId)||{},options.focus));
  return {refs,targets,data:{capturedAt:new Date().toISOString(),health:snapshot.health||{ok:false},collectedAt,
    fresh:!!snapshot.health?.ok&&collectedAt>0&&Math.floor(Date.now()/1000)-collectedAt<=30,
    focusedChat:focusedEntry?{ref:focusedEntry[0],chatName:focusedEntry[1].chatName,meaning:'Last source chat opened by the user in Hyphen; a named destination or explicit conversation reference takes precedence.'}:null,
    coverage:{totalCards:all.length,includedCards:cards.length,monitoredChats:snapshot.monitoredCount||0,
      sourceConversationsIncluded:cards.filter(c=>c.conversation?.length).length},cards}};
}
function messageTarget(current,question,options={}) {
  const destination=question.match(/(?:tell|ask|message|send|queue)\s+(?:(?:a|the)\s+)?(.{1,180}?)\s+(?:chat|thread)\b/i);
  const named=destination?words(destination[1]):[];
  const explicit=current.data.cards.filter(card=>named.length?named.every(w=>card.chatName.toLowerCase().includes(w)):
    !/\b(?:this|that|same) (?:chat|thread)\b/i.test(question)&&card.chatName.length>=4&&question.toLowerCase().includes(card.chatName.toLowerCase()));
  if(explicit.length)return explicit.length===1?explicit[0].ref:null;
  if(named.length)return null;
  if(!/\b(that|this|same|him|them|her|it)\b/i.test(question))return null;
  if(options.focus) {
    const focused=[...current.refs].filter(([,r])=>r.id===options.focus.id&&r.sourceId===options.focus.sourceId&&r.ownerId===options.focus.ownerId);
    if(focused.length===1)return focused[0][0];
  }
  const previous=(options.history||[]).findLast(m=>m.links?.length);
  if(previous?.links.length===1){const prior=previous.links[0];return [...current.refs].find(([,r])=>r.id===prior.id&&r.sourceId===prior.sourceId&&r.ownerId===prior.ownerId)?.[0]||null;}
  return null;
}
// Wait on existing feed events, never claim a writer or repeatedly poll a chat.
async function loadContext(options,targets) {
  const available=()=>{
    const snapshot=options.snapshot(),all=[...(snapshot.cards||[]),...(snapshot.done||[])];
    return {snapshot,missing:targets.filter(t=>{const card=all.find(c=>matches(c,t));const source=card?.sources?.find(s=>s.id===t.sourceId);
      return card&&card.owner?.online!==false&&!(source?.contextLoaded&&source?.conversationLoaded);})};
  };
  if(!available().missing.length)return available().snapshot;
  return new Promise(resolve=>{
    let stopped=false,unsubscribe=()=>{};
    const finish=()=>{if(stopped)return;stopped=true;clearTimeout(timer);unsubscribe();resolve(options.snapshot());};
    const timer=setTimeout(finish,options.timeoutMs??6000);
    const changed=()=>{if(!available().missing.length)finish();};
    unsubscribe=options.subscribe(changed);
    Promise.resolve().then(()=>options.request(available().missing)).then(changed,finish);
    changed();
  });
}
module.exports={context,history,conversation,revision,loadContext,messageTarget};
