'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const assert = require('node:assert/strict');
const {NativeControl} = require('../src/native-control.cjs');
const directory = path.resolve(__dirname,'../artifacts/native-bridge-audit');
const executable = path.resolve(__dirname,'../native/windows/build/Native Hover.exe');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const changes=[];
  let control=await new NativeControl({directory,changed:value=>changes.push(value),status:()=>({activeWriters:0}),quit:()=>{}}).start();
  let child;
  try {
    child=spawn(executable,['--bridge',control.file],{windowsHide:true,stdio:'ignore'});
    const exited=once(child,'exit');
    for(let i=0;i<100&&!control.claimed;i++) await pause(50);
    assert.equal(control.claimed,true,'real C++ client must own the corner');
    await pause(500);
    const trace=fs.readFileSync(path.join(path.dirname(executable),'artifacts/native-hover.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert(trace.some(e=>e.event==='started'&&e.cornerCoordinated));
    control.close();
    const exit=await Promise.race([exited,pause(5000).then(()=>{throw new Error('Native client did not close after server loss');})]);
    assert.equal(exit[0],0);
    control=await new NativeControl({directory,changed:value=>changes.push(value),status:()=>({activeWriters:0}),quit:()=>{}}).start();
    child=spawn(executable,['--bridge',control.file],{windowsHide:true,stdio:'ignore'});
    const crashed=once(child,'exit');
    for(let i=0;i<100&&!control.claimed;i++) await pause(50);
    assert.equal(control.claimed,true);
    child.kill(); await crashed;
    for(let i=0;i<100&&control.claimed;i++) await pause(50);
    assert.equal(control.claimed,false,'native process death must release ownership');
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({passed:true,cppHandshake:true,serverLossClosesNative:true,nativeCrashReleasesCorner:true,changes},null,2));
    console.log('Real C++ pipe handshake, server-loss shutdown, and native-crash recovery passed.');
  } finally {if(child?.exitCode===null)child.kill();control.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
