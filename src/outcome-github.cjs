'use strict';
const crypto = require('node:crypto');
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
function target(spec) {
  const match =
    typeof spec.target === 'string' &&
    spec.target.match(
      /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,9})$/,
    );
  if (
    !match ||
    !/^[a-f0-9]{40}$/.test(spec.targetRevision) ||
    typeof spec.baseRef !== 'string' ||
    !/^[A-Za-z0-9_./-]{1,200}$/.test(spec.baseRef) ||
    spec.baseRef.includes('..') ||
    spec.baseRef.startsWith('/') ||
    spec.baseRef.endsWith('/')
  )
    throw new Error(
      'GitHub merge proof needs one exact public pull URL, expected head SHA and baseRef.',
    );
  return {
    owner: match[1],
    repository: match[2],
    number: Number(match[3]),
    api: `https://api.github.com/repos/${match[1]}/${match[2]}/pulls/${match[3]}`,
  };
}
class PublicGitHubPR {
  constructor(options) {
    this.options = options;
    this.pending = new Set();
    this.closed = false;
  }
  now() {
    return this.options.now?.() ?? Date.now();
  }
  async read(spec, context) {
    const selected = target(spec),
      budgets = this.options.budgets;
    if (this.closed || !budgets) throw new Error('Public GitHub verification is unavailable.');
    context.beforeRead();
    const connectorKey = sha('public-github-api'),
      delay = budgets.state.connectors[connectorKey];
    if (delay?.nextAt > this.now())
      return {
        status: 'rate_limited',
        reason: 'provider_backoff',
        retryAfterMs: Math.max(60000, Math.min(86400000, delay.nextAt - this.now())),
      };
    const id = crypto.randomUUID(),
      controller = new AbortController();
    budgets.reserve({
      id,
      kind: 'read',
      provider: 'public-github',
      model: 'none',
      sourceId: context.sourceId,
      taskKey: context.responsibilityId,
      estimate: { tokens: 0, costMicros: 0 },
    });
    let started = false,
      response;
    this.pending.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    timeout.unref?.();
    try {
      context.beforeRead();
      budgets.started(id);
      started = true;
      response = await (this.options.fetch || fetch)(selected.api, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'Hyphen-public-outcome-check',
          'Cache-Control': 'no-cache',
        },
      });
      context.beforeRead();
      if (this.closed || controller.signal.aborted)
        throw new Error('Destination read was interrupted.');
      if (response.redirected || (response.url && response.url !== selected.api))
        throw new Error('Destination response changed its exact endpoint.');
      let result;
      if (
        response.status === 429 ||
        (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
      ) {
        const raw = response.headers.get('retry-after'),
          seconds = raw && /^[0-9]{1,6}$/.test(raw) ? Number(raw) : null,
          reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        result = {
          status: 'rate_limited',
          reason: 'provider_rate_limit',
          retryAfterMs: Math.max(
            60000,
            Math.min(
              86400000,
              seconds === null && Number.isFinite(reset) && reset > this.now()
                ? reset - this.now()
                : (seconds || 300) * 1000,
            ),
          ),
        };
      } else if (response.status !== 200) {
        result = { status: 'inaccessible', reason: 'destination_unavailable' };
      } else if (
        !/^application\/(?:json|vnd\.github\+json)(?:;|$)/i.test(
          response.headers.get('content-type') || '',
        )
      ) {
        result = { status: 'partial', reason: 'response_format' };
      } else {
        const advertised = response.headers.get('content-length');
        if (advertised && (!/^[0-9]+$/.test(advertised) || Number(advertised) > 1024 * 1024))
          result = { status: 'partial', reason: 'response_bound' };
        else {
          const chunks = [];
          let bytes = 0;
          for await (const chunk of response.body || []) {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) {
              controller.abort();
              throw new Error('Destination response exceeded its bound.');
            }
            chunks.push(Buffer.from(chunk));
          }
          context.beforeRead();
          const raw = Buffer.concat(chunks);
          try {
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
            result = this.evaluate(spec, selected, value, response.headers, sha(raw));
          } catch {
            result = { status: 'partial', reason: 'invalid_response' };
          }
        }
      }
      await response.body?.cancel().catch(() => {});
      context.beforeRead();
      budgets.finish(id, { status: 'settled' });
      if (result.reason === 'provider_rate_limit')
        budgets.change((next) => {
          next.connectors[connectorKey] = {
            fingerprint: null,
            unchanged: 0,
            nextAt: this.now() + result.retryAfterMs,
          };
        });
      return result;
    } catch (error) {
      controller.abort();
      try {
        budgets.finish(id, { status: started ? 'unknown' : 'not_started' });
      } catch {}
      throw error;
    } finally {
      clearTimeout(timeout);
      this.pending.delete(controller);
    }
  }
  evaluate(spec, selected, value, headers, responseSha256) {
    const repo = value?.base?.repo,
      head = value?.head;
    if (
      value?.number !== selected.number ||
      value.html_url !== spec.target ||
      repo?.full_name?.toLowerCase() !==
        (selected.owner + '/' + selected.repository).toLowerCase() ||
      repo?.private !== false ||
      !['open', 'closed'].includes(value.state) ||
      typeof value.merged !== 'boolean' ||
      !/^[a-f0-9]{40}$/.test(head?.sha || '')
    )
      return { status: 'partial', reason: 'identity_or_coverage' };
    const date = Date.parse(headers.get('date')),
      age = Number(headers.get('age') || 0);
    if (!Number.isFinite(date) || !Number.isFinite(age) || age < 0)
      return { status: 'partial', reason: 'freshness_unavailable' };
    if (
      date > this.now() + 5000 ||
      this.now() - date > spec.maxAgeSeconds * 1000 ||
      age > spec.maxAgeSeconds
    )
      return { status: 'stale', reason: 'stale_destination' };
    if (head.sha !== spec.targetRevision || value.base.ref !== spec.baseRef)
      return { status: 'changed', reason: 'destination_revision' };
    const observation = {
      provider: 'public-github',
      target: spec.target,
      headSha: head.sha,
      baseRef: value.base.ref,
      responseSha256,
      observedAt: this.now(),
      merged: value.merged,
    };
    if (!value.merged) return { status: 'not_satisfied', reason: 'not_merged', observation };
    if (
      value.state !== 'closed' ||
      !Number.isFinite(Date.parse(value.merged_at)) ||
      Date.parse(value.merged_at) > this.now() + 5000 ||
      !/^[a-f0-9]{40}$/.test(value.merge_commit_sha || '')
    )
      return { status: 'partial', reason: 'merge_evidence' };
    return {
      status: 'verified',
      proof: {
        ...observation,
        stage: 'merged',
        targetRevision: spec.targetRevision,
        mergeSha: value.merge_commit_sha,
      },
    };
  }
  close() {
    this.closed = true;
    for (const controller of this.pending) controller.abort();
  }
}
module.exports = { PublicGitHubPR, target };
