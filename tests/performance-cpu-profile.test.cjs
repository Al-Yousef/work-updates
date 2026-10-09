'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {summarizeProfile}=require('../scripts/performance-cpu-profile.cjs');
const repo=path.resolve(__dirname,'..'),tracked=new Set(['main.cjs']);
function profile(){return {startTime:0,endTime:2000000,timeDeltas:[1000,2000,3000],samples:[3,3,4],nodes:[
  {id:1,callFrame:{functionName:'(root)',url:''},children:[2,4]},
  {id:2,callFrame:{functionName:'snapshot',url:pathToFileURL(path.join(repo,'main.cjs')).href,lineNumber:19},children:[3]},
  {id:3,callFrame:{functionName:'PRIVATE_EXTERNAL_NAME',url:'https://private.invalid/token=SECRET',lineNumber:100}},
  {id:4,callFrame:{functionName:'(idle)',url:''}}]};}
test('CPU diagnostic attributes weighted source ancestors while removing external paths and names',()=>{
  const result=summarizeProfile(profile(),repo,tracked);assert.equal(result.totalSampledMs,6);
  assert.deepEqual(result.topInclusiveSource,[{file:'main.cjs',line:20,function:'snapshot',selfMs:0,inclusiveMs:3}]);
  assert.equal(result.topSelf.reduce((n,r)=>n+r.selfMs,0),6);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_EXTERNAL_NAME'));assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('missing, cyclic, duplicated and invalid weighted samples cannot produce a diagnostic',()=>{
  for(const mutate of [p=>p.samples.push(3),p=>p.timeDeltas[0]=-1,p=>p.nodes[2].children=[1],
    p=>p.nodes.push(p.nodes[0]),p=>p.samples[0]=99]){const p=profile();mutate(p);assert.throws(()=>summarizeProfile(p,repo,tracked));}
});
