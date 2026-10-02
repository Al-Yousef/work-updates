'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  asar = require('@electron/asar');
const root = path.resolve(__dirname, '..'),
  dir = path.join(root, 'dist');
let executable, resources;
if (process.platform === 'win32') {
  resources = path.join(dir, 'win-unpacked', 'resources');
  executable = path.join(dir, 'win-unpacked', 'Work Updates.exe');
} else {
  const candidates = fs.readdirSync(dir).filter((n) => n === 'mac' || n.startsWith('mac-'));
  const bundle = candidates
    .map((n) => path.join(dir, n, 'Work Updates.app'))
    .find((p) => fs.existsSync(p));
  assert.ok(bundle, 'A native Mac app must be built');
  resources = path.join(bundle, 'Contents', 'Resources');
  executable = path.join(bundle, 'Contents', 'MacOS', 'Work Updates');
}
const archive = path.join(resources, 'app.asar'),
  entries = asar.listPackage(archive).map((p) => p.replaceAll('\\', '/'));
for (const file of entries) {
  const first = file.split('/').filter(Boolean)[0];
  assert.ok(
    [
      'main.cjs',
      'preload.cjs',
      'src',
      'ui',
      'assets',
      'node_modules',
      'package.json',
      'LICENSE',
    ].includes(first),
    'Unexpected packaged source: ' + first,
  );
  if (first !== 'node_modules')
    assert.ok(
      !/(?:^|\/)(?:data|user-data|observer)\/|\.(?:jsonl|sqlite\w*|enc|key|pem|log)$/.test(file),
      'Private data in package',
    );
}
assert.ok(
  fs.existsSync(
    path.join(resources, 'helper', process.platform === 'win32' ? 'collector.exe' : 'collector'),
  ),
  'The observer must be bundled',
);
process.stdout.write('Packaged contents audit passed: source allowlist and bundled observer.\n');
if (process.argv.includes('--ui')) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'ui-audit.cjs')], {
    env: { ...process.env, WORK_UPDATES_EXECUTABLE: executable },
    stdio: 'inherit',
  });
  process.exit(result.status || 0);
}
