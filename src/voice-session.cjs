'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { readStore, atomicJSON } = require('./private-store.cjs');
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
const uuid = (v) => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
const held = (message) => Object.assign(new Error(message), { code: 'VOICE_SESSION_HELD' });
function validate(s) {
  if (s?.version !== 1 || !Array.isArray(s.sessions) || s.sessions.length > 64)
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
      e.responses.some(
        (r) =>
          typeof r.id !== 'string' ||
          !['active', 'completed', 'cancelled', 'failed', 'unconfirmed'].includes(r.status),
      ) ||
      typeof e.model !== 'string' ||
      e.provider !== 'openai-realtime'
    )
      throw held('Invalid voice checkpoint.');
}
class VoiceSession {
  constructor(options) {
    this.options = options;
    this.actorId = options.actorId;
    this.file = path.join(options.directory, 'voice.json');
    this.live = null;
    this.failed = false;
    const saved = readStore(this.file);
    this.state = saved.missing ? { version: 1, sessions: [] } : saved.value;
    validate(this.state);
    this.diskHash = saved.missing ? null : hash(fs.readFileSync(this.file));
    if (this.state.sessions.some((s) => ['starting', 'connected', 'muted'].includes(s.status)))
      this.change((v) => {
        for (const s of v.sessions)
          if (['starting', 'connected', 'muted'].includes(s.status)) {
            s.status = 'unconfirmed';
            for (const r of s.responses) if (r.status === 'active') r.status = 'unconfirmed';
          }
      });
  }
  now() {
    return this.options.now?.() ?? Date.now();
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
  async begin(i, { maxSeconds, billingConfirmed, microphoneConfirmed }) {
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
      context: 'Voice conversation only; no task history shared',
      microphonePermission: 'explicit_current_session',
      billing: 'separate provider API',
      originMessageId: i.messageId,
    };
    this.change((v) => v.sessions.push(e));
    this.live = {
      id: e.id,
      epoch: crypto.randomUUID(),
      abort: new AbortController(),
      connected: false,
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
      const answer = await this.options.provider.connect({
        sdp,
        signal: live.abort.signal,
        model: e.model,
      });
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
      this.options.admission?.() !== 'allow'
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
      this.change((v) =>
        v.sessions
          .find((x) => x.id === id)
          .responses.push({ id: r.id, status: 'active', at: this.now() }),
      );
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
        s.usageActual = usage;
      });
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
  end(i, id, reason = 'human_end') {
    this.human(i);
    const e = this.entry(id);
    if (this.live?.id === id) {
      this.live.abort.abort();
      this.live = null;
    }
    this.change((v) => {
      const s = v.sessions.find((x) => x.id === id);
      s.status = 'ended';
      s.endedAt = this.now();
      s.reason = reason;
      for (const r of s.responses) if (r.status === 'active') r.status = 'unconfirmed';
    });
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
    this.change((v) => {
      const s = v.sessions.find((x) => x.id === id);
      s.status = 'disconnected';
      for (const r of s.responses) if (r.status === 'active') r.status = 'unconfirmed';
    });
    return { automaticReconnect: false, newConsentRequired: true };
  }
  expire() {
    if (
      this.live &&
      (this.now() >= this.entry(this.live.id).until || this.options.admission?.() !== 'allow')
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
      this.options.stopAudio?.(id);
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
    };
  }
  close() {
    if (this.live) {
      const id = this.live.id;
      this.disconnect(id);
      this.options.stopAudio?.(id);
    }
  }
}
module.exports = { VoiceSession, validate };
