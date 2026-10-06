'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawn} = require('node:child_process');
const {forceAuditApp} = require('./electron-audit-lifecycle.cjs');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-shutdown-audit-'));
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;

// Hold the real quit lifecycle after cleanup for longer than the diagnostic
// interval. This reproduces debugger/OS-delayed termination without altering
// production timing. UI/pair audits separately require a normal clean exit.
const fixture = path.join(directory, 'fixture.cjs');
fs.writeFileSync(fixture, `
const {app}=require('electron'), fs=require('node:fs'), assert=require('node:assert/strict');
process.once('uncaughtExceptionMonitor',error=>{console.error(error.stack);app.exit(1);});
app.once('will-quit',event=>event.preventDefault());
require(${JSON.stringify(path.join(root, 'main.cjs'))});
const runtimeFile=process.argv[process.argv.indexOf('--data-dir')+1]+'/runtime.json';
app.whenReady().then(async()=>{
  for(let attempt=0;attempt<100&&!fs.existsSync(runtimeFile);attempt++)
    await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(fs.existsSync(runtimeFile),'Synthetic app did not become ready');
  const before=fs.readFileSync(runtimeFile,'utf8');
  setTimeout(()=>{
    try {
      assert.equal(fs.readFileSync(runtimeFile,'utf8'),before,'Runtime timer wrote after quit cleanup');
      console.log('shutdown-periodic-work-stopped');
      app.exit(0);
    } catch(error) {console.error(error.stack);app.exit(1);}
  },3600);
  app.quit();
}).catch(error=>{console.error(error.stack);app.exit(1);});
`);

async function check(mode) {
  const args = [fixture, '--demo', '--hidden', '--data-dir', path.join(directory, mode)];
  if (mode === 'native-backend') args.push('--native-backend');
  if (process.platform === 'darwin') args.push('--use-mock-keychain');
  const child = spawn(require('electron'), args, {
    env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', timedOut = false;
  const capture = chunk => {output = (output + chunk.toString()).slice(-8192);};
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const timer = setTimeout(() => {timedOut = true; forceAuditApp({process: () => child});}, 30000);
  try {
    const code = await new Promise((resolve, reject) => {child.once('error', reject);child.once('close', resolve);});
    assert.equal(timedOut, false, mode + ' shutdown regression timed out\n' + output);
    assert.equal(code, 0, mode + ' shutdown regression failed\n' + output);
    assert.ok(output.includes('shutdown-periodic-work-stopped'), 'Missing shutdown assertion: ' + mode);
  } finally {clearTimeout(timer);}
}
(async () => {
  try {
    await check('compatibility-ui');
    if (process.platform === 'win32') await check('native-backend');
    console.log('Quit cleanup stops diagnostics before destroyed services are accessed.');
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
})().catch(error => {console.error(error.stack);process.exitCode = 1;});
