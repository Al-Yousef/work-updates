'use strict';
// Disposable installation: production ownership/control/readiness/launcher,
// synthetic chats, no collector/model/account calls or Explorer attachment.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),asar=require('@electron/asar');
const {execFileSync}=require('node:child_process');
const {packCandidate}=require('./package-transactional-update.cjs'),{identity}=require('./create-update-manifest.cjs'),{windowsHooks}=require('./update-host.cjs');
const {UpdateTransaction,digest}=require('../src/update-transaction.cjs'),{atomicJSON}=require('../src/private-store.cjs');
const root=path.resolve(__dirname,'..');
async function audit(){
  if(process.platform!=='win32')throw new Error('The packaged native update audit requires Windows');
  const output=path.join(root,'artifacts/update-runtime');fs.mkdirSync(output,{recursive:true});
  const packed=await packCandidate(path.join(output,'package'),{audit:true});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-packaged-update-')),installRoot=path.join(directory,'install'),dataDirectory=path.join(installRoot,'data/desktop'),packageDirectory=path.join(directory,'candidate');
  for(const dir of [installRoot,dataDirectory,packageDirectory])fs.mkdirSync(dir,{recursive:true});
  fs.cpSync(path.dirname(path.dirname(packed)),path.join(installRoot,'desktop'),{recursive:true});
  fs.mkdirSync(path.join(installRoot,'native'));for(const file of ['Native Hover.exe','Start Native Preview.exe'])fs.copyFileSync(path.join(root,'native/windows/build/candidate',file),path.join(installRoot,'native',file));
  const archive=path.join(installRoot,'desktop/resources/app.asar'),baselineStage=path.join(directory,'baseline-stage');asar.extractAll(archive,baselineStage);
  const metadata=JSON.parse(fs.readFileSync(path.join(baselineStage,'package.json')));metadata.version+='-baseline-fixture';atomicJSON(path.join(baselineStage,'package.json'),metadata);await asar.createPackage(baselineStage,archive);
  fs.copyFileSync(packed,path.join(packageDirectory,'app.asar'));
  const intentId='12345678-1234-1234-1234-123456789abc';
  atomicJSON(path.join(dataDirectory,'state.json'),{version:1,tasks:[],cards:{},done:{},groups:[],settings:{aiSummaries:false,corner:false}});
  atomicJSON(path.join(dataDirectory,'messages.json'),{version:1,entries:[{id:intentId,sourceId:'disposable-nonexistent-source',mode:'queue',status:'queued',text:'Synthetic retained update intent',textHash:'a'.repeat(64),createdAt:1}],barriers:{},receipts:{}});
  atomicJSON(path.join(dataDirectory,'drafts.json'),{version:3,drafts:{'disposable-nonexistent-source':'Synthetic retained draft'},intentIds:{'disposable-nonexistent-source':intentId},attachments:{}});
  const sourceRevision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const manifest={schema:1,product:'Hyphen',sourceRevision,sourceHashes:{'main.cjs':digest(path.join(root,'main.cjs'))},candidate:identity(packed),baseline:identity(archive),components:[{role:'backend',path:'desktop/resources/app.asar',file:'app.asar',sha256:digest(packed),baselineSha256:digest(archive)}]};
  const hooks=windowsHooks({installRoot,dataDirectory,demo:true});
  try{
    const make=(value=hooks)=>new UpdateTransaction({installRoot,dataDirectory,packageDirectory,sourceRoot:root,hooks:value});
    await make().run(manifest);assert.equal(digest(archive),manifest.components[0].sha256);
    const successfulHash=digest(archive),failureStage=path.join(directory,'failure-stage');asar.extractAll(archive,failureStage);
    const failureMetadata=JSON.parse(fs.readFileSync(path.join(failureStage,'package.json')));failureMetadata.version+='-startup-fixture';atomicJSON(path.join(failureStage,'package.json'),failureMetadata);await asar.createPackage(failureStage,path.join(packageDirectory,'app.asar'));
    const rollbackManifest={...manifest,baseline:manifest.candidate,candidate:identity(path.join(packageDirectory,'app.asar')),components:[{...manifest.components[0],baselineSha256:successfulHash,sha256:digest(path.join(packageDirectory,'app.asar'))}]};
    const failedHooks={...hooks,async launch(input){if(!input.baseline)throw new Error('Injected launcher failure');return hooks.launch(input);}};
    await assert.rejects(make(failedHooks).run(rollbackManifest),/Injected launcher failure/);
    assert.equal(digest(archive),successfulHash);assert.equal(JSON.parse(fs.readFileSync(path.join(dataDirectory,'update-journal.json'))).phase,'rolled-back');
    const messages=JSON.parse(fs.readFileSync(path.join(dataDirectory,'messages.json'))),drafts=JSON.parse(fs.readFileSync(path.join(dataDirectory,'drafts.json')));
    assert.equal(messages.entries[0].id,intentId);assert.equal(messages.entries[0].status,'queued');assert.equal(drafts.intentIds['disposable-nonexistent-source'],intentId);
    const runtime=JSON.parse(fs.readFileSync(path.join(dataDirectory,'runtime.json')));assert.equal(runtime.collectorPid,null);assert.equal(runtime.desktop.connected,false);assert.equal(runtime.codex.active,0);
    await hooks.stop();
    const report={schema:1,passed:true,packagedBackend:true,actualNativeLauncher:true,sourceRevision,healthyInstall:true,failedLauncherRollback:true,retainedIntentIds:true,accountsUsed:0,modelCalls:0,codexDispatches:0,collectorStarted:false,adapterAttached:false,installedAppChanged:false};
    atomicJSON(path.join(output,'verification.json'),report);console.log(JSON.stringify(report));return report;
  }finally{await hooks.stop();fs.rmSync(directory,{recursive:true,force:true});}
}
if(require.main===module)audit().catch(e=>{console.error(e.stack);process.exitCode=1;});module.exports={audit};
