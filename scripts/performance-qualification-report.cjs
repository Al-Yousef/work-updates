'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { qualification } = require('../src/performance-qualification.cjs');
const root = path.resolve(process.argv[2]);
const read = (name) =>
  JSON.parse(fs.readFileSync(path.join(root, name, 'verification.json'), 'utf8'));
try {
  const report = qualification(
    [1, 2, 3, 4, 5].map((i) => read('baseline-' + i)),
    read('current'),
    read('soak'),
  );
  fs.writeFileSync(path.join(root, 'qualification.json'), JSON.stringify(report, null, 2));
  process.stdout.write(
    JSON.stringify({
      passed: report.passed,
      sourceRevision: report.sourceRevision,
      comparableWorkloads: report.checks.length,
      growth: report.soak.growth.state,
    }) + '\n',
  );
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  fs.writeFileSync(
    path.join(root, 'qualification.json'),
    JSON.stringify(
      { schema: 1, passed: false, state: 'unverified', reason: error.message },
      null,
      2,
    ),
  );
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
