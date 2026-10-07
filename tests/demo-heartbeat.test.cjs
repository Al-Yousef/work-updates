'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Queue}=require('../src/queue.cjs');
const {startDemoObserver}=require('../src/demo.cjs');
test('demo freshness renews without changing source revisions and stops with observer cleanup',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hyphen-demo-heartbeat-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  t.mock.timers.enable({apis:['setInterval']});let clock=Date.now()/1000;
  const queue=new Queue(directory),observer=startDemoObserver(queue,{clock:()=>clock});
  const sources=structuredClone(queue.feed.threads);clock+=120;t.mock.timers.tick(5000);
  assert.equal(queue.feed.collectedAt,clock);assert.deepEqual(queue.feed.threads,sources);assert.equal(observer.pid,null);assert.equal(queue.health.synthetic,true);
  observer.close();clock+=120;t.mock.timers.tick(10000);observer.request();assert.notEqual(queue.feed.collectedAt,clock);
});
