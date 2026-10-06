'use strict';
const path = require('node:path');
const repo = path.resolve(__dirname, '..');
function installedRoot(env = process.env) {
  const value = env.HYPHEN_INSTALL_ROOT;
  if (!value || !path.isAbsolute(value))
    throw new Error('Set HYPHEN_INSTALL_ROOT to the absolute portable installation directory before using an installed-app audit or updater.');
  return path.resolve(value);
}
function installed(relative = '', env = process.env) {
  const root = installedRoot(env), resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
    throw new Error('Installed-app paths must stay inside HYPHEN_INSTALL_ROOT.');
  return resolved;
}
module.exports = { repo, installedRoot, installed, nativeRoot: path.join(repo, 'native', 'windows') };
