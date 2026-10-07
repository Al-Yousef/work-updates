'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {configuration,verify,sourceId,draft}=require('../scripts/native-physical-contract.cjs');
const {run}=require('../scripts/native-qa-runner.cjs');
const root=path.resolve(__dirname,'..'),revision='a'.repeat(40),chatId='10000000-0000-4000-8000-000000000099';
function temp(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-physical-contract-'));t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});return directory;}
function proof(){return {schema:1,sourceRevision:revision,chatId,nativePid:345,accountsUsed:0,modelCalls:0,installedAppChanged:false,
  evidence:'separate_cursor_owned_synthetic_native_controls',inputBackend:'private_input_v2',processIdentityPreserved:true,passed:true,
  checks:['source_selection','unicode_draft_readback','draft_preserved_after_navigation','exactly_once_synthetic_delivery','panel_hidden','owned_input_released'],
  sent:[{threadId:sourceId,text:draft,images:[]}],desktop:{independentOfTargetAndCursorProcesses:true,unchanged:true,samples:60,durationMs:300,maximumGapMs:8,betweenSamplesUnverified:true}};}
test('configuration never accepts implicit legacy or another chat namespace',t=>{
  const directory=temp(t),cursor=path.join(directory,'agent_cli.py');fs.writeFileSync(cursor,'# source fixture');
  const env={HYPHEN_PHYSICAL_INPUT:'separate-cursor',CODEX_THREAD_ID:chatId,HYPHEN_CURSOR_CLI:cursor};
  assert.equal(configuration(env).chatId,chatId);
  for(const field of Object.keys(env))assert.throws(()=>configuration({...env,[field]:''}));
  assert.throws(()=>configuration({...env,CODEX_THREAD_ID:'legacy'}));
  assert.throws(()=>configuration({...env,HYPHEN_CURSOR_CLI:directory}));
});
test('readback contract rejects duplicate or redirected delivery, stale ownership and desktop gaps',()=>{
  assert.equal(verify(proof(),revision,chatId,345).passed,true);
  const mutate=[p=>p.sent.push(p.sent[0]),p=>p.sent[0].threadId=chatId,p=>p.sent[0].text+='changed',
    p=>p.chatId=sourceId,p=>p.sourceRevision='b'.repeat(40),p=>p.nativePid=346,p=>p.processIdentityPreserved=false,
    p=>p.accountsUsed=1,p=>p.inputBackend='foreground_messages',p=>p.checks.pop(),p=>p.desktop.unchanged=false,
    p=>p.desktop.maximumGapMs=51,p=>p.desktop.maximumGapMs=Infinity,p=>p.desktop.samples=1,
    p=>p.desktop.independentOfTargetAndCursorProcesses=false,p=>p.desktop.betweenSamplesUnverified=false];
  for(const change of mutate){const value=proof();change(value);assert.throws(()=>verify(value,revision,chatId,345));}
  assert.throws(()=>verify(proof(),revision,chatId,null));
});
test('clean physical candidate is required before any command even with explicit configuration',async t=>{
  let calls=0;const report=await run({root,directory:path.join(temp(t),'run'),lanes:['physical'],revision,
    physicalConfiguration:()=>({chatId}),verifyCandidate:()=>({revision,dirty:true,binaryHashes:{}}),
    executeCase:async()=>{calls++;return {status:'passed',cleanup:'normal_exit',exitObserved:true};}});
  assert.equal(calls,0);assert.equal(report.lanes[0].reason,'fresh_clean_native_candidate_required');
});
test('a successful child cannot qualify physical input without independent current-candidate proof',async t=>{
  const report=await run({root,directory:path.join(temp(t),'run'),lanes:['physical'],revision,
    physicalConfiguration:()=>({chatId}),verifyCandidate:()=>({revision,dirty:false,binaryHashes:{}}),
    executeCase:async()=>({status:'passed',cleanup:'normal_exit',exitObserved:true})});
  assert.equal(report.passed,false);assert.equal(report.lanes[0].cases[0].reason,'independent_physical_proof_required');
});
