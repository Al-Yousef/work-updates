'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verifyCandidate, releaseFiles } = require('./native-build-audit.cjs');

function verifyResources(rows, record) {
  assert.ok(Array.isArray(rows), 'Missing native PE resource records');
  assert.deepEqual(
    rows.map((row) => row.name).sort(),
    [...releaseFiles].sort(),
    'Native PE resource set differs from distributed files',
  );
  for (const row of rows) {
    assert.match(row.sha256, /^[a-f0-9]{64}$/, 'Missing native binary hash');
    assert.equal(
      row.sha256,
      record.binaryHashes[row.name].toLowerCase(),
      'Native PE evidence belongs to a different binary',
    );
    assert.ok(Number.isSafeInteger(row.bytes) && row.bytes > 0, 'Missing native file size');
    assert.equal(row.productName, 'Hyphen', 'Missing or foreign native product name');
    assert.equal(row.fileVersion, record.version, 'Missing or stale native file version');
    assert.equal(row.productVersion, record.version, 'Missing or stale native product version');
    // This gate describes unsigned development outputs. It must never promote a
    // signature error, unexpected publisher or missing status as trusted signing.
    assert.equal(
      row.signatureStatus,
      'NotSigned',
      'Unexpected native development signature status',
    );
    assert.equal(row.hasSignerCertificate, false, 'Unexpected native development signer');
  }
  return {
    schema: 1,
    passed: true,
    sourceRevision: record.revision,
    version: record.version,
    resourcesVerified: true,
    unsignedDevelopmentBuild: true,
    trustedSigningVerified: false,
    files: rows,
    limits:
      'PE metadata and original file hashes only; no signing service, certificate trust, installation or physical behavior is verified.',
  };
}
module.exports = { verifyResources };
if (require.main === module) {
  const candidate = path.resolve(process.argv[2]);
  const rows = JSON.parse(fs.readFileSync(process.argv[3], 'utf8').replace(/^\uFEFF/, ''));
  const proof = verifyResources(rows, verifyCandidate(candidate));
  fs.writeFileSync(process.argv[4], JSON.stringify(proof, null, 2) + '\n');
  console.log('All four native product/version resources and unsigned binary identities verified.');
}
