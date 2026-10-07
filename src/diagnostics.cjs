'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const IDS = new Set([
  'messageId',
  'assistantIntentId',
  'sourceId',
  'threadId',
  'turnId',
  'cardId',
  'taskKey',
  'deviceId',
  'ownerId',
  'clientId',
  'targetClientId',
  'requestId',
  'backendSessionId',
  'nativeSessionId',
]);
const NUMBERS = new Set([
  'id',
  'pid',
  'exitCode',
  'elapsedMs',
  'timeoutMs',
  'bytes',
  'frameBytes',
  'responseBytes',
  'characters',
  'count',
  'links',
  'queueDepth',
  'pending',
  'windowCount',
  'snapshotProtocol',
  'omittedFields',
]);
const STRINGS = {
  code: /^[A-Z][A-Z\d_]{1,60}$/,
  phase: new Set([
    'preparing-chat',
    'awaiting-receipt',
    'ownership-discovery',
    'local-queue',
    'collector-read',
    'native-command',
  ]),
  delivery: new Set([
    'sent',
    'queued',
    'not-sent',
    'uncertain',
    'unconfirmed',
    'accepted',
    'completed',
    'failed',
    'cancelled',
  ]),
  route: new Set(['desktop', 'app-server', 'hyphen', 'synthetic']),
  owner: new Set(['desktop', 'app-server', 'native', 'electron', 'none']),
  mode: new Set(['send', 'queue', 'native-backend', 'electron']),
  status: new Set([
    'queued',
    'sending',
    'sent',
    'uncertain',
    'failed',
    'cancelled',
    'working',
    'starting',
    'needs',
    'waiting',
    'ready',
    'done',
    'unknown',
    'completed',
    'interrupted',
    'current',
    'cached',
    'error',
  ]),
  signal: /^SIG[A-Z]{1,12}$/,
  version: /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[a-z\d.-]{1,30})?$/i,
  model: /^gpt-[a-z\d.-]{1,40}$/i,
  key: /^[a-f\d]{24,64}$/i,
  backendHash: /^[a-f\d]{64}$/i,
  nativeProtocol: new Set(['work-updates-native-v1']),
  category: new Set([
    'receipt-unknown',
    'writer-unavailable',
    'preparation-timeout',
    'ownership-timeout',
    'transport-disconnected',
    'operation-failed',
  ]),
};
const EVENTS = new Set(
  'app.started app.stopping app.command.failed codex.connection.closed codex.connection.ready codex.process.cleanup_failed codex.process.start codex.process.exit codex.protocol.invalid codex.handler.error codex.stderr codex.rpc.started codex.rpc.completed codex.rpc.error codex.rpc.timeout codex.turn.started codex.turn.completed desktop.connected desktop.disconnected desktop.rpc.started desktop.rpc.accepted desktop.rpc.failed desktop.rpc.timeout desktop.rpc.disconnected native.corner.owner native.backend.ready native.control.failed native.pipe.connected native.pipe.disconnected native.command.started native.command.completed native.command.failed native.frame observer.started observer.heartbeat-expired observer.health devices.restore.failed summary.completed summary.failed message.queued message.requested message.dispatching message.sent message.failed message.uncertain message.reconciled message.cancelled message.queue.error message.recovered assistant.focus_save_failed assistant.updates_save_failed assistant.updates assistant.accepted assistant.chat_message assistant.completed assistant.failed dispatch.bound dispatch.owner dispatch.accepted dispatch.failed rpc.error stderr test diagnostic.invalid-event'.split(
    ' ',
  ),
);
EVENTS.add('observer.error');
EVENTS.add('observer.exited');
EVENTS.add('message.cleared');
EVENTS.add('responsibility.recovery_failed');
EVENTS.add('schedule.recovery_failed');
const FLAGS = new Set(['demo', 'intentional', 'truncated', 'local', 'connected', 'noResend']);
const methods = new Set([
  'initialize',
  'thread/start',
  'thread/name/set',
  'thread/resume',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'thread-owner-discovery',
  'thread-follower-start-turn',
  'thread-follower-steer-turn',
  'action',
  'undo',
  'details',
  'open',
  'refresh',
  'send',
  'queueMessage',
  'cancelMessage',
  'clearMessages',
  'logs',
  'assistantAsk',
  'assistantUse',
  'attachImages',
  'openAttachment',
  'state',
  'status',
  'quitIfIdle',
  'claimCorner',
  'subscribe',
]);
function recovery({ code, phase, delivery, message = '' } = {}) {
  if (
    delivery === 'uncertain' ||
    (delivery !== 'not-sent' && ['DELIVERY_RECEIPT', 'DESKTOP_RECEIPT'].includes(code))
  )
    return {
      category: 'receipt-unknown',
      guidance: 'Check the source chat before sending again. Your draft is saved.',
      noResend: true,
    };
  if (/active writer|already.*writer/i.test(message) || code === 'DESKTOP_NO_OWNER')
    return {
      category: 'writer-unavailable',
      guidance: 'Open this chat in Codex to check its writer. Your draft is saved.',
      noResend: false,
    };
  if (phase === 'preparing-chat' && ['CODEX_TIMEOUT', 'DESKTOP_TIMEOUT'].includes(code))
    return {
      category: 'preparation-timeout',
      guidance: 'The chat did not reopen. Your message was not sent; you can retry reopening.',
      noResend: false,
    };
  if (phase === 'ownership-discovery' && code === 'DESKTOP_TIMEOUT')
    return {
      category: 'ownership-timeout',
      guidance:
        "Codex did not identify this chat's writer. Your message was not sent. Open the source chat.",
      noResend: false,
    };
  if (
    [
      'CODEX_DISCONNECTED',
      'DESKTOP_DISCONNECTED',
      'DESKTOP_UNAVAILABLE',
      'EPIPE',
      'ECONNREFUSED',
    ].includes(code)
  )
    return {
      category: 'transport-disconnected',
      guidance:
        delivery === 'not-sent'
          ? 'Open Codex and reconnect. Your message was not sent.'
          : 'Check the source chat before retrying; acceptance is unknown.',
      noResend: delivery !== 'not-sent',
    };
  return {
    category: code === undefined ? 'none' : 'operation-failed',
    guidance: '',
    noResend: false,
  };
}
function fields(details = {}) {
  const out = {};
  let omitted = 0;
  for (const [key, value] of Object.entries(details)) {
    if (['schema', 'at', 'event'].includes(key)) continue;
    if (
      IDS.has(key) &&
      typeof value === 'string' &&
      /^[a-z\d._:-]{1,160}$/i.test(value) &&
      redact(value) === value
    )
      out[key] = value;
    else if (NUMBERS.has(key) && Number.isFinite(value))
      out[key] = Math.max(-2147483648, Math.min(2147483647, value));
    else if (FLAGS.has(key) && typeof value === 'boolean') out[key] = value;
    else if (key === 'code' && Number.isFinite(value)) out[key] = value;
    else if (key === 'method' && methods.has(value)) out[key] = value;
    else if (
      STRINGS[key] &&
      typeof value === 'string' &&
      (STRINGS[key] instanceof Set ? STRINGS[key].has(value) : STRINGS[key].test(value))
    )
      out[key] = value;
    else if (value !== undefined) omitted++;
  }
  if (omitted) out.omittedFields = (out.omittedFields || 0) + omitted;
  if (details.message !== undefined) out.message = '[redacted]';
  return out;
}

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
  constructor(
    directory,
    {
      name = 'app.log',
      maxBytes = 512 * 1024,
      backups = 2,
      protectedDirectory = directory,
      metadata = {},
    } = {},
  ) {
    if (!/^[a-z\d-]+\.log$/i.test(name)) throw new Error('Invalid diagnostic log name');
    this.directory = directory;
    this.file = path.join(directory, name);
    this.maxBytes = Math.max(256, Math.min(Number(maxBytes) || 512 * 1024, 512 * 1024));
    this.backups = Math.max(0, Math.min(Math.floor(Number(backups) || 0), 2));
    this.protectedDirectory = path.resolve(protectedDirectory);
    this.metadata = fields(
      Object.fromEntries(
        ['version', 'backendHash', 'nativeProtocol', 'snapshotProtocol']
          .filter((key) => metadata[key] !== undefined)
          .map((key) => [key, metadata[key]]),
      ),
    );
    delete this.metadata.omittedFields;
    this.sessionId = crypto.randomUUID();
    this.context = { backendSessionId: this.sessionId };
    this.scopes = new AsyncLocalStorage();
    this.prepared = null;
    this.error = null;
  }
  setContext(value) {
    this.context = { ...this.context, ...fields(value) };
  }
  capture() {
    return { ...this.scopes.getStore() };
  }
  scope(value, run) {
    return this.scopes.run({ ...this.capture(), ...fields(value) }, run);
  }
  write(event, details = {}, { context = this.capture() } = {}) {
    const safeEvent = EVENTS.has(event) ? event : 'diagnostic.invalid-event';
    const diagnosis = recovery(details);
    let record = {
      schema: 1,
      at: new Date().toISOString(),
      event: safeEvent,
      ...this.context,
      ...fields(context || {}),
      ...fields(details),
      ...(diagnosis.category !== 'none'
        ? { category: diagnosis.category, noResend: diagnosis.noResend }
        : {}),
    };
    // Even a caller supplying many valid fields cannot exceed the file bound.
    let line = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(line) > Math.min(8192, this.maxBytes)) {
      record = {
        schema: 1,
        at: record.at,
        event: safeEvent,
        backendSessionId: this.sessionId,
        truncated: true,
      };
      line = JSON.stringify(record) + '\n';
    }
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      let size = 0;
      try {
        size = fs.statSync(this.file).size;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (size && size + Buffer.byteLength(line) > this.maxBytes) {
        if (!this.backups) fs.rmSync(this.file, { force: true });
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
  preview({ health } = {}) {
    const salt = crypto.randomBytes(32),
      files = [];
    let totalRecords = 0;
    for (let n = this.backups; n >= 0; n--) {
      const file = this.file + (n ? '.' + n : ''),
        name = path.basename(file);
      let stat;
      try {
        stat = fs.lstatSync(file);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error('Diagnostic input must be a regular log file.');
      if (stat.size > this.maxBytes)
        throw new Error(
          'A legacy diagnostic file exceeds the export bound. Preserve it separately.',
        );
      const records = [];
      let omittedRecords = 0;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let raw;
        try {
          raw = JSON.parse(line);
        } catch {
          omittedRecords++;
          continue;
        }
        if (
          !raw ||
          typeof raw !== 'object' ||
          Array.isArray(raw) ||
          typeof raw.event !== 'string' ||
          !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(raw.at || '') ||
          !Number.isFinite(Date.parse(raw.at))
        ) {
          omittedRecords++;
          continue;
        }
        const clean = fields(raw);
        delete clean.message;
        for (const key of IDS)
          if (clean[key])
            clean[key] =
              'id:' +
              crypto.createHmac('sha256', salt).update(clean[key]).digest('hex').slice(0, 24);
        records.push({
          schema: 1,
          at: raw.at,
          event: EVENTS.has(raw.event) ? raw.event : 'diagnostic.invalid-event',
          ...clean,
        });
      }
      totalRecords += records.length;
      files.push({ name, records, omittedRecords });
    }
    const bundle = {
      schema: 1,
      generatedAt: new Date().toISOString(),
      metadata: this.metadata,
      ...(health ? { health: healthFields(health) } : {}),
      identityEncoding: 'bundle-scoped HMAC aliases',
      files,
    };
    const bytes = Buffer.from(JSON.stringify(bundle, null, 2) + '\n');
    if (bytes.length > 8 * 1024 * 1024)
      throw new Error('Sanitized diagnostics exceed the export bound.');
    const previewId = crypto.randomUUID();
    this.prepared = { previewId, bytes, expiresAt: Date.now() + 600000 };
    return {
      schema: 1,
      previewId,
      bytes: bytes.length,
      records: totalRecords,
      files: files.map((f) => ({
        name: f.name,
        records: f.records.length,
        omittedRecords: f.omittedRecords,
      })),
      includes: [
        'bounded timings and counts',
        'delivery phases and error categories',
        'version and protocol metadata',
        'pseudonymous correlation identities',
      ],
      excludes: ['prompts, answers and drafts', 'images', 'credentials and private paths'],
      automaticUpload: false,
    };
  }
  export(previewId, destination) {
    const prepared = this.prepared;
    if (!prepared || prepared.previewId !== previewId || prepared.expiresAt < Date.now())
      throw new Error('Diagnostic preview expired. Preview the report again.');
    if (!path.isAbsolute(destination)) throw new Error('Choose an absolute export destination.');
    const canonical = path.join(
      fs.realpathSync(path.dirname(destination)),
      path.basename(destination),
    );
    const relative = path.relative(fs.realpathSync(this.protectedDirectory), canonical);
    if (
      relative === '' ||
      (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    )
      throw new Error('Keep diagnostic exports outside Hyphen private storage.');
    const temporary = destination + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, prepared.bytes, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, destination);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    this.prepared = null;
    return {
      schema: 1,
      exported: true,
      bytes: prepared.bytes.length,
      sha256: crypto.createHash('sha256').update(prepared.bytes).digest('hex'),
    };
  }
}
function healthFields(value) {
  const states = {
    collector: ['fresh', 'stale', 'error'],
    helper: ['connected', 'disconnected', 'idle'],
    desktop: ['connected', 'unavailable'],
    pipe: ['listening', 'unavailable'],
  };
  const result = { schema: 1 };
  for (const [part, allowed] of Object.entries(states)) {
    const raw = value[part] || {},
      state = allowed.includes(raw.state) ? raw.state : 'unknown';
    result[part] = { state };
    for (const field of ['ageMs', 'pending', 'clients'])
      if (Number.isFinite(raw[field]))
        result[part][field] = Math.max(0, Math.min(2147483647, raw[field]));
  }
  result.executionDevices = (Array.isArray(value.executionDevices) ? value.executionDevices : [])
    .slice(0, 64)
    .map((d) => ({
      kind: ['pc', 'mac', 'linux', 'iphone'].includes(d.kind) ? d.kind : 'unknown',
      online: d.online === true,
    }));
  return result;
}
function connectionHealth({
  collectedAt,
  collector = {},
  helper = {},
  desktopConnected = false,
  pipeListening = false,
  nativeClients = 0,
  devices = [],
  now = Date.now() / 1000,
} = {}) {
  const age = now - Number(collectedAt),
    fresh = Number.isFinite(age) && Number(collectedAt) > 0 && age >= -5 && age <= 30;
  return {
    schema: 1,
    collector: {
      state: collector.ok && fresh ? 'fresh' : collector.status === 'error' ? 'error' : 'stale',
      ageMs: Number.isFinite(age)
        ? Math.min(2147483647, Math.max(0, Math.round(age * 1000)))
        : null,
    },
    helper: {
      state: helper.connected
        ? 'connected'
        : helper.pid || helper.lastFailure
          ? 'disconnected'
          : 'idle',
      pending: Math.min(10000, helper.pending || 0),
    },
    desktop: { state: desktopConnected ? 'connected' : 'unavailable' },
    pipe: {
      state: pipeListening ? 'listening' : 'unavailable',
      clients: Math.min(10000, nativeClients),
    },
    executionDevices: devices
      .slice(0, 64)
      .map((d) => ({
        kind: ['pc', 'mac', 'linux', 'iphone'].includes(d.kind) ? d.kind : 'unknown',
        online: d.online === true,
      })),
  };
}
module.exports = { DiagnosticLog, redact, recovery, connectionHealth };
