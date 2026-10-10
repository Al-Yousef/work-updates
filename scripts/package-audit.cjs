'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  asar = require('@electron/asar');
const root = path.resolve(__dirname, '..'),
  dir = process.env.WORK_UPDATES_PACKAGE_DIR || path.join(root, 'dist');
let executable, resources;
if (process.platform === 'win32') {
  resources = path.join(dir, 'win-unpacked', 'resources');
  executable = path.join(dir, 'win-unpacked', 'Work Updates.exe');
} else {
  // electron-builder uses executableName for both the bundle filename and its
  // internal executable. productName remains the user-facing app name.
  const build = require('../package.json').build;
  const executableName = build.mac.executableName || build.productName;
  const candidates = fs.readdirSync(dir).filter((n) => n === 'mac' || n.startsWith('mac-'));
  const bundle = candidates
    .map((n) => path.join(dir, n, executableName + '.app'))
    .find((p) => fs.existsSync(p));
  assert.ok(bundle, 'The Electron Mac compatibility app must be built');
  resources = path.join(bundle, 'Contents', 'Resources');
  executable = path.join(bundle, 'Contents', 'MacOS', executableName);
}
const archive = path.join(resources, 'app.asar'),
  entries = asar.listPackage(archive).map((p) => p.replaceAll('\\', '/'));
const packagedVersion = JSON.parse(asar.extractFile(archive, 'package.json').toString()).version;
assert.equal(packagedVersion, require('../package.json').version, 'Stale packaged backend version');
// Package contents must come from this checkout, rather than an older unpacked app.
for (const file of [
  'main.cjs',
  'preload.cjs',
  ...fs
    .readdirSync(path.join(root, 'src'))
    .filter((name) => name.endsWith('.cjs'))
    .map((name) => 'src/' + name),
])
  assert.ok(
    asar.extractFile(archive, file).equals(fs.readFileSync(path.join(root, file))),
    'Stale packaged source: ' + file,
  );
assert.ok(
  asar.extractFile(archive, 'src/native-control.cjs').toString().includes('work-updates-native-v1'),
  'Unsupported native descriptor',
);
const { nativeView } = require('../src/native-view.cjs');
assert.equal(nativeView({ cards: [], done: [] }).schema, 1, 'Unsupported native snapshot protocol');
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
assert.ok(
  fs
    .readFileSync(path.join(resources, 'helper', 'collector.py'))
    .equals(fs.readFileSync(path.join(root, 'bridge', 'collector.py'))),
  'Stale packaged original-reader source',
);
const runtimeNotices = require('./helper-notices-audit.cjs').verifyHelperNotices(
  path.join(resources, 'helper'),
);
fs.mkdirSync(path.join(root, 'artifacts/runtime-notices'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'artifacts/runtime-notices/verification.json'),
  JSON.stringify(
    {
      schema: 1,
      passed: true,
      packagedNoticesVerified: true,
      runtimeNotices,
      completeBinarySbom: false,
    },
    null,
    2,
  ) + '\n',
);
process.stdout.write('Packaged contents audit passed: source allowlist and bundled observer.\n');
async function finish() {
  await require('./research-contract-audit.cjs').audit({
    helper: path.join(
      resources,
      'helper',
      process.platform === 'win32' ? 'collector.exe' : 'collector',
    ),
  });
  if (process.argv.includes('--ui')) {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, [path.join(__dirname, 'ui-audit.cjs')], {
      env: { ...process.env, WORK_UPDATES_EXECUTABLE: executable },
      stdio: 'inherit',
      timeout: 180000,
      killSignal: 'SIGTERM',
    });
    if (result.error) throw result.error;
    process.exit(result.status === null ? 1 : result.status);
  }
}
finish().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
