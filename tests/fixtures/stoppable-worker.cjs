'use strict';
// The audit owns this process and its temporary root. It has no account,
// network, model, arbitrary command or production-data capability.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  readline = require('node:readline');
const [directory, nonce] = process.argv.slice(2),
  root = fs.realpathSync.native(directory || '.');
if (
  path.dirname(root) !== fs.realpathSync.native(os.tmpdir()) ||
  !path.basename(root).startsWith('hyphen-responsibility-audit-policy-') ||
  !/^[a-f0-9]{32}$/.test(nonce || '')
)
  throw new Error('Invalid owned stoppable fixture');
const input = readline.createInterface({ input: process.stdin }),
  timer = setTimeout(() => process.exit(2), 10000);
process.stdout.write(JSON.stringify({ ready: true, nonce }) + '\n');
input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.stop !== nonce) return;
  fs.writeFileSync(
    path.join(root, 'stopped-' + nonce + '.json'),
    JSON.stringify({ schema: 1, nonce, terminal: 'interrupted', requestedWorkFinished: false }),
    { flag: 'wx' },
  );
  clearTimeout(timer);
  input.close();
  process.exit(0);
});
