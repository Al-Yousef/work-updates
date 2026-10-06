'use strict';
// Private ephemeral inference with synthetic data. No desktop chat is resumed or messaged.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Assistant}=require('../src/assistant.cjs');
const directory=path.resolve(process.argv[2]||'artifacts/assistant-live-'+Date.now());fs.mkdirSync(directory,{recursive:true});
const base={kind:'observed',at:Math.floor(Date.now()/1000),owner:{id:'local-test',name:'This PC',online:true},reviewed:false,done:false,snoozed:false};
const snapshot={cards:[
  {...base,id:'you',taskKey:'you-v1',chatName:'Release review',title:'Approve a prepared release',summary:'A tested draft is ready for the user to review. It is not published.',status:'needs',urgent:true,waitingOn:{kind:'you'},primarySourceId:'release',sources:[{id:'release',lifecycle:'completed'}]},
  {...base,id:'other',taskKey:'other-v1',chatName:'Design feedback',title:'Await design feedback',summary:'Waiting on Morgan to review the design.',status:'waiting',waitingOn:{kind:'other',name:'Morgan'},primarySourceId:'design',sources:[{id:'design',lifecycle:'completed'}]},
],done:[],health:{ok:true},collectedAt:Math.floor(Date.now()/1000),monitoredCount:2};
const app=new Assistant({directory,snapshot:()=>snapshot});
(async()=>{try {
  const ask=async text=>{app.ask({messageId:crypto.randomUUID(),text});await app.work;
    const message=app.state.messages.at(-1);if(message.status!=='completed')throw new Error(message.error);return message;};
  app.ask({messageId:crypto.randomUUID(),text:'Remember that I prefer concise updates.'});
  const first=await ask('What needs me right now? Distinguish waiting on me from waiting on Morgan, and link the release review.');
  const second=await ask('Draft a short message for that release chat asking for the remaining review steps. Include its related update with the draft.');
  if(!first.answer.includes('Morgan')||!first.links.some(l=>l.id==='you'))throw new Error('Assistant did not ground the priority answer.');
  const link=second.links.find(l=>l.id==='you'&&l.draft.trim());if(!link)throw new Error('Assistant did not ground its follow-up draft.');
  const used=app.use({messageId:second.id,index:second.links.indexOf(link)});if(used.sourceId!=='release')throw new Error('Draft routing mismatch.');
  const result={passed:true,model:second.model,questions:2,memorySaved:true,historyFollowUp:true,exactSourceDraft:true,ephemeral:true,desktopChatsTouched:0,
    answer:first.answer,draft:link.draft,at:new Date().toISOString()};
  fs.writeFileSync(path.join(directory,'verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {app.close();}})().catch(error=>{console.error(error.message);process.exitCode=1;});
