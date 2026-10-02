'use strict';
const fs = require('node:fs');
const path = require('node:path');

function redact(value) {
  return String(value)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[\w-]+|ghp_[\w]+|github_pat_[\w]+)\b/g, '[redacted]')
    .replace(
      /(["']?(?:access_token|refresh_token|api_key|password|authorization)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
      '$1"[redacted]"',
    )
    .slice(0, 4000);
}

class DiagnosticLog {
  constructor(directory, { name = 'app.log', maxBytes = 512 * 1024, backups = 2 } = {}) {
    this.directory = directory;
    this.file = path.join(directory, name);
    this.maxBytes = maxBytes;
    this.backups = backups;
    this.error = null;
  }
  write(event, details = {}) {
    // Callers supply metadata, never RPC params/results or chat contents.
    const fields = {};
    for (const [key, value] of Object.entries(details)) {
      if (['string', 'number', 'boolean'].includes(typeof value) || value === null)
        fields[key] = typeof value === 'string' ? redact(value) : value;
    }
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n';
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      let size = 0;
      try {
        size = fs.statSync(this.file).size;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (size && size + Buffer.byteLength(line) > this.maxBytes) {
        for (let n = this.backups; n >= 1; n--) {
          const destination = this.file + '.' + n;
          const source = n === 1 ? this.file : this.file + '.' + (n - 1);
          fs.rmSync(destination, { force: true });
          try {
            fs.renameSync(source, destination);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      }
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      this.error = null;
    } catch (error) {
      // A full disk or denied log folder must not break a running chat.
      this.error = error.code || 'LOG_WRITE_FAILED';
    }
  }
}
module.exports = { DiagnosticLog, redact };
