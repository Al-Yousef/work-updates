'use strict';
const {revision}=require('./assistant-context.cjs');
const {presentAnswer}=require('./assistant-presentation.cjs');
const clip=(text,n)=>String(text||'').toWellFormed().slice(0,n).replace(/[\uD800-\uDBFF]$/,'');
function valid(value) {
  return value&&typeof value==='object'&&!Array.isArray(value)&&
    typeof value.id==='string'&&value.id.length>0&&value.id.length<=100&&
    typeof value.text==='string'&&value.text.length<=4000&&
    typeof value.answer==='string'&&value.answer.length>0&&value.answer.length<=6000&&
    ['reply','update'].includes(value.kind)&&
    (value.imageIds===undefined||Array.isArray(value.imageIds)&&value.imageIds.length<=4&&value.imageIds.every(id=>typeof id==='string'&&id.length<=100));
}
function resolve(messages,id,snapshot) {
  const parent=messages.find(m=>m.id===id&&m.status==='completed'&&m.answer);
  if(!parent)throw new Error('That message is no longer available to reply to. Cancel the reply or choose another message. Your draft is saved.');
  const replyTo={id:parent.id,text:parent.text,answer:parent.answer,kind:parent.kind==='update'?'update':'reply',imageIds:(parent.images||[]).map(i=>i.id)};
  // A reply can ground "this chat" only in the original, unchanged source.
  // Never fall back to an unrelated last-opened chat for an explicit reply.
  const cards=[...(snapshot.cards||[]),...(snapshot.done||[])];
  const links=(parent.links||[]).filter(ref=>cards.some(c=>c.id===ref.id&&c.taskKey===ref.taskKey&&
    (c.owner?.id||'local')===ref.ownerId&&revision(c)===ref.revision&&c.sources?.some(s=>s.id===ref.sourceId)));
  return {replyTo,focus:links.length===1?{...links[0]}:null};
}
function preview(value) {
  if(!valid(value))return undefined;
  return {id:value.id,text:clip(presentAnswer(value.answer).text.replace(/\s+/g,' '),240)};
}
module.exports={valid,resolve,preview};
