'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {atomicJSON}=require('./private-store.cjs');
const identity=v=>typeof v==='string'&&v.length>0&&v.length<=200;
const held=()=>new Error('Hyphen’s saved Codex chat needs recovery. Its identity is preserved; no new message was sent.');
class AssistantSession {
  constructor(directory){
    this.file=path.join(directory,'session.json');this.state={version:1,threadId:null,pending:null};this.disk=null;
    if(fs.existsSync(this.file)){
      const stat=fs.lstatSync(this.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw held();
      const bytes=fs.readFileSync(this.file);this.disk=this.hash(bytes);
      try{this.state=JSON.parse(bytes);this.validate();}catch{throw held();}
    }
  }
  hash(bytes){return crypto.createHash('sha256').update(bytes).digest('hex');}
  validate(){const s=this.state;if(s.version!==1||!(s.threadId===null||identity(s.threadId))||
    !(s.pending===null||s.threadId&&identity(s.pending.messageId)&&(s.pending.turnId===null||identity(s.pending.turnId)))||
    s.deleting!==undefined&&typeof s.deleting!=='boolean')throw held();}
  save(change){
    const disk=fs.existsSync(this.file)?this.hash(fs.readFileSync(this.file)):null;if(disk!==this.disk)throw held();
    const prior=structuredClone(this.state);try{change(this.state);this.validate();atomicJSON(this.file,this.state);this.disk=this.hash(fs.readFileSync(this.file));}
    catch(error){this.state=prior;throw error;}
  }
  async prepare(client,params){
    if(this.state.deleting){await client.call('thread/delete',{threadId:this.state.threadId});this.save(s=>{s.threadId=null;s.pending=null;delete s.deleting;});}
    let result;
    const resumeSaved=async()=>{
      const {dynamicTools,...resume}=params;
      try{return await client.call('thread/resume',{...resume,threadId:this.state.threadId});}
      catch(error){
        // A new human question may reopen this exact owned chat. Missing or
        // deleted history still fails closed; never create a replacement.
        if(error.delivery==='not-sent'&&error.message.startsWith('session '+this.state.threadId+' is archived.')){
          await client.call('thread/unarchive',{threadId:this.state.threadId});
          return client.call('thread/resume',{...resume,threadId:this.state.threadId});
        }
        if(/already has an active writer/.test(error.message))throw new Error('Hyphen’s Codex chat is open in another writer. Close that chat in Codex, then try again. Your message was not sent.');
        throw error;
      }
    };
    if(this.state.threadId){
      let read=await client.call('thread/read',{threadId:this.state.threadId,includeTurns:!!this.state.pending}),resumed=false;
      if(read.thread?.id!==this.state.threadId||read.thread.ephemeral!==false)throw held();
      if(read.thread.status?.type==='active')throw new Error('Hyphen’s Codex chat is still working. Wait for that pass to finish before sending again.');
      if(this.state.pending){
        const pending=this.state.pending,match=thread=>(thread.turns||[]).find(t=>pending.turnId?t.id===pending.turnId:
          (t.items||[]).some(i=>i.type==='userMessage'&&(i.id===pending.messageId||JSON.stringify(i).includes(pending.messageId))));
        let turn=match(read.thread);
        // Loading an unloaded chat reconciles an interrupted persisted pass;
        // it does not start inference or repeat its message.
        if(turn?.status==='inProgress'&&read.thread.status?.type==='notLoaded'){
          result=await resumeSaved();resumed=true;
          if(result.thread?.id!==this.state.threadId||result.thread.ephemeral!==false||result.thread.status?.type==='active')throw held();
          read=await client.call('thread/read',{threadId:this.state.threadId,includeTurns:true});
          if(read.thread?.id!==this.state.threadId||read.thread.ephemeral!==false||read.thread.status?.type==='active')throw held();turn=match(read.thread);
        }
        if(!turn||!['completed','failed','interrupted'].includes(turn.status))throw held();
        this.save(s=>s.pending=null);
      }
      if(!resumed)result=await resumeSaved();
      if(result.thread?.id!==this.state.threadId)throw held();
    }else{
      result=await client.call('thread/start',{...params,ephemeral:false});
      if(!identity(result.thread?.id)||result.thread.ephemeral!==false)throw new Error('Hyphen could not create its continuing Codex chat.');
      this.save(s=>s.threadId=result.thread.id);
      await client.call('thread/name/set',{threadId:result.thread.id,name:'Hyphen'});
    }
    if(result.thread.ephemeral!==false)throw held();return result.thread.id;
  }
  dispatch(messageId){if(this.state.pending)throw held();this.save(s=>s.pending={messageId,turnId:null});}
  accepted(turnId){if(!identity(turnId)||!this.state.pending||this.state.pending.turnId&&this.state.pending.turnId!==turnId)throw held();this.save(s=>s.pending.turnId=turnId);}
  complete(turnId){if(!this.state.pending||this.state.pending.turnId!==turnId)throw held();this.save(s=>s.pending=null);}
  async forget(client){
    if(!this.state.threadId)return;
    if(this.state.pending)throw new Error('Hyphen’s Codex pass needs reconciliation before its history can be removed.');
    this.save(s=>s.deleting=true);
    await client.call('thread/delete',{threadId:this.state.threadId});
    this.save(s=>{s.threadId=null;delete s.deleting;});
  }
}
module.exports={AssistantSession};
