'use strict';
// Finite, explicit private-input lane. No worker startup, account, compiler,
// installed-app fallback, automatic input retry, or foreground input route.
const fs = require('node:fs'), path = require('node:path');
const {spawn, execFileSync, execFile} = require('node:child_process');
const {configuration, verify} = require('./native-physical-contract.cjs');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  if (process.platform !== 'win32') throw new Error('Physical Windows lane unavailable');
  const config = configuration();
  const directory = path.resolve(process.argv[2] || '');
  const parent = path.join(root, 'artifacts', 'native-qa');
  if (!directory.startsWith(parent + path.sep) || !fs.statSync(directory).isDirectory() ||
      fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(parent).isSymbolicLink() ||
      fs.lstatSync(path.join(root,'artifacts')).isSymbolicLink()) throw new Error('Private QA case directory required');
  if (!fs.realpathSync(directory).toLowerCase().startsWith(fs.realpathSync(parent).toLowerCase()+path.sep))
    throw new Error('QA case cannot escape through a linked ancestor');
  const candidateDirectory = path.join(root,'native/windows/build/candidate');
  const candidate = require('./native-build-audit.cjs').verifyCandidate(candidateDirectory);
  if (candidate.dirty !== false) throw new Error('Clean candidate required');
  // Check the existing worker before launching a target. This command is discovery.
  const preflight = JSON.parse(execFileSync(config.python,[config.cursor,'--chat-id',config.chatId,'info','--timeout','5'],
    {encoding:'utf8',windowsHide:true,timeout:7000,maxBuffer:65536}));
  if (preflight.ok !== true || preflight.result?.api_version !== 4 ||
      preflight.result.owner?.chat_id !== config.chatId || preflight.result.busy !== false ||
      preflight.result.input_backend !== 'private_input_v2' || preflight.result.protected_input !== true)
    throw new Error('Existing idle chat-owned protected worker required');
  const fixture = path.join(directory,'fixture');
  fs.mkdirSync(fixture);
  const children = [], descriptors = [];
  function start(file,args,label) {
    const stdout = fs.openSync(path.join(directory,label+'.stdout.txt'),'wx',0o600);
    descriptors.push(stdout);
    const stderr = fs.openSync(path.join(directory,label+'.stderr.txt'),'wx',0o600);
    descriptors.push(stderr);
    const child = spawn(file,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const entry = {child,closed:false,code:null,error:false};
    let bytes = 0;
    const capture = fd => chunk => {
      const room = Math.max(0,2*1024*1024-bytes);
      try {fs.writeSync(fd,chunk.subarray(0,room));}
      catch {entry.error=true;controller.abort();child.kill();}
      bytes += chunk.length;
      if(bytes>2*1024*1024){entry.error=true;controller.abort();child.kill();}
    };
    child.stdout.on('data',capture(stdout));child.stderr.on('data',capture(stderr));
    child.on('error',()=>{entry.error=true;});
    child.on('close',code=>{entry.closed=true;entry.code=code;});
    children.push(entry);return entry;
  }
  async function wait(predicate, milliseconds) {
    const deadline = performance.now()+milliseconds;
    while (!predicate()) {if(performance.now()>=deadline) throw new Error('Owned fixture deadline exceeded');await delay(50);}
  }
  let backend, native, observed, failure = null, normalExit = false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT',abort);process.once('SIGTERM',abort);
  try {
    backend = start(process.execPath,[path.join(root,'scripts/native-reply-fixture.cjs'),fixture,
      '--many-chats','--ux-audit','--details-delay-ms','250'],'backend');
    await wait(()=>controller.signal.aborted || backend.closed || fs.existsSync(path.join(fixture,'fixture-ready.json')),6000);
    if(controller.signal.aborted || backend.closed || backend.error) throw new Error('Synthetic backend unavailable');
    const ready = JSON.parse(fs.readFileSync(path.join(fixture,'fixture-ready.json'),'utf8'));
    if(ready.isolated !== true || ready.pid !== backend.child.pid) throw new Error('Owned backend identity changed');
    native = start(path.join(candidateDirectory,'Native Hover.exe'),['--isolated-session','--no-auto-attach',
      '--show','--audit-reduced-motion','--audit-capture',path.join(directory,'panel.png'),
      '--bridge',path.join(fixture,'native-control.info')],'native');
    if(!native.child.pid) throw new Error('Native candidate launch failed');
    const driver = start(config.python,[path.join(root,'native/windows/scripts/physical-qa.py'),
      directory,String(native.child.pid),candidate.revision,config.chatId],'driver');
    await wait(()=>controller.signal.aborted || driver.closed,180000);
    if(controller.signal.aborted || driver.error || driver.code !== 0) throw new Error('Private-input driver did not pass');
    observed = verify(JSON.parse(fs.readFileSync(path.join(directory,'physical-input.json'),'utf8')),
      candidate.revision,config.chatId,native.child.pid);
  } catch {failure = 'physical_case_unverified';}
  finally {
    // Shutdown uses only our descriptor and retained child objects. A forced
    // owned-child exit always fails. Never enumerate or stop installed processes.
    try {
      const deadline = performance.now()+8000;
      while(backend && !backend.closed && fs.existsSync(path.join(fixture,'native-control.info')) && performance.now()<deadline) {
        // Idle shutdown may initially be refused while the synthetic turn ends.
        // This retries a bounded shutdown request, never a source/input action.
        await new Promise(resolve=>execFile(process.execPath,[path.join(root,'scripts/native-control.cjs'),
          path.join(fixture,'native-control.info'),'quitIfIdle'],{cwd:root,windowsHide:true,timeout:1500,maxBuffer:16384},()=>resolve()));
        if(!backend.closed) await delay(100);
      }
      await wait(()=>children.every(item=>item.closed),8000);
      normalExit = children.every(item=>!item.error && item.code === 0);
    } catch {normalExit = false;}
    for(const item of children) if(!item.closed) {item.child.kill();failure ||= 'owned_cleanup_unverified';}
    for(const fd of descriptors) try{fs.closeSync(fd);}catch{failure ||= 'log_close_failed';}
    process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);
    const result = {schema:1,sourceRevision:candidate.revision,chatId:config.chatId,
      nativePid:native?.child.pid || null,passed:!failure && normalExit,normalExit,
      candidateHashes:candidate.binaryHashes,input:observed || null,failure};
    fs.writeFileSync(path.join(directory,'physical-verification.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  }
  if(failure || !normalExit) throw new Error('Physical lane did not qualify');
  console.log('Separate-cursor synthetic native checks and owned-process cleanup passed.');
}
if(require.main === module) main().catch(()=>{console.error('Physical QA unverified; inspect the private report. No input is retried.');process.exitCode=1;});
