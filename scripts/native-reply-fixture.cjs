'use strict';
// An isolated local pipe uses the real queue/controller with a deterministic
// Codex transport. It never touches signed-in chats, desktop writers or models.
const fs=require('node:fs'),path=require('node:path');
const {NativeControl}=require('../src/native-control.cjs');
const {Queue}=require('../src/queue.cjs');
const {Controller}=require('../src/controller.cjs');
const {Messages}=require('../src/messages.cjs');
const {Assistant}=require('../src/assistant.cjs');
const {Attachments}=require('../src/attachments.cjs');
const {nativeView,cardView}=require('../src/native-view.cjs');
const {DemoCodex,feed}=require('../src/demo.cjs');
const directory=path.resolve(process.argv[2]);fs.mkdirSync(directory,{recursive:true});
const delayOption=(flag,fallback=0)=>{const at=process.argv.indexOf(flag);return at<0?fallback:Math.min(5000,Math.max(0,Number(process.argv[at+1])||0));};
const detailsDelay=delayOption('--details-delay-ms'),sendDelay=delayOption('--send-delay-ms',250),attachDelay=delayOption('--attach-delay-ms');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const attachments=new Attachments(directory);
fs.copyFileSync(path.resolve(__dirname,'../assets/icon.png'),path.join(directory,'fixture-image.png'));
const queue=new Queue(directory);const sample=feed();
// A consecutive same-role run proves native grouping against real paint targets.
sample.threads[2].conversation=[
  {role:'user',text:'Can I compare the two layouts?'},
  {role:'assistant',text:'Need your choice between the compact and expanded queue.'},
  {role:'assistant',text:'Both previews are ready.'},
  {role:'assistant',text:'Choose the compact layout, or keep the expanded queue.'},
];
sample.threads[2].conversationLoaded=true;
if(process.argv.includes('--long-history'))for(let i=0;i<12;i++)sample.threads[2].conversation.push({role:i%2?'assistant':'user',text:'Reading history '+i+'. '+('This longer conversation verifies that returning to a chat preserves the position you were reading. '.repeat(8))});
if(process.argv.includes('--many-chats'))for(let i=10;i<16;i++)sample.threads.push({id:'10000000-0000-4000-8000-'+String(i).padStart(12,'0'),title:'Sample chat '+i,taskTitle:'Review sample context',body:'A synthetic scrolling fixture.',summary:'A synthetic scrolling fixture.',status:'unknown',lifecycle:'completed',readyForReview:false,contextLoaded:true,updatedAt:Math.floor(Date.now()/1000)-1000,fingerprint:'sample-'+i,device:{kind:'pc',label:'Windows PC'}});
sample.monitoredCount=sample.threads.length;queue.setFeed(sample);
const client=new DemoCodex(),sent=[];
client.prepare=async threadId=>{
  if(threadId.endsWith('000002')) {const error=new Error('already has an active writer');error.code=-32600;throw error;}
};
const send=client.send.bind(client);
client.send=async(threadId,text,images=[])=>{
  sent.push({threadId,text,images});fs.writeFileSync(path.join(directory,'sent.json'),JSON.stringify(sent));
  await pause(sendDelay);return send(threadId,text);
};
const controller=new Controller(queue,client);let control;
const messages=new Messages(queue,controller,{auto:false,attachments});
const assistant=new Assistant({directory,snapshot:()=>queue.snapshot(),attachments,provider:{
  async answer(input){await new Promise(resolve=>setTimeout(resolve,600));const target=input.queue.cards.find(c=>c.chatName==='Launch planning');
    return {answer:'The launch notes need your review. Here is a draft for that chat.',links:target?[{ref:target.ref,draft:'Please share the remaining launch review steps.'}]:[],model:'fixture'};},close(){}}});
const state=()=>({...messages.decorate(queue.snapshot()),assistant:assistant.snapshot()});
let uxWatch,uxOverride={},uxPaused=false,detailFailures=0;
const fixtureView=()=>({...nativeView(state()),...uxOverride});
function close(){uxWatch?.close();assistant.close();messages.close();control?.close();client.close();process.exitCode=0;}
(async()=>{
  control=await new NativeControl({directory,changed:()=>{},status:()=>({activeWriters:Math.max(client.active.size,queue.busy.size)}),quit:close,
    state:fixtureView,command:async(method,input)=>{
      if(method==='attachImages'){await pause(attachDelay);return {images:attachments.import(input.paths)};}
      if(method==='openAttachment'){attachments.resolve([input.attachmentId]);return {opened:true};}
      if(method==='assistantAsk')return assistant.ask(input);
      if(method==='assistantUse'){const result=assistant.use(input);return {...result,card:cardView(result.card,true,attachments)};}
      if(method==='details'){await pause(detailsDelay);if(detailFailures>0){detailFailures--;throw new Error('Synthetic detail failure');}return cardView(messages.decorate({cards:[queue.get(input.id,input.taskKey)]}).cards[0],true,attachments);}
      if(method==='send')return controller.send(input.id,input.text,input.sourceId,input.taskKey,{messageId:input.messageId,images:attachments.resolve(input.attachmentIds||[])});
      if(method==='queueMessage')return messages.enqueue(input);
      if(method==='clearMessages')return messages.clear(input.sourceId,input.checked);
      if(method==='action')return queue.action(input.id,input.action,input.taskKey);
      if(method==='undo')return queue.undoLast();
      if(method==='open'){queue.get(input.id,input.taskKey);return {};}
      throw new Error('Unsupported fixture action');
    }}).start();
  const publish=()=>{
    const view=fixtureView();
    fs.writeFileSync(path.join(directory,'view.json'),JSON.stringify(view));control.broadcast(view);
  };
  queue.on('change',publish);messages.on('change',publish);assistant.on('change',publish);publish();
  // Fault injection exists only in this unsigned, isolated synthetic fixture.
  // It never changes the production protocol or touches the user's chats.
  const originalSendState=control.sendState.bind(control);
  control.sendState=(socket,value)=>uxPaused?socket.destroy():originalSendState(socket,value);
  if(process.argv.includes('--ux-audit')){
    let lastId='';uxWatch=fs.watch(directory,(_,file)=>{
      if(String(file)!=='ux-command.json')return;
      let request;try{request=JSON.parse(fs.readFileSync(path.join(directory,'ux-command.json'),'utf8'));}catch{return;}
      if(!request.id||request.id===lastId)return;lastId=request.id;
      if(request.op==='disconnect'){uxPaused=true;for(const socket of control.subscribers)socket.destroy();}
      else if(request.op==='resume')uxPaused=false;
      else if(request.op==='patch')uxOverride=request.value||{};
      else if(request.op==='reset')uxOverride={};
      else if(request.op==='fail-details')detailFailures=1;
      publish();fs.writeFileSync(path.join(directory,'ux-result.json'),JSON.stringify({id:lastId,ok:true}));
    });
  }
  fs.writeFileSync(path.join(directory,'fixture-ready.json'),JSON.stringify({pid:process.pid,isolated:true,cards:queue.cards().length}));
  console.log('Isolated native reply fixture ready; no live Codex transport.');
})().catch(error=>{console.error(error.message);close();process.exitCode=1;});
