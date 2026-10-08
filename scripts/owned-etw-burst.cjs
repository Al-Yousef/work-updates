'use strict';
// CI-owned descendants; no account, GUI or external source is used.
const fs = require('node:fs'), path = require('node:path'), {spawn} = require('node:child_process');
if (process.env.CI !== 'true' || process.env.RUNNER_OS !== 'Windows' || !path.isAbsolute(process.argv[2] || ''))
  throw new Error('Only the isolated Windows CI trace fixture is supported.');
const children = [], rows = [];
let failure = false;
for (let i = 0; i < 8; i++) {
  const child = spawn(process.execPath, ['-e', 'const end=Date.now()+90;while(Date.now()<end){}'],
    {windowsHide:true, stdio:'ignore'});
  children.push(child);
  const row = {pid:child.pid, normalExit:false}; rows.push(row);
  child.on('error', () => {failure=true;});
  child.on('close', code => {row.normalExit=code===0; row.closed=true;});
}
const deadline = setTimeout(() => {
  failure=true;
  for (const child of children) if (child.exitCode===null) child.kill();
}, 10000);
const wait = setInterval(() => {
  if (!rows.every(row=>row.closed)) return;
  clearInterval(wait); clearTimeout(deadline);
  fs.writeFileSync(process.argv[2], JSON.stringify({schema:1,children:rows,normalExit:!failure&&rows.every(row=>row.normalExit)}));
  process.exitCode=failure||rows.some(row=>!row.normalExit)?1:0;
}, 20);
