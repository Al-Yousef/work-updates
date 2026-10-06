'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const repo = path.resolve(__dirname,'..');
const installed = require('./dev-paths.cjs').installed('desktop/resources/app.asar');
const audit = path.join(repo,'artifacts/native-control-install');
const stage = path.join(audit,'app-' + Date.now());
fs.mkdirSync(stage,{recursive:true});
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
// Start with exactly the installed release; replace only the bridge and main.
for(const file of ['ui/app.js','ui/style.css','preload.cjs','src/queue.cjs','src/window-controller.cjs'])
  if(hash(asar.extractFile(installed,file))!==hash(fs.readFileSync(path.join(repo,file))))
    throw new Error('Installed source differs: ' + file);
asar.extractAll(installed,stage);
fs.copyFileSync(path.join(repo,'main.cjs'),path.join(stage,'main.cjs'));
fs.copyFileSync(path.join(repo,'src/native-control.cjs'),path.join(stage,'src/native-control.cjs'));
(async()=>{
  const destination=path.join(audit,'app.asar');
  await asar.createPackage(stage,destination);
  for(const file of ['main.cjs','src/native-control.cjs'])
    if(hash(asar.extractFile(destination,file))!==hash(fs.readFileSync(path.join(repo,file))))
      throw new Error('Archive verification failed: ' + file);
  fs.writeFileSync(path.join(audit,'package.json'),JSON.stringify({built:true,sha256:hash(fs.readFileSync(destination)),replaced:['main.cjs','src/native-control.cjs'],preservedInstalledRelease:true},null,2));
  console.log('Verified bridge archive prepared; installed release assets preserved.');
})().catch(error=>{console.error(error);process.exitCode=1;});
