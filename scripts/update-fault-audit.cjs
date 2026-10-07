'use strict';
const fs=require('node:fs'),path=require('node:path'),{fixture}=require('../tests/fixtures/update-profile.cjs');
const {digest}=require('../src/update-transaction.cjs'),{atomicJSON}=require('../src/private-store.cjs');
async function audit(){
  const outcomes=[];
  for(const phase of ['prepared','staged','stopping','stopped','replacing','replaced','starting','healthy','launching']){
    const f=await fixture();try{let once=false;try{await f.transaction({checkpoint:p=>{if(p===phase&&!once){once=true;throw Object.assign(new Error('disposable interruption'),{simulatedInterruption:true});}}}).run(f.manifest);}catch(e){if(!e.simulatedInterruption)throw e;}
      const recovered=await f.transaction().recover();if(recovered.phase!=='rolled-back'||digest(f.original)!==f.manifest.components[0].baselineSha256)throw new Error('Update phase recovery failed');
      const messages=JSON.parse(fs.readFileSync(path.join(f.dataDirectory,'messages.json')));if(messages.entries[0].id!=='stable-intent')throw new Error('Retained intent changed');outcomes.push({phase,recovered:true,retainedIntent:true});
    }finally{await f.close();}
  }
  const report={schema:1,passed:true,synthetic:true,realChildProcesses:true,accountsUsed:0,modelCalls:0,codexDispatches:0,installedAppChanged:false,outcomes};
  const output=path.resolve(__dirname,'../artifacts/update-faults');fs.mkdirSync(output,{recursive:true});atomicJSON(path.join(output,'verification.json'),report);console.log(JSON.stringify(report));return report;
}
if(require.main===module)audit().catch(e=>{console.error(e.message);process.exitCode=1;});module.exports={audit};
