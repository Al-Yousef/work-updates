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
  let forced=false;
  const timer=setTimeout(()=>{forced=true;forceAuditApp(app);},12000);
  try {
    // Return the inspector evaluation before beginning quit. Calling app.quit()
    // inside the synchronous evaluation can leave that evaluation waiting for
    // the same debugger connection which Playwright still needs to disconnect.
    await app.evaluate(({app})=>{setImmediate(()=>app.quit());}).catch(()=>{});
    await app.close();
    if (forced || child.exitCode !== 0)
      throw new Error('Synthetic Electron app did not quit cleanly: exit=' + child.exitCode + ', signal=' + child.signalCode);
  } finally {clearTimeout(timer);}
}
module.exports={closeAuditApp,forceAuditApp};
