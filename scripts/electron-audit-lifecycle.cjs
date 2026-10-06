'use strict';
const {spawnSync}=require('node:child_process');

// Only use with ElectronApplication instances launched by a synthetic audit.
// Playwright launches a dedicated process group on Unix and a child tree on Windows.
function forceAuditApp(app) {
  const child=app?.process();
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null)
        spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});
    } else process.kill(-child.pid,'SIGKILL');
  } catch (error) {if (error.code !== 'ESRCH') throw error;}
}
async function closeAuditApp(app) {
  if (!app) return;
  const child=app.process();
  let stderr='';
  const capture=chunk=>{stderr=(stderr+chunk.toString()).slice(-8192);};
  child.stderr?.on('data',capture);
  let forced=false;
  const timer=setTimeout(()=>{forced=true;forceAuditApp(app);},12000);
  try {
    // Observe the real quit path; do not bypass window or backend cleanup.
    await app.evaluate(({app})=>{
      process.once('uncaughtExceptionMonitor',error=>console.error('audit.uncaught',error.stack));
      app.prependOnceListener('before-quit',()=>console.error('audit.before-quit'));
      app.prependOnceListener('will-quit',()=>console.error('audit.will-quit'));
      app.once('quit',()=>console.error('audit.quit'));
    }).catch(()=>{});
    await app.close();
    if (forced || child.exitCode !== 0)
      throw new Error('Synthetic Electron app did not quit cleanly: exit=' + child.exitCode + ', signal=' + child.signalCode + '\nSynthetic shutdown stderr:\n' + stderr);
  } finally {clearTimeout(timer);child.stderr?.removeListener('data',capture);}
}
module.exports={closeAuditApp,forceAuditApp};
