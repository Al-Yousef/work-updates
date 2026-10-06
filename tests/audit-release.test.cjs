'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyphen-source-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(__dirname, '../scripts/audit-release.cjs'), path.join(root, 'scripts/audit-release.cjs'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ build: { files: ['main.cjs', 'preload.cjs', 'src/**', 'ui/**', 'assets/**', 'package.json', 'LICENSE'] } }));
  const write = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  return { root, write, run: () => spawnSync(process.execPath, [path.join(root, 'scripts/audit-release.cjs')], { cwd: root, encoding: 'utf8' }) };
}
test('source audit rejects fixed private chat identities in reusable scripts', t => {
  const f = fixture(t), id = require('node:crypto').randomUUID().split('-');
  id[2] = '7' + id[2].slice(1);
  f.write('scripts/private-fixture.cjs', 'const source = ' + JSON.stringify(id.join('-')) + ';');
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /fixed private chat identity/);
});
test('native source allowlist rejects generated executables', t => {
  const f = fixture(t); f.write('native/windows/src/generated.exe', 'synthetic binary');
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /private or generated file/);
});
test('the vendor size/email exception is tied to the reviewed header digest', t => {
  const f = fixture(t), header = fs.readFileSync(path.join(__dirname, '../native/windows/vendor/nlohmann/json.hpp'));
  f.write('native/windows/vendor/nlohmann/json.hpp', header);
  assert.equal(f.run().status, 0);
  f.write('native/windows/vendor/nlohmann/json.hpp', Buffer.concat([header, Buffer.from('\nchanged\n')]));
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /vendored header digest changed/);
});
