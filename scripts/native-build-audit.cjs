'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const native = path.join(root, 'native/windows');
const releaseFiles = [
  'Native Hover.exe',
  'Start Native Preview.exe',
  'WorkUpdatesTaskbar-v2.dll',
  'Taskbar Adapter Control.exe',
];
const testFiles = [
  'motion-tests.exe',
  'input-tests.exe',
  'accessibility-ids-tests.exe',
  'queue-tests.exe',
  'adapter-tests.exe',
  'native-adapter-tests.exe',
  'native-queue-tests.exe',
  'native-ux-tests.exe',
  'native-responsiveness-tests.exe',
];
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function walk(directory, prefix = '') {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(directory, entry.name), prefix + entry.name + '/')
        : [prefix + entry.name],
    );
}
function sourceFiles() {
  return [
    'build.ps1',
    'app.rc',
    'app.manifest',
    'toolchain.json',
    'bootstrap-toolchain.ps1',
    'THIRD_PARTY_NOTICES.txt',
    ...['src', 'tests', 'scripts', 'taskbar-adapter', 'vendor', 'assets'].flatMap((dir) =>
      walk(path.join(native, dir), dir + '/'),
    ),
  ].sort();
}
function verifyCandidate(directory) {
  const record = JSON.parse(
    fs.readFileSync(path.join(directory, 'build-verification.json'), 'utf8').replace(/^\uFEFF/, ''),
  );
  assert.equal(record.schema, 1, 'Unknown build proof schema');
  assert.equal(record.built, true, 'Build failed');
  assert.equal(record.modelTestsPassed, true, 'Model checks did not pass');
  assert.equal(record.version, require('../package.json').version, 'Stale app version');
  assert.match(record.revision, /^[a-f0-9]{40}$/, 'Missing source revision');
  assert.equal(
    record.revision,
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim(),
    'Candidate belongs to another checkout revision',
  );
  assert.equal(typeof record.dirty, 'boolean', 'Missing source cleanliness');
  if (process.env.CI === 'true')
    assert.equal(record.dirty, false, 'CI candidates require a clean source checkout');
  const lock = JSON.parse(fs.readFileSync(path.join(native, 'toolchain.json'), 'utf8'));
  assert.deepEqual(
    record.toolchain,
    {
      tag: lock.tag,
      llvmVersion: lock.llvmVersion,
      archiveSha256: lock.sha256,
      binaryHashes: lock.binaries,
    },
    'Unverified toolchain',
  );
  assert.deepEqual(
    record.protocol,
    { descriptor: 'work-updates-native-v1', snapshot: 1, adapter: 1 },
    'Native protocol contract changed',
  );
  const { nativeView } = require('../src/native-view.cjs');
  assert.equal(
    nativeView({ cards: [], done: [] }).schema,
    record.protocol.snapshot,
    'Backend/native snapshot mismatch',
  );
  for (const file of ['src/bridge.h', 'src/queue-client.h'])
    assert.ok(
      fs.readFileSync(path.join(native, file), 'utf8').includes(record.protocol.descriptor),
      'Native descriptor mismatch',
    );
  assert.ok(
    fs
      .readFileSync(path.join(root, 'src/native-control.cjs'), 'utf8')
      .includes(record.protocol.descriptor),
    'Backend descriptor mismatch',
  );
  assert.deepEqual(
    Object.keys(record.sourceHashes).sort(),
    sourceFiles(),
    'Source manifest is incomplete',
  );
  for (const [file, expected] of Object.entries(record.sourceHashes))
    assert.equal(
      hash(path.join(native, file)),
      expected.toLowerCase(),
      'Source changed since build: ' + file,
    );
  assert.deepEqual(
    Object.keys(record.binaryHashes).sort(),
    [...releaseFiles, ...testFiles].sort(),
    'Binary manifest is incomplete',
  );
  for (const [file, expected] of Object.entries(record.binaryHashes))
    assert.equal(
      hash(path.join(directory, file)),
      expected.toLowerCase(),
      'Candidate binary changed: ' + file,
    );
  return record;
}
function verifyPackage(directory, record) {
  assert.deepEqual(
    fs.readdirSync(directory).sort(),
    [...releaseFiles, 'build-verification.json', 'README.txt', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'].sort(),
    'Unexpected native package resource',
  );
  const packaged = JSON.parse(
    fs.readFileSync(path.join(directory, 'build-verification.json'), 'utf8'),
  );
  assert.deepEqual(packaged, record, 'Native package proof differs from candidate');
  for (const file of releaseFiles)
    assert.equal(
      hash(path.join(directory, file)),
      record.binaryHashes[file].toLowerCase(),
      'Stale packaged binary: ' + file,
    );
  for (const [file, source] of [
    ['LICENSE', path.join(root, 'LICENSE')],
    ['THIRD_PARTY_NOTICES.txt', path.join(native, 'THIRD_PARTY_NOTICES.txt')],
  ])
    assert.equal(hash(path.join(directory, file)), hash(source), 'Packaged license or notices changed: ' + file);
  const readme = fs.readFileSync(path.join(directory, 'README.txt'), 'utf8');
  assert.ok(
    readme.includes(record.version) && readme.includes('HYPHEN_INSTALL_ROOT'),
    'Missing backend version/layout requirement',
  );
}
module.exports = { verifyCandidate, verifyPackage, releaseFiles, testFiles, sourceFiles };
if (require.main === module) {
  const candidate = path.resolve(process.argv[2] || path.join(native, 'build/candidate'));
  const record = verifyCandidate(candidate);
  if (process.argv[3]) verifyPackage(path.resolve(process.argv[3]), record);
  console.log(
    'Native candidate/package audit passed: version, source/binary/toolchain hashes, protocol and resource allowlist.',
  );
}
