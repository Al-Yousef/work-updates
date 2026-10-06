'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), os = require('node:os');
const { installedRoot, installed, nativeRoot, repo } = require('../scripts/dev-paths.cjs');
test('installed-app scripts require an explicit absolute installation root', () => {
  assert.throws(() => installedRoot({}), /HYPHEN_INSTALL_ROOT/);
  assert.throws(() => installedRoot({ HYPHEN_INSTALL_ROOT: 'relative' }), /absolute/);
  const root = path.join(os.tmpdir(), 'Hyphen portable');
  assert.equal(installed('data/desktop', { HYPHEN_INSTALL_ROOT: root }), path.join(root, 'data/desktop'));
});
test('installed-app paths cannot escape the configured installation', () => {
  const env = { HYPHEN_INSTALL_ROOT: path.join(os.tmpdir(), 'Hyphen') };
  assert.throws(() => installed('../another-app/data', env), /stay inside/);
  assert.throws(() => installed(os.tmpdir(), env), /stay inside/);
  assert.equal(nativeRoot, path.join(repo, 'native', 'windows'));
});
