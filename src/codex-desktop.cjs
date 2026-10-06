'use strict';
const net=require('node:net'),crypto=require('node:crypto'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const versions={'initialize':0,'thread-owner-discovery':1,'thread-follower-start-turn':2,'thread-follower-steer-turn':1};
function frame(value){const data=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(4);header.writeUInt32LE(data.length);return Buffer.concat([header,data]);}
class DesktopError extends Error {
  constructor(message,code,delivery='not-sent',phase=delivery==='uncertain'?'awaiting-receipt':'ownership-discovery'){super(message);this.code=code;this.delivery=delivery;this.phase=phase;this.route='desktop';}
}
// This is the installed desktop's existing same-user coordination channel.
// Never claim ownership, resume a desktop thread, intercept stdio, or retry a
// mutation after an uncertain result. This adapter is versioned and bounded.
class CodexDesktop extends EventEmitter {
  constructor(options={}){super();this.options=options;this.pending=new Map();this.socket=null;this.connecting=null;this.clientId=null;}
  log(event,fields,context=null){this.options.log?.write(event,fields,{context});}
  status(){return {connected:!!this.socket&&!this.socket.destroyed&&!!this.clientId,pending:this.pending.size};}
  async connect(){
    if(this.socket&&!this.socket.destroyed&&this.clientId)return;
    if(this.connecting)return this.connecting;
    this.connecting=(async()=>{
      const address=this.options.address||(process.platform==='win32'?'\\\\.\\pipe\\codex-ipc':path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'ipc/ipc.sock'));
      const socket=this.socket=net.createConnection(address);let buffer=Buffer.alloc(0),skip=0;
      socket.on('data',chunk=>{
        if(skip){const count=Math.min(skip,chunk.length);skip-=count;chunk=chunk.subarray(count);}
        if(!chunk.length)return;buffer=Buffer.concat([buffer,chunk]);
        while(buffer.length>=4){
          const size=buffer.readUInt32LE(0);
          if(size===0||size>268435456){socket.destroy(new Error('Invalid desktop frame'));return;}
          // Large unrelated stream snapshots are discarded without buffering
          // their conversation text. Replies to our bounded commands are small.
          if(size>1024*1024){const available=Math.min(size,buffer.length-4);skip=size-available;buffer=buffer.subarray(4+available);if(skip)return;continue;}
          if(buffer.length<size+4)return;
          const body=buffer.subarray(4,size+4);buffer=buffer.subarray(size+4);
          try{this.receive(JSON.parse(body.toString('utf8')),socket);}catch{socket.destroy(new Error('Invalid desktop response'));return;}
        }
      });
      socket.on('error',()=>{});
      socket.on('close',()=>{
        if(this.socket!==socket)return;this.socket=null;this.clientId=null;
        for(const [id,call] of this.pending){clearTimeout(call.timer);this.pending.delete(id);
          this.log('desktop.rpc.disconnected',{requestId:id,method:call.method,threadId:call.threadId,phase:call.mutation?'awaiting-receipt':'ownership-discovery',code:'DESKTOP_DISCONNECTED',delivery:call.mutation?'uncertain':'not-sent'},call.context);
          call.reject(new DesktopError('Codex disconnected before confirming this request. Check the chat before retrying.','DESKTOP_DISCONNECTED',call.mutation?'uncertain':'not-sent'));}
        this.log('desktop.disconnected',{});
      });
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{socket.destroy();reject(new DesktopError('Open Codex to connect Hyphen.','DESKTOP_UNAVAILABLE'));},this.options.connectTimeoutMs||2500);
        socket.once('connect',()=>{clearTimeout(timer);resolve();});socket.once('error',()=>{clearTimeout(timer);reject(new DesktopError('Open Codex to connect Hyphen.','DESKTOP_UNAVAILABLE'));});
      });
      const response=await this.request('initialize',{clientType:'hyphen'},{timeoutMs:3000});
      this.clientId=response.result?.clientId;if(!this.clientId)throw new DesktopError('Codex did not initialize the Hyphen connection.','DESKTOP_PROTOCOL');
      this.log('desktop.connected',{clientId:this.clientId});
    })();
    try{await this.connecting;}catch(error){this.socket?.destroy();throw error;}finally{this.connecting=null;}
  }
  receive(message,socket){
    if(message.type==='client-discovery-request'){
      socket.write(frame({type:'client-discovery-response',requestId:message.requestId,response:{canHandle:false}}));return;
    }
    if(message.type!=='response')return;
    const call=this.pending.get(message.requestId);if(!call)return;
    clearTimeout(call.timer);this.pending.delete(message.requestId);
    if(message.resultType!=='success'){
      const reason=String(message.error||'Desktop request failed');
      const code=reason==='no-client-found'?'DESKTOP_NO_OWNER':reason.includes('timeout')?'DESKTOP_TIMEOUT':'DESKTOP_REJECTED';
      // Router-level absence is definitely unsent. Other forwarded errors can
      // hide a lost app-server acknowledgement, so fail conservatively.
      const definitelyUnsent=code==='DESKTOP_NO_OWNER'||/no active turn to steer|not being streamed|not found|invalid (?:params|request)|already.*in progress/i.test(reason);
      call.reject(new DesktopError(reason,code,call.mutation&&!definitelyUnsent?'uncertain':'not-sent',call.mutation?'awaiting-receipt':'ownership-discovery'));
      this.log('desktop.rpc.failed',{requestId:message.requestId,method:call.method,threadId:call.threadId,code,phase:call.mutation?'awaiting-receipt':'ownership-discovery',delivery:call.mutation&&!definitelyUnsent?'uncertain':'not-sent'},call.context);return;
    }
    if(message.method!==call.method||(call.targetClientId&&message.handledByClientId!==call.targetClientId)){
      call.reject(new DesktopError('Codex returned a mismatched delivery receipt. Check chat before retrying.','DESKTOP_RECEIPT',call.mutation?'uncertain':'not-sent'));return;
    }
    this.log('desktop.rpc.accepted',{requestId:message.requestId,method:call.method,threadId:call.threadId,ownerId:message.handledByClientId,responseBytes:Buffer.byteLength(JSON.stringify(message))},call.context);call.resolve(message);
  }
  request(method,params,{targetClientId,mutation=false,timeoutMs=10000}={}){
    const requestId=crypto.randomUUID(),version=versions[method];
    const context={...this.options.log?.capture?.(),...(params.clientUserMessageId?{messageId:params.clientUserMessageId}:{}),sourceId:params.conversationId};
    if(version===undefined)throw new DesktopError('Unsupported desktop command.','DESKTOP_PROTOCOL');
    return new Promise((resolve,reject)=>{
      if(!this.socket||this.socket.destroyed)return reject(new DesktopError('Codex is unavailable.','DESKTOP_UNAVAILABLE'));
      const timer=setTimeout(()=>{this.pending.delete(requestId);this.log('desktop.rpc.timeout',{requestId,method,threadId:params.conversationId,phase:mutation?'awaiting-receipt':'ownership-discovery',code:'DESKTOP_TIMEOUT',delivery:mutation?'uncertain':'not-sent',timeoutMs},context);reject(new DesktopError('Codex did not confirm delivery. Check chat before retrying.','DESKTOP_TIMEOUT',mutation?'uncertain':'not-sent'));},timeoutMs);
      this.pending.set(requestId,{resolve,reject,timer,method,targetClientId,mutation,threadId:params.conversationId,context});
      this.log('desktop.rpc.started',{requestId,method,threadId:params.conversationId,targetClientId,phase:mutation?'awaiting-receipt':'ownership-discovery',pending:this.pending.size},context);
      try{this.socket.write(frame({type:'request',requestId,method,params,version,...(targetClientId?{targetClientId}:{})}));}
      catch(error){clearTimeout(timer);this.pending.delete(requestId);reject(new DesktopError(error.message,'DESKTOP_WRITE',mutation?'uncertain':'not-sent'));}
    });
  }
  async owner(threadId){
    await this.connect();
    try{return (await this.request('thread-owner-discovery',{hostId:'local',conversationId:threadId})).handledByClientId;}
    catch(error){if(error.code==='DESKTOP_NO_OWNER')return null;throw error;}
  }
  async send(threadId,text,{owner,working=false,messageId=crypto.randomUUID(),images=[]}={}){
    await this.connect();
    const target=owner||await this.owner(threadId);
    if(!target)throw new DesktopError('Codex has no available owner for this chat.','DESKTOP_NO_OWNER');
    const input=[...(text?[{type:'text',text,text_elements:[]}]:[]),...images.map(image=>({type:'localImage',path:image.path}))];
    const method=working?'thread-follower-steer-turn':'thread-follower-start-turn';
    const params=working?{conversationId:threadId,input,clientUserMessageId:messageId,attachments:[],
      restoreMessage:{id:messageId,text,createdAt:Date.now(),context:{prompt:text,addedFiles:[],fileAttachments:[],ideContext:null,imageAttachments:[],workspaceRoots:[]}}}:
      {conversationId:threadId,turnStart:{request:{threadId,input,clientUserMessageId:messageId},context:{inheritThreadSettings:true}}};
    const response=await this.request(method,params,{targetClientId:target,mutation:true,timeoutMs:this.options.sendTimeoutMs||120000});
    const receipt=response.result?.result;
    const turnId=working?receipt?.turnId:receipt?.turn?.id;
    if(!turnId)throw new DesktopError('Codex returned no delivery receipt. Check the chat before retrying.','DESKTOP_RECEIPT','uncertain');
    return {messageId,route:'desktop',delivery:'sent',turnId};
  }
  close(){this.socket?.destroy();}
}
module.exports={CodexDesktop,DesktopError,frame};
