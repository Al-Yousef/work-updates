'use strict';
// Synthetic pixels in an ephemeral read-only assistant session. No real chat is messaged.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const {Assistant}=require('../src/assistant.cjs');const {Attachments}=require('../src/attachments.cjs');
const {AssistantProvider}=require('../src/assistant-provider.cjs');const {Codex}=require('../src/codex.cjs');const {DiagnosticLog}=require('../src/diagnostics.cjs');
const directory=path.resolve(process.argv[2]||'artifacts/image-live-audit');fs.mkdirSync(directory,{recursive:true});
function crc32(data){let crc=0xffffffff;for(const byte of data){crc^=byte;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunk(type,bytes){const kind=Buffer.from(type),out=Buffer.alloc(bytes.length+12);out.writeUInt32BE(bytes.length);kind.copy(out,4);bytes.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([kind,bytes])),out.length-4);return out;}
const header=Buffer.alloc(13);header.writeUInt32BE(512);header.writeUInt32BE(256,4);header[8]=8;header[9]=2;
const pixels=Buffer.alloc(256*(1+512*3));for(let y=0;y<256;y++)for(let x=0;x<512;x++){const i=y*1537+1+x*3;pixels.set(x<256?[240,32,40]:[32,80,240],i);}
const file=path.join(directory,'sample.png');fs.writeFileSync(file,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]));
const attachments=new Attachments(directory),[image]=attachments.import([file]);
const log=new DiagnosticLog(directory);
const provider=new AssistantProvider({directory:path.join(directory,'session'),timeoutMs:120000,clientFactory:()=>{
  const client=new Codex({log,requestTimeoutMs:15000});client.on('notification',m=>log.write('vision.event',{method:m.method,itemType:m.params?.item?.type,status:m.params?.turn?.status,message:m.params?.error?.message}));return client;
}});
const assistant=new Assistant({directory,attachments,provider,snapshot:()=>({cards:[],done:[],health:{ok:true},collectedAt:Math.floor(Date.now()/1000)})});
(async()=>{try {
  const ask=async input=>{assistant.ask({...input,messageId:crypto.randomUUID()});await assistant.work;const result=assistant.state.messages.at(-1);if(result.status!=='completed')throw new Error(result.error);return result;};
  const first=await ask({text:'Name the solid color on the LEFT HALF, then the solid color on the RIGHT HALF. Use exactly: Left: [color]; Right: [color].',attachmentIds:[image.id]});
  if(!/left:\s*(?:bright\s+)?red\b[^;\n]*;\s*right:\s*(?:bright\s+)?blue\b/i.test(first.answer))throw new Error('Vision answer did not identify the correct sides: '+first.answer);
  const second=await ask({text:'Which single color was on the left in the previous image?'});if(!/red/i.test(second.answer)||/blue/i.test(second.answer))throw new Error('Image follow-up did not preserve visual context: '+second.answer);
  const result={passed:true,model:first.model,imageInput:true,followUp:true,ephemeral:true,desktopChatsTouched:0,answers:[first.answer,second.answer],at:new Date().toISOString()};
  fs.writeFileSync(path.join(directory,'verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{assistant.close();}})().catch(error=>{console.error(error.message);process.exitCode=1;});
