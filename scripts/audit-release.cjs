'use strict';
// Inspect tracked source, not the developer's app-data directory. Fail closed on extras.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const roots = new Set(['src', 'ui', 'bridge', 'tests', 'scripts', 'docs', 'assets', '.github']);
const files = new Set([
  'package.json',
  'package-lock.json',
  '.gitignore',
  '.gitattributes',
  '.prettierrc.json',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'requirements-build.txt',
  'main.cjs',
  'preload.cjs',
]);
function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix + e.name;
    if (
      e.name === '__pycache__' ||
      (!prefix && ['node_modules', 'dist', 'build', 'artifacts', '.git'].includes(e.name))
    )
      return [];
    return e.isDirectory() ? walk(path.join(dir, e.name), rel + '/') : [rel];
  });
}
let tracked;
try {
  tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\0')
    .filter(Boolean);
} catch {
  tracked = walk(root);
}
const violations = [];
for (const file of tracked) {
  const absolute = path.join(root, file),
    first = file.split('/')[0];
  if (!files.has(file) && !roots.has(first)) violations.push(file + ': outside source allowlist');
  if (
    /(?:^|\/)(?:data|user-data|observer|dist|node_modules)\/|(?:^|\/)(?:\.env|\.DS_Store)(?:[.]|$)|\.(?:sqlite\w*|jsonl|pem|key|enc|exe|dmg|zip|log|pyc)$/.test(
      file,
    )
  )
    violations.push(file + ': private or generated file');
  const bytes = fs.readFileSync(absolute);
  if (file.endsWith('.png')) {
    if (!file.startsWith('assets/') || bytes.subarray(1, 4).toString() !== 'PNG')
      violations.push(file + ': unexpected image');
    continue;
  }
  const value = bytes.toString('utf8');
  const patterns = [
    [/[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\s'"/\\]+/i, 'personal Windows path'],
    [/\/Users\/[^\s'"/]+/, 'personal Mac path'],
    [new RegExp('(?:gh' + 'p_|github_' + 'pat_|sk-' + 'proj-)[A-Za-z0-9_-]{15,}'), 'credential'],
    [new RegExp('-----BEGIN ' + '(?:RSA |EC |OPENSSH )?PRIVATE KEY-----'), 'private key'],
    [/[A-Z0-9._%+-]+@(?!users\.noreply\.github\.com)[A-Z0-9.-]+\.[A-Z]{2,}/i, 'email address'],
  ];
  for (const [pattern, label] of patterns)
    if (!(file === 'package-lock.json' && label === 'email address') && pattern.test(value))
      violations.push(file + ': ' + label);
  if (bytes.length > 700000) violations.push(file + ': unexpectedly large source file');
}
if (violations.length) {
  process.stderr.write(violations.join('\n') + '\n');
  process.exit(1);
}
const pkg = require('../package.json');
const allowedFiles = [
  'main.cjs',
  'preload.cjs',
  'src/**',
  'ui/**',
  'assets/**',
  'package.json',
  'LICENSE',
];
if (JSON.stringify(pkg.build.files) !== JSON.stringify(allowedFiles))
  throw new Error('Review the package allowlist before releasing.');
process.stdout.write(
  'Release privacy audit passed: ' +
    tracked.length +
    ' source files, explicit package allowlist, no personal paths or credentials.\n',
);
if (process.argv.includes('--checksums')) {
  const dir = path.join(root, 'dist');
  const assets = fs.readdirSync(dir).filter((f) => /^Work-Updates-.*\.(exe|zip|dmg)$/.test(f));
  if (!assets.length) throw new Error('No installers were built.');
  fs.writeFileSync(
    path.join(dir, 'SHA256-' + process.platform + '-' + process.arch + '.txt'),
    assets
      .map(
        (f) =>
          crypto
            .createHash('sha256')
            .update(fs.readFileSync(path.join(dir, f)))
            .digest('hex') +
          '  ' +
          f,
      )
      .join('\n') + '\n',
  );
}
