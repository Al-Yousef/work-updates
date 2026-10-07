'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),asar=require('@electron/asar');
const {identity,create}=require('../scripts/create-update-manifest.cjs');
const {execFileSync}=require('node:child_process'),{createTransformer}=require('app-builder-lib/out/fileTransformer.js');
const {finished}=require('node:stream/promises');
// Locked ASAR 3 returns its output stream before the final writes finish.
const pack=async (...args)=>finished(await asar.createPackage(...args),{cleanup:true});
test('archive identity reads current atomic replacement rather than cached ASAR offsets',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-asar-identity-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const archive=path.join(directory,'app.asar'),stage=path.join(directory,'stage');fs.mkdirSync(path.join(stage,'src'),{recursive:true});
  fs.writeFileSync(path.join(stage,'main.cjs'),'synthetic source');fs.copyFileSync(path.resolve(__dirname,'../src/update-compatibility.json'),path.join(stage,'src/update-compatibility.json'));
  fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify({version:'0.6.9',padding:'first'}));await pack(stage,archive);assert.equal(identity(archive).version,'0.6.9');
  fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify({version:'0.6.10-fixture',padding:'longer replacement '.repeat(50)}));const next=path.join(directory,'next.asar');await pack(stage,next);fs.renameSync(next,archive);
  assert.equal(identity(archive).version,'0.6.10-fixture');
});
test('production manifest checks the locked builder metadata transform and rejects changed packaged source',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-update-package-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const sourceRoot=path.join(directory,'source'),stage=path.join(directory,'stage');for(const root of [sourceRoot,stage])fs.mkdirSync(path.join(root,'src'),{recursive:true});
  const metadata={name:'hyphen-fixture',version:'0.6.9',main:'main.cjs',scripts:{test:'node fixture'},devDependencies:{electron:'44.5.1'},build:{asar:true}};
  for(const root of [sourceRoot,stage]){fs.writeFileSync(path.join(root,'main.cjs'),'synthetic committed main');fs.writeFileSync(path.join(root,'preload.cjs'),'synthetic committed preload');fs.writeFileSync(path.join(root,'package.json'),JSON.stringify(metadata,null,2));fs.copyFileSync(path.resolve(__dirname,'../src/update-compatibility.json'),path.join(root,'src/update-compatibility.json'));}
  const git=(...args)=>execFileSync('git',['-c','safe.directory='+sourceRoot,'-c','user.name=Hyphen fixture','-c','user.email=hyphen-fixture@users.noreply.github.com',...args],{cwd:sourceRoot,stdio:'pipe'});
  git('init');git('add','main.cjs','preload.cjs','package.json','src/update-compatibility.json');git('commit','-m','Synthetic package source');
  const transform=createTransformer(sourceRoot,metadata.build,null,null);fs.writeFileSync(path.join(stage,'package.json'),await transform(path.join(sourceRoot,'package.json')));
  const baseline=path.join(directory,'baseline.asar'),candidate=path.join(directory,'candidate.asar');await pack(stage,baseline);await pack(stage,candidate);
  const manifest=await create({baseline,candidate,output:path.join(directory,'valid'),sourceRoot});assert.equal(manifest.candidate.version,'0.6.9');assert.ok(manifest.sourceHashes['package.json']);
  fs.writeFileSync(path.join(stage,'main.cjs'),'unreviewed packaged change');await pack(stage,candidate);await assert.rejects(create({baseline,candidate,output:path.join(directory,'invalid'),sourceRoot}),/main.cjs/);assert.equal(fs.existsSync(path.join(directory,'invalid/update-manifest.json')),false);
});
