'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto'),
  { execFile } = require('node:child_process');
function reader(options = {}) {
  const home = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  let closed = false;
  const children = new Set();
  function storeId() {
    const canonical = fs.realpathSync(home);
    return crypto
      .createHash('sha256')
      .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
      .digest('hex');
  }
  async function read(request) {
    if (closed) throw new Error('The scoped reader is closed');
    request.beforeRead();
    if (storeId() !== request.storeId) throw new Error('The selected local Codex store changed');
    const bundled = path.join(
        os.homedir(),
        '.cache',
        'codex-runtimes',
        'codex-primary-runtime',
        'dependencies',
        'python',
        process.platform === 'win32' ? 'python.exe' : 'bin/python3',
      ),
      python =
        options.python ||
        (fs.existsSync(bundled) ? bundled : process.platform === 'win32' ? 'python' : 'python3'),
      script = options.helperScript || path.join(__dirname, '..', 'bridge', 'collector.py'),
      useHelper =
        options.helper && !options.python && (!options.helperScript || !fs.existsSync(bundled)),
      binary = useHelper ? options.helper : python,
      args = [
        ...(useHelper ? [] : ['-X', 'utf8', script]),
        '--read-thread',
        request.scope.sourceId,
        '--codex-home',
        home,
        '--since',
        String(request.since),
        '--until',
        String(request.until),
        '--request-nonce',
        request.nonce,
        '--record-limit',
        String(request.limit),
      ];
    request.beforeRead();
    return new Promise((resolve, reject) => {
      const child = execFile(
        binary,
        args,
        { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout) => {
          children.delete(child);
          if (error)
            return reject(
              Object.assign(new Error('The scoped original reader is unavailable'), {
                code: 'RESEARCH_READ_FAILED',
              }),
            );
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(
              Object.assign(new Error('The scoped reader returned an invalid record envelope'), {
                code: 'RESEARCH_READ_INVALID',
              }),
            );
          }
        },
      );
      children.add(child);
    });
  }
  return {
    storeId,
    read,
    close() {
      closed = true;
      for (const child of children) child.kill();
      children.clear();
    },
  };
}
module.exports = { reader };
