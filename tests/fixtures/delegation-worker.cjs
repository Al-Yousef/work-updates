'use strict';
// An owned-process fixture writes one distinct result per child. It accepts no
// command, source instruction, model configuration or network operation.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const [directory, nonce] = process.argv.slice(2),
  root = path.resolve(directory || '');
if (
  path.dirname(root) !== path.resolve(os.tmpdir()) ||
  !path.basename(root).startsWith('hyphen-responsibility-audit-policy-') ||
  fs.lstatSync(root).isSymbolicLink() ||
  !/^[a-f0-9]{32}$/.test(nonce || '')
)
  throw new Error('Invalid owned delegation fixture');
fs.writeFileSync(
  path.join(root, 'child-' + nonce + '.json'),
  JSON.stringify({ schema: 1, nonce, verified: true }),
  { flag: 'wx', mode: 0o600 },
);
