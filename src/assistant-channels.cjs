'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { Assistant } = require('./assistant.cjs'),
  { AssistantProvider } = require('./assistant-provider.cjs');
const { StatePublisher } = require('./state-order.cjs');
const uuid = (v) =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const digest = (v) => crypto.createHash('sha256').update(v).digest('hex');
const held = () =>
  Object.assign(new Error('This private assistant channel is unavailable or revoked.'), {
    code: 'ASSISTANT_CHANNEL_HELD',
  });
function validate(s, actorId) {
  if (
    s?.version !== 1 ||
    !Array.isArray(s.entries) ||
    s.entries.length > 32 ||
    new Set(s.entries.map((e) => e.id)).size !== s.entries.length
  )
    throw held();
  for (const e of s.entries)
    if (
      !uuid(e.id) ||
      e.actorId !== actorId ||
      typeof e.label !== 'string' ||
      !e.label.trim() ||
      e.label.length > 80 ||
      !/^[a-f0-9]{64}$/.test(e.tokenHash) ||
      !['active', 'revoked'].includes(e.access) ||
      !Number.isFinite(e.until) ||
      !Number.isFinite(e.createdAt) ||
      e.until <= e.createdAt ||
      e.until - e.createdAt > 30 * 86400000 ||
      e.privateContextConfirmed !== true
    )
      throw held();
}
class AssistantChannels {
  constructor(options) {
    this.options = options;
    this.actorId = options.actorId;
    this.file = path.join(options.directory, 'private-assistant-channels.enc');
    this.live = new Map();
    this.publishers = new Map();
    this.closed = false;
    this.failed = false;
    this.state = { version: 1, entries: [] };
    this.diskHash = null;
    if (fs.existsSync(this.file)) {
      if (!options.available()) throw held();
      const info = fs.lstatSync(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 262144) throw held();
      const bytes = fs.readFileSync(this.file);
      this.state = JSON.parse(options.decrypt(bytes));
      validate(this.state, this.actorId);
      this.diskHash = digest(bytes);
    }
  }
  now() {
    return this.options.now?.() ?? Date.now();
  }
  storage() {
    if (this.closed || this.failed || !this.options.available()) throw held();
    if (fs.existsSync(this.file)) {
      const info = fs.lstatSync(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 262144) throw held();
    }
    if ((fs.existsSync(this.file) ? digest(fs.readFileSync(this.file)) : null) !== this.diskHash)
      throw held();
  }
  save(change) {
    this.storage();
    const next = structuredClone(this.state);
    change(next);
    validate(next, this.actorId);
    const tmp = this.file + '.' + crypto.randomUUID() + '.tmp';
    try {
      const bytes = this.options.encrypt(JSON.stringify(next));
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
      const actual = fs.readFileSync(this.file);
      if (JSON.stringify(JSON.parse(this.options.decrypt(actual))) !== JSON.stringify(next))
        throw held();
      this.diskHash = digest(actual);
      this.state = next;
    } catch (e) {
      this.failed = true;
      throw e;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  }
  human(input) {
    if (
      input?.role !== 'human' ||
      input.authority !== 'accepted_human' ||
      input.actorId !== this.actorId ||
      !uuid(input.messageId)
    )
      throw held();
  }
  checkInvitation(input, { label, days, privateContextConfirmed }) {
    this.human(input);
    this.storage();
    if (
      typeof label !== 'string' ||
      !label.trim() ||
      label.length > 80 ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > 30 ||
      privateContextConfirmed !== true ||
      this.state.entries.length >= 32
    )
      throw held();
  }
  invite(input, { label, days, privateContextConfirmed }) {
    this.checkInvitation(input, { label, days, privateContextConfirmed });
    const token = crypto.randomBytes(32).toString('hex'),
      entry = {
        id: crypto.randomUUID(),
        actorId: this.actorId,
        label: label.trim(),
        createdAt: this.now(),
        until: this.now() + days * 86400000,
        access: 'active',
        tokenHash: digest(token),
        privateContextConfirmed: true,
      };
    this.save((s) => s.entries.push(entry));
    return { id: entry.id, token, until: entry.until };
  }
  assert(id) {
    this.storage();
    const e = this.state.entries.find((e) => e.id === id);
    if (
      !e ||
      e.access !== 'active' ||
      e.until <= this.now() ||
      this.options.admission?.() !== 'allow'
    )
      throw held();
    return e;
  }
  authenticate(req) {
    if (req.headers.origin || typeof req.headers.authorization !== 'string') throw held();
    const match = req.headers.authorization.match(/^Bearer ([a-f0-9]{64})$/);
    if (!match) throw held();
    const hash = Buffer.from(digest(match[1]), 'hex');
    this.storage();
    const entry = this.state.entries.find((e) =>
      crypto.timingSafeEqual(hash, Buffer.from(e.tokenHash, 'hex')),
    );
    if (!entry) throw held();
    return this.assert(entry.id);
  }
  revoke(input, id) {
    this.human(input);
    this.save((s) => {
      const e = s.entries.find((e) => e.id === id);
      if (!e) throw held();
      e.access = 'revoked';
    });
    this.live.get(id)?.close();
    this.live.delete(id);
    return { revoked: true, acceptedWorkStopped: false };
  }
  assistant(id) {
    this.assert(id);
    if (this.live.has(id)) return this.live.get(id);
    const directory = path.join(this.options.directory, 'assistant-channels', id);
    fs.mkdirSync(directory, { recursive: true });
    const base =
      this.options.provider?.(id, directory) ||
      new AssistantProvider({
        directory: path.join(directory, 'session'),
        budgets: this.options.budgets,
        binary: this.options.binary,
      });
    const provider = {
      answer: async (context) => {
        this.assert(id);
        const answer = await base.answer({
          ...context,
          savedNotes: this.options.notes?.() || [],
          assistantIdentity: this.options.profile?.() || null,
          channel: {
            id,
            audience: 'one explicitly granted private owner client',
            history: 'this channel only',
          },
        });
        this.assert(id);
        return answer;
      },
      close: () => base.close?.(),
    };
    const assistant = new Assistant({
      directory,
      provider,
      snapshot: this.options.snapshot,
      commitments: this.options.commitments,
    });
    this.live.set(id, assistant);
    return assistant;
  }
  inspect() {
    this.storage();
    return this.state.entries.map(({ tokenHash, ...e }) => ({
      ...e,
      expired: e.until <= this.now(),
    }));
  }
  snapshot(id) {
    const e = this.assert(id),
      assistant = this.assistant(id),
      snapshot = assistant.snapshot();
    const value = {
      schema: 1,
      version: 1,
      channelId: e.id,
      actorId: e.actorId,
      hostId: this.options.hostId,
      epoch: this.options.epoch,
      until: e.until,
      profile: this.options.profile?.() || null,
      capabilities: {
        history: true,
        questions: true,
        taskActions: false,
        attachments: false,
        sharedAudience: false,
      },
      responding: snapshot.responding,
      error: !!snapshot.error,
      messages: snapshot.messages.map((m) => ({
        id: m.id,
        text: m.text,
        status: m.status,
        at: m.at,
        answer: m.answer || '',
        error: m.status === 'failed' ? 'Answer is unavailable or interrupted.' : '',
      })),
    };
    if (Buffer.byteLength(JSON.stringify(value)) > 512000) throw held();
    if (!this.publishers.has(id)) this.publishers.set(id, new StatePublisher());
    const stamped = this.publishers.get(id).stamp(value);
    stamped.epoch = this.options.epoch;
    return stamped;
  }
  ask(id, input) {
    this.assert(id);
    if (
      !input ||
      Object.keys(input).sort().join(',') !== 'messageId,text' ||
      !uuid(input.messageId) ||
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      input.text.length > 4000 ||
      input.text.trim().startsWith('/') ||
      require('./assistant-coordination.cjs').directRequest(input.text)
    )
      throw held();
    const receipt = this.assistant(id).ask(input);
    this.assert(id);
    return {
      schema: 1,
      channelId: id,
      hostId: this.options.hostId,
      messageId: receipt.messageId,
      delivery: 'accepted',
      completed: false,
      destination: 'private-assistant-channel',
      epoch: this.options.epoch,
    };
  }
  clear(input, id) {
    this.human(input);
    this.storage();
    if (!this.state.entries.some((e) => e.id === id)) throw held();
    const existing = this.live.get(id);
    const assistant =
      existing ||
      new Assistant({
        directory: path.join(this.options.directory, 'assistant-channels', id),
        provider: {
          answer: async () => {
            throw held();
          },
          close() {},
        },
        snapshot: this.options.snapshot,
      });
    if (assistant.active) throw held();
    assistant.ask({ messageId: input.messageId, text: '/forget history all' });
    if (!existing) assistant.close();
    return { cleared: true, receiptsRetained: true, otherChannelsChanged: false };
  }
  async request(req, res, json) {
    let entry;
    try {
      entry = this.authenticate(req);
    } catch {
      return json(res, 401, { error: 'Private assistant grant required.' });
    }
    const receiptId = req.url?.match(/^\/assistant\/receipt\/([a-f0-9-]{36})$/)?.[1];
    if (req.method === 'GET' && uuid(receiptId)) {
      try {
        const assistant = this.assistant(entry.id);
        if (assistant.error) throw held();
        const textHash = assistant.state.receipts[receiptId];
        this.assert(entry.id);
        return json(res, 200, {
          schema: 1,
          channelId: entry.id,
          hostId: this.options.hostId,
          epoch: this.options.epoch,
          messageId: receiptId,
          delivery: textHash ? 'accepted' : 'unknown',
          textHash: textHash || null,
          completed: false,
        });
      } catch {
        return json(res, 409, { error: 'Receipt unavailable.' });
      }
    }
    if (req.method === 'GET' && req.url === '/assistant/state') {
      try {
        return json(res, 200, this.snapshot(entry.id));
      } catch {
        return json(res, 409, { error: 'Assistant state unavailable.' });
      }
    }
    if (req.method !== 'POST' || req.url !== '/assistant/ask')
      return json(res, 404, { error: 'Unsupported assistant action.' });
    if (req.headers['content-type'] !== 'application/json')
      return json(res, 415, { error: 'JSON required.' });
    let size = 0,
      body = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 20000) return json(res, 413, { error: 'Message exceeds its bound.' });
        body.push(chunk);
      }
      this.assert(entry.id);
      const value = JSON.parse(Buffer.concat(body).toString('utf8'));
      if (
        value?.epoch !== this.options.epoch ||
        value?.channelId !== entry.id ||
        value?.version !== 1 ||
        Object.keys(value).sort().join(',') !== 'channelId,epoch,input,version'
      )
        throw held();
      const receipt = this.ask(entry.id, value.input);
      this.assert(entry.id);
      return json(res, 200, { ok: true, value: receipt });
    } catch {
      return json(res, 409, {
        error:
          'Message was refused or acceptance is unconfirmed. Check this exact channel before retrying.',
      });
    }
  }
  close() {
    this.closed = true;
    for (const assistant of this.live.values()) assistant.close();
    this.live.clear();
  }
}
module.exports = { AssistantChannels, validate };
