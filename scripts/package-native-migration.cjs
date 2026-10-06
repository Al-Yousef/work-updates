'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const asar=require('@electron/asar');
const repo=path.resolve(__dirname,'..'),root=path.join(repo,'artifacts/native-migration');
const installed=require('./dev-paths.cjs').installed('desktop/resources/app.asar');
const stage=path.join(root,'app-'+Date.now());fs.mkdirSync(stage,{recursive:true});
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
for(const file of ['ui/app.js','ui/style.css','preload.cjs'])
  if(hash(asar.extractFile(installed,file))!==hash(fs.readFileSync(path.join(repo,file))))
    throw new Error('Installed source differs: '+file);
const replaced=['main.cjs','package.json','src/codex.cjs','src/native-control.cjs','src/native-view.cjs','src/controller.cjs','src/codex-desktop.cjs','src/messages.cjs','src/peer.cjs','src/tray.cjs','src/assistant.cjs','src/assistant-provider.cjs','src/attachments.cjs','src/queue.cjs','src/devices.cjs','bridge/collector.py'];
asar.extractAll(installed,stage);
for(const file of replaced){fs.mkdirSync(path.dirname(path.join(stage,file)),{recursive:true});fs.copyFileSync(path.join(repo,file),path.join(stage,file));}
(async()=>{
  const destination=path.join(root,'app.asar');await asar.createPackage(stage,destination);
  for(const file of replaced)if(hash(asar.extractFile(destination,file))!==hash(fs.readFileSync(path.join(repo,file))))
    throw new Error('Archive verification failed: '+file);
  fs.copyFileSync(path.join(repo,'bridge/collector.py'),path.join(root,'collector.py'));
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({built:true,sha256:hash(fs.readFileSync(destination)),collectorSha256:hash(fs.readFileSync(path.join(root,'collector.py'))),replaced,preservedInstalledRelease:true},null,2));
  console.log('Verified native backend archive and collector prepared; private queue data is preserved.');
})().catch(error=>{console.error(error);process.exitCode=1;});
