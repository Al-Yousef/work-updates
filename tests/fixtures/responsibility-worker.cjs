'use strict';
// Own-process synthetic outcome fixture. It accepts no command, network target,
// model configuration or arbitrary operation from a source chat.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const [directory, nonce] = process.argv.slice(2),
  root = path.resolve(directory || '');
if (
  path.dirname(root) !== path.resolve(os.tmpdir()) ||
  !path.basename(root).startsWith('hyphen-responsibility-audit-') ||
  fs.lstatSync(root).isSymbolicLink() ||
  !/^[a-f0-9]{32}$/.test(nonce || '')
)
  throw new Error('Invalid owned responsibility fixture');
const result = { schema: 1, verified: true, nonce };
fs.writeFileSync(path.join(root, 'requested-result.json'), JSON.stringify(result), {
  flag: 'wx',
  mode: 0o600,
});
