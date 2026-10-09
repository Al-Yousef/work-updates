'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { audit } = require('../scripts/schedule-contract-audit.cjs');

test('slow schedule preparation preserves the future timer wake and exactly one owned dispatch', async () => {
  const report = await audit({ preparationDelayMs: 500 });
  assert.equal(report.passed, true);
  assert.equal(report.timerWokeRun, true);
  assert.equal(report.sourceDispatches, 1);
  assert.equal(report.restartPreventedReadmission, true);
  assert.equal(report.actualResultArtifactVerified, true);
});
