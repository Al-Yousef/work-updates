'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { readStore, atomicJSON, versions } = require('./private-store.cjs');
const uuid = (v) =>
  typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const hold = (message) => Object.assign(new Error(message), { code: 'PRIVACY_OPERATION_HELD' });
function validate(v) {
  if (
    v?.version !== 1 ||
    !Array.isArray(v.disconnected) ||
    v.disconnected.length > 2048 ||
    v.disconnected.some((x) => !uuid(x)) ||
    new Set(v.disconnected).size !== v.disconnected.length ||
    !Array.isArray(v.previews) ||
    v.previews.length > 64 ||
    !Array.isArray(v.operations) ||
    v.operations.length > 512
  )
    throw hold('Unsupported privacy journal. The original is preserved.');
  for (const p of v.previews)
    if (
      !uuid(p.id) ||
      !['notes', 'conversation', 'source-cache', 'source-extracts', 'orphan-attachments', 'diagnostic-backups', 'voice-configuration'].includes(p.kind) ||
      !/^[a-f0-9]{64}$/.test(p.hash) ||
      !Number.isFinite(p.expiresAt) ||
      typeof p.actorId !== 'string' ||
      (['source-cache','source-extracts'].includes(p.kind) ? !uuid(p.sourceId) : p.sourceId !== null)
    )
      throw hold('Invalid privacy preview.');
  for (const o of v.operations)
    if (
      !uuid(o.messageId) ||
      !uuid(o.previewId) ||
      !['applying', 'completed', 'unconfirmed'].includes(o.status)
    )
      throw hold('Invalid privacy removal checkpoint.');
}
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:token|secret|password|authorization|apiKey|salt|code|pin)$/i.test(key)
          ? '[credential omitted]'
          : redact(item),
      ]),
    );
  if (typeof value !== 'string') return value;
  return value
    .replace(/\b(?:sk|sess)-[a-zA-Z0-9_-]{16,}\b/g, '[credential omitted]')
    .replace(/\bBearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [credential omitted]')
    .replace(
      /\b(password|api[_ -]?key|access[_ -]?token)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[credential omitted]',
    )
    .replace(/wu1:[a-zA-Z0-9_-]+/g, '[pairing code omitted]');
}
class Privacy {
  constructor(options) {
    this.options = options;
    this.actorId = options.actorId;
    this.file = path.join(options.directory, 'privacy.json');
    this.activeRemoval = false;
    this.failed = false;
    const saved = readStore(this.file);
    this.state = saved.missing
      ? { version: 1, disconnected: [], previews: [], operations: [] }
      : saved.value;
    validate(this.state);
    this.diskHash = saved.missing ? null : hash(fs.readFileSync(this.file).toString());
    if (this.state.operations.some((o) => o.status === 'applying'))
      this.change((next) => {
        for (const o of next.operations) if (o.status === 'applying') o.status = 'unconfirmed';
      });
  }
  now() {
    return this.options.now?.() ?? Date.now();
  }
  human(input, text) {
    if (
      input?.role !== 'human' ||
      input.authority !== 'accepted_human' ||
      input.actorId !== this.actorId ||
      !uuid(input.messageId) ||
      input.text !== text
    )
      throw hold('This privacy control requires the exact current human request.');
  }
  change(update) {
    const current = fs.existsSync(this.file) ? hash(fs.readFileSync(this.file).toString()) : null;
    if (this.failed || current !== this.diskHash) {
      this.failed = true;
      throw hold('Privacy checkpoints changed or need recovery. Removal is held.');
    }
    const next = structuredClone(this.state);
    update(next);
    validate(next);
    try {
      atomicJSON(this.file, next);
      const bytes = fs.readFileSync(this.file).toString();
      if (JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(next))
        throw hold('Privacy checkpoint was not confirmed.');
      this.state = next;
      this.diskHash = hash(bytes);
    } catch (e) {
      this.failed = true;
      throw e;
    }
  }
  disconnected(sourceId) {
    return this.state.disconnected.includes(sourceId);
  }
  async disconnect(input, sourceId) {
    this.human(input, '/privacy disconnect ' + sourceId);
    if (!uuid(sourceId) || (!this.disconnected(sourceId) && !this.options.localSource(sourceId)))
      throw hold('Choose an exact source owned by this local computer.');
    if (!this.disconnected(sourceId)) this.change((next) => next.disconnected.push(sourceId));
    await this.options.disconnect?.(sourceId, input);
    return 'Future reads and dispatch to this local source are disconnected. Previously retained text and receipts remain. Preview source-cache removal separately; external chats and accepted turns are unchanged.';
  }
  filterSnapshot(snapshot) {
    const filtered = structuredClone(snapshot),
      keep = (c) => !c.sources?.some((s) => this.disconnected(s.id));
    filtered.cards = filtered.cards.filter(keep);
    filtered.done = filtered.done.filter(keep);
    return filtered;
  }
  select(kind, sourceId) {
    const adapter = this.options.adapters[kind];
    if (!adapter) throw hold('That retained-data class has no removal adapter.');
    return {
      data: adapter.read(sourceId),
      dependencies: adapter.dependencies?.(sourceId) || [],
      adapter,
    };
  }
  preview(input, kind, sourceId) {
    this.human(input, '/privacy preview ' + kind + (sourceId ? ' ' + sourceId : ''));
    if (['source-cache','source-extracts'].includes(kind) && (!uuid(sourceId) || !this.disconnected(sourceId)))
      throw hold('Disconnect the exact local source before previewing retained-cache removal.');
    if (!['source-cache','source-extracts'].includes(kind) && sourceId)
      throw hold('This retained-data class does not accept a source identity.');
    const { data, dependencies } = this.select(kind, sourceId),
      p = {
        id: crypto.randomUUID(),
        kind,
        sourceId: sourceId || null,
        hash: hash(data),
        actorId: this.actorId,
        expiresAt: this.now() + 30 * 60000,
        bytes: Buffer.byteLength(JSON.stringify(data)),
        dependencies,
      };
    this.change((next) => {
      next.previews = next.previews.filter((p) => p.expiresAt > this.now());
      next.previews.push(p);
    });
    return {
      previewId: p.id,
      kind,
      sourceId: p.sourceId,
      retainedBytes: p.bytes,
      dependencies,
      expiresAt: new Date(p.expiresAt).toISOString(),
      confirmation: '/privacy delete ' + p.id,
      externalActionsReversed: false,
      kept: this.options.adapters[kind].kept || 'Original source chats, pinned notes or other unselected classes, action/replay receipts and external provider data remain.',
    };
  }
  async remove(input, id) {
    this.human(input, '/privacy delete ' + id);
    if (this.activeRemoval) throw hold('Another removal is still being verified. Nothing was repeated.');
    const prior = this.state.operations.find((o) => o.messageId === input.messageId);
    if (prior) {
      if (prior.previewId !== id)
        throw hold('This confirmation identity belongs to another preview.');
      return { status: prior.status, noRetry: true };
    }
    const p = this.state.previews.find((p) => p.id === id);
    if (
      !p ||
      p.actorId !== this.actorId ||
      p.expiresAt < this.now() ||
      this.state.operations.some((o) => o.previewId === id)
    )
      throw hold(
        'Preview is expired, unavailable or already attempted. Inspect its original result; nothing was repeated.',
      );
    const { data, dependencies, adapter } = this.select(p.kind, p.sourceId);
    if (dependencies.length || hash(data) !== p.hash)
      throw hold(
        'The affected data or its dependencies changed. Make a fresh preview before removal.',
      );
    this.change((next) =>
      next.operations.push({
        messageId: input.messageId,
        previewId: id,
        status: 'applying',
        at: this.now(),
      }),
    );
    this.activeRemoval = true;
    try {
      await adapter.remove(p.sourceId, data);
      if (!adapter.removed(adapter.read(p.sourceId)))
        throw hold(
          'Removal readback was not confirmed. Inspect retained data before another operation.',
        );
      this.change(
        (next) =>
          (next.operations.find((o) => o.messageId === input.messageId).status = 'completed'),
      );
      return {
        status: 'completed',
        kind: p.kind,
        sourceId: p.sourceId,
        externalActionsReversed: false,
        replayReceiptsRetained: true,
      };
    } catch (error) {
      try {
        this.change(
          (next) =>
            (next.operations.find((o) => o.messageId === input.messageId).status = 'unconfirmed'),
        );
      } catch {}
      throw hold(
        'Removal is unconfirmed and will not retry automatically. Some selected data may already be removed. Inspect its original checkpoint.',
      );
    } finally {
      this.activeRemoval = false;
    }
  }
  inspect() {
    return {
      disconnectedSources: [...this.state.disconnected],
      removals: structuredClone(this.state.operations.slice(-16)),
      externalProviderDeletion:
        'Manage in the original provider; this app does not erase external chats or reverse actions.',
    };
  }
  inventory() {
    return require('./privacy-inventory.cjs').inventory(versions);
  }
  export(input, kind, sourceId) {
    this.human(input, '/privacy export ' + kind + (sourceId ? ' ' + sourceId : ''));
    if ((['source-cache','source-extracts'].includes(kind) && (!uuid(sourceId) || !this.disconnected(sourceId))) ||
        (!['source-cache','source-extracts'].includes(kind) && sourceId)) throw hold('Choose one exact disconnected local source for a source export.');
    if (this.options.adapters[kind]?.exportable === false) throw hold('This class is excluded from privacy text exports. Use its original previewed export control if available.');
    let payload;
    if (this.options.adapters[kind]) payload = this.select(kind, sourceId).data;
    else if (Object.keys(versions).includes(kind) && kind !== 'privacy.json')
      payload = readStore(path.join(this.options.directory, kind)).value;
    else
      throw hold(
        'Choose a supported local text class; pairing credentials and external data are excluded.',
      );
    const root=fs.realpathSync.native(this.options.directory),directory=path.join(root,'exports');
    if(fs.existsSync(directory)){
      const stat=fs.lstatSync(directory);
      if(!stat.isDirectory()||stat.isSymbolicLink()||path.relative(root,fs.realpathSync.native(directory))!=='exports')throw hold('Private export directory requires recovery.');
    }else fs.mkdirSync(directory,{mode:0o700});
    const file = path.join(directory, crypto.randomUUID() + '.json');
    atomicJSON(file, {
      schema: 1,
      kind,
      sourceId: sourceId || null,
      createdAt: new Date(this.now()).toISOString(),
      credentialRedaction:
        'Known credential fields/patterns omitted; review private free text before sharing.',
      data: redact(payload),
    });
    return { file, privateExport: true, externalDataIncluded: false };
  }
}
module.exports = { Privacy, validate, redact };
