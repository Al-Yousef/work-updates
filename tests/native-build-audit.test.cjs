'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  verifyCandidate,
  verifyPackage,
  releaseFiles,
  testFiles,
  sourceFiles,
} = require('../scripts/native-build-audit.cjs');
const root = path.resolve(__dirname, '..');
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-proof-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lock = require('../native/windows/toolchain.json');
  const record = {
    schema: 1,
    built: true,
    modelTestsPassed: true,
    version: require('../package.json').version,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: false,
    toolchain: {
      tag: lock.tag,
      llvmVersion: lock.llvmVersion,
      archiveSha256: lock.sha256,
      binaryHashes: lock.binaries,
    },
    protocol: { descriptor: 'work-updates-native-v1', snapshot: 1, adapter: 1 },
    sourceHashes: Object.fromEntries(
      sourceFiles().map((file) => [
        file,
        digest(fs.readFileSync(path.join(root, 'native/windows', file))),
      ]),
    ),
    binaryHashes: {},
  };
  for (const file of [...releaseFiles, ...testFiles]) {
    const bytes = Buffer.from('Synthetic binary bytes for hash validation: ' + file);
    fs.writeFileSync(path.join(directory, file), bytes);
    record.binaryHashes[file] = digest(bytes);
  }
  const save = () =>
    fs.writeFileSync(path.join(directory, 'build-verification.json'), JSON.stringify(record));
  save();
  return { directory, record, save };
}
test('native proof requires model success, current version and the complete source/toolchain identity', (t) => {
  const f = fixture(t);
  assert.equal(verifyCandidate(f.directory).version, f.record.version);
  f.record.modelTestsPassed = false;
  f.save();
  assert.throws(() => verifyCandidate(f.directory), /Model checks did not pass/);
  f.record.modelTestsPassed = true;
  f.record.version = '0.0.0';
  f.save();
  assert.throws(() => verifyCandidate(f.directory), /Stale app version/);
});
test('copied proof cannot validate a changed binary, including an isolated test target', (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.directory, 'native-adapter-tests.exe'), 'changed');
  assert.throws(() => verifyCandidate(f.directory), /Candidate binary changed/);
});
test('an earlier checkout revision cannot promote the same binaries as current proof', (t) => {
  const f = fixture(t);
  f.record.revision = '0'.repeat(40);
  f.save();
  assert.throws(() => verifyCandidate(f.directory), /another checkout revision/);
});
test('omitted source and traversal paths fail before accessing an unlisted source', (t) => {
  const f = fixture(t);
  delete f.record.sourceHashes['src/main.cpp'];
  f.save();
  assert.throws(() => verifyCandidate(f.directory), /Source manifest is incomplete/);
  f.record.sourceHashes['../../private-data'] = '0'.repeat(64);
  f.save();
  assert.throws(() => verifyCandidate(f.directory), /Source manifest is incomplete/);
});
test('a stale source hash and an unsupported snapshot protocol cannot be promoted', (t) => {
  const f = fixture(t);
  f.record.sourceHashes['src/main.cpp'] = '0'.repeat(64);
  f.save();
  assert.throws(() => verifyCandidate(f.directory), /Source changed since build/);
  f.record.protocol.snapshot = 2;
  f.save();
  assert.throws(() => verifyCandidate(f.directory), /Native protocol contract changed/);
});
test('a manifest cannot substitute an unpinned linker or omit a test executable', (t) => {
  const f = fixture(t);
  f.record.toolchain = structuredClone(f.record.toolchain);
  f.record.toolchain.binaryHashes['ld.lld.exe'] = '0'.repeat(64);
  f.save();
  assert.throws(() => verifyCandidate(f.directory), /Unverified toolchain/);
  f.record.toolchain.binaryHashes['ld.lld.exe'] =
    require('../native/windows/toolchain.json').binaries['ld.lld.exe'];
  delete f.record.binaryHashes['native-queue-tests.exe'];
  f.save();
  assert.throws(() => verifyCandidate(f.directory), /Binary manifest is incomplete/);
});
test('native packages exclude private descriptors and bind every distributed binary to the proof', (t) => {
  const f = fixture(t);
  const stage = path.join(f.directory, 'stage');
  fs.mkdirSync(stage);
  for (const file of [...releaseFiles, 'build-verification.json'])
    fs.copyFileSync(path.join(f.directory, file), path.join(stage, file));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
  fs.copyFileSync(path.join(root, 'native/windows/THIRD_PARTY_NOTICES.txt'), path.join(stage, 'THIRD_PARTY_NOTICES.txt'));
  fs.writeFileSync(
    path.join(stage, 'README.txt'),
    'Hyphen ' + f.record.version + ' requires HYPHEN_INSTALL_ROOT',
  );
  verifyPackage(stage, f.record);
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.txt']) {
    const original = fs.readFileSync(path.join(stage, file));
    fs.unlinkSync(path.join(stage, file));
    assert.throws(() => verifyPackage(stage, f.record), /Unexpected native package resource/);
    fs.writeFileSync(path.join(stage, file), Buffer.concat([original, Buffer.from(' altered')]));
    assert.throws(() => verifyPackage(stage, f.record), /Packaged license or notices changed/);
    fs.writeFileSync(path.join(stage, file), original);
    verifyPackage(stage, f.record);
  }
  fs.writeFileSync(path.join(stage, 'native-control.info'), 'synthetic private descriptor');
  assert.throws(() => verifyPackage(stage, f.record), /Unexpected native package resource/);
  fs.unlinkSync(path.join(stage, 'native-control.info'));
  fs.appendFileSync(path.join(stage, 'Native Hover.exe'), 'changed');
  assert.throws(() => verifyPackage(stage, f.record), /Stale packaged binary/);
});
