'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { readStore, atomicJSON, syncDirectory } = require('./private-store.cjs');
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
const uuid = (v) =>
  typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const held = (message) => Object.assign(new Error(message), { code: 'DOCUMENT_REQUEST_HELD' });
function validate(s) {
  if (
    s?.version !== 1 ||
    !Array.isArray(s.documents) ||
    s.documents.length > 128 ||
    !Array.isArray(s.drafts) ||
    s.drafts.length > 128 ||
    !Array.isArray(s.receipts) ||
    s.receipts.length > 1000 ||
    !Array.isArray(s.schedules) ||
    s.schedules.length > 32
  )
    throw held('Unsupported document journal; original bytes are preserved.');
  for (const d of s.documents)
    if (
      !uuid(d.id) ||
      d.provider !== 'local-private-text' ||
      typeof d.title !== 'string' ||
      d.title.length > 160 ||
      !['md', 'txt'].includes(d.extension) ||
      !Number.isFinite(d.connectedAt)
    )
      throw held('Invalid document identity.');
  for (const d of s.drafts)
    if (
      !uuid(d.id) ||
      !uuid(d.documentId) ||
      !['draft', 'applying', 'applied', 'unconfirmed'].includes(d.status) ||
      !/^[a-f0-9]{64}$/.test(d.baseRevision) ||
      typeof d.replacement !== 'string' ||
      d.replacement.length > 12000 ||
      !Number.isSafeInteger(d.start) ||
      !Number.isSafeInteger(d.end) ||
      d.start < 1 ||
      d.end < d.start ||
      typeof d.actorId !== 'string'
    )
      throw held('Invalid bounded document draft.');
  for (const r of s.receipts)
    if (
      !uuid(r.requestId) ||
      !uuid(r.documentId) ||
      !['applying', 'applied', 'unconfirmed'].includes(r.status)
    )
      throw held('Invalid document receipt.');
  for (const r of s.schedules)
    if (
      !uuid(r.id) ||
      !uuid(r.documentId) ||
      !['active', 'cancelled', 'held', 'complete'].includes(r.status) ||
      !Number.isSafeInteger(r.everySeconds) ||
      r.everySeconds < 60 ||
      !Number.isSafeInteger(r.maxRuns) ||
      r.maxRuns < 1 ||
      r.maxRuns > 64 ||
      !Number.isFinite(r.until) ||
      !Number.isFinite(r.nextAt) ||
      !Array.isArray(r.runs) ||
      r.runs.length > 64 ||
      typeof r.append !== 'string' ||
      r.append.length > 12000 ||
      !/^[a-f0-9]{64}$/.test(r.expectedRevision) ||
      typeof r.actorId !== 'string'
    )
      throw held('Invalid document schedule.');
}
class Documents {
  constructor(options) {
    this.options = options;
    this.actorId = options.actorId;
    this.file = path.join(options.directory, 'documents.json');
    this.library = path.join(options.directory, 'document-library');
    this.failed = false;
    this.busy = false;
    const saved = readStore(this.file);
    this.state = saved.missing
      ? { version: 1, documents: [], drafts: [], receipts: [], schedules: [] }
      : saved.value;
    validate(this.state);
    this.diskHash = saved.missing ? null : hash(fs.readFileSync(this.file));
    if (this.state.receipts.some((r) => r.status === 'applying'))
      this.change((s) => {
        for (const r of s.receipts) if (r.status === 'applying') r.status = 'unconfirmed';
        for (const d of s.drafts) if (d.status === 'applying') d.status = 'unconfirmed';
        for (const r of s.schedules)
          if (
            r.runs.some(
              (id) => s.receipts.find((x) => x.requestId === id)?.status === 'unconfirmed',
            )
          )
            r.status = 'held';
      });
  }
  now() {
    return this.options.now?.() ?? Date.now();
  }
  human(input, literal) {
    if (
      input?.role !== 'human' ||
      input.authority !== 'accepted_human' ||
      input.actorId !== this.actorId ||
      !uuid(input.messageId) ||
      input.text !== literal
    )
      throw held('This document action requires the exact current human request.');
  }
  humanJSON(input, prefix, spec) {
    this.human(input, input?.text);
    let parsed;
    try {
      if (!input.text.startsWith(prefix)) throw held('Wrong document request.');
      parsed = JSON.parse(input.text.slice(prefix.length));
    } catch {
      throw held('Document request must match its literal human configuration.');
    }
    if (JSON.stringify(parsed) !== JSON.stringify(spec))
      throw held('Document request changed after acceptance.');
  }
  change(update) {
    const disk = fs.existsSync(this.file) ? hash(fs.readFileSync(this.file)) : null;
    if (this.failed || disk !== this.diskHash)
      throw held('Document journal changed; original work is held.');
    const next = structuredClone(this.state);
    update(next);
    validate(next);
    try {
      atomicJSON(this.file, next);
      const bytes = fs.readFileSync(this.file);
      if (JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(next))
        throw held('Document checkpoint was not confirmed.');
      this.diskHash = hash(bytes);
      this.state = next;
    } catch (e) {
      this.failed = true;
      throw e;
    }
  }
  owned(d) {
    const root = fs.realpathSync.native(this.options.directory);
    if (!fs.existsSync(this.library)) fs.mkdirSync(this.library, { mode: 0o700 });
    const st = fs.lstatSync(this.library);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      path.relative(root, fs.realpathSync.native(this.library)) !== 'document-library'
    )
      throw held('Document library requires recovery.');
    const file = path.join(this.library, d.id + '.' + d.extension);
    if (fs.existsSync(file)) {
      const f = fs.lstatSync(file);
      if (!f.isFile() || f.isSymbolicLink() || f.size > 512 * 1024)
        throw held('Selected document is unavailable or outside its size bound.');
    }
    return file;
  }
  read(id) {
    const d = this.state.documents.find((d) => d.id === id);
    if (!d) throw held('Select the exact connected document.');
    const file = this.owned(d),
      bytes = fs.readFileSync(file);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw held('Document requires valid UTF-8 text.');
    }
    return { ...d, file, text, revision: hash(bytes), lines: text.split('\n') };
  }
  write(d, text) {
    if (Buffer.byteLength(text) > 512 * 1024) throw held('Document exceeds its size bound.');
    const file = this.owned(d),
      tmp = file + '.' + crypto.randomUUID() + '.tmp';
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, file);
      syncDirectory(this.library);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  }
  import(input, spec) {
    this.humanJSON(input, '/document import ', spec);
    if (
      !spec ||
      Object.keys(spec).sort().join(',') !== 'file,title' ||
      !path.isAbsolute(spec.file || '') ||
      typeof spec.title !== 'string' ||
      !spec.title.trim() ||
      spec.title.length > 160
    )
      throw held('Import one explicit local UTF-8 .md or .txt copy with file and title.');
    const extension = path.extname(spec.file).slice(1).toLowerCase(),
      stat = fs.lstatSync(spec.file);
    if (
      !['md', 'txt'].includes(extension) ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 512 * 1024
    )
      throw held('Only one bounded plain text or Markdown file is supported.');
    const bytes = fs.readFileSync(spec.file);
    if (bytes.length > 512 * 1024) throw held('Selected file changed beyond its bound.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      d = {
        id: crypto.randomUUID(),
        title: spec.title,
        extension,
        provider: 'local-private-text',
        connectedAt: this.now(),
      };
    this.write(d, text);
    this.change((s) => s.documents.push(d));
    return {
      id: d.id,
      title: d.title,
      revision: hash(Buffer.from(text)),
      location: 'Private local imported copy',
      originalFileChanged: false,
      scheduleCreated: false,
    };
  }
  request(input, id, spec) {
    this.humanJSON(input, '/document request ' + id + ': ', spec);
    if (
      !spec ||
      !['reply', 'draft'].includes(spec.mode) ||
      Object.keys(spec).some(
        (k) => !['mode', 'revision', 'start', 'end', 'replacement'].includes(k),
      )
    )
      throw held(
        'Choose reply or draft with exact revision and line range; comments and remote editing are unsupported.',
      );
    const d = this.read(id);
    if (
      spec.revision !== d.revision ||
      !Number.isSafeInteger(spec.start) ||
      !Number.isSafeInteger(spec.end) ||
      spec.start < 1 ||
      spec.end < spec.start ||
      spec.end > d.lines.length
    )
      throw held('Document revision or range changed. Inspect again before drafting.');
    const selected = d.lines.slice(spec.start - 1, spec.end).join('\n');
    if (selected.length > 12000) throw held('Choose a smaller document range.');
    if (spec.mode === 'reply') {
      if (spec.replacement !== undefined) throw held('Reply cannot include an edit.');
      return {
        documentId: id,
        revision: d.revision,
        start: spec.start,
        end: spec.end,
        text: selected,
        provenance: 'document_data',
        instructionsAuthorized: false,
        scheduleCreated: false,
      };
    }
    if (typeof spec.replacement !== 'string' || spec.replacement.length > 12000)
      throw held('Draft needs a bounded literal replacement.');
    const draft = {
      id: crypto.randomUUID(),
      documentId: id,
      actorId: this.actorId,
      baseRevision: d.revision,
      start: spec.start,
      end: spec.end,
      replacement: spec.replacement,
      status: 'draft',
      at: this.now(),
    };
    this.change((s) => s.drafts.push(draft));
    return {
      draftId: draft.id,
      documentId: id,
      baseRevision: d.revision,
      before: selected,
      after: spec.replacement,
      confirmation: '/document apply ' + draft.id,
      scheduleCreated: false,
    };
  }
  apply(input, id) {
    this.human(input, '/document apply ' + id);
    const draft = this.state.drafts.find((d) => d.id === id);
    if (!draft || draft.actorId !== this.actorId || draft.status !== 'draft')
      throw held(
        'This draft is unavailable or already attempted. Inspect its original receipt; nothing was repeated.',
      );
    const d = this.read(draft.documentId);
    if (d.revision !== draft.baseRevision)
      throw held('Document changed since the draft. Original contents are preserved.');
    const lines = d.lines.slice();
    lines.splice(draft.start - 1, draft.end - draft.start + 1, draft.replacement);
    return this.mutate(
      input.messageId,
      d,
      lines.join('\n'),
      (s) => {
        s.drafts.find((x) => x.id === id).status = 'applying';
      },
      (s) => {
        s.drafts.find((x) => x.id === id).status = 'applied';
      },
    );
  }
  mutate(requestId, d, text, before = () => {}, after = () => {}) {
    if (this.busy || this.options.admission?.() === 'deny')
      throw held('Document changes are held by the current work/privacy control.');
    const prior = this.state.receipts.find((r) => r.requestId === requestId);
    if (prior) {
      if (prior.documentId !== d.id) throw held('Request identity belongs to another document.');
      return { ...prior, noRetry: true };
    }
    const targetRevision = hash(Buffer.from(text));
    this.change((s) => {
      s.receipts.push({
        requestId,
        documentId: d.id,
        baseRevision: d.revision,
        targetRevision,
        status: 'applying',
        at: this.now(),
      });
      before(s);
    });
    this.busy = true;
    try {
      this.options.beforeWrite?.();
      if (this.read(d.id).revision !== d.revision)
        throw held('Selected document changed before writing.');
      this.write(d, text);
      if (this.read(d.id).revision !== targetRevision)
        throw held('Document output was not confirmed.');
      this.change((s) => {
        s.receipts.find((r) => r.requestId === requestId).status = 'applied';
        after(s);
      });
      return {
        requestId,
        documentId: d.id,
        status: 'applied',
        revision: targetRevision,
        localOutput: d.file,
        externalProviderChanged: false,
      };
    } catch (e) {
      try {
        this.change((s) => {
          s.receipts.find((r) => r.requestId === requestId).status = 'unconfirmed';
          for (const x of s.drafts) if (x.status === 'applying') x.status = 'unconfirmed';
        });
      } catch {}
      throw held(
        'Document output is unconfirmed. Inspect the original request and output before retrying.',
      );
    } finally {
      this.busy = false;
    }
  }
  schedule(input, id, spec) {
    this.humanJSON(input, '/document schedule ' + id + ': ', spec);
    if (
      Object.keys(spec || {})
        .sort()
        .join(',') !== 'append,everySeconds,maxRuns,revision,until' ||
      !Number.isSafeInteger(spec.everySeconds) ||
      spec.everySeconds < 60 ||
      spec.everySeconds > 86400 ||
      !Number.isSafeInteger(spec.maxRuns) ||
      spec.maxRuns < 1 ||
      spec.maxRuns > 64 ||
      !Number.isFinite(spec.until) ||
      spec.until <= this.now() ||
      spec.until > this.now() + 30 * 86400000 ||
      typeof spec.append !== 'string' ||
      !spec.append ||
      spec.append.length > 12000
    )
      throw held(
        'Choose a finite explicit local append schedule with revision, everySeconds, until, maxRuns and append.',
      );
    const d = this.read(id);
    if (d.revision !== spec.revision) throw held('Inspect the current document revision first.');
    const rule = {
      id: crypto.randomUUID(),
      documentId: id,
      actorId: this.actorId,
      status: 'active',
      everySeconds: spec.everySeconds,
      until: spec.until,
      maxRuns: spec.maxRuns,
      append: spec.append,
      expectedRevision: d.revision,
      nextAt: this.now() + spec.everySeconds * 1000,
      runs: [],
      originMessageId: input.messageId,
    };
    this.change((s) => s.schedules.push(rule));
    return {
      scheduleId: rule.id,
      nextAt: rule.nextAt,
      lastActualOutput: null,
      explicitHumanSetup: true,
    };
  }
  cancel(input, id) {
    this.human(input, '/document cancel ' + id);
    this.change((s) => {
      const r = s.schedules.find((r) => r.id === id && r.actorId === this.actorId);
      if (!r) throw held('Schedule is unavailable.');
      r.status = 'cancelled';
    });
    return { scheduleId: id, status: 'cancelled', outputsRetained: true };
  }
  tick() {
    if (this.busy || this.options.admission?.() === 'deny') return;
    for (const rule of this.state.schedules.filter(
      (r) => r.status === 'active' && r.nextAt <= this.now(),
    )) {
      if (this.now() >= rule.until || rule.runs.length >= rule.maxRuns) {
        this.change((s) => {
          s.schedules.find((r) => r.id === rule.id).status = 'complete';
        });
        continue;
      }
      try {
        const d = this.read(rule.documentId);
        if (rule.actorId !== this.actorId || d.revision !== rule.expectedRevision)
          throw held('Document changed outside its schedule.');
        const requestId = crypto.randomUUID();
        this.mutate(
          requestId,
          d,
          d.text + rule.append,
          (s) => {
            s.schedules.find((r) => r.id === rule.id).runs.push(requestId);
          },
          (s) => {
            const r = s.schedules.find((r) => r.id === rule.id);
            r.expectedRevision = hash(Buffer.from(d.text + rule.append));
            r.nextAt = this.now() + r.everySeconds * 1000;
            if (r.runs.length >= r.maxRuns) r.status = 'complete';
          },
        );
      } catch {
        this.change((s) => {
          s.schedules.find((r) => r.id === rule.id).status = 'held';
        });
      }
    }
  }
  inspect() {
    return {
      providers: [
        {
          id: 'local-private-text',
          location: 'private desktop copy',
          reply: true,
          draft: true,
          versionAwareEdit: true,
          comments: false,
          mentions: false,
          remoteProviders: false,
        },
      ],
      documents: this.state.documents.map((d) => {
        try {
          const r = this.read(d.id);
          return { ...d, revision: r.revision, lines: r.lines.length, available: true };
        } catch {
          return { ...d, available: false };
        }
      }),
      drafts: this.state.drafts.slice(-8),
      schedules: this.state.schedules.map((r) => ({
        ...r,
        append: '[explicit configured output text retained privately]',
        lastActualOutput:
          this.state.receipts.filter((x) => r.runs.includes(x.requestId)).at(-1) || null,
      })),
      receipts: this.state.receipts.slice(-8),
    };
  }
}
module.exports = { Documents, validate };
