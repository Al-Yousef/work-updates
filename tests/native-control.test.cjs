'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {once} = require('node:events');
const {NativeControl} = require('../src/native-control.cjs');

async function request(control, method, token = control.token) {
  const socket = net.createConnection(control.pipe);
  socket.on('error', () => {});
  await once(socket, 'connect');
  const received = once(socket, 'data');
  socket.write(JSON.stringify({method, token}) + '\n');
  return {socket, response:JSON.parse(String((await received)[0]))};
}
test('native ownership is exclusive, authenticated, and released on disconnect without changing preferences', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-updates-control-'));
  let activeWriters = 1, quit = false;
  const changes = [];
  const preferences = {corner:true};
  const control = await new NativeControl({directory, changed:value=>changes.push(value),
    status:()=>({activeWriters, cornerConfigured:preferences.corner}), quit:()=>{quit=true;}}).start();
  t.after(()=>{control.close();fs.rmSync(directory,{recursive:true,force:true});});
  const rejected = await request(control, 'claimCorner', 'wrong');
  assert.equal(rejected.response.ok,false); assert.equal(control.claimed,false);
  const owner = await request(control, 'claimCorner');
  assert.equal(owner.response.ok,true); assert.equal(control.claimed,true);
  assert.deepEqual(changes,[true]); assert.deepEqual(preferences,{corner:true});
  const serverOwner=control.owner;
  const second = await request(control, 'claimCorner');
  assert.equal(second.response.ok,false); assert.equal(control.owner,serverOwner);
  const blockedQuit = await request(control, 'quitIfIdle');
  assert.equal(blockedQuit.response.ok,false); assert.equal(quit,false);
  const status = await request(control, 'status');
  assert.equal(status.response.value.cornerOwner,'native');
  const released = new Promise(resolve => {control.changed=value=>{changes.push(value); if(!value)resolve();};});
  owner.socket.destroy(); await released;
  assert.equal(control.claimed,false); assert.deepEqual(changes,[true,false]); assert.equal(preferences.corner,true);
  activeWriters=0;
  const safeQuit=await request(control,'quitIfIdle'); assert.equal(safeQuit.response.ok,true);
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(quit,true);
});

test('Unix control stays private and cleans up even with a long app-data path', {skip:process.platform === 'win32'}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-long-'));
  const directory = path.join(root, 'a'.repeat(70), 'b'.repeat(70));
  fs.mkdirSync(directory, {recursive:true});
  const control = await new NativeControl({directory, changed:()=>{},
    status:()=>({activeWriters:0}), quit:()=>{}}).start();
  t.after(()=>{control.close();fs.rmSync(root,{recursive:true,force:true});});
  const endpoint = control.endpointDirectory;
  assert.ok(Buffer.byteLength(control.pipe) <= 103);
  assert.equal(fs.statSync(endpoint).mode & 0o777, 0o700);
  assert.equal(fs.statSync(control.file).mode & 0o777, 0o600);
  assert.equal((await request(control, 'status', 'wrong')).response.ok,false);
  assert.equal((await request(control, 'status')).response.ok,true);
  const stopped = once(control.server, 'close');
  control.close();
  await stopped;
  assert.equal(fs.existsSync(endpoint),false);
  assert.equal(fs.existsSync(control.file),false);
});
