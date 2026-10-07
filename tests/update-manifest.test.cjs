'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),asar=require('@electron/asar');
const {identity}=require('../scripts/create-update-manifest.cjs');
test('archive identity reads current atomic replacement rather than cached ASAR offsets',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-asar-identity-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const archive=path.join(directory,'app.asar'),stage=path.join(directory,'stage');fs.mkdirSync(path.join(stage,'src'),{recursive:true});
  fs.writeFileSync(path.join(stage,'main.cjs'),'synthetic source');fs.copyFileSync(path.resolve(__dirname,'../src/update-compatibility.json'),path.join(stage,'src/update-compatibility.json'));
  fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify({version:'0.6.9',padding:'first'}));await asar.createPackage(stage,archive);assert.equal(identity(archive).version,'0.6.9');
  fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify({version:'0.6.10-fixture',padding:'longer replacement '.repeat(50)}));const next=path.join(directory,'next.asar');await asar.createPackage(stage,next);fs.renameSync(next,archive);
  assert.equal(identity(archive).version,'0.6.10-fixture');
});
