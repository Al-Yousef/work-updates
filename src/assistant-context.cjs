'use strict';
const crypto=require('node:crypto');
const clip=(value,n)=>{const text=String(value??'').toWellFormed();let end=Math.min(n,text.length);if(end&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;return text.slice(0,end);};
const budgets=Object.freeze({recent:12000,recalled:8000,userEvidence:4000,cards:18000,source:4200});
const revision=card=>crypto.createHash('sha256').update(JSON.stringify([card.id,card.taskKey,card.primarySourceId,card.fingerprint,card.status,card.summary,card.owner?.id,card.owner?.name,card.owner?.kind,card.device,card.sources?.map(s=>[s.id,s.lifecycle,s.kind,s.device])])).digest('hex');
const conversation=m=>m.kind!=='update'&&!!(m.text||(m.images||[]).length);
const stop=new Set('what which when where please needs need right now chat chats thread threads this that with from about draft reply message recently changed happening have does make tell know remember earlier discussed said should could would again there them then want like just can you the and for how why did are was'.split(' '));
const words=text=>[...new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[]).filter(w=>!stop.has(w)))];
const owner=card=>card.owner?.id||'local';
const matches=(card,ref)=>!!ref&&card.id===ref.id&&owner(card)===(ref.ownerId||'local')&&card.sources?.some(s=>s.id===ref.sourceId);
function history(messages,current) {
  const all=messages.filter(m=>m.id!==current.id&&m.status==='completed'&&m.kind!=='memory_inspection'&&conversation(m));
  const entry=(m,userLimit,assistantLimit)=>({id:m.id,at:m.at,user:clip(m.text,userLimit),assistant:clip(m.answer,assistantLimit),imageIds:(m.images||[]).map(i=>i.id),
    provenance:{user:'human_statement',assistant:'generated_answer'},truncated:{user:m.text.length>userLimit,assistant:(m.answer||'').length>assistantLimit}});
  const recent=[];let budget=budgets.recent;
  for(const m of all.slice(-10).reverse()) {
    const item=entry(m,1000,1500);
    const size=JSON.stringify(item).length;if(size>budget)continue;budget-=size;recent.unshift(item);
  }
  const included=new Set(recent.map(m=>m.id)),tokens=words(current.text);
  const personal=/\bwhat (?:do you )?(?:remember|know)\b.*(?:about me)?/i.test(current.text);
  const ranked=all.filter(m=>!included.has(m.id)).map((m,index)=>{
    const user=tokens.filter(w=>m.text.toLowerCase().includes(w)).length;
    const assistant=tokens.filter(w=>(m.answer||'').toLowerCase().includes(w)).length;
    const preference=personal&&/\b(?:I (?:prefer|like|want|work|live|study)|my (?:name|job|goal|preference)|we (?:agreed|decided))\b/i.test(m.text);
    const correction=(user||preference)&&/\b(?:actually|correction|instead|no longer|changed my mind|now prefer)\b/i.test(m.text);
    return {m,index,score:user*4+Math.min(assistant,2)+(preference?4:0)+(correction?8:0)};
  }).filter(r=>r.score>0).sort((a,b)=>b.score-a.score||b.index-a.index);
  const recall=[];let recalledBudget=budgets.recalled;
  for(const {m} of ranked){const item=entry(m,800,1000),size=JSON.stringify(item).length;if(size>recalledBudget)continue;recall.push(item);recalledBudget-=size;if(recall.length===4)break;}
  const selected=new Set([...recent,...recall].map(m=>m.id));
  const evidence=[];let evidenceBudget=budgets.userEvidence;
  const evidenceRank=all.map((m,index)=>({m,index,score:tokens.filter(w=>m.text.toLowerCase().includes(w)).length*4+
    (personal&&/\b(?:I |my |we (?:agreed|decided))/i.test(m.text)?4:0)})).filter(({m})=>selected.has(m.id)&&!/^\/(?:memory|forget|correct)\b/i.test(m.text))
    .sort((a,b)=>b.score-a.score||b.index-a.index);
  const evidenceOrder=new Map(all.map((m,i)=>[m.id,i]));
  for(const {m} of evidenceRank) {
    const item={exchangeId:m.id,at:m.at,text:clip(m.text,800),provenance:'human_statement',truncated:m.text.length>800};
    const size=JSON.stringify(item).length;if(size>evidenceBudget)continue;evidence.push(item);evidenceBudget-=size;if(evidence.length===6)break;
  }
  evidence.sort((a,b)=>evidenceOrder.get(a.exchangeId)-evidenceOrder.get(b.exchangeId));
  return {recent,recalled:recall,userEvidence:evidence,coverage:{retainedExchanges:all.length,recentExchanges:recent.length,recalledExchanges:recall.length,
    selectedCharacters:budgets.recent-budget+budgets.recalled-recalledBudget,userEvidenceCharacters:budgets.userEvidence-evidenceBudget,budgets},messages:all};
}
// A generated related link is not a human-confirmed conversational destination.
function confirmedLinks(messages,cards) {
  return messages.flatMap(m=>/\b(?:not|never|wrong|incorrect|guess(?:ed)?|unconfirmed|quoted|said|says)\b|\b(?:don['’]t|wasn['’]t|isn['’]t|didn['’]t)\b/i.test(m.text||'')?[]:(m.links||[]).filter(ref=>ref.chatName?.length>=4&&m.text?.toLowerCase().includes(ref.chatName.toLowerCase())&&
    cards.filter(c=>c.chatName?.toLowerCase()===ref.chatName.toLowerCase()).length===1));
}
function context(snapshot,question,options={}) {
  const all=[...new Map([...(snapshot.cards||[]),...(snapshot.done||[])].map(c=>[owner(c)+'\n'+c.id+'\n'+c.taskKey,c])).values()];
  // A new human follow-up may refer to the same opened source after adoption
  // changes its card ID. Bind its current revision below; never move owners.
  if(options.focus){const focused=all.filter(c=>owner(c)===options.focus.ownerId&&c.sources?.some(s=>s.id===options.focus.sourceId));if(focused.length===1)options={...options,focus:{...options.focus,id:focused[0].id,taskKey:focused[0].taskKey}};}
  const tokens=words(question),followUp=/\b(that|this|it|them|him|her|same|continue|again)\b/i.test(question);
  const recentLinks=confirmedLinks((options.history||[]).slice(-3),all);
  const collectedAt=snapshot.collectedAt||snapshot.feedCollectedAt||0,age=Math.floor(Date.now()/1000)-collectedAt;
  const fresh=!!snapshot.health?.ok&&collectedAt>0&&age>=-5&&age<=30;
  const inQueue=c=>!c.done&&!c.reviewed&&!c.snoozed&&(c.kind==='local'||(c.at||0)>=(snapshot.settings?.queueSince||0));
  const rank=card=>{
    const text=[card.chatName,card.title,card.summary,...(card.sources||[]).map(s=>s.title)].join(' ').toLowerCase();
    const lexical=tokens.filter(w=>text.includes(w)).length;
    const focused=followUp&&matches(card,options.focus),linked=followUp&&recentLinks.some(ref=>matches(card,ref));
    return {card,lexical,focused,linked,score:lexical*500+(focused?350:linked?300:0)+(card.waitingOn?.kind==='you'||card.status==='needs'?80:0)+(card.urgent?40:0)-(inQueue(card)?0:100)};
  };
  const ranked=all.map(rank).sort((a,b)=>b.score-a.score||(b.card.at||0)-(a.card.at||0));
  const refs=new Map(),cards=[],targets=[];let budget=budgets.cards;
  for(const item of ranked.slice(0,36)) {
    const {card}=item;
    const previous=recentLinks.findLast(ref=>matches(card,ref));
    const source=card.sources?.find(s=>s.id===(item.focused?options.focus.sourceId:item.linked?previous.sourceId:card.primarySourceId))||card.sources?.[0];
    const ref='c'+cards.length;
    const data={ref,chatName:clip(card.chatName,180),task:clip(card.title,240),summary:clip(card.summary,600),
      status:card.status,waitingOn:card.waitingOn,label:clip(card.label,160),urgent:!!card.urgent,reviewed:!!card.reviewed,
      snoozed:!!card.snoozed,done:!!card.done,device:card.owner?.name||card.device?.label,online:card.owner?.online!==false,
      inQueue:inQueue(card),hasChat:!!source,queuedMessages:source?.queuedMessages||0,deliveryIssue:clip(source?.deliveryIssue,300),at:card.at,
      contextLoaded:!!source?.contextLoaded,conversationLoaded:!!source?.conversationLoaded,
      summaryProvenance:card.summaryOrigin==='ai'?'generated_summary':'recorded_queue_summary',
      sourceCoverage:{state:card.owner?.online===false?'offline':!source?.contextLoaded?'unavailable':!fresh?'cached':'available',historical:!inQueue(card),
        collectedAt,sourceEventAt:card.at||0,truncated:false,excerptIncluded:false,conversationIncluded:false}};
    const route={id:card.id,taskKey:card.taskKey,sourceId:source?.id||'',ownerId:owner(card),revision:revision(card),chatName:clip(card.chatName||card.title,180),executionDevice:{ownerId:owner(card),kind:source?.device?.kind||card.device?.kind||card.owner?.kind||'unknown',name:source?.device?.label||card.device?.label||card.owner?.name||'Unknown device'}};
    const selected=source&&targets.length<3&&(item.lexical>0||item.focused||item.linked||cards.length<3);
    let size=JSON.stringify(data).length;if(size>budget)continue;
    if(selected&&source?.contextLoaded) {
      const transcript=(source.conversation||[]).filter(m=>['user','assistant'].includes(m.role)&&m.text);
      const extra={excerpt:clip(source.body,1600),excerptProvenance:'source_chat_evidence',conversation:transcript.slice(-8).map(m=>({role:m.role,text:clip(m.text,600),provenance:'source_chat_evidence'}))};
      data.sourceCoverage.truncated=(source.body||'').length>1600||transcript.length>8||transcript.slice(-8).some(m=>m.text.length>600);
      while(JSON.stringify(extra).length>budgets.source&&extra.conversation.length){extra.conversation.shift();data.sourceCoverage.truncated=true;}
      if(size+JSON.stringify(extra).length+100<=budget){Object.assign(data,extra);data.sourceCoverage.excerptIncluded=!!extra.excerpt;data.sourceCoverage.conversationIncluded=!!extra.conversation.length;}
      else data.sourceCoverage.truncated=true;
    }
    size=JSON.stringify(data).length;if(size>budget)continue;budget-=size;cards.push(data);refs.set(ref,route);if(selected)targets.push(route);
  }
  const focusedEntry=[...refs].find(([,ref])=>matches(all.find(c=>c.id===ref.id&&owner(c)===ref.ownerId)||{},options.focus));
  return {refs,targets,data:{capturedAt:new Date().toISOString(),health:snapshot.health||{ok:false},collectedAt,
    fresh,
    focusedChat:focusedEntry?{ref:focusedEntry[0],chatName:focusedEntry[1].chatName,meaning:'Last source chat opened by the user in Hyphen; a named destination or explicit conversation reference takes precedence.'}:null,
    coverage:{totalCards:all.length,includedCards:cards.length,monitoredChats:snapshot.monitoredCount||0,
      sourceConversationsIncluded:cards.filter(c=>c.conversation?.length).length,selectedCharacters:budgets.cards-budget,characterBudget:budgets.cards},cards}};
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
    const focused=[...current.refs].filter(([,r])=>r.sourceId===options.focus.sourceId&&r.ownerId===options.focus.ownerId);
    if(focused.length===1)return focused[0][0];
  }
  for(const message of (options.history||[]).slice(-3).reverse()) {
    const previous=confirmedLinks([message],current.data.cards);
    if(previous.length>1)return null;
    const prior=previous[0];
    if(prior)return [...current.refs].find(([,r])=>r.id===prior.id&&r.sourceId===prior.sourceId&&r.ownerId===prior.ownerId)?.[0]||null;
  }
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
module.exports={context,history,conversation,revision,loadContext,messageTarget,budgets};
