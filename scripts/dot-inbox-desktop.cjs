'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const child = spawn(
  require('electron'),
  [path.join(root, 'candidate', 'dot-inbox', 'desktop', 'main.cjs'), ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit', windowsHide: true },
);
child.on('exit', (code) => {
  process.exitCode = code || 0;
});
child.on('error', (error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
