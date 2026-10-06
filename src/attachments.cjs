'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const MAX_BYTES=20*1024*1024,MAX_IMAGES=4;
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function readImage(file){
  const handle=fs.openSync(file,'r');try{
    const stat=fs.fstatSync(handle);if(!stat.isFile()||stat.size>MAX_BYTES||!stat.size)throw new Error('Each image must be smaller than 20 MB.');
    const buffer=Buffer.alloc(stat.size+1);let length=0,count;
    while(length<buffer.length&&(count=fs.readSync(handle,buffer,length,buffer.length-length,null))>0)length+=count;
    if(length!==stat.size)throw new Error('This image changed while importing. Try again.');return buffer.subarray(0,length);
  }finally{fs.closeSync(handle);}
}
function imageType(bytes){
  if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'jpg';
  if(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'webp';
  if(bytes.length>=10&&/^GIF8[79]a$/.test(bytes.toString('ascii',0,6)))return 'gif';
  throw new Error('Choose a PNG, JPEG, WebP or GIF image.');
}
function attachmentIds(input=[]){
  if(!Array.isArray(input)||input.length>MAX_IMAGES||input.some(id=>typeof id!=='string'||!/^([a-f0-9]{64})\.(png|jpg|webp|gif)$/.test(id)))throw new Error('Attach up to four valid images.');
  if(new Set(input).size!==input.length)throw new Error('This image is already attached.');
  return input;
}
function messageHash(text,ids=[]){return digest(ids.length?JSON.stringify([text,ids]):text);}
class Attachments{
  constructor(directory){this.directory=path.join(directory,'attachments');fs.mkdirSync(this.directory,{recursive:true});}
  import(paths){
    if(!Array.isArray(paths)||!paths.length||paths.length>MAX_IMAGES)throw new Error('Choose up to four images.');
    const images=paths.map(file=>{
      if(typeof file!=='string'||!path.isAbsolute(file)||file.length>32768)throw new Error('Choose an image from this computer.');
      const bytes=readImage(file);
      const type=imageType(bytes),id=digest(bytes)+'.'+type,target=path.join(this.directory,id);
      if(!fs.existsSync(target))fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});
      return {id,path:target,name:path.basename(file).slice(0,160),bytes:bytes.length};
    });
    return [...new Map(images.map(image=>[image.id,image])).values()];
  }
  resolve(ids=[]){return attachmentIds(ids).map(id=>{
    const target=path.join(this.directory,id);let bytes;try{bytes=readImage(target);}catch{throw new Error('An attached image is unavailable. Reattach it before sending.');}
    if(bytes.length>MAX_BYTES||digest(bytes)+'.'+imageType(bytes)!==id)throw new Error('An attached image changed or is unavailable. Reattach it before sending.');
    return {id,path:target,name:'Image',bytes:bytes.length};
  });}
  inputs(ids=[]){return this.resolve(ids).map(image=>({type:'localImage',path:image.path}));}
  output(paths=[]){const out=[];for(const file of paths.slice(0,8)){try{out.push(...this.import([file]));}catch{}}return out;}
}
module.exports={Attachments,attachmentIds,messageHash,MAX_BYTES,MAX_IMAGES,imageType};
