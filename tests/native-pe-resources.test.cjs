'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { verifyResources } = require('../scripts/native-pe-resources.cjs');
const { releaseFiles } = require('../scripts/native-build-audit.cjs');
function fixture() {
  const rows = releaseFiles.map((name, i) => ({
    name,
    sha256: String(i + 1).repeat(64),
    bytes: 1024,
    productName: 'Hyphen',
    fileVersion: '0.6.9',
    productVersion: '0.6.9',
    signatureStatus: 'NotSigned',
    hasSignerCertificate: false,
  }));
  return {
    rows,
    record: {
      revision: 'a'.repeat(40),
      version: '0.6.9',
      binaryHashes: Object.fromEntries(rows.map((row) => [row.name, row.sha256])),
    },
  };
}
test('all four distributed originals need matching product and version resources', () => {
  const f = fixture();
  const p = verifyResources(f.rows, f.record);
  assert.equal(p.files.length, 4);
  assert.equal(p.trustedSigningVerified, false);
  for (const row of f.rows)
    for (const [key, value] of [
      ['productName', 'Windows'],
      ['fileVersion', '0.0.0'],
      ['productVersion', null],
    ]) {
      const before = row[key];
      row[key] = value;
      assert.throws(
        () => verifyResources(f.rows, f.record),
        /native (product name|file version|product version)/,
      );
      row[key] = before;
    }
});
test('omitted, duplicate and changed-binary metadata cannot promote a package', () => {
  const f = fixture();
  assert.throws(() => verifyResources(f.rows.slice(0, 3), f.record), /set differs/);
  assert.throws(() => verifyResources([...f.rows.slice(0, 3), f.rows[0]], f.record), /set differs/);
  f.rows[2].sha256 = '0'.repeat(64);
  assert.throws(() => verifyResources(f.rows, f.record), /different binary/);
});
test('signature uncertainty and unexpected signers are never treated as signed or unsigned proof', () => {
  const f = fixture();
  for (const state of [undefined, 'UnknownError', 'HashMismatch', 'Valid']) {
    f.rows[0].signatureStatus = state;
    assert.throws(() => verifyResources(f.rows, f.record), /signature status/);
  }
  f.rows[0].signatureStatus = 'NotSigned';
  f.rows[0].hasSignerCertificate = true;
  assert.throws(() => verifyResources(f.rows, f.record), /signer/);
});
