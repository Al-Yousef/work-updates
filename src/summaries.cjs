'use strict';
const path = require('node:path');
const { atomic, read } = require('./queue.cjs');
const { summaryKey, summaryInput, validateSummary, VERSION } = require('./summary-key.cjs');
const { CodexSummaryProvider } = require('./summary-provider.cjs');
class Summaries {
  constructor(queue, options = {}) {
    this.queue = queue;
    this.options = options;
    this.file = path.join(queue.directory, 'summary-cache.json');
    this.cache = read(this.file, { version: VERSION, entries: {}, seen: {}, attempts: [] });
    if (this.cache.version !== VERSION)
      this.cache = { version: VERSION, entries: {}, seen: {}, attempts: [] };
    this.cache.entries ||= {};
    this.cache.seen ||= {};
    this.cache.queued ||= {};
    if (!Array.isArray(this.cache.attempts)) this.cache.attempts = [];
    this.pending = new Map();
    this.running = false;
    this.closed = false;
    this.retry = null;
    this.error = '';
    this.pauseUntil = 0;
    this.provider =
      options.provider ||
      new CodexSummaryProvider({
        directory: path.join(queue.directory, 'summary-workspace'),
        binary: queue.state.settings.codexBinary,
      });
    // A persisted attempt is never repeated after a crash, preventing duplicate inference charges.
    for (const entry of Object.values(this.cache.entries))
      if (entry.status === 'pending') entry.status = 'failed';
    this.publish();
  }
  now() {
    return this.options.now?.() ?? Date.now();
  }
  currentUpdates() {
    const sources = new Map(this.queue.feed.threads.map((s) => [s.id, s]));
    const updates = new Map();
    for (const card of this.queue.cards()) {
      if (
        card.done ||
        card.reviewed ||
        card.snoozed ||
        card.status === 'queued' ||
        (card.kind !== 'local' && card.at < (this.queue.state.settings.queueSince || 0))
      )
        continue;
      const source = sources.get(card.primarySourceId);
      const key = summaryKey(source);
      if (key) updates.set(source.id, { source, key });
    }
    return updates;
  }
  resumeAt() {
    const now = this.now();
    const daily = this.cache.attempts.filter((at) => at > now - 86400000);
    const hourly = daily.filter((at) => at > now - 3600000);
    return Math.max(
      this.pauseUntil,
      hourly.length >= 20 ? Math.min(...hourly) + 3600001 : 0,
      daily.length >= 100 ? Math.min(...daily) + 86400001 : 0,
    );
  }
  save() {
    const entries = Object.entries(this.cache.entries)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, 2000);
    this.cache.entries = Object.fromEntries(entries);
    this.cache.attempts = this.cache.attempts.filter((at) => at > this.now() - 86400000);
    try {
      atomic(this.file, this.cache);
      return true;
    } catch {
      this.error = 'SUMMARY_CACHE_UNAVAILABLE';
      return false;
    }
  }
  publish() {
    const values = new Map();
    for (const [key, entry] of Object.entries(this.cache.entries)) {
      if (entry.status !== 'ok') continue;
      try {
        values.set(key, { ...validateSummary(entry), model: entry.model });
      } catch {}
    }
    const current = [...this.currentUpdates().values()];
    const failed = current.filter(({ key }) => this.cache.entries[key]?.status === 'failed').length;
    const pending = this.pending.size + Number(this.running);
    const resumeAt = pending && !this.running ? this.resumeAt() : 0;
    this.queue.setSummaries(values, {
      enabled: this.queue.state.settings.aiSummaries === true,
      model: this.provider.model || [...values.values()].at(-1)?.model || '',
      cached: values.size,
      eligible: current.length,
      summarized: current.filter(({ key }) => values.has(key)).length,
      failed,
      pending,
      resumeAt: resumeAt > this.now() ? resumeAt : 0,
      message:
        this.error && (this.error === 'SUMMARY_CACHE_UNAVAILABLE' || resumeAt > this.now())
          ? 'AI summaries paused; recorded excerpts remain available.'
          : '',
    });
  }
  refresh() {
    if (this.closed) return;
    const sources = this.queue.feed.threads;
    const current = this.currentUpdates();
    let changed = false;
    for (const source of sources) {
      const key = summaryKey(source);
      if (!key) {
        this.pending.delete(source.id);
        continue;
      }
      if (key !== this.cache.seen[source.id]) {
        this.cache.seen[source.id] = key;
        changed = true;
      }
    }
    // Backfill the active queue, including cards marked seen by older versions.
    // Priority order comes from Queue.cards(); the historical catalogue stays untouched.
    this.pending.clear();
    for (const [id, item] of current) {
      if (this.cache.entries[item.key] || this.queue.state.settings.aiSummaries !== true) continue;
      if (this.cache.queued[id] !== item.key) {
        this.cache.queued[id] = item.key;
        changed = true;
      }
      this.pending.set(id, item);
    }
    for (const [id, key] of Object.entries(this.cache.queued)) {
      if (current.get(id)?.key !== key || this.cache.entries[key]) {
        delete this.cache.queued[id];
        changed = true;
      }
    }
    if (sources.length && !this.cache.seeded) {
      this.cache.seeded = true;
      changed = true;
    }
    if (changed && !this.save()) {
      this.pending.clear();
      this.publish();
      return;
    }
    if (this.queue.state.settings.aiSummaries !== true) {
      this.pending.clear();
      this.provider.close();
    }
    this.publish();
    this.drain();
  }
  retryFailed() {
    if (this.closed || this.queue.state.settings.aiSummaries !== true) return 0;
    let count = 0;
    for (const { key } of this.currentUpdates().values()) {
      if (this.cache.entries[key]?.status !== 'failed') continue;
      delete this.cache.entries[key];
      count++;
    }
    // This method is invoked only by an explicit retry, never by polling or restart.
    if (count) {
      this.pauseUntil = 0;
      this.error = '';
      if (!this.save()) return 0;
      this.refresh();
    }
    return count;
  }
  async drain() {
    if (
      this.closed ||
      this.running ||
      this.queue.state.settings.aiSummaries !== true ||
      !this.pending.size
    )
      return;
    const now = this.now();
    const resume = this.resumeAt();
    if (resume > now) {
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.drain(), Math.min(resume - now, 2147483647));
      this.retry.unref?.();
      return;
    }
    const [id, item] = this.pending.entries().next().value;
    this.pending.delete(id);
    if (this.currentUpdates().get(id)?.key !== item.key) return this.drain();
    this.running = true;
    this.cache.attempts.push(now);
    delete this.cache.queued[id];
    this.cache.entries[item.key] = { status: 'pending', at: now };
    if (!this.save()) {
      this.running = false;
      this.pending.clear();
      this.publish();
      return;
    }
    this.publish();
    try {
      const result = await this.provider.summarize(summaryInput(item.source));
      const value = validateSummary(result);
      if (this.closed) return;
      this.cache.entries[item.key] = {
        ...value,
        model: result.model,
        status: 'ok',
        at: this.now(),
      };
      this.error = '';
      this.options.log?.write('summary.completed', { key: item.key, model: result.model });
    } catch (error) {
      if (this.closed) return;
      this.cache.entries[item.key] = { status: 'failed', at: this.now() };
      const code = /^SUMMARY_[A-Z_]+$/.test(error.message || '')
        ? error.message
        : 'SUMMARY_UNAVAILABLE';
      this.error = code;
      // Bad output belongs to this update; it must not stall unrelated cards.
      this.pauseUntil = code === 'SUMMARY_INVALID' ? 0 : this.now() + 15 * 60000;
      this.options.log?.write('summary.failed', {
        key: item.key,
        code,
        method: error.method,
        rpcCode: error.code,
      });
    } finally {
      this.running = false;
      if (!this.closed) {
        this.save();
        this.publish();
        this.drain();
      }
    }
  }
  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.pending.clear();
    this.provider.close();
  }
}
module.exports = { Summaries };
