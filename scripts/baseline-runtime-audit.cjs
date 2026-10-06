'use strict';
// Source-only composition-root check: demo data, no Codex observer/writer,
// model invocation, pairing restore, windows, tray or Explorer attachment.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const net = require('node:net'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (process.platform !== 'win32') throw new Error('Native backend runtime check requires Windows.');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-baseline-runtime-'));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [root, '--demo', '--native-backend', '--hidden', '--data-dir', directory], { windowsHide: true, stdio: 'ignore', env });
let failure; child.on('error', error => failure = error);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exited = new Promise(resolve => child.once('exit', resolve));
async function rpc(method) {
  const [magic, pipe, token, pid] = fs.readFileSync(path.join(directory, 'native-control.info'), 'utf8').split('\n');
  assert.equal(magic, 'work-updates-native-v1'); assert.equal(Number(pid), child.pid);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe); let bytes = '';
    socket.setEncoding('utf8'); socket.setTimeout(3000, () => socket.destroy(new Error('Isolated runtime control timed out')));
    socket.on('error', reject); socket.on('connect', () => socket.write(JSON.stringify({ method, token }) + '\n'));
    socket.on('data', data => { bytes += data; if (bytes.includes('\n')) { socket.destroy(); const result = JSON.parse(bytes.split('\n')[0]); result.ok ? resolve(result.value) : reject(new Error(result.error)); } });
  });
}
(async () => {
  try {
    let runtime;
    for (let i = 0; i < 100; i++) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error('Isolated source backend exited before readiness');
      try { runtime = JSON.parse(fs.readFileSync(path.join(directory, 'runtime.json'), 'utf8')); } catch {}
      if (runtime?.appPid === child.pid) break;
      await pause(100);
    }
    assert.equal(runtime?.appPid, child.pid); assert.equal(runtime.version, require('../package.json').version);
    assert.equal(runtime.mode, 'native-backend'); assert.equal(runtime.windowCount, 0); assert.equal(runtime.rendererCount, 0);
    assert.equal(runtime.collectorPid, null); assert.equal(runtime.desktop.connected, false);
    assert.equal(runtime.codex.active, 0); assert.equal(runtime.assistant.active, false);
    assert.equal(fs.existsSync(path.join(directory, 'observer')), false);
    const state = await rpc('status'); assert.equal(state.mode, 'native-backend'); assert.equal(state.activeWriters, 0);
    await rpc('quitIfIdle');
    await Promise.race([exited, pause(5000).then(() => { throw new Error('Isolated source backend did not quit'); })]);
    const report = { passed: true, version: runtime.version, windowCount: 0, rendererCount: 0, collectorStarted: false, signedInChatMutation: false, modelInvocation: false };
    fs.mkdirSync(path.join(root, 'artifacts/baseline'), { recursive: true });
    fs.writeFileSync(path.join(root, 'artifacts/baseline/runtime-audit.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    if (child.exitCode === null && !failure) { child.kill(); await Promise.race([exited, pause(3000)]); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
