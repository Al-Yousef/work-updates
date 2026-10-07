'use strict';
const fs = require('node:fs'), path = require('node:path');
const { fixtures } = require('../tests/fixtures/status-contract.cjs');
const directory = path.resolve(__dirname, '../artifacts/status-contract');
fs.mkdirSync(directory, { recursive: true });
const cases = fixtures(path.join(directory, 'profile'));
fs.writeFileSync(path.join(directory, 'fixtures.json'), JSON.stringify({ schema: 1, synthetic: true, cases }, null, 2));
console.log('Generated ' + cases.length + ' shared status fixtures without accounts or model inference.');
