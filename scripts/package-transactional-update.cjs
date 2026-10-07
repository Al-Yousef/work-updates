'use strict';
const path=require('node:path'),fs=require('node:fs'),builder=require('electron-builder');
const {create}=require('./create-update-manifest.cjs');
const sourceRoot=path.resolve(__dirname,'..');
async function packCandidate(output,{audit=false}={}){
  if(!path.isAbsolute(output))throw new Error('Use an absolute package output directory');
  if(!audit&&!fs.existsSync(path.join(sourceRoot,'build/helper/collector.exe')))throw new Error('Build the verified collector before creating a production update package');
  await builder.build({projectDir:sourceRoot,publish:'never',targets:builder.Platform.WINDOWS.createTarget(['dir'],builder.Arch.x64),config:{directories:{output},...(audit?{extraResources:[]}:{}),publish:null}});
  return path.join(output,'win-unpacked/resources/app.asar');
}
async function main(args=process.argv.slice(2)){
  const [baseline,output]=args;if(![baseline,output].every(v=>v&&path.isAbsolute(v)))throw new Error('Provide absolute reviewed baseline archive and package output directory paths');
  const candidate=await packCandidate(path.join(output,'candidate')),value=create({baseline,candidate,output,sourceRoot});
  console.log(JSON.stringify({built:true,version:value.candidate.version,sourceRevision:value.sourceRevision}));
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exit(1);});
module.exports={main,packCandidate};
