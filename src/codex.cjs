'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');

const messageMutation = (method) => ['turn/start', 'turn/steer'].includes(method);
const rpcPhase = (method) => messageMutation(method) ? 'awaiting-receipt' : 'preparing-chat';

function findCodex(override) {
  if (override && path.isAbsolute(override) && fs.existsSync(override)) return override;
  if (process.platform === 'win32') {
    const base = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'OpenAI',
      'Codex',
      'bin',
    );
    try {
      const files = fs
        .readdirSync(base)
        .map((d) => path.join(base, d, 'codex.exe'))
        .filter((p) => fs.existsSync(p))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (files.length) return files[0];
    } catch {}
  }
  for (const file of [
    '/Applications/Codex.app/Contents/Resources/codex',
    path.join(os.homedir(), 'Applications/Codex.app/Contents/Resources/codex'),
  ])
    if (fs.existsSync(file)) return file;
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}
class Codex extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.sequence = 0;
    this.waiting = new Map();
    this.active = new Map();
    this.loaded = new Set();
    this.proc = null;
    this.connecting = null;
    this.ready = false;
    this.lastFailure = null;
  }
  log(event, details) {
    this.options.log?.write(event, details);
  }
  status() {
    return {
      connected: this.ready,
      pid: this.proc?.pid || null,
      pending: this.waiting.size,
      loaded: this.loaded.size,
      active: this.active.size,
      lastFailure: this.lastFailure,
    };
  }
  fail(connection, reason, details = {}) {
    if (connection.closed) return;
    connection.closed = true;
    const error = new Error(
      connection.intentional
        ? 'Work Updates closed its Codex connection.'
        : 'Codex disconnected. Open chat to check its progress before retrying.',
    );
    error.code = details.code || 'CODEX_DISCONNECTED';
    const affected = new Set([...this.loaded, ...this.active.keys()]);
    for (const [id, pending] of this.waiting) {
      if (pending.proc !== connection.proc) continue;
      if (pending.threadId) affected.add(pending.threadId);
      clearTimeout(pending.timer);
      this.waiting.delete(id);
      // Each pending request has its own delivery boundary. A broken resume
      // cannot have sent the draft, even if another turn lost its receipt.
      const failure = new Error(error.message);
      failure.code = error.code;
      failure.method = pending.method;
      failure.phase = rpcPhase(pending.method);
      failure.delivery = messageMutation(pending.method) ? 'uncertain' : 'not-sent';
      pending.reject(failure);
    }
    this.log('codex.connection.closed', {
      pid: connection.proc.pid,
      reason,
      intentional: !!connection.intentional,
      ...details,
    });
    if (this.connection === connection) {
      this.ready = false;
      this.proc = null;
      this.loaded.clear();
      this.active.clear();
      if (!connection.intentional) {
        this.lastFailure = { at: new Date().toISOString(), reason, ...details };
        this.emit('disconnected', { threadIds: [...affected], message: error.message });
      }
    }
    connection.reader.close();
    // Retire only our own broken transport, so it cannot keep a writer lock
    // after a replacement connection is created.
    try {
      if (connection.proc.exitCode == null) connection.proc.kill();
    } catch (error) {
      this.log('codex.process.cleanup_failed', {
        pid: connection.proc.pid,
        code: error.code,
        message: error.message,
      });
    }
  }
  write(message, proc = this.proc) {
    const connection = this.connection;
    if (!proc || proc !== connection?.proc || connection.closed)
      throw new Error('Install or open Codex, then try again.');
    try {
      proc.stdin.write(JSON.stringify(message) + '\n', (error) => {
        if (error)
          this.fail(connection, 'stdin write failed', { code: error.code, message: error.message });
      });
    } catch (error) {
      this.fail(connection, 'stdin write failed', { code: error.code, message: error.message });
      throw error;
    }
  }
  async connect() {
    if (this.proc && this.ready) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const binary = findCodex(this.options.binary);
      const proc = (this.options.spawn || spawn)(binary, ['app-server'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = proc;
      const rl = readline.createInterface({ input: proc.stdout });
      this.reader = rl;
      const connection = { proc, reader: rl, closed: false, intentional: false };
      this.connection = connection;
      this.log('codex.process.start', { binary, pid: proc.pid });
      rl.on('line', (line) => {
        if (connection.closed || this.connection !== connection) return;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          this.log('codex.protocol.invalid', { pid: proc.pid, bytes: Buffer.byteLength(line) });
          return;
        }
        try {
          if (m.method && m.id !== undefined) this.emit('request', m);
          else if (m.method) {
            if (m.method === 'thread/closed') {
              this.loaded.delete(m.params.threadId);
              this.active.delete(m.params.threadId);
            }
            if (m.method === 'turn/started') this.active.set(m.params.threadId, m.params.turn.id);
            if (m.method === 'turn/completed') this.active.delete(m.params.threadId);
            if (['turn/started', 'turn/completed'].includes(m.method))
              this.log('codex.' + m.method.replace('/', '.'), {
                pid: proc.pid,
                threadId: m.params.threadId,
                turnId: m.params.turn.id,
                status: m.params.turn.status,
                message: m.params.turn.error?.message,
              });
            this.emit('notification', m);
          } else if (m.id !== undefined) {
            const pending = this.waiting.get(m.id);
            if (pending) {
              this.waiting.delete(m.id);
              clearTimeout(pending.timer);
              this.log(m.error ? 'codex.rpc.error' : 'codex.rpc.completed', {
                pid: proc.pid,
                id: m.id,
                method: pending.method,
                threadId: pending.threadId,
                elapsedMs: Date.now() - pending.startedAt,
                bytes: Buffer.byteLength(line),
                code: m.error?.code,
                message: m.error?.message,
              });
              if (m.error) {
                const error = new Error(m.error.message);
                error.code = m.error.code;
                error.method = pending.method;
                error.phase = rpcPhase(pending.method);
                error.delivery = 'not-sent';
                pending.reject(error);
              } else pending.resolve(m.result);
            }
          }
        } catch (error) {
          this.log('codex.handler.error', { method: m.method, message: error.message });
        }
      });
      // Bound each stderr line before storing it. Never record RPC payloads.
      let stderr = '',
        overflow = false;
      const flush = () => {
        if (stderr.trim())
          this.log('codex.stderr', { pid: proc.pid, message: stderr, truncated: overflow });
        stderr = '';
        overflow = false;
      };
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => {
        for (const part of chunk.split(/(?<=\n)/)) {
          if (part.length > 8192 - stderr.length) overflow = true;
          stderr += part.slice(0, Math.max(0, 8192 - stderr.length));
          if (part.endsWith('\n')) flush();
        }
      });
      proc.stderr.once('end', flush);
      proc.once('error', (error) =>
        this.fail(connection, 'process error', { code: error.code, message: error.message }),
      );
      proc.stdin.on('error', (error) =>
        this.fail(connection, 'stdin error', { code: error.code, message: error.message }),
      );
      proc.once('exit', (code, signal) => {
        this.log('codex.process.exit', { pid: proc.pid, exitCode: code, signal });
        this.fail(connection, 'process exited', { exitCode: code, signal });
      });
      rl.once('close', () => this.fail(connection, 'stdout closed'));
      try {
        await this.call('initialize', {
          clientInfo: {
            name: 'work_updates',
            title: 'Work Updates',
            version: require('../package.json').version,
          },
          capabilities: { experimentalApi: true },
        });
        this.notify('initialized', {});
        if (connection.closed) throw new Error('Codex disconnected during initialization.');
        this.ready = true;
        this.lastFailure = null;
        this.log('codex.connection.ready', { pid: proc.pid });
      } catch (error) {
        this.fail(connection, 'initialization failed', {
          code: error.code,
          message: error.message,
        });
        throw error;
      }
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }
  call(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('Install or open Codex, then try again.'));
      const proc = this.proc;
      const id = ++this.sequence,
        timer = setTimeout(() => {
          this.waiting.delete(id);
          this.log('codex.rpc.timeout', {
            pid: proc.pid,
            id,
            method,
            phase: rpcPhase(method),
            delivery: messageMutation(method) ? 'uncertain' : 'not-sent',
            threadId: params?.threadId,
            timeoutMs: this.options.requestTimeoutMs || 60000,
          });
          const error = new Error(
            'Codex took too long to confirm ' + method + '. Open chat to check before retrying.',
          );
          error.code = 'CODEX_TIMEOUT';
          error.method = method;
          error.phase = rpcPhase(method);
          error.delivery = messageMutation(method) ? 'uncertain' : 'not-sent';
          reject(error);
          // A late resume must not leave a hidden writer behind after its
          // timeout. Retire only our helper, and only when it has no active
          // turn or other outstanding RPC. Never retire a live send timeout.
          if (method === 'thread/resume' && !this.waiting.size && !this.loaded.size && !this.active.size &&
              this.connection?.proc === proc) {
            this.connection.intentional = true;
            this.fail(this.connection, 'idle preparation timed out', { method, code: error.code });
          }
        }, this.options.requestTimeoutMs || 60000);
      this.waiting.set(id, {
        resolve,
        reject,
        timer,
        proc,
        method,
        threadId: params?.threadId,
        startedAt: Date.now(),
      });
      this.log('codex.rpc.started', { pid: proc.pid, id, method, threadId: params?.threadId });
      try {
        this.write({ id, method, params }, proc);
      } catch (error) {
        clearTimeout(timer);
        this.waiting.delete(id);
        reject(error);
      }
    });
  }
  notify(method, params) {
    this.write({ method, params });
  }
  reply(id, result) {
    this.write({ id, result });
  }
  reject(id) {
    this.write({
      id,
      error: { code: -32601, message: 'This request needs to be handled in Codex.' },
    });
  }
  async start(task, cwd) {
    await this.connect();
    let id = task.threadId;
    if (!id) {
      const out = await this.call('thread/start', {
        cwd,
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        developerInstructions:
          'This task is shown in Work Updates, a compact task queue. Keep progress concise. When input or an external dependency prevents completion, clearly state what is needed and whether the task is blocked or waiting. A completed pass means ready for review; the user decides when the overall task is Done.',
      });
      id = out.thread.id;
      this.loaded.add(id);
      this.emit('created', { taskId: task.id, threadId: id });
      await this.call('thread/name/set', { threadId: id, name: task.title });
    } else if (!this.loaded.has(id)) {
      await this.prepare(id);
    }
    const turn = await this.call('turn/start', {
      threadId: id,
      input: [{ type: 'text', text: task.prompt }],
    });
    return { threadId: id, turnId: turn.turn.id };
  }
  async prepare(threadId) {
    try {
      await this.connect();
      if (!this.loaded.has(threadId)) {
        // Hyphen already reads the conversation from its collector. Returning
        // image/tool history here can produce hundreds of MB of unused JSON.
        const resumed = await this.call('thread/resume', { threadId, excludeTurns: true });
        if (resumed.thread?.id !== threadId)
          throw new Error('Codex resumed an unexpected chat. No message was sent.');
        this.loaded.add(threadId);
      }
      this.emit('loaded', { threadId });
    } catch (error) {
      error.delivery = 'not-sent';
      error.phase = 'preparing-chat';
      if (['CODEX_TIMEOUT', 'CODEX_DISCONNECTED'].includes(error.code))
        error.message = 'Could not reopen this chat in Codex. Your message was not sent. Try again.';
      throw error;
    }
  }
  async send(threadId, value, images=[], {messageId}={}) {
    await this.prepare(threadId);
    const input=[...(value?[{type:'text',text:value}]:[]),...images.map(image=>({type:'localImage',path:image.path}))];
    if (this.active.has(threadId))
      return this.call('turn/steer', {
        threadId,
        expectedTurnId: this.active.get(threadId),
        input,
        ...(messageId?{clientUserMessageId:messageId}:{}),
      });
    return this.call('turn/start', { threadId, input,...(messageId?{clientUserMessageId:messageId}:{}) });
  }
  async stop(threadId) {
    if (this.active.has(threadId))
      await this.call('turn/interrupt', { threadId, turnId: this.active.get(threadId) });
  }
  close() {
    const connection = this.connection;
    if (!connection || connection.closed) return;
    connection.intentional = true;
    this.fail(connection, 'app shutdown');
  }
}
module.exports = { Codex, findCodex };
