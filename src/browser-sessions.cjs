'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { readStore, atomicJSON } = require('./private-store.cjs');
const uuid = (v) =>
  typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
const held = (message) => Object.assign(new Error(message), { code: 'BROWSER_SESSION_HELD' });
function origin(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw held('Choose an exact http or https browser destination.');
  }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password)
    throw held('Browser destination cannot embed credentials or use a local file/protocol.');
  return u.origin;
}
function validate(s) {
  if (s?.version !== 1 || !Array.isArray(s.entries) || s.entries.length > 128)
    throw held('Unsupported browser journal; original bytes are preserved.');
  for (const e of s.entries)
    if (
      !uuid(e.id) ||
      !uuid(e.grantId) ||
      typeof e.taskId !== 'string' ||
      !e.taskId ||
      !['human', 'agent', 'held', 'closed'].includes(e.owner) ||
      !Number.isSafeInteger(e.epoch) ||
      e.epoch < 0 ||
      !Array.isArray(e.origins) ||
      !e.origins.length ||
      e.origins.length > 8 ||
      e.origins.some((x) => origin(x) !== x) ||
      typeof e.actorId !== 'string' ||
      !Number.isFinite(e.createdAt)
    )
      throw held('Invalid browser binding.');
}
class BrowserSessions {
  constructor(options) {
    this.options = options;
    this.actorId = options.actorId;
    this.file = path.join(options.directory, 'browsers.json');
    this.live = new Map();
    this.failed = false;
    const saved = readStore(this.file);
    this.state = saved.missing ? { version: 1, entries: [] } : saved.value;
    validate(this.state);
    this.diskHash = saved.missing ? null : hash(fs.readFileSync(this.file));
    if (this.state.entries.some((e) => ['human', 'agent'].includes(e.owner)))
      this.change((s) => {
        for (const e of s.entries)
          if (['human', 'agent'].includes(e.owner)) {
            e.owner = 'held';
            e.epoch++;
            e.reason =
              'Restart needs an explicit new browser session; no login or worker was restored.';
          }
      });
  }
  human(i, text) {
    if (
      i?.role !== 'human' ||
      i.authority !== 'accepted_human' ||
      i.actorId !== this.actorId ||
      !uuid(i.messageId) ||
      i.text !== text
    )
      throw held('Browser control requires the exact current human request.');
  }
  change(fn) {
    const actual = fs.existsSync(this.file) ? hash(fs.readFileSync(this.file)) : null;
    if (this.failed || actual !== this.diskHash)
      throw held('Browser ownership journal changed. Automation is held.');
    const next = structuredClone(this.state);
    fn(next);
    validate(next);
    try {
      atomicJSON(this.file, next);
      const bytes = fs.readFileSync(this.file);
      if (JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(next))
        throw held('Browser ownership was not confirmed.');
      this.diskHash = hash(bytes);
      this.state = next;
    } catch (e) {
      this.failed = true;
      throw e;
    }
  }
  entry(id) {
    const e = this.state.entries.find((e) => e.id === id);
    if (!e || e.actorId !== this.actorId)
      throw held('Select the exact browser owned by the current human.');
    return e;
  }
  async run(live, operation) {
    if (live.pending) throw held('The original browser operation has not settled.');
    const job = { settled: false };
    live.pending = job;
    job.promise = Promise.resolve()
      .then(operation)
      .finally(() => {
        job.settled = true;
        if (live.pending === job) live.pending = null;
      });
    return job.promise;
  }
  async bound(e) {
    if (this.options.admission?.() !== 'allow')
      throw held('Browser work is paused by its local work control.');
    await this.options.verifyBinding(e.taskId, e.grantId);
    if (this.options.admission?.() !== 'allow')
      throw held('Browser work was paused during its executor handshake.');
  }
  async open(i, spec) {
    this.human(i, i?.text);
    const prefix = '/browser open ';
    if (
      !i.text.startsWith(prefix) ||
      JSON.stringify(JSON.parse(i.text.slice(prefix.length))) !== JSON.stringify(spec) ||
      Object.keys(spec || {})
        .sort()
        .join(',') !== 'grantId,origins,taskId,url' ||
      !uuid(spec.grantId) ||
      typeof spec.taskId !== 'string' ||
      !spec.taskId ||
      !Array.isArray(spec.origins) ||
      !spec.origins.length ||
      spec.origins.length > 8 ||
      spec.origins.some((u) => origin(u) !== u) ||
      !spec.origins.includes(origin(spec.url))
    )
      throw held('Open needs exact local taskId, grantId, url and allowed origins.');
    const e = {
      id: crypto.randomUUID(),
      taskId: spec.taskId,
      grantId: spec.grantId,
      actorId: this.actorId,
      origins: [...new Set(spec.origins)],
      owner: 'held',
      epoch: 0,
      createdAt: Date.now(),
      origin: origin(spec.url),
      provider: 'local-electron-private',
      reason: null,
    };
    await this.bound(e);
    this.change((s) => s.entries.push(e));
    let adapter;
    try {
      adapter = await this.options.create({
        id: e.id,
        url: spec.url,
        allowNavigation: (target) =>
          this.entry(e.id).owner === 'human' || this.entry(e.id).origins.includes(origin(target)),
        onClosed: () => {
          try {
            this.closed(e.id);
          } catch {
            this.failed = true;
            const live = this.live.get(e.id);
            if (live) live.lease = null;
          }
        },
      });
      this.live.set(e.id, { adapter, lease: null });
      this.change((s) => {
        s.entries.find((x) => x.id === e.id).owner = 'human';
      });
      return {
        sessionId: e.id,
        control: 'human',
        origin: e.origin,
        login: 'ephemeral',
        savedCredentialsReused: false,
      };
    } catch (error) {
      adapter?.close();
      this.change((s) => {
        s.entries.find((x) => x.id === e.id).reason =
          'Browser could not open. No alternate or cloud browser was started.';
      });
      throw held('Local browser is unavailable. Original task stays on its executor.');
    }
  }
  async takeover(i, id) {
    this.human(i, '/browser takeover ' + id);
    const e = this.entry(id),
      live = this.live.get(id);
    if (!live) throw held('Original browser is unavailable; it was not replaced.');
    this.change((s) => {
      const x = s.entries.find((x) => x.id === id);
      x.owner = 'held';
      x.epoch++;
      x.reason = 'Waiting for the existing automated operation to stop.';
    });
    live.lease = null;
    const stopped = await live.adapter.stop();
    if (live.pending) {
      const job = live.pending;
      let timer;
      try {
        const settled = await Promise.race([
          job.promise.then(
            () => true,
            () => true,
          ),
          new Promise((resolve) => (timer = setTimeout(() => resolve(false), 2000))),
        ]);
        if (!settled)
          throw held('The original browser operation has not settled. Human control remains held.');
      } finally {
        clearTimeout(timer);
      }
    }
    if (stopped !== true)
      throw held('Automation stop was not confirmed. Browser control remains held.');
    live.adapter.show();
    this.change((s) => {
      const x = s.entries.find((x) => x.id === id);
      x.owner = 'human';
      x.reason = null;
    });
    return { sessionId: e.id, control: 'human', automatedInputsStopped: true };
  }
  async returnControl(i, id) {
    this.human(i, '/browser return ' + id);
    const e = this.entry(id),
      live = this.live.get(id);
    if (!live || e.owner !== 'human')
      throw held('Take over the original browser before returning control.');
    await this.bound(e);
    const current = origin(live.adapter.url());
    if (!e.origins.includes(current))
      throw held(
        'Current site is outside this browser scope. No fallback or widened access was granted.',
      );
    if ((await live.adapter.stop()) !== true) throw held('Pending navigation has not stopped.');
    if (this.entry(id).owner !== 'human' || live.pending)
      throw held('Original browser control changed before return.');
    live.adapter.hide();
    const lease = { id, epoch: e.epoch + 1, token: crypto.randomUUID() };
    this.change((s) => {
      const x = s.entries.find((x) => x.id === id);
      x.owner = 'agent';
      x.epoch = lease.epoch;
      x.origin = current;
    });
    live.lease = lease;
    return { sessionId: id, control: 'agent', epoch: lease.epoch };
  }
  lease(id) {
    return structuredClone(this.live.get(id)?.lease || null);
  }
  async check(lease) {
    const e = this.entry(lease?.id),
      live = this.live.get(e.id);
    if (
      this.failed ||
      !live ||
      e.owner !== 'agent' ||
      e.epoch !== lease.epoch ||
      live.lease?.token !== lease.token
    )
      throw held('Browser lease changed; human ownership or another session blocks automation.');
    await this.bound(e);
    const current = this.entry(e.id);
    if (
      current.owner !== 'agent' ||
      current.epoch !== lease.epoch ||
      live.lease?.token !== lease.token
    )
      throw held('Browser ownership changed during its executor handshake.');
    if (!e.origins.includes(origin(live.adapter.url())))
      throw held('Current page left the authorized site scope. No browser fallback is allowed.');
    return { e, live };
  }
  async read(lease) {
    const { e, live } = await this.check(lease);
    const value = await this.run(live, () => live.adapter.read());
    await this.check(lease);
    return {
      sessionId: e.id,
      origin: origin(live.adapter.url()),
      text: String(value).slice(0, 12000),
      truncated: String(value).length > 12000,
      provenance: 'untrusted_browser_page',
      instructionsAuthorized: false,
    };
  }
  async navigate(lease, url) {
    const { e, live } = await this.check(lease);
    if (!e.origins.includes(origin(url)))
      throw held('Destination is outside the authorized origins.');
    await this.run(live, () => live.adapter.navigate(url));
    await this.check(lease);
    this.change((s) => {
      s.entries.find((x) => x.id === e.id).origin = origin(live.adapter.url());
    });
    return { sessionId: e.id, origin: origin(live.adapter.url()), navigationCompleted: true };
  }
  async saveLogin(i, id) {
    this.human(i, '/browser save-login ' + id);
    const e = this.entry(id),
      live = this.live.get(id);
    if (!live || e.owner !== 'human')
      throw held('Saving a login requires current human control of the original browser.');
    await this.bound(e);
    const current = origin(live.adapter.url());
    if (!current.startsWith('https:') || !e.origins.includes(current))
      throw held('Save only the exact authorized HTTPS login destination.');
    const cookies = await this.run(live, () => live.adapter.cookies(current));
    if (this.entry(id).owner !== 'human')
      throw held('Browser ownership changed while preparing the saved login.');
    const vaultId = this.options.vault.save(this.actorId, current, cookies);
    return {
      vaultId,
      origin: current,
      credentialLocation: 'OS-encrypted local vault',
      savedOnlyAfterExplicitHumanRequest: true,
    };
  }
  async reuseLogin(i, id, vaultId) {
    this.human(i, '/browser reuse-login ' + id + ' ' + vaultId);
    const e = this.entry(id),
      live = this.live.get(id);
    if (!live || e.owner !== 'human')
      throw held('Reusing a saved login requires current human control.');
    await this.bound(e);
    const current = origin(live.adapter.url());
    if (!e.origins.includes(current)) throw held('Browser is outside its login scope.');
    const cookies = this.options.vault.load(this.actorId, current, vaultId);
    await this.run(live, () => live.adapter.restoreCookies(current, cookies));
    if (this.entry(id).owner !== 'human')
      throw held('Ownership changed while applying the explicit saved login.');
    return {
      sessionId: id,
      origin: current,
      savedCredentialsReused: true,
      authenticatedSiteVerified: false,
    };
  }
  close(i, id) {
    this.human(i, '/browser close ' + id);
    this.entry(id);
    this.closed(id);
    this.live.get(id)?.adapter.close();
    this.live.delete(id);
    return { sessionId: id, control: 'closed', externalActionsReversed: false };
  }
  closed(id) {
    if (!this.state.entries.some((e) => e.id === id)) return;
    this.change((s) => {
      const e = s.entries.find((e) => e.id === id);
      e.owner = 'closed';
      e.epoch++;
    });
    const live = this.live.get(id);
    if (live) live.lease = null;
  }
  inspect() {
    return {
      support: {
        localPrivateBrowser: !!this.options.create,
        existingChromeProfile: false,
        cloudBrowser: false,
        automaticFallback: false,
        osEncryptedExplicitLogin: !!this.options.vault,
      },
      sessions: this.state.entries
        .slice(-16)
        .map((e) => ({
          ...e,
          live: this.live.has(e.id),
          pageContentsIncluded: false,
          credentialValuesIncluded: false,
        })),
    };
  }
  shutdown() {
    for (const live of this.live.values()) live.adapter.close();
    this.live.clear();
  }
}
module.exports = { BrowserSessions, validate, origin };
