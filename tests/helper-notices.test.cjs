'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyHelperNotices } = require('../scripts/helper-notices-audit.cjs');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-notices-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'notices'));
  fs.writeFileSync(path.join(dir, 'collector.exe'), 'original binary');
  fs.writeFileSync(path.join(dir, 'collector.py'), 'original source');
  const documents = ['cpython-license.txt', 'pyinstaller-copying.txt'].map((name, i) => {
    const bytes = Buffer.from('Original copyright and terms\r\n' + name);
    fs.writeFileSync(path.join(dir, 'notices', name), bytes);
    return {
      name,
      component: i ? 'PyInstaller' : 'CPython',
      version: i ? '6.22.3' : '3.12.10',
      bytes: bytes.length,
      sha256: hash(bytes),
    };
  });
  const record = {
    schema: 1,
    platform: 'win32',
    pythonVersion: '3.12.10',
    pyInstallerVersion: '6.22.3',
    collectorSha256: hash(Buffer.from('original binary')),
    collectorSourceSha256: hash(Buffer.from('original source')),
    documents,
    completeBinarySbom: false,
  };
  const save = () =>
    fs.writeFileSync(path.join(dir, 'runtime-notices.json'), JSON.stringify(record));
  save();
  return {
    dir,
    record,
    save,
    verify: () => verifyHelperNotices(dir, { platform: 'win32', pyInstallerVersion: '6.22.3' }),
  };
}
test('packaged notices match their original bytes, versions and exact helper', (t) => {
  const f = fixture(t);
  assert.equal(f.verify().completeBinarySbom, false);
  fs.appendFileSync(path.join(f.dir, 'collector.exe'), 'changed');
  assert.throws(f.verify, /changed collector/);
});
test('missing, extra, modified and relabelled runtime notices fail packaging', (t) => {
  const f = fixture(t),
    file = path.join(f.dir, 'notices/cpython-license.txt');
  const original = fs.readFileSync(file);
  fs.appendFileSync(file, 'changed');
  assert.throws(f.verify, /size differs|bytes differ/);
  fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(f.dir, 'notices/extra.txt'), 'extra');
  assert.throws(f.verify, /unexpected runtime notice/);
  fs.unlinkSync(path.join(f.dir, 'notices/extra.txt'));
  f.record.documents[0].version = '3.12.0';
  f.save();
  assert.throws(f.verify, /Stale runtime notice/);
  f.record.documents[0].version = '3.12.10';
  f.save();
  fs.unlinkSync(file);
  assert.throws(f.verify, /unexpected runtime notice/);
});
test('foreign platform, duplicate records, stale builder and completeness claims fail', (t) => {
  const f = fixture(t);
  for (const [key, value, pattern] of [
    ['platform', 'darwin', /Foreign/],
    ['pyInstallerVersion', '0.0.0', /Stale/],
    ['completeBinarySbom', true, /complete binary/],
  ]) {
    const original = f.record[key];
    f.record[key] = value;
    f.save();
    assert.throws(f.verify, pattern);
    f.record[key] = original;
    f.save();
  }
  f.record.documents[1] = f.record.documents[0];
  f.save();
  assert.throws(f.verify, /document set differs/);
});
