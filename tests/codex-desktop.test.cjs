'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {CodexDesktop,frame}=require('../src/codex-desktop.cjs');
async function fixture(t,handler){
  const address=process.platform==='win32'?'\\\\.\\pipe\\hyphen-test-'+crypto.randomUUID():path.join(os.tmpdir(),'hyphen-'+crypto.randomUUID()+'.sock');
  const sockets=new Set(),server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4){const length=buffer.readUInt32LE();if(buffer.length<length+4)return;
      const request=JSON.parse(buffer.subarray(4,length+4));buffer=buffer.subarray(length+4);if(request.type!=='request')continue;
      if(request.method==='initialize')socket.write(frame({type:'response',requestId:request.requestId,resultType:'success',method:request.method,result:{clientId:'hyphen-test'}}));
      else handler(request,socket);
    }});
  });await new Promise(resolve=>server.listen(address,resolve));const client=new CodexDesktop({address,sendTimeoutMs:40});
  t.after(()=>{client.close();for(const socket of sockets)socket.destroy();server.close();});return client;
}
function respond(request,socket,result,owner='desktop-owner'){socket.write(frame({type:'response',requestId:request.requestId,method:request.method,resultType:'success',handledByClientId:owner,result}));}
test('desktop routes idle and active replies to their exact owner and validates receipts',async t=>{
  const seen=[];const c=await fixture(t,(r,s)=>{seen.push(r);respond(r,s,r.method==='thread-owner-discovery'?{}:{result:r.method==='thread-follower-start-turn'?{turn:{id:'new-turn'}}:{turnId:'active-turn'}});});
  const owner=await c.owner('chat-a');assert.equal(owner,'desktop-owner');
  const idle=await c.send('chat-a','Test',{owner,messageId:'message-a'});assert.equal(idle.turnId,'new-turn');
  const active=await c.send('chat-a','Steer',{owner,working:true});assert.equal(active.turnId,'active-turn');
  assert.equal(seen[1].targetClientId,owner);assert.equal(seen[1].version,2);assert.equal(seen[1].params.turnStart.request.clientUserMessageId,'message-a');
  assert.deepEqual(seen[2].params.restoreMessage.context.workspaceRoots,[]);assert.equal(seen[2].version,1);
  assert.deepEqual(seen[2].params.input[0].text_elements,[]);
});
test('lost acknowledgements and mismatched receipts are uncertain and never retried',async t=>{
  let count=0;const c=await fixture(t,(r,s)=>{count++;if(count===2)respond(r,s,{result:{turn:{id:'t'}}},'wrong-owner');});
  await assert.rejects(c.send('chat','Test',{owner:'desktop-owner'}),e=>e.code==='DESKTOP_TIMEOUT'&&e.delivery==='uncertain');assert.equal(count,1);
  await assert.rejects(c.send('chat','Test',{owner:'desktop-owner'}),e=>e.code==='DESKTOP_RECEIPT'&&e.delivery==='uncertain');assert.equal(count,2);
});
test('explicit owner absence does not send a reply',async t=>{
  const c=await fixture(t,(r,s)=>s.write(frame({type:'response',requestId:r.requestId,resultType:'error',error:'no-client-found'})));
  assert.equal(await c.owner('chat'),null);await assert.rejects(c.send('chat','Test'),e=>e.code==='DESKTOP_NO_OWNER'&&e.delivery==='not-sent');
});
test('idle and active desktop image replies retain image inputs and the exact destination owner',async t=>{
  const seen=[],c=await fixture(t,(r,s)=>{seen.push(r);respond(r,s,{result:r.method==='thread-follower-start-turn'?{turn:{id:'image-turn'}}:{turnId:'image-turn'}});});
  const images=[{path:'C:/private/image.png'}];
  await c.send('image-chat','',{owner:'desktop-owner',images});
  await c.send('image-chat','Look at this',{owner:'desktop-owner',images,working:true});
  assert.deepEqual(seen[0].params.turnStart.request.input,[{type:'localImage',path:images[0].path}]);
  assert.equal(seen[1].params.input[1].path,images[0].path);assert.equal(seen[1].params.conversationId,'image-chat');
  assert.equal(seen[1].targetClientId,'desktop-owner');
});
