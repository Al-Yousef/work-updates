'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
class BrowserVault {
  constructor({ directory, encrypt, decrypt, available }) {
    this.directory = path.join(directory, 'browser-vault');
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.available = available;
  }
  file(id) {
    if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('Invalid saved-login identity.');
    if (!this.available())
      throw new Error(
        'OS credential encryption is unavailable. No plaintext fallback is permitted.',
      );
    if (!fs.existsSync(this.directory)) fs.mkdirSync(this.directory, { mode: 0o700 });
    const root = fs.realpathSync.native(path.dirname(this.directory)),
      st = fs.lstatSync(this.directory);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      path.relative(root, fs.realpathSync.native(this.directory)) !== 'browser-vault'
    )
      throw new Error('Private browser vault requires recovery.');
    return path.join(this.directory, id + '.enc');
  }
  save(actorId, origin, cookies) {
    if (
      !Array.isArray(cookies) ||
      cookies.length > 256 ||
      Buffer.byteLength(JSON.stringify(cookies)) > 512 * 1024
    )
      throw new Error('Saved login exceeds its private bound.');
    const id = crypto.randomUUID(),
      file = this.file(id),
      bytes = this.encrypt(JSON.stringify({ schema: 1, actorId, origin, cookies }));
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    const result = this.load(actorId, origin, id);
    if (JSON.stringify(result) !== JSON.stringify(cookies))
      throw new Error('Saved login readback was not confirmed.');
    return id;
  }
  load(actorId, origin, id) {
    const file = this.file(id),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new Error('Saved login is unavailable.');
    const v = JSON.parse(this.decrypt(fs.readFileSync(file)));
    if (
      v.schema !== 1 ||
      v.actorId !== actorId ||
      v.origin !== origin ||
      !Array.isArray(v.cookies) ||
      v.cookies.length > 256
    )
      throw new Error('Saved login belongs to another owner or destination.');
    return v.cookies;
  }
}
module.exports = { BrowserVault };
