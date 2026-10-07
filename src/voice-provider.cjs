'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
class VoiceProvider {
  constructor({ directory, encrypt, decrypt, available, fetch: request = global.fetch, actorId }) {
    this.file = path.join(directory, 'voice-provider.enc');
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.available = available;
    this.request = request;
    this.actorId = actorId;
  }
  support() {
    return {
      provider: 'openai-realtime',
      configured: fs.existsSync(this.file) && this.available(),
      model: 'gpt-realtime-2.1',
      billing: 'Separate OpenAI API; not Codex quota',
      pricingURL: 'https://developers.openai.com/api/docs/models/gpt-realtime-2.1',
      accountEntitlement: 'unverified_until_explicit_call',
      lastVerifiedAt: null,
      voiceTransport: 'WebRTC',
      outboundTelephony: false,
    };
  }
  configure(key) {
    if (
      !this.available() ||
      typeof key !== 'string' ||
      key.length < 16 ||
      key.length > 512 ||
      /[\r\n]/.test(key)
    )
      throw new Error('OS encryption and a valid separately provided API key are required.');
    const bytes = this.encrypt(
        JSON.stringify({
          schema: 1,
          provider: 'openai-realtime',
          model: 'gpt-realtime-2.1',
          actorId: this.actorId,
          key,
        }),
      ),
      tmp = this.file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    return this.support();
  }
  credentials() {
    if (!this.available()) throw new Error('Voice credentials are unavailable.');
    const st = fs.lstatSync(this.file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 4096)
      throw new Error('Voice configuration requires recovery.');
    const v = JSON.parse(this.decrypt(fs.readFileSync(this.file)));
    if (
      v.schema !== 1 ||
      v.actorId !== this.actorId ||
      v.provider !== 'openai-realtime' ||
      v.model !== 'gpt-realtime-2.1' ||
      typeof v.key !== 'string'
    )
      throw new Error('Voice configuration belongs to another owner or provider.');
    return v;
  }
  async connect({ sdp, model, signal }) {
    const config = this.credentials();
    if (model !== config.model) throw new Error('Voice model changed.');
    const body = new FormData();
    body.set('sdp', sdp);
    body.set(
      'session',
      JSON.stringify({
        type: 'realtime',
        model,
        tools: [],
        instructions:
          'You are Hyphen in a private voice conversation. You have no task execution tools, no access to other chats and no authority to contact people. Speak naturally; do not claim task progress you cannot inspect.',
        audio: {
          input: {
            turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true },
          },
          output: { voice: 'marin' },
        },
      }),
    );
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 20000);
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    try {
      const response = await this.request('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + config.key,
          'OpenAI-Safety-Identifier': crypto
            .createHash('sha256')
            .update(this.actorId)
            .digest('hex'),
        },
        body,
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Configured voice provider denied the connection.');
      const answer = await response.text();
      if (answer.length > 128000) throw new Error('Voice response exceeded its bound.');
      return answer;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
  }
}
module.exports = { VoiceProvider };
