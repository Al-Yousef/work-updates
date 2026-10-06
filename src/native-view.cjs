'use strict';
// The native view is a projection, never another queue or writer owner.
const crypto=require('node:crypto');
const path=require('node:path');
const clipped = (value, limit) => {
  const text = String(value ?? '').toWellFormed();
  let end = Math.min(limit, text.length);
  if (end && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end);
};
function sourceMessage(message,attachments) {
  const raw=String(message.text||''),refs=[...(message.images||[]).map(image=>typeof image==='string'?image:image.path)];
  const text=raw.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,(_,caption,file)=>{const ref=file.replace(/^<|>$/g,'');if(path.isAbsolute(ref))refs.push(ref);return caption;});
  return {role:message.role==='user'?'user':'assistant',text:clipped(text,6000),images:attachments?attachments.output([...new Set(refs)]):[]};
}
function cardView(card, details = false, attachments) {
  const keys = ['id', 'taskKey', 'kind', 'status', 'primarySourceId', 'at', 'reviewed',
    'snoozed', 'snoozedUntil', 'done', 'urgent', 'readyForReview', 'summaryOrigin','queuedMessages'];
  return {
    ...Object.fromEntries(keys.filter(key => card[key] !== undefined).map(key => [key, card[key]])),
    chatName: clipped(card.chatName, 180), title: clipped(card.title, 240),
    summary: clipped(card.summary, 600), label: clipped(card.label, 160),
    device: card.device, waitingOn: card.waitingOn,
    owner: card.owner && {local:card.owner.local, online:card.owner.online, name:card.owner.name},
    sources: (card.sources || []).slice(0, 32).map(source => ({
      id: source.id, title: clipped(source.title, 180), contextLoaded: !!source.contextLoaded,
      conversationLoaded:!!source.conversationLoaded,
      contextRevision:crypto.createHash('sha256').update(JSON.stringify([source.body,source.conversation])).digest('hex').slice(0,16),
      lifecycle:source.lifecycle, queuedMessages:source.queuedMessages||0, deliveryIssue:clipped(source.deliveryIssue,300),
      ...(details ? {body: clipped(source.body, 16000),
        conversation:(source.conversation||[]).slice(-12).map(m=>sourceMessage(m,card.owner?.local!==false?attachments:undefined)),
        messageQueue:(source.messageQueue||[]).slice(0,8).map(m=>({id:m.id,status:m.status,text:clipped(m.text,1500),error:clipped(m.error,300)}))} : {}),
    })),
  };
}
function nativeView(state) {
  return {
    schema: 1, cards: (state.cards || []).slice(0, 500).map(card => cardView(card)),
    done: (state.done || []).slice(0, 500).map(card => cardView(card)),
    truncated: (state.cards?.length || 0) > 500 || (state.done?.length || 0) > 500,
    monitoredCount: state.monitoredCount, ready: state.ready, working: state.working,
    health: state.health && {ok:state.health.ok, message:state.health.message},
    aiSummary: state.aiSummary, undo: !!state.undo,
    settings: {queueSince: state.settings?.queueSince || 0},
    connection: state.connection, version: state.version,
    connectionHealth:state.connectionHealth,
    assistant: state.assistant && {...state.assistant,messages:state.assistant.messages.slice(-30).map(m=>({
      id:m.id,text:clipped(m.text,4000),answer:clipped(m.answer,6000),status:m.status,error:clipped(m.error,300),at:m.at,images:m.images||[],
      links:(m.links||[]).slice(0,3).map(link=>({index:link.index,chatName:clipped(link.chatName,180),hasDraft:!!link.draft}))
    }))},
  };
}
module.exports = {nativeView, cardView};
