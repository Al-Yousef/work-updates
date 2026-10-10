'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const names = ['cpython-license.txt', 'pyinstaller-copying.txt'];
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function regular(file, directory = false) {
  const stat = fs.lstatSync(file);
  assert.ok(
    !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()),
    'Runtime notice path is not a regular owned file',
  );
  return stat;
}
function verifyHelperNotices(helper, expected = {}) {
  const executable =
    (expected.platform || process.platform) === 'win32' ? 'collector.exe' : 'collector';
  const manifestFile = path.join(helper, 'runtime-notices.json');
  regular(manifestFile);
  const record = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  assert.equal(record.schema, 1, 'Unsupported runtime notice record');
  assert.equal(
    record.platform,
    expected.platform || process.platform,
    'Foreign runtime notice platform',
  );
  assert.match(record.pythonVersion, /^\d+\.\d+\.\d+$/, 'Missing original Python version');
  const required =
    expected.pyInstallerVersion ||
    fs
      .readFileSync(path.join(__dirname, '../requirements-build.txt'), 'utf8')
      .trim()
      .split('==')[1];
  assert.equal(record.pyInstallerVersion, required, 'Stale PyInstaller notice version');
  assert.equal(
    record.completeBinarySbom,
    false,
    'Runtime notices cannot establish a complete binary inventory',
  );
  for (const [name, digest] of [
    [executable, record.collectorSha256],
    ['collector.py', record.collectorSourceSha256],
  ]) {
    const file = path.join(helper, name);
    regular(file);
    assert.equal(
      hash(fs.readFileSync(file)),
      digest,
      'Runtime notices belong to a changed collector',
    );
  }
  const dir = path.join(helper, 'notices');
  regular(dir, true);
  assert.deepEqual(fs.readdirSync(dir).sort(), names, 'Missing or unexpected runtime notice');
  assert.ok(Array.isArray(record.documents), 'Missing runtime notice documents');
  assert.deepEqual(
    record.documents.map((d) => d.name).sort(),
    names,
    'Runtime notice document set differs',
  );
  for (const doc of record.documents) {
    const file = path.join(dir, doc.name);
    regular(file);
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.toString('utf8').trim().length > 0, 'Empty runtime notice');
    assert.equal(bytes.length, doc.bytes, 'Runtime notice size differs');
    assert.equal(hash(bytes), doc.sha256, 'Runtime notice bytes differ');
    assert.equal(
      doc.component,
      doc.name === names[0] ? 'CPython' : 'PyInstaller',
      'Foreign runtime notice component',
    );
    assert.equal(
      doc.version,
      doc.name === names[0] ? record.pythonVersion : record.pyInstallerVersion,
      'Stale runtime notice component',
    );
  }
  return record;
}
module.exports = { verifyHelperNotices };
