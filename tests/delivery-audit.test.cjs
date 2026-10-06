'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const run=promisify(execFile),script=path.resolve(__dirname,'../scripts/delivery-contract-audit.cjs');
test('disposable audit handles acceptance before turn-start notification without using an account',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-audit-ordering-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const {stdout}=await run(process.execPath,[script,'--synthetic','--output='+directory],{timeout:15000});const report=JSON.parse(stdout);
  assert.equal(report.passed,true);assert.equal(report.actualModelTurns,0);assert.equal(report.createdChats,0);
  assert.equal(report.dispatches,4);assert.equal(report.originalUserMessagesVerified,4);assert.match(report.limits,/Synthetic transport only/);
});
