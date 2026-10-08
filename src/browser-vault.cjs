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
  inspectOwned(actorId) {
    if (!fs.existsSync(this.directory)) return [];
    this.file(crypto.randomUUID()); // Guard encryption and redirects even for an empty vault.
    const names = fs.readdirSync(this.directory).sort();
    if (
      names.length > 128 ||
      names.some(
        (name) => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.enc$/.test(name),
      )
    )
      throw new Error('Saved-login inventory requires recovery.');
    const selected = [];
    for (const name of names) {
      const id = name.slice(0, -4),
        file = this.file(id),
        stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
        throw new Error('Saved login is unavailable.');
      const bytes = fs.readFileSync(file),
        value = JSON.parse(this.decrypt(bytes));
      if (value.schema !== 1 || typeof value.actorId !== 'string')
        throw new Error('Saved-login ownership requires recovery.');
      if (value.actorId !== actorId) continue;
      const destination = new URL(value.origin);
      if (
        destination.protocol !== 'https:' ||
        destination.origin !== value.origin ||
        !Array.isArray(value.cookies) ||
        value.cookies.length > 256
      )
        throw new Error('Saved-login destination requires recovery.');
      selected.push({
        name: 'browser-vault/' + name,
        origin: destination.origin,
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      });
    }
    return selected;
  }
  forget(actorId, id) {
    const file = this.file(id),
      owned = this.inspectOwned(actorId).find((row) => row.name === 'browser-vault/' + id + '.enc');
    if (!owned) throw new Error('Select an existing saved login owned by the current human.');
    this.load(actorId, owned.origin, id);
    const stat = fs.lstatSync(this.file(id));
    if (!stat.isFile() || stat.isSymbolicLink() ||
        crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== owned.sha256)
      throw new Error('Saved login changed before removal. Original bytes are preserved.');
    fs.unlinkSync(file);
    if (fs.existsSync(file)) throw new Error('Saved-login removal was not confirmed.');
    return { vaultId: id, origin: owned.origin, savedLoginForgotten: true,
      activeBrowserLoginCleared: false, externalSessionsRevoked: false };
  }
}
module.exports = { BrowserVault };
