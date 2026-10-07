'use strict';
const https = require('node:https'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  net = require('node:net'),
  crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const selfsigned = require('selfsigned');
const peerContract = require('./peer-contract.cjs');
const { StatePublisher } = require('./state-order.cjs');
const allowed = new Set([
  'create',
  'start',
  'action',
  'undo',
  'send',
  'queueMessage',
  'cancelMessage',
  'clearMessages',
  'stop',
  'respond',
  'details',
  'group',
  'refresh',
  'open',
]);
const fingerprint = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
function privateAddress(host) {
  if (net.isIP(host) !== 4) return false;
  const n = host.split('.').map(Number);
  return (
    n[0] === 10 ||
    n[0] === 127 ||
    (n[0] === 192 && n[1] === 168) ||
    (n[0] === 172 && n[1] >= 16 && n[1] <= 31) ||
    (n[0] === 100 && n[1] >= 64 && n[1] <= 127)
  );
}
function interfaces() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i.family === 'IPv4' && privateAddress(i.address))
    .map((i) => i.address);
}
function parseCode(code) {
  if (typeof code !== 'string' || code.length > 2000 || !code.startsWith('wu1:'))
    throw new Error('Paste a Work Updates pairing code.');
  let value;
  try {
    value = JSON.parse(Buffer.from(code.slice(4), 'base64url').toString());
  } catch {
    throw new Error('This pairing code is incomplete.');
  }
  if (
    !privateAddress(value.host) ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(value.pin) ||
    !/^[a-f0-9]{64}$/.test(value.token)
  )
    throw new Error('This pairing code is invalid.');
  return value;
}
class HostPeer extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.clients = new Set();
    this.publisher = new StatePublisher();
    this.file = path.join(options.directory, 'paired-host.enc');
  }
  async start(host) {
    if (!privateAddress(host) || !interfaces().includes(host))
      throw new Error('Choose a private IPv4 address assigned to this desktop.');
    if (this.server && this.host === host) return this.code;
    this.close();
    let credentials;
    try {
      credentials = JSON.parse(this.options.decrypt(fs.readFileSync(this.file)));
    } catch {}
    if (!credentials?.private || !credentials?.cert || !credentials?.token) {
      const cert = await selfsigned.generate(
        [{ name: 'commonName', value: 'Work Updates paired desktop' }],
        { days: 365, keySize: 2048, algorithm: 'sha256' },
      );
      credentials = {
        private: cert.private,
        cert: cert.cert,
        token: crypto.randomBytes(32).toString('hex'),
      };
    }
    this.credentials = credentials;
    this.host = host;
    const server = https.createServer(
      { key: credentials.private, cert: credentials.cert, minVersion: 'TLSv1.2' },
      (req, res) => this.request(req, res),
    );
    this.server = server;
    server.headersTimeout = 10000;
    server.requestTimeout = 15000;
    server.on('tlsClientError', () => {});
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port || 0, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    server.on('error', () => this.emit('connection', false));
    const pin = fingerprint(new crypto.X509Certificate(credentials.cert).raw);
    this.code =
      'wu1:' +
      Buffer.from(
        JSON.stringify({ host, port: server.address().port, pin, token: credentials.token }),
      ).toString('base64url');
    fs.mkdirSync(this.options.directory, { recursive: true });
    fs.writeFileSync(
      this.file,
      this.options.encrypt(JSON.stringify({ ...credentials, host, port: server.address().port })),
      { mode: 0o600 },
    );
    return this.code;
  }
  saved() {
    try {
      return JSON.parse(this.options.decrypt(fs.readFileSync(this.file)));
    } catch {
      return null;
    }
  }
  async restore() {
    const saved = this.saved();
    if (saved?.host) {
      this.options.port = saved.port;
      await this.start(saved.host);
    }
  }
  authorized(req) {
    if (req.headers.origin) return false;
    const expected = Buffer.from('Bearer ' + this.credentials.token),
      provided = Buffer.from(req.headers.authorization || '');
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  }
  json(res, status, value) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  }
  contractState(state) {
    const contract = peerContract.capabilities(this.options.commands);
    if (state.executorReport !== undefined) {
      require('./executor-report.cjs').validate(state.executorReport, state.host?.id);
      contract.executorReports = 1;
    }
    return {
      ...(state.stateVersion ? state : this.publisher.stamp(state)),
      peerContract: contract,
    };
  }
  state() {
    return this.contractState(this.options.state());
  }
  request(req, res) {
    if (!this.authorized(req)) return this.json(res, 401, { error: 'Pairing required.' });
    if (req.method === 'GET' && req.url === '/state') return this.json(res, 200, this.state());
    if (req.method === 'GET' && req.url === '/events') {
      if (this.clients.size >= 8)
        return this.json(res, 429, { error: 'Too many connected devices.' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
      });
      this.clients.add(res);
      res.write('data: ' + JSON.stringify(this.state()) + '\n\n');
      const timer = setInterval(() => res.write(': keepalive\n\n'), 15000);
      req.on('close', () => {
        clearInterval(timer);
        this.clients.delete(res);
      });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/command')
      return this.json(res, 404, { error: 'Unknown action.' });
    if (req.headers['content-type'] !== 'application/json')
      return this.json(res, 415, { error: 'JSON required.' });
    let body = '',
      size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64000) {
        this.json(res, 413, { error: 'Request too large.' });
        req.destroy();
      } else body += chunk;
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        return this.json(res, 400, { error: 'Invalid request.' });
      }
      if (
        !allowed.has(input.method) ||
        !input.input ||
        typeof input.input !== 'object' ||
        Array.isArray(input.input)
      )
        return this.json(res, 400, { error: 'Unknown action.' });
      try {
        peerContract.admission(this.state(), input.method, input);
        this.json(res, 200, {
          ok: true,
          value: await this.options.command(input.method, input.input),
        });
      } catch (error) {
        this.json(res, 400, {
          ok: false,
          error: error.message,
          code: error.code,
          delivery: error.delivery,
        });
      }
    });
  }
  broadcast(state) {
    this.latest = this.contractState(structuredClone(state));
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const data = 'data: ' + JSON.stringify(this.latest) + '\n\n';
      for (const res of this.clients) {
        if (res.writableLength > 2e6) {
          res.destroy();
          this.clients.delete(res);
        } else res.write(data);
      }
    }, 200);
  }
  revoke() {
    this.close();
    fs.rmSync(this.file, { force: true });
    this.credentials = null;
    this.code = null;
  }
  close() {
    clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
    for (const res of this.clients) res.destroy();
    this.clients.clear();
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = null;
  }
}
class RemotePeer extends EventEmitter {
  constructor(code) {
    super();
    this.address = parseCode(code);
    this.connected = false;
    this.closed = false;
    this.attempt = 0;
    this.requests = new Set();
    this.generation = 0;
  }
  request(route, method = 'GET', body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : undefined;
      const req = https.request(
        {
          host: this.address.host,
          port: this.address.port,
          path: route,
          method,
          agent: false,
          rejectUnauthorized: false,
          minVersion: 'TLSv1.2',
          headers: {
            Authorization: 'Bearer ' + this.address.token,
            ...(data ? { 'Content-Type': 'application/json' } : {}),
          },
        },
        (res) => {
          req.setTimeout(0);
          if (res.statusCode !== 200 && !(route === '/command' && res.statusCode === 400)) {
            res.resume();
            reject(
              new Error(
                res.statusCode === 401
                  ? 'Pairing was revoked. Pair these devices again.'
                  : 'The paired desktop could not complete this action.',
              ),
            );
            return;
          }
          resolve(res);
        },
      );
      this.requests.add(req);
      req.on('close', () => this.requests.delete(req));
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('The paired desktop is unavailable.')));
      // Do not send the bearer token or command until the actual TLS certificate matches the pairing code.
      req.on('socket', (socket) =>
        socket.once('secureConnect', () => {
          const raw = socket.getPeerCertificate().raw;
          if (!raw || fingerprint(raw) !== this.address.pin) {
            req.destroy(new Error('This desktop certificate does not match your pairing.'));
            return;
          }
          req.end(data);
        }),
      );
    });
  }
  async json(route, method, body) {
    const res = await this.request(route, method, body);
    const chunks = [];
    let size = 0;
    for await (const chunk of res) {
      size += chunk.length;
      if (size > 16e6) {
        res.destroy();
        throw new Error('The paired response was too large.');
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async connect() {
    if (this.connecting) return this.connecting;
    this.closed = false;
    const generation = ++this.generation;
    const pending = (async () => {
      try {
        const state = await this.json('/state');
        if (this.closed || generation !== this.generation) throw new Error('Pairing was closed.');
        peerContract.negotiate(state);
        this.state = state;
        this.connected = true;
        this.attempt = 0;
        this.emit('state', state);
        this.emit('connection', true);
        await this.events(generation);
      } catch (error) {
        if (generation === this.generation && !this.closed) {
          this.connected = false;
          this.emit('connection', false);
        }
        throw error;
      }
    })();
    this.connecting = pending;
    try {
      return await pending;
    } finally {
      if (this.connecting === pending) this.connecting = null;
    }
  }
  async events(generation = this.generation) {
    if (this.closed) return;
    const res = await this.request('/events');
    if (this.closed || generation !== this.generation) {
      res.destroy();
      return;
    }
    this.stream = res;
    res.setTimeout(45000, () => res.destroy());
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    res.on('data', (chunk) => {
      if (this.closed || generation !== this.generation) return;
      buffer += decoder.write(chunk);
      if (buffer.length > 16e6) {
        res.destroy();
        return;
      }
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (event.startsWith('data: ')) {
          try {
            const value = JSON.parse(event.slice(6));
            peerContract.negotiate(value);
            const previous = this.state?.stateVersion;
            if (
              !previous ||
              !value.stateVersion ||
              previous.epoch !== value.stateVersion.epoch ||
              previous.revision < value.stateVersion.revision
            )
              this.state = value;
            this.emit('state', value);
          } catch (error) {
            if (error.code === 'PEER_CAPABILITY') res.destroy();
          }
        }
      }
    });
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (this.closed || generation !== this.generation) return;
      this.connected = false;
      this.emit('connection', false);
      this.reconnect();
    };
    res.on('end', end);
    res.on('error', end);
    res.on('close', end);
  }
  reconnect() {
    if (this.closed) return;
    clearTimeout(this.timer);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5));
    this.timer = setTimeout(() => this.connect().catch(() => this.reconnect()), delay);
  }
  resync() {
    if (this.closed) return;
    this.generation++;
    this.connected = false;
    this.stream?.destroy();
    this.emit('connection', false);
    this.reconnect();
  }
  async command(method, input = {}) {
    if (!allowed.has(method)) throw new Error('Unknown paired action.');
    if (!this.connected) throw new Error('Reconnect to your desktop before sending this action.');
    const contract = peerContract.negotiate(this.state);
    peerContract.admission(
      this.state,
      method,
      contract.version === 2
        ? { peerProtocolVersion: 2, hostEpoch: this.state?.stateVersion?.epoch }
        : undefined,
    );
    const out = await this.json('/command', 'POST', {
      method,
      input,
      ...(contract.version === 2
        ? { peerProtocolVersion: 2, hostEpoch: this.state?.stateVersion?.epoch }
        : {}),
    });
    if (!out.ok)
      throw Object.assign(new Error(out.error || 'The desktop rejected this action.'), {
        code: out.code,
        delivery: out.delivery,
      });
    return out.value;
  }
  close() {
    this.generation++;
    this.closed = true;
    this.connected = false;
    clearTimeout(this.timer);
    this.stream?.destroy();
    for (const req of this.requests) req.destroy();
    this.requests.clear();
  }
}
module.exports = { HostPeer, RemotePeer, parseCode, privateAddress, interfaces, fingerprint };
