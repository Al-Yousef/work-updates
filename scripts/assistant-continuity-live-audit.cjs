'use strict';
// Real private inference; all sources and deliveries are synthetic.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {Assistant}=require('../src/assistant.cjs');
const directory=path.resolve(process.argv[2]||'artifacts/assistant-continuity-live-'+Date.now());fs.mkdirSync(directory,{recursive:true});
const state={health:{ok:true},collectedAt:Math.floor(Date.now()/1000),cards:[{
  id:'release',taskKey:'release-v1',kind:'local',chatName:'Neptune release',title:'Prepare the release',summary:'A review is pending',status:'needs',waitingOn:{kind:'you'},at:Date.now()/1000,
  owner:{id:'test-pc',name:'This PC',online:true},primarySourceId:'test-source',sources:[{id:'test-source',lifecycle:'completed',contextLoaded:true,conversationLoaded:true,
    body:'Latest release checklist is prepared.',conversation:[{role:'user',text:'Use the violet layout. Keep this release private until I approve it.'},{role:'assistant',text:'The violet layout is ready. Release approval is still waiting on you; nothing was published.'}]}],
}],done:[]};
const deliveries=[],steps=[];
const options={directory,snapshot:()=>({...state,collectedAt:Math.floor(Date.now()/1000)}),dispatch:async(mode,input)=>{deliveries.push({mode,input});return {delivery:mode==='queue'?'queued':'sent',route:'synthetic'};}};
let app=new Assistant(options);
async function ask(text){const id=crypto.randomUUID(),started=Date.now();app.ask({messageId:id,text});await app.work;
  const message=app.state.messages.find(m=>m.id===id);assert.equal(message.status,'completed',message.error);
  steps.push({question:text,answer:message.answer,model:message.model,elapsedMs:Date.now()-started});return message;}
(async()=>{try{
  await ask('For future discussion, our internal test codename is Paper Kite 47.');
  for(let i=0;i<14;i++)app.state.messages.push({id:crypto.randomUUID(),text:'Unrelated synthetic discussion '+i,answer:'Recorded.',status:'completed',at:Date.now(),links:[]});
  app.save();app.close();app=new Assistant(options);app.focus(state.cards[0],'test-source');
  const recalled=await ask('What internal test codename did I give you earlier, and what does this chat need before publishing?');
  assert.match(recalled.answer,/Paper Kite 47/i);assert.match(recalled.answer,/approv|permission|review/i);assert.equal(deliveries.length,0);
  const requested=await ask('Tell this chat to review the violet layout and report the remaining approval steps.');
  assert.match(requested.answer,/^Sent to Neptune release:/);assert.equal(deliveries.length,1);assert.equal(deliveries[0].input.sourceId,'test-source');assert.match(deliveries[0].input.text,/violet/i);
  const result={passed:true,at:new Date().toISOString(),steps,ordinaryConversationRecallAfterRestart:true,sourceTranscriptGrounding:true,explicitChatInstruction:true,syntheticDeliveries:deliveries.length,realChatsTouched:0};
  fs.writeFileSync(path.join(directory,'verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{app.close();}})().catch(error=>{fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({passed:false,error:error.message,steps},null,2));console.error(error.message);process.exitCode=1;});
