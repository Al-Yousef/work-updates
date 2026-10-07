'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { readStore, atomicJSON } = require('./private-store.cjs');
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
const uuid = (v) => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
const held = (message) => Object.assign(new Error(message), { code: 'VOICE_SESSION_HELD' });
const validUsage = (value) =>
  value == null ||
  (['inputTokens', 'outputTokens', 'totalTokens'].every(
    (k) => Number.isSafeInteger(value[k]) && value[k] >= 0,
  ) &&
    value.totalTokens === value.inputTokens + value.outputTokens);
function usageSummary(session) {
  const known = session.responses.filter((r) => r.usageActual);
  const usageActual = known.length
    ? known.reduce(
        (total, r) => ({
          inputTokens: total.inputTokens + r.usageActual.inputTokens,
          outputTokens: total.outputTokens + r.usageActual.outputTokens,
          totalTokens: total.totalTokens + r.usageActual.totalTokens,
        }),
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      )
    : null;
  if (!validUsage(usageActual))
    throw held('Reported voice usage exceeded its supported bound. Preserve the prior checkpoint.');
  return {
    usageActual,
    usageCoverage: {
      reportedResponses: known.length,
      missingUsageResponses: session.responses.filter(
        (r) => r.status !== 'active' && !r.usageActual,
      ).length,
      activeResponses: session.responses.filter((r) => r.status === 'active').length,
    },
  };
}
function validate(s) {
  if (
    s?.version !== 1 ||
    !Array.isArray(s.sessions) ||
    s.sessions.length > 64 ||
    new Set(s.sessions.map((e) => e.id)).size !== s.sessions.length
  )
    throw held('Unsupported voice journal; original bytes are preserved.');
  for (const e of s.sessions)
    if (
      !uuid(e.id) ||
      typeof e.actorId !== 'string' ||
      !['starting', 'connected', 'muted', 'disconnected', 'ended', 'unconfirmed'].includes(
        e.status,
      ) ||
      !Number.isFinite(e.startedAt) ||
      !Number.isFinite(e.until) ||
      !Array.isArray(e.responses) ||
      e.responses.length > 128 ||
      new Set(e.responses.map((r) => r.id)).size !== e.responses.length ||
      !validUsage(e.usageActual) ||
      (e.tokenReservation !== undefined &&
        (!Number.isSafeInteger(e.tokenReservation) ||
          e.tokenReservation < 1 ||
          e.tokenReservation > 300000)) ||
      e.responses.some(
        (r) =>
          typeof r.id !== 'string' ||
          !r.id ||
          r.id.length > 160 ||
          !validUsage(r.usageActual) ||
          (r.status === 'active' && r.usageActual != null) ||
          !['active', 'completed', 'cancelled', 'failed', 'unconfirmed'].includes(r.status),
      ) ||
      typeof e.model !== 'string' ||
      e.provider !== 'openai-realtime'
    )
      throw held('Invalid voice checkpoint.');
  for (const e of s.sessions)
    if (e.selectedContext !== undefined)
      require('./voice-context.cjs').validateMetadata(e.selectedContext);
  for (const e of s.sessions)
    if (
      e.providerTermination !== undefined &&
      (!['pending', 'initiated', 'unconfirmed', 'unavailable'].includes(
        e.providerTermination.state,
      ) ||
        !Number.isSafeInteger(e.providerTermination.attempts) ||
        e.providerTermination.attempts < 1 ||
        !Number.isFinite(e.providerTermination.at))
    )
      throw held('Invalid provider termination checkpoint.');
}
class VoiceSession {
  constructor(options) {
    this.options = options;
    this.actorId = options.actorId;
    this.file = path.join(options.directory, 'voice.json');
    this.live = null;
    this.failed = false;
    this.terminationJobs = new Map();
    this.pendingTerminations = new Set();
    const saved = readStore(this.file);
    this.state = saved.missing ? { version: 1, sessions: [] } : saved.value;
    validate(this.state);
    for (const session of this.state.sessions) Object.assign(session, usageSummary(session));
    this.diskHash = saved.missing ? null : hash(fs.readFileSync(this.file));
    if (
      this.state.sessions.some(
        (s) =>
          ['starting', 'connected', 'muted'].includes(s.status) ||
          s.providerTermination?.state === 'pending',
      )
    )
      this.change((v) => {
        for (const s of v.sessions) {
          if (s.providerTermination?.state === 'pending')
            s.providerTermination.state = 'unconfirmed';
          if (['starting', 'connected', 'muted'].includes(s.status)) {
            s.status = 'unconfirmed';
            for (const r of s.responses) if (r.status === 'active') r.status = 'unconfirmed';
            Object.assign(s, usageSummary(s));
          }
        }
      });
  }
  now() {
    return this.options.now?.() ?? Date.now();
  }
  get active() {
    return !!this.live || this.pendingTerminations.size > 0;
  }
  forgetProviderCredentials() {
    if (this.active)
      throw held(
        'End the current voice session and wait for its end request before removing credentials.',
      );
    this.options.provider.forgetCredentials?.();
  }
  change(update) {
    const disk = fs.existsSync(this.file) ? hash(fs.readFileSync(this.file)) : null;
    if (this.failed || disk !== this.diskHash)
      throw held('Voice checkpoints changed; a new call is held.');
    const next = structuredClone(this.state);
    update(next);
    validate(next);
    try {
      atomicJSON(this.file, next);
      const bytes = fs.readFileSync(this.file);
      if (JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(next))
        throw held('Voice checkpoint was not confirmed.');
      this.diskHash = hash(bytes);
      this.state = next;
    } catch (e) {
      this.failed = true;
      throw e;
    }
  }
  human(i) {
    if (
      i?.role !== 'human' ||
      i.authority !== 'accepted_human' ||
      i.actorId !== this.actorId ||
      !uuid(i.messageId)
    )
      throw held('Voice needs the current explicit human request.');
  }
  entry(id) {
    const s = this.state.sessions.find((x) => x.id === id && x.actorId === this.actorId);
    if (!s) throw held('Select the exact current voice session.');
    return s;
  }
  async begin(
    i,
    { maxSeconds, billingConfirmed, microphoneConfirmed, tokenReservation, selectedContext },
  ) {
    this.human(i);
    if (
      this.live ||
      !Number.isSafeInteger(maxSeconds) ||
      maxSeconds < 15 ||
      maxSeconds > 300 ||
      billingConfirmed !== true ||
      microphoneConfirmed !== true ||
      this.options.admission?.() !== 'allow'
    )
      throw held(
        'Voice needs explicit microphone/API-billing consent and one finite session on this device.',
      );
    const support = this.options.provider.support();
    if (!support.configured || support.provider !== 'openai-realtime' || !support.model)
      throw held(
        'Configure a supported voice provider separately. Codex plan inference is not an audio provider.',
      );
    const context = selectedContext ? this.options.context?.capture(selectedContext) : null;
    if (selectedContext && !context) throw held('Selected task context is unavailable.');
    const e = {
      id: crypto.randomUUID(),
      actorId: this.actorId,
      provider: support.provider,
      model: support.model,
      status: 'starting',
      startedAt: this.now(),
      until: this.now() + maxSeconds * 1000,
      responses: [],
      usageActual: null,
      costActualUSD: null,
      context: context?.label || 'Voice conversation only; no task history shared',
      microphonePermission: 'explicit_current_session',
      billing: 'separate provider API',
      originMessageId: i.messageId,
    };
    if (context)
      e.selectedContext = {
        selection: context.selection,
        digest: context.digest,
        capturedAt: context.capturedAt,
        coverage: context.data.coverage,
      };
    if (this.options.budgets) {
      if (
        !Number.isSafeInteger(tokenReservation) ||
        tokenReservation < 1 ||
        tokenReservation > 300000
      )
        throw held(
          'Choose a finite voice token reservation before microphone access. It is an estimate, not a provider price or token ceiling.',
        );
      if (
        context &&
        tokenReservation < Math.ceil(Buffer.byteLength(JSON.stringify(context.data)) / 3) + 1
      )
        throw held('The token reservation must include the selected task snapshot.');
      this.options.budgets.reserve({
        id: e.id,
        kind: 'model',
        provider: e.provider,
        model: e.model,
        ...(context
          ? { sourceId: context.selection.sourceId, taskKey: context.selection.taskKey }
          : {}),
        estimate: { tokens: tokenReservation, costMicros: null },
      });
      e.tokenReservation = tokenReservation;
    }
    try {
      this.change((v) => v.sessions.push(e));
    } catch (error) {
      this.options.budgets?.finish(e.id, { status: 'not_started' });
      throw error;
    }
    this.live = {
      id: e.id,
      epoch: crypto.randomUUID(),
      abort: new AbortController(),
      connected: false,
      context,
    };
    return {
      sessionId: e.id,
      until: e.until,
      provider: e.provider,
      model: e.model,
      context: e.context,
      recordingStored: false,
      outboundCalls: false,
      costActualUSD: null,
    };
  }
  async connect(id, sdp) {
    const e = this.entry(id),
      live = this.live;
    if (
      !live ||
      live.id !== id ||
      e.status !== 'starting' ||
      live.connecting ||
      typeof sdp !== 'string' ||
      sdp.length > 128000 ||
      !sdp.startsWith('v=0') ||
      this.now() >= e.until ||
      this.options.admission?.() !== 'allow'
    )
      throw held('The current voice connection request is unavailable or changed.');
    live.connecting = true;
    try {
      if (live.context) this.options.context.assertCurrent(live.context);
      this.options.budgets?.started(id, id);
      const answer = await this.options.provider.connect({
        sessionId: id,
        sdp,
        signal: live.abort.signal,
        model: e.model,
        ...(live.context
          ? { context: { capturedAt: live.context.capturedAt, data: live.context.data } }
          : {}),
      });
      if (live.context) this.options.context.assertCurrent(live.context);
      if (this.live !== live || this.now() >= e.until || this.options.admission?.() !== 'allow')
        throw held('Voice ended or was paused during connection; its answer is discarded.');
      if (typeof answer !== 'string' || !answer.startsWith('v=0') || answer.length > 128000)
        throw held('Provider returned an invalid audio connection answer.');
      this.change((v) => {
        v.sessions.find((x) => x.id === id).status = 'connected';
      });
      live.connected = true;
      return { sdp: answer, sessionId: id };
    } catch (error) {
      this.requestTermination(id);
      if (this.options.budgets) {
        const reservation = this.options.budgets.state.entries.find((r) => r.id === id);
        this.options.budgets.finish(id, {
          status: reservation?.status === 'reserved' ? 'not_started' : 'unknown',
        });
      }
      if (this.live === live) {
        this.change((v) => {
          v.sessions.find((x) => x.id === id).status = 'unconfirmed';
        });
        live.abort.abort();
        this.live = null;
      }
      throw held(
        'Voice connection is unconfirmed. No automatic reconnect or replacement call will occur.',
      );
    }
  }
  current(id) {
    const e = this.entry(id);
    if (
      !this.live ||
      this.live.id !== id ||
      !['connected', 'muted'].includes(e.status) ||
      this.now() >= e.until ||
      this.options.admission?.() !== 'allow' ||
      (this.live.context && !this.options.context.available(this.live.context))
    )
      throw held('Voice is disconnected, ended, expired or held.');
    return e;
  }
  events(id, event) {
    const e = this.current(id);
    if (event?.type === 'response.created') {
      const r = event.response;
      if (typeof r?.id !== 'string' || !r.id || r.id.length > 160)
        throw held('Invalid voice response identity.');
      if (e.responses.some((x) => x.id === r.id)) return;
      this.change((v) => {
        const session = v.sessions.find((x) => x.id === id);
        session.responses.push({ id: r.id, status: 'active', at: this.now() });
        Object.assign(session, usageSummary(session));
      });
    } else if (event?.type === 'response.done') {
      const r = event.response,
        original = e.responses.find((x) => x.id === r?.id);
      if (!original) throw held('Voice completion belongs to an unaccepted response.');
      if (original.status !== 'active') return;
      const status =
        {
          completed: 'completed',
          cancelled: 'cancelled',
          failed: 'failed',
          incomplete: 'unconfirmed',
        }[r.status] || 'unconfirmed';
      let usage = null;
      if (
        r.usage &&
        ['input_tokens', 'output_tokens', 'total_tokens'].every(
          (k) => Number.isSafeInteger(r.usage[k]) && r.usage[k] >= 0,
        ) &&
        r.usage.total_tokens === r.usage.input_tokens + r.usage.output_tokens
      )
        usage = {
          inputTokens: r.usage.input_tokens,
          outputTokens: r.usage.output_tokens,
          totalTokens: r.usage.total_tokens,
        };
      this.change((v) => {
        const s = v.sessions.find((x) => x.id === id),
          response = s.responses.find((x) => x.id === r.id);
        response.status = status;
        response.usageActual = usage;
        response.completedAt = this.now();
        Object.assign(s, usageSummary(s));
      });
      const updated = this.entry(id);
      if (this.options.budgets && updated.usageActual) {
        this.options.budgets.reportTokens(id, id, updated.usageActual.totalTokens);
        if (
          updated.usageActual.totalTokens >= updated.tokenReservation ||
          this.options.budgets.tokenLimitReached(id)
        ) {
          this.end(
            {
              role: 'human',
              authority: 'accepted_human',
              actorId: this.actorId,
              messageId: crypto.randomUUID(),
            },
            id,
            'resource_budget',
          );
        }
      }
    }
  }
  steer(i, id, text) {
    this.human(i);
    const e = this.current(id);
    if (typeof text !== 'string' || !text.trim() || text.length > 4000)
      throw held('Choose one bounded current human voice message.');
    const active = e.responses.findLast((r) => r.status === 'active'),
      events = [];
    if (active)
      events.push(
        { type: 'response.cancel', response_id: active.id },
        { type: 'output_audio_buffer.clear' },
      );
    events.push(
      {
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      },
      { type: 'response.create', response: { output_modalities: ['audio'] } },
    );
    return { sessionId: id, events, taskActionsAuthorized: false };
  }
  mute(i, id, muted) {
    this.human(i);
    this.current(id);
    if (typeof muted !== 'boolean') throw held('Choose mute or unmute for the current session.');
    this.change((v) => {
      v.sessions.find((x) => x.id === id).status = muted ? 'muted' : 'connected';
    });
    return { sessionId: id, microphoneMuted: muted, providerSessionContinues: true };
  }
  requestTermination(id, retry = false) {
    const entry = this.entry(id);
    if (
      this.terminationJobs.has(id) &&
      (!retry || entry.providerTermination?.state !== 'unconfirmed')
    )
      return this.terminationJobs.get(id);
    if (entry.providerTermination?.state === 'initiated')
      return Promise.resolve(entry.providerTermination);
    const checkpoint = {
      state: 'pending',
      attempts: (entry.providerTermination?.attempts || 0) + 1,
      at: this.now(),
    };
    try {
      this.change((v) => {
        v.sessions.find((s) => s.id === id).providerTermination = checkpoint;
      });
    } catch {
      /* Stop the exact owned call even when its journal requires recovery. */
    }
    this.pendingTerminations.add(id);
    const job = Promise.resolve()
      .then(() => this.options.provider.terminate?.(id, { retry }) || { state: 'unavailable' })
      .catch(() => ({ state: 'unconfirmed' }))
      .then((result) => {
        const state = ['initiated', 'unconfirmed', 'unavailable'].includes(result?.state)
          ? result.state
          : 'unconfirmed';
        const settled = { ...checkpoint, state };
        try {
          this.change((v) => {
            v.sessions.find((s) => s.id === id).providerTermination = settled;
          });
        } catch {
          return { ...settled, checkpoint: 'unconfirmed' };
        }
        return settled;
      })
      .finally(() => this.pendingTerminations.delete(id));
    this.terminationJobs.set(id, job);
    return job;
  }
  termination(id) {
    const e = this.entry(id);
    return {
      sessionId: id,
      state: e.providerTermination?.state || 'unavailable',
      remoteTerminationVerified: false,
      remoteTerminationRequested: e.providerTermination?.state === 'initiated',
      finalUsageVerified: false,
      retryAvailable:
        e.providerTermination?.state === 'unconfirmed' &&
        !!this.options.provider.canTerminate?.(id),
    };
  }
  async waitForTermination(id) {
    await this.terminationJobs.get(id);
    return this.termination(id);
  }
  end(i, id, reason = 'human_end', retryTermination = false) {
    this.human(i);
    const e = this.entry(id);
    if (this.live?.id === id) {
      this.live.abort.abort();
      this.live = null;
    }
    this.options.stopAudio?.(id);
    try {
      this.change((v) => {
        const s = v.sessions.find((x) => x.id === id);
        s.status = 'ended';
        s.endedAt = this.now();
        s.reason = reason;
        for (const r of s.responses) if (r.status === 'active') r.status = 'unconfirmed';
        Object.assign(s, usageSummary(s));
      });
    } finally {
      this.requestTermination(id, retryTermination);
    }
    if (this.options.budgets) {
      const reservation = this.options.budgets.state.entries.find((x) => x.id === id);
      if (reservation && ['reserved', 'running', 'unknown'].includes(reservation.status)) {
        const neverConnected = reservation.status === 'reserved';
        this.options.budgets.finish(id, { status: neverConnected ? 'not_started' : 'unknown' });
      }
    }
    return {
      sessionId: e.id,
      status: 'ended',
      localAudioMustStop: true,
      remoteTerminationVerified: false,
      unrelatedTasksStopped: false,
    };
  }
  disconnect(id) {
    this.entry(id);
    if (this.live?.id === id) {
      this.live.abort.abort();
      this.live = null;
    }
    this.options.stopAudio?.(id);
    try {
      this.change((v) => {
        const s = v.sessions.find((x) => x.id === id);
        s.status = 'disconnected';
        for (const r of s.responses) if (r.status === 'active') r.status = 'unconfirmed';
        Object.assign(s, usageSummary(s));
      });
    } finally {
      this.requestTermination(id);
    }
    if (this.options.budgets) {
      this.options.budgets.finish(id, { status: 'unknown' });
    }
    return { automaticReconnect: false, newConsentRequired: true };
  }
  expire() {
    if (
      this.live &&
      (this.now() >= this.entry(this.live.id).until ||
        this.options.admission?.() !== 'allow' ||
        (this.live.context && !this.options.context.available(this.live.context)))
    ) {
      const id = this.live.id;
      this.end(
        {
          role: 'human',
          authority: 'accepted_human',
          actorId: this.actorId,
          messageId: crypto.randomUUID(),
        },
        id,
        'finite_session_or_work_hold',
      );
    }
  }
  inspect() {
    return {
      support: this.options.provider.support(),
      sessions: this.state.sessions.slice(-8),
      audioStorage: 'No microphone samples or transcripts persisted',
      taskDispatch: false,
      outboundTelephony: false,
      automaticReconnect: false,
      providerTermination: this.state.sessions.slice(-8).map((s) => this.termination(s.id)),
    };
  }
  close() {
    if (this.live) {
      const id = this.live.id;
      this.disconnect(id);
    }
    return Promise.allSettled([...this.terminationJobs.values()]);
  }
}
module.exports = { VoiceSession, validate };
