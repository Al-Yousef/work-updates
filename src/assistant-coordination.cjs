'use strict';
const {revision,messageTarget}=require('./assistant-context.cjs');
const normalize=text=>String(text||'').trim().toLowerCase().replace(/[.!]+$/,'').replace(/\s+/g,' ');
const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function directRequest(text){return /^(?:(?:ok(?:ay)?|yeah|yes)[,.!]?\s+)?(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:tell|ask|message|send|queue)\b(?!\s+(?:me|us|yourself|what|whether|if|how|why)\b)/i.test(text)&&!/(?:\bonly draft\b|\bdraft only\b|\bwithout sending\b)/i.test(text);}
function proposal(text,current){
  if(!directRequest(text))return null;
  let body=text.match(/\b(?:chat|thread)\s*(?:to\s+|that\s+|:\s*)([\s\S]+)$/i)?.[1];
  if(!body)body=text.match(/\b(?:send|queue)\s+["“]([\s\S]+?)["”]\s+(?:to|in|for)\b/i)?.[1];
  if(!body)for(const card of current.data.cards){body=text.match(new RegExp(escape(card.chatName)+'\\s*(?:(?:chat|thread)\\s*)?(?:to\\s+|that\\s+|:\\s*)([\\s\\S]+)$','i'))?.[1];if(body)break;}
  if(!body||!body.trim()||body.length>12000)return null;
  const verb=text.match(/^(?:(?:ok(?:ay)?|yeah|yes)[,.!]?\s+)?(?:(?:can|could|would) you\s+)?(?:please\s+)?(tell|ask|message|send|queue)\b/i)?.[1];
  return {text:body.trim(),mode:verb?.toLowerCase()==='queue'?'queue':'send',provenance:'human_instruction'};
}
function request(messages,message,current,selection){
  const direct=proposal(message.text,current);
  if(direct)return {proposal:direct,ref:messageTarget(current,message.text,selection)};
  const previous=messages.filter(m=>m.id!==message.id&&m.text&&m.status==='completed').at(-1);
  if(!previous?.pendingDestination||!previous.proposal||previous.proposal.provenance!=='human_instruction')return null;
  const original=proposal(previous.text,current);if(!original||normalize(original.text)!==normalize(previous.proposal.text))return null;
  const selected=current.data.cards.filter(card=>[card.chatName,card.chatName+' chat',card.chatName+' on '+card.device].some(name=>normalize(name)===normalize(message.text.replace(/^the\s+/i,''))));
  if(selected.length!==1)return null;
  return {proposal:{...original,requestMessageId:previous.id,destinationChosenBy:message.id},ref:selected[0].ref};
}
function fresh(snapshot){const at=Number(snapshot.collectedAt||snapshot.feedCollectedAt||0),age=Date.now()/1000-at;return !!snapshot.health?.ok&&at>0&&Number.isFinite(age)&&age>=-5&&age<=30;}
function sourceFor(snapshot,action){
  const choices=[...(snapshot.cards||[]),...(snapshot.done||[])].filter(c=>(c.owner?.id||'local')===action.ownerId&&c.sources?.some(s=>s.id===action.sourceId));
  if(choices.length!==1)return null;const card=choices[0];return {card,source:card.sources.find(s=>s.id===action.sourceId)};
}
function link(card,sourceId){return {id:card.id,taskKey:card.taskKey,sourceId,ownerId:card.owner?.id||'local',revision:revision(card),chatName:card.chatName||card.title,draft:''};}
function outcome(snapshot,action){
  if(!fresh(snapshot))return null;const match=sourceFor(snapshot,action);if(!match||match.card.owner?.online===false)return null;
  const {source}=match,delivery=source.deliveryOutcomes?.find(d=>d.messageId===action.messageId&&d.sourceId===action.sourceId);
  let status=action.status,turnId=action.turnId;
  if(delivery?.status==='cancelled')status='cancelled';
  else if(delivery?.status==='failed')status='not-sent';
  else if(delivery?.status==='uncertain')status='unconfirmed';
  else if(delivery?.status==='sent'&&delivery.turnId){status='accepted';turnId=delivery.turnId;}
  if(turnId&&source.turnId===turnId&&['completed','failed','interrupted'].includes(source.turnOutcome))status=source.turnOutcome==='completed'?'completed':'failed';
  if(status===action.status&&turnId===action.turnId)return null;
  return {status,turnId,acceptedAt:delivery?.status==='sent'?delivery.acceptedAt:undefined,link:link(match.card,action.sourceId)};
}
function receiptMatches(receipt,action){return receipt?.messageId===action.messageId&&receipt.sourceId===action.sourceId&&receipt.ownerId===action.ownerId&&
  (receipt.delivery==='queued'||receipt.delivery==='sent'&&typeof receipt.turnId==='string'&&!!receipt.turnId.trim());}
function cancellation(messages,message){
  const text=normalize(message.text);if(!/^(?:please )?cancel (?:that|the|my) queued message(?: for .+)?$/.test(text))return null;
  const named=text.match(/ queued message for (.+)$/)?.[1];
  const prior=messages.filter(m=>m.id!==message.id&&m.text&&m.status==='completed');
  const choices=named?prior.filter(m=>m.action?.status==='queued'&&normalize(m.action.chatName)===named):prior.slice(-1).filter(m=>m.action?.status==='queued');
  return {target:choices.length===1?choices[0]:null};
}
module.exports={normalize,directRequest,proposal,request,fresh,sourceFor,link,outcome,receiptMatches,cancellation};
