'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');

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
  }
  async connect() {
    if (this.proc && this.ready) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const proc = spawn(findCodex(this.options.binary), ['app-server'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = proc;
      const rl = readline.createInterface({ input: proc.stdout });
      this.reader = rl;
      rl.on('line', (line) => {
        try {
          const m = JSON.parse(line);
          if (m.method && m.id !== undefined) this.emit('request', m);
          else if (m.method) {
            if (m.method === 'turn/started') this.active.set(m.params.threadId, m.params.turn.id);
            if (m.method === 'turn/completed') this.active.delete(m.params.threadId);
            this.emit('notification', m);
          } else if (m.id !== undefined) {
            const pending = this.waiting.get(m.id);
            if (pending) {
              this.waiting.delete(m.id);
              clearTimeout(pending.timer);
              m.error ? pending.reject(new Error(m.error.message)) : pending.resolve(m.result);
            }
          }
        } catch {}
      });
      proc.stderr.on('data', () => {}); // Server logs stay off the UI and out of release diagnostics.
      const failed = () => {
        this.ready = false;
        this.proc = null;
        this.loaded.clear();
        this.active.clear();
        for (const p of this.waiting.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('Codex disconnected. Retry this task to continue.'));
        }
        this.waiting.clear();
        this.emit('disconnected');
        rl.close();
      };
      proc.once('error', failed);
      proc.once('exit', failed);
      await this.call('initialize', {
        clientInfo: { name: 'work_updates', title: 'Work Updates', version: '0.2.0' },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized', {});
      this.ready = true;
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
      const id = ++this.sequence,
        timer = setTimeout(() => {
          this.waiting.delete(id);
          reject(new Error('Codex took too long. Retry to continue.'));
        }, 60000);
      this.waiting.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      } catch (error) {
        clearTimeout(timer);
        this.waiting.delete(id);
        reject(error);
      }
    });
  }
  notify(method, params) {
    this.proc?.stdin.write(JSON.stringify({ method, params }) + '\n');
  }
  reply(id, result) {
    this.proc?.stdin.write(JSON.stringify({ id, result }) + '\n');
  }
  reject(id) {
    this.proc?.stdin.write(
      JSON.stringify({
        id,
        error: { code: -32601, message: 'This request needs to be handled in Codex.' },
      }) + '\n',
    );
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
      await this.call('thread/resume', { threadId: id });
      this.loaded.add(id);
    }
    const turn = await this.call('turn/start', {
      threadId: id,
      input: [{ type: 'text', text: task.prompt }],
    });
    return { threadId: id, turnId: turn.turn.id };
  }
  async send(threadId, value) {
    await this.connect();
    if (!this.loaded.has(threadId)) {
      await this.call('thread/resume', { threadId });
      this.loaded.add(threadId);
    }
    if (this.active.has(threadId))
      return this.call('turn/steer', {
        threadId,
        expectedTurnId: this.active.get(threadId),
        input: [{ type: 'text', text: value }],
      });
    return this.call('turn/start', { threadId, input: [{ type: 'text', text: value }] });
  }
  async stop(threadId) {
    if (this.active.has(threadId))
      await this.call('turn/interrupt', { threadId, turnId: this.active.get(threadId) });
  }
  close() {
    this.proc?.kill();
    this.reader?.close();
  }
}
module.exports = { Codex, findCodex };
