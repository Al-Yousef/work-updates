'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),asar=require('@electron/asar');
const repo=path.resolve(__dirname,'..'),root=path.join(repo,'artifacts/assistant-continuity-20261006');fs.mkdirSync(root,{recursive:true});
const installed=require('./dev-paths.cjs').installed('desktop/resources/app.asar'),stage=path.join(root,'app-'+Date.now());
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const replaced=['main.cjs','src/assistant.cjs','src/assistant-provider.cjs','src/assistant-context.cjs','src/observer.cjs','src/native-view.cjs'];
const baselineSha256=hash(fs.readFileSync(installed));asar.extractAll(installed,stage);
const sourceHashes={};for(const file of replaced){const bytes=fs.readFileSync(path.join(repo,file));sourceHashes[file]=hash(bytes);fs.mkdirSync(path.dirname(path.join(stage,file)),{recursive:true});fs.writeFileSync(path.join(stage,file),bytes);}
const metadata=JSON.parse(fs.readFileSync(path.join(stage,'package.json'),'utf8'));metadata.version='0.6.9';fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify(metadata,null,2));
(async()=>{
  const archive=path.join(root,'app.asar');await asar.createPackage(stage,archive);
  for(const file of replaced)if(hash(asar.extractFile(archive,file))!==sourceHashes[file])throw new Error('Changed source verification failed: '+file);
  let preserved=0;
  for(const raw of asar.listPackage(installed)){
    const file=raw.replaceAll('\\','/').replace(/^\//,''),nativePath=path.join(...file.split('/'));
    if(replaced.includes(file)||file==='package.json'||asar.statFile(installed,nativePath).files)continue;
    if(hash(asar.extractFile(installed,nativePath))!==hash(asar.extractFile(archive,nativePath)))throw new Error('Unrelated installed file changed: '+file);preserved++;
  }
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({built:true,version:metadata.version,sha256:hash(fs.readFileSync(archive)),baselineSha256,replaced,sourceHashes,preservedFiles:preserved,stage},null,2));
  console.log(JSON.stringify({built:true,replaced:replaced.length,preservedFiles:preserved,stage}));
})().catch(error=>{console.error(error);process.exitCode=1;});
