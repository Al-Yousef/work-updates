'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { readStore, atomicJSON } = require('./private-store.cjs');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512;
const refusal = (message) =>
  Object.assign(new Error(message), { code: 'EXECUTOR_BINDING_HELD', delivery: 'not-sent' });
function workspace(value) {
  if (!path.isAbsolute(value || '')) throw refusal('An exact local workspace is required.');
  const canonical = fs.realpathSync.native(value);
  if (!fs.statSync(canonical).isDirectory()) throw refusal('The bound workspace is unavailable.');
  return canonical;
}
function validate(state) {
  if (
    state?.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(state.salt || '') ||
    !Array.isArray(state.entries) ||
    state.entries.length > 2048 ||
    new Set(state.entries.map((e) => e.taskId)).size !== state.entries.length
  )
    throw refusal('Unsupported executor bindings. The original journal is preserved.');
  for (const e of state.entries)
    if (
      !identifier(e.id) ||
      !identifier(e.taskId) ||
      !identifier(e.deviceId) ||
      !identifier(e.actorId) ||
      !path.isAbsolute(e.workspace || '') ||
      !identifier(e.serverVersion) ||
      !/^[a-f0-9]{64}$/.test(e.accountHash || '') ||
      !/^[a-f0-9]{64}$/.test(e.profileHash || '') ||
      !['active', 'revoked'].includes(e.access) ||
      !Number.isFinite(e.grantedAt) ||
      e.location !== 'local' ||
      e.provider !== 'codex-app-server' ||
      e.schema !== 1 ||
      (e.threadId !== null && !identifier(e.threadId)) ||
      !Array.isArray(e.capabilities) ||
      e.capabilities.join(',') !== 'task_create,task_continue,turn_interrupt'
    )
      throw refusal('Invalid executor binding. The original journal is preserved.');
    else if (e.browserTools !== undefined) {
      require('./browser-worker-tools.cjs').validateContract(e.browserTools);
      if (!e.threadId || e.browserTools.serverVersion !== e.serverVersion)
        throw refusal('Invalid browser tool registration.');
    }
}
class ExecutorBindings {
  constructor({ directory, deviceId, actorId, now = () => Date.now() }) {
    this.file = path.join(directory, 'executors.json');
    this.deviceId = deviceId;
    this.actorId = actorId;
    this.now = now;
    const stored = readStore(this.file);
    this.state = stored.missing
      ? { version: 1, salt: crypto.randomBytes(32).toString('hex'), entries: [] }
      : stored.value;
    validate(this.state);
    this.diskHash = stored.missing ? null : digest(fs.readFileSync(this.file));
    this.failed = false;
  }
  save(update) {
    if (this.failed) throw refusal('Executor storage needs recovery. Work is held.');
    const actual = fs.existsSync(this.file) ? digest(fs.readFileSync(this.file)) : null;
    if (actual !== this.diskHash) {
      this.failed = true;
      throw refusal('Executor bindings changed outside their owner. Work is held.');
    }
    const next = structuredClone(this.state);
    update(next);
    validate(next);
    try {
      atomicJSON(this.file, next);
      const bytes = fs.readFileSync(this.file);
      if (JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(next))
        throw refusal('Executor checkpoint was not confirmed.');
      this.state = next;
      this.diskHash = digest(bytes);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
  runtime(initialized, account) {
    const version = String(initialized?.userAgent || '').match(
      /\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b/,
    )?.[0];
    if (
      !version ||
      !path.isAbsolute(initialized?.codexHome || '') ||
      !['windows', 'macos', 'linux'].includes(initialized.platformOs) ||
      account?.account?.type !== 'chatgpt' ||
      !identifier(account.account.email)
    )
      throw refusal(
        'This executor requires a verified ChatGPT account and current app-server version. No task was started.',
      );
    const keyed = (value) =>
      crypto.createHmac('sha256', Buffer.from(this.state.salt, 'hex')).update(value).digest('hex');
    return {
      schema: 1,
      deviceId: this.deviceId,
      location: 'local',
      provider: 'codex-app-server',
      serverVersion: version,
      accountHash: keyed('chatgpt:' + account.account.email.trim().toLowerCase()),
      profileHash: keyed(initialized.codexHome),
      platform: initialized.platformOs,
    };
  }
  same(entry, runtime, cwd) {
    return (
      entry.deviceId === runtime.deviceId &&
      entry.serverVersion === runtime.serverVersion &&
      entry.accountHash === runtime.accountHash &&
      entry.profileHash === runtime.profileHash &&
      entry.workspace === workspace(cwd) &&
      entry.location === runtime.location &&
      entry.provider === runtime.provider &&
      entry.platform === runtime.platform
    );
  }
  grant(taskId, runtime, cwd) {
    const existing = this.state.entries.find((e) => e.taskId === taskId);
    if (existing) {
      this.assert(existing, runtime, cwd);
      return structuredClone(existing);
    }
    if (!identifier(taskId) || runtime.deviceId !== this.deviceId || runtime.location !== 'local')
      throw refusal('An exact task on the original local executor is required.');
    const entry = {
      ...runtime,
      id: crypto.randomUUID(),
      taskId,
      threadId: null,
      workspace: workspace(cwd),
      actorId: this.actorId,
      grantedAt: this.now(),
      access: 'active',
      capabilities: ['task_create', 'task_continue', 'turn_interrupt'],
      verifiedAt: this.now(),
    };
    this.save((next) => next.entries.push(entry));
    return structuredClone(entry);
  }
  assert(entry, runtime, cwd) {
    if (
      this.failed ||
      !entry ||
      entry.access !== 'active' ||
      entry.actorId !== this.actorId ||
      !this.same(entry, runtime, cwd)
    )
      throw refusal(
        'The original executor, workspace, account, version or access grant changed. This task is retained on its original executor.',
      );
    const actual = fs.existsSync(this.file) ? digest(fs.readFileSync(this.file)) : null;
    if (actual !== this.diskHash) {
      this.failed = true;
      throw refusal('Executor bindings changed outside their owner. Work is held.');
    }
    return entry;
  }
  attach(taskId, threadId, runtime, returnedWorkspace, browserTools) {
    const entry = this.state.entries.find((e) => e.taskId === taskId);
    this.assert(entry, runtime, returnedWorkspace);
    if (
      !identifier(threadId) ||
      (entry.threadId && entry.threadId !== threadId) ||
      this.state.entries.some((e) => e.taskId !== taskId && e.threadId === threadId)
    )
      throw refusal('The executor returned a different task identity. Nothing was sent.');
    this.save((next) => {
      const bound = next.entries.find((e) => e.taskId === taskId);
      bound.threadId = threadId;
      if (browserTools !== undefined) {
        require('./browser-worker-tools.cjs').validateContract(browserTools);
        if (browserTools.serverVersion !== bound.serverVersion)
          throw refusal('Browser tool version is unavailable.');
        bound.browserTools = structuredClone(browserTools);
      }
      bound.verifiedAt = this.now();
    });
  }
  thread(threadId) {
    return this.state.entries.find((e) => e.threadId === threadId);
  }
  assertThread(threadId, runtime, returnedWorkspace) {
    return this.assert(this.thread(threadId), runtime, returnedWorkspace);
  }
  revoke(id, actorId) {
    if (actorId !== this.actorId)
      throw refusal('Only the current human owner can revoke an executor grant.');
    this.save((next) => {
      const entry = next.entries.find((e) => e.id === id);
      if (!entry) throw refusal('Executor grant is unavailable.');
      entry.access = 'revoked';
    });
  }
  inspect() {
    if (this.report().coverage === 'storage_held')
      throw refusal(
        'Executor storage needs recovery; retained grants are not current verification.',
      );
    return this.state.entries.map(({ accountHash, profileHash, ...entry }) => ({
      ...entry,
      accountVerified: true,
      profileVerified: true,
      online: 'unknown_until_next_handshake',
    }));
  }
  report(transport = 'unknown') {
    let held = this.failed;
    try {
      const stored = readStore(this.file);
      if (!stored.missing) validate(stored.value);
      held ||= (stored.missing ? null : digest(fs.readFileSync(this.file))) !== this.diskHash;
    } catch {
      held = true;
    }
    const workspaceRef = (value) =>
      crypto
        .createHmac('sha256', Buffer.from(this.state.salt, 'hex'))
        .update('workspace:' + value)
        .digest('hex');
    return require('./executor-report.cjs').validate(
      {
        schema: 1,
        deviceId: this.deviceId,
        location: 'local',
        cloud: false,
        liveExecutorVerified: false,
        coverage: held ? 'storage_held' : 'recorded_grants',
        transport,
        reportedAt: this.now(),
        grants: held
          ? []
          : this.state.entries.map((e) => ({
              id: e.id,
              taskId: e.taskId,
              threadId: e.threadId,
              serverVersion: e.serverVersion,
              access: e.access,
              workspaceRef: workspaceRef(e.workspace),
              accountRef: e.accountHash,
              profileRef: e.profileHash,
              verifiedAt: e.verifiedAt,
              capabilities: [...e.capabilities],
            })),
      },
      this.deviceId,
    );
  }
}
module.exports = { ExecutorBindings, workspace, validate };
