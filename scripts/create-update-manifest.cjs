'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const asar=require('@electron/asar');
const {execFileSync}=require('node:child_process');
const {validateManifest}=require('../src/update-transaction.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function identity(archive){
  const metadata=JSON.parse(asar.extractFile(archive,'package.json'));
  const compatibility=JSON.parse(asar.extractFile(archive,'src/update-compatibility.json'));if(compatibility.schema!==1)throw new Error('Archive has no reviewed update compatibility contract');
  return {version:metadata.version,sourceHash:hash(asar.extractFile(archive,'main.cjs')),protocols:compatibility.protocols,stores:compatibility.stores};
}
function create({baseline,candidate,output,sourceRoot}){
  const target=path.resolve(output,'app.asar');
  if(target===path.resolve(baseline)||target===path.resolve(candidate)||fs.existsSync(target)||fs.existsSync(path.join(output,'update-manifest.json')))throw new Error('Use a new output directory. Packaging cannot replace an existing archive or manifest.');
  const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:sourceRoot,encoding:'utf8'}).trim();
  const changed=execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:sourceRoot,encoding:'utf8'});if(changed.trim())throw new Error('Commit the reviewed source before packaging an update');
  const sources=execFileSync('git',['ls-files','-z'],{cwd:sourceRoot,encoding:'utf8'}).split('\0').filter(f=>f==='main.cjs'||f==='preload.cjs'||f==='package.json'||/^(src|ui)\//.test(f));
  const sourceHashes={};for(const file of sources){const bytes=fs.readFileSync(path.join(sourceRoot,...file.split('/')));sourceHashes[file]=hash(bytes);if(hash(asar.extractFile(candidate,file))!==sourceHashes[file])throw new Error('Candidate archive does not match committed source: '+file);}
  const value={schema:1,product:'Hyphen',sourceRevision:revision,sourceHashes,candidate:identity(candidate),baseline:identity(baseline),components:[{role:'backend',path:'desktop/resources/app.asar',file:'app.asar',sha256:hash(fs.readFileSync(candidate)),baselineSha256:hash(fs.readFileSync(baseline))}]};
  validateManifest(value);fs.mkdirSync(output,{recursive:true});fs.copyFileSync(candidate,target,fs.constants.COPYFILE_EXCL);fs.writeFileSync(path.join(output,'update-manifest.json'),JSON.stringify(value,null,2),{flag:'wx'});return value;
}
if(require.main===module){const [baseline,candidate,output]=process.argv.slice(2);try{if(![baseline,candidate,output].every(v=>v&&path.isAbsolute(v)))throw new Error('Provide absolute baseline archive, candidate archive and output directory paths');const value=create({baseline,candidate,output,sourceRoot:path.resolve(__dirname,'..')});console.log(JSON.stringify({built:true,sourceRevision:value.sourceRevision,version:value.candidate.version}));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={create,identity};
