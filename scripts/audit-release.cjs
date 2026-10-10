'use strict';
// Inspect tracked source, not the developer's app-data directory. Fail closed on extras.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const roots = new Set([
  'src',
  'ui',
  'bridge',
  'tests',
  'scripts',
  'docs',
  'assets',
  '.github',
  'ios',
]);
const files = new Set([
  'package.json',
  'package-lock.json',
  '.gitignore',
  '.gitattributes',
  '.prettierrc.json',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'requirements-build.txt',
  'requirements-qa.txt',
  'main.cjs',
  'preload.cjs',
  // Review-only inbox source. Keep its runtime data and evidence outside this allowlist.
  'candidate/dot-inbox/CONTRACT.md',
  'candidate/dot-inbox/README.md',
  'candidate/dot-inbox/app.js',
  'candidate/dot-inbox/model.js',
  'candidate/dot-inbox/fixture.cjs',
  'candidate/dot-inbox/protocol-fixture.cjs',
  'candidate/dot-inbox/server.cjs',
  'candidate/dot-inbox/journal.cjs',
  'candidate/dot-inbox/style.css',
  'candidate/dot-inbox/index.html',
  'candidate/dot-inbox/desktop/main.cjs',
  'candidate/dot-inbox/desktop/preload.cjs',
  'candidate/dot-inbox/desktop/policy.cjs',
  'candidate/dot-inbox/desktop/window.cjs',
  'candidate/dot-inbox/desktop/desktop.css',
]);
const nativeTop = new Set(['.gitignore', 'README.md', 'MIGRATION.md', 'THIRD_PARTY_NOTICES.txt', 'app.manifest', 'app.rc', 'app-dll.rc', 'control.rc', 'build.ps1', 'install-preview.ps1', 'toolchain.json', 'bootstrap-toolchain.ps1']);
function allowedNative(file) {
  if (!file.startsWith('native/windows/')) return false;
  const rel = file.slice('native/windows/'.length);
  return nativeTop.has(rel) ||
    /^(?:src|tests)\/[^/]+\.(?:h|cpp)$/.test(rel) ||
    /^scripts\/[^/]+\.(?:py|ps1)$/.test(rel) ||
    rel === 'assets/icon.ico' ||
    /^(?:vendor\/nlohmann|taskbar-adapter)(?:\/vendor\/minhook)?\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:h|hpp|c|cpp|md|txt|json|MIT)$/.test(rel);
}
const vendorHeader = 'native/windows/vendor/nlohmann/json.hpp';
const vendorDigest = 'aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63';
function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix + e.name;
    if (
      e.name === '__pycache__' ||
      ['.build', '.swiftpm', 'DerivedData', '.tools', '__pycache__'].includes(e.name) ||
      e.name.endsWith('.xcodeproj') ||
      (!prefix && ['node_modules', 'dist', 'build', 'artifacts', '.git'].includes(e.name))
    )
      return [];
    return e.isDirectory() ? walk(path.join(dir, e.name), rel + '/') : [rel];
  });
}
let tracked;
try {
  const args = ['ls-files', '-z'];
  if (process.argv.includes('--include-untracked'))
    args.push('--cached', '--others', '--exclude-standard');
  tracked = execFileSync('git', args, {
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
  if (!files.has(file) && !roots.has(first) && !allowedNative(file)) violations.push(file + ': outside source allowlist');
  if (
    /(?:^|\/)(?:data|user-data|observer|dist|node_modules)\/|(?:^|\/)(?:\.env|\.DS_Store)(?:[.]|$)|\.(?:sqlite\w*|jsonl|pem|key|enc|exe|dmg|zip|log|pyc)$/.test(
      file,
    )
  )
    violations.push(file + ': private or generated file');
  const bytes = fs.readFileSync(absolute);
  const reviewedVendor = file === vendorHeader && crypto.createHash('sha256').update(bytes).digest('hex') === vendorDigest;
  if (file === vendorHeader && !reviewedVendor) violations.push(file + ': vendored header digest changed');
  if (file.endsWith('.png')) {
    if (
      (!file.startsWith('assets/') &&
        file !== 'ios/App/Assets.xcassets/AppIcon.appiconset/icon.png') ||
      bytes.subarray(1, 4).toString() !== 'PNG'
    )
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
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i, 'fixed private chat identity'],
  ];
  for (const [pattern, label] of patterns)
    if (!((file === 'package-lock.json' || reviewedVendor) && label === 'email address') && pattern.test(value))
      violations.push(file + ': ' + label);
  if (bytes.length > 700000 && !reviewedVendor) violations.push(file + ': unexpectedly large source file');
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
