'use strict';
const fs=require('node:fs'), path=require('node:path'), net=require('node:net');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const assert=require('node:assert/strict');
const repo=path.resolve(__dirname,'..');
const root=path.join(repo,'artifacts/native-control-install');
const stage=fs.readdirSync(root).filter(name=>name.startsWith('app-')).sort().at(-1);
const directory=path.join(root,'isolated-profile-' + Date.now());
const electron=path.join(repo,'node_modules/electron/dist/electron.exe');
const native=path.resolve(repo,'native/windows/build/Native Hover.exe');
const descriptor=path.join(directory,'native-control.info');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function status(method='status') {
  const [magic,pipe,token]=fs.readFileSync(descriptor,'utf8').split('\n');
  assert.equal(magic,'work-updates-native-v1');
  const socket=net.createConnection(pipe);socket.on('error',()=>{});
  await once(socket,'connect');const received=once(socket,'data');
  socket.write(JSON.stringify({method,token})+'\n');
  const response=JSON.parse(String((await received)[0]));socket.destroy();assert.equal(response.ok,true);
  return response.value;
}
async function waitUntil(predicate,label) {
  for(let i=0;i<200;i++){if(await predicate())return;await pause(50);}
  throw new Error(label+' timed out');
}
(async()=>{
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'state.json'),JSON.stringify({version:1,tasks:[],cards:{},done:{},groups:[],settings:{corner:true,pin:false,attention:false,aiSummaries:false}}));
  const app=spawn(electron,[path.join(root,stage),'--demo','--hidden','--data-dir',directory],{windowsHide:true,stdio:'ignore'});
  app.on('error',()=>{});const appExited=once(app,'exit');
  let client;
  try {
    await waitUntil(()=>fs.existsSync(descriptor),'isolated app startup');
    const initial=await status(); assert.equal(initial.launcherActive,true);assert.equal(initial.cornerOwner,'electron');
    client=spawn(native,['--bridge',descriptor,'--audit-exit-ms','2500'],{windowsHide:true,stdio:'ignore'});
    const nativeExited=once(client,'exit');
    await waitUntil(async()=>{return (await status()).cornerOwner==='native';},'corner ownership');
    const owned=await status(); assert.equal(owned.launcherActive,false); assert.equal(owned.cornerConfigured,true);
    const exit=await Promise.race([nativeExited,pause(5000).then(()=>{throw new Error('Native preview exit timed out');})]);
    assert.equal(exit[0],0);
    await waitUntil(async()=>{const value=await status();return value.cornerOwner==='electron'&&value.launcherActive;},'old launcher restoration');
    const restored=await status();assert.equal(restored.cornerConfigured,true);
    const saved=JSON.parse(fs.readFileSync(path.join(directory,'state.json'),'utf8')); assert.equal(saved.settings.corner,true);
    await status('quitIfIdle');
    const appExit=await Promise.race([appExited,pause(5000).then(()=>{throw new Error('Isolated app quit timed out');})]);assert.equal(appExit[0],0);
    fs.writeFileSync(path.join(root,'electron-audit.json'),JSON.stringify({passed:true,realElectron:true,realCpp:true,initial,owned,restored,preferencePreserved:true,gracefulNativeExit:true,gracefulAppQuit:true},null,2));
    console.log('Real Electron + C++: launcher removed during ownership, restored on exit, preference preserved, both exited gracefully.');
  } finally {
    if(app.exitCode===null&&fs.existsSync(descriptor))await status('quitIfIdle').catch(()=>{});
    if(client?.exitCode===null)client.kill();
    if(app.exitCode===null)app.kill(); // Only this isolated audit process, never the installed app.
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
